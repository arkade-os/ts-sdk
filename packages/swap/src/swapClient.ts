/**
 * One entry point over both swap families.
 *
 * The package's two halves are complete on their own: the RFQ corridors
 * (`requestLightningSend` / `requestLightningReceive` / `requestOnchainSend`,
 * driven by `RfqSwapManager`) and the arkade↔arkade offer flow (`createOffer`,
 * watched by `watchOfferSwaps`). What a wallet had to write itself was the
 * dispatch between them, the funding step each one expects, the record/origin
 * assembly `addSwap` needs, and the callback wiring the manager's README
 * documents as prose. That glue is this module.
 *
 * **The backend is chosen by the market, not by the caller.** A market with a
 * non-arkade leg carries an RFQ rendezvous (its card's `discovery_pubkey` +
 * `transports`), so its quote is a solver round trip; a spot arkade↔arkade
 * market carries a price feed and no rendezvous, so its quote resolves
 * client-side and the offer covenant is the whole protocol — the solver fills
 * from the arkd stream without ever being contacted. Swapping a backend is a
 * card change, never a client change.
 *
 * The corridor fields are read off the market at runtime rather than through
 * `@arkade-os/solver-discovery`'s types, which at 0.1.x predate corridor
 * markets. A pre-corridor index simply has no such fields, so every market in
 * it dispatches spot — the correct reading of that data, not a fallback.
 *
 * `onchain_receive` is deliberately absent: `RfqSwapManager` does not drive
 * that leg yet, and a facade quoting what nothing can monitor would be
 * offering a swap it cannot finish. Quote it directly with
 * `requestOnchainReceive` until the manager grows the fourth kind.
 */
import { hex } from "@scure/base";
import {
    ArkAddress,
    RestArkProvider,
    RestIndexerProvider,
    asset,
    contractSigner,
    type IWallet,
} from "@arkade-os/sdk";
import { quoteOffer, type DiscoveredMarket, type OfferPlan } from "@arkade-os/solver-discovery";
import { createOffer, cancelOffer } from "./offer";
import { discoverMarkets, type DiscoverMarketsOptions } from "./markets";
import {
    BTC_ASSET_ID,
    addAssetSwap,
    getAssetSwaps,
    preimageForSwapRecord,
    updateAssetSwap,
    type AssetSwap,
} from "./store";
import type { AssetSwapRepository } from "./repository";
import { watchOfferSwaps, type OfferSwapWatcher } from "./watch";
import {
    requestLightningReceive,
    requestLightningSend,
    requestOnchainSend,
    type InvoiceFacts,
    type RfqTransport,
} from "./rfq";
import {
    RfqSwapManager,
    type LightningReceiveSwap,
    type LightningSendSwap,
    type OnchainSendSwap,
    type RfqSwap,
    type RfqSwapManagerCallbacks,
    type RfqSwapManagerDeps,
} from "./swapManager";
import type { RfqSwapOrigin } from "./rfqRecord";
import type { RefundArkProvider } from "./refund";
import { rfqClaimSecretOf, rfqSecretsProfile } from "./rfqProfileParts";
import { onchainSendProfile } from "./rfqCorridors";
import { arkadeRefunder } from "./arkadeRefunder";
import { pushClaim } from "./claim";
import type { ChainSource } from "./onchainHtlc";

// ── Dispatch: what kind of swap a market sells ───────────────────────────────

/** The corridor-qualified read of a market, tolerant of pre-corridor data. */
const corridorOf = (market: DiscoveredMarket): "spot" | "lightning" | "onchain" => {
    const m = market as { base_corridor?: string; quote_corridor?: string };
    const side = [m.base_corridor, m.quote_corridor].find((c) => c && c !== "arkade");
    if (side === "lightning" || side === "onchain") return side;
    return "spot";
};

// ── Quote inputs, one member per swap kind ──────────────────────────────────

export interface SpotQuoteInput {
    kind: "spot";
    /** Which side the trader deposits. */
    give: "base" | "quote";
    /** Display amount ("0.01") or atomic bigint of the given side. */
    giveAmount: string | number | bigint;
}

export interface LightningSendQuoteInput {
    kind: "ln_send";
    /** From the caller's own BOLT11 decoder — facts, not a decoder. */
    invoice: InvoiceFacts;
}

export interface LightningReceiveQuoteInput {
    kind: "ln_receive";
    amount: number;
    amountSide: "from" | "to";
    /** covclaimd's 33-byte compressed pubkey. */
    covclaimdPubkey: Uint8Array;
    /** The caller's own decoder, applied to the SOLVER's hold invoice. */
    decodeInvoice: (bolt11: string) => InvoiceFacts;
    maxPayAmount?: number;
}

export interface OnchainSendQuoteInput {
    kind: "onchain_send";
    amount: number;
    amountSide: "from" | "to";
    /** Trader's x-only L1 key that will claim the HTLC. */
    payoutPubkey: Uint8Array;
    preimage?: Uint8Array;
}

export type SwapQuoteInput =
    | SpotQuoteInput
    | LightningSendQuoteInput
    | LightningReceiveQuoteInput
    | OnchainSendQuoteInput;

// ── Quotes, carrying exactly what accept() needs ─────────────────────────────

export interface SpotQuote {
    kind: "spot";
    market: DiscoveredMarket;
    /** Client-side pre-commitment plan: `receive.atomic` is the covenant's
     * wantAmount, `deposit` what the funding tx must put in. */
    plan: OfferPlan;
}

export interface LightningSendQuote {
    kind: "ln_send";
    market: DiscoveredMarket;
    request: Awaited<ReturnType<typeof requestLightningSend>>;
}

export interface LightningReceiveQuote {
    kind: "ln_receive";
    market: DiscoveredMarket;
    request: Awaited<ReturnType<typeof requestLightningReceive>>;
    /** The solver's hold invoice — show it to the payer. */
    invoice: string;
}

export interface OnchainSendQuote {
    kind: "onchain_send";
    market: DiscoveredMarket;
    request: Awaited<ReturnType<typeof requestOnchainSend>>;
}

export type SwapQuote = SpotQuote | LightningSendQuote | LightningReceiveQuote | OnchainSendQuote;

// ── The one swap union both watchers feed ───────────────────────────────────

export type UnifiedSwap = { family: "offer"; swap: AssetSwap } | { family: "rfq"; swap: RfqSwap };

export interface SwapClientDeps {
    wallet: IWallet;
    arkServerUrl: string;
    /** One repository backs both stores (`AssetSwap` rows and RFQ records). */
    repository: AssetSwapRepository;
    /**
     * The RFQ transport for a corridor market — read the card's `transports`
     * (`nostrRfqTransport`), or pin one (`httpTransport`) for a solver you
     * already know. Never called for a spot market.
     */
    transportFor: (market: DiscoveredMarket) => RfqTransport;
    /** Registry discovery config, minus the repository (wired here). */
    discovery: Omit<DiscoverMarketsOptions, "repository">;
    /** L1 access; required only to drive onchain-send swaps. */
    chain?: ChainSource;
    /**
     * The L1 claim callback (fee rate and L1 signing are environment-specific;
     * see `claimOnchainFill`). Without it an onchain send still watches and
     * refunds — the manager reports the claim as blocked instead of taking it.
     */
    claimOnchain?: RfqSwapManagerCallbacks["claimOnchain"];
    /** Co-signer key override, forwarded to every derivation. */
    emulatorPubkey?: string;
    /** Injectable for tests; defaults constructed from `arkServerUrl`. */
    ark?: RefundArkProvider;
    indexer?: RestIndexerProvider;
}

export interface SwapClient {
    markets(useCache?: boolean): Promise<DiscoveredMarket[]>;
    quote(market: DiscoveredMarket, input: SwapQuoteInput): Promise<SwapQuote>;
    /** Fund/arm the quoted swap and hand it to the right watcher. */
    accept(quote: SwapQuote): Promise<UnifiedSwap>;
    /** Spot only: the covenant's cooperative reclaim. */
    cancel(fundingTxid: string): Promise<void>;
    swaps(): Promise<UnifiedSwap[]>;
    onUpdate(listener: (swap: UnifiedSwap) => void): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** The composed manager, for callers needing the finer-grained surface. */
    readonly manager: RfqSwapManager;
}

export function createSwapClient(deps: SwapClientDeps): SwapClient {
    const { wallet, arkServerUrl, repository, transportFor } = deps;
    const ark = deps.ark ?? new RestArkProvider(arkServerUrl);
    const indexer = deps.indexer ?? new RestIndexerProvider(arkServerUrl);

    // `contracts` is filled in at start(): getting the contract manager is
    // async and the constructor is not. The manager holds deps by reference,
    // so the late write is seen by restore and every later pass.
    const managerDeps: RfqSwapManagerDeps = { indexer, chain: deps.chain, repository };
    const manager = new RfqSwapManager(managerDeps);

    const listeners = new Set<(swap: UnifiedSwap) => void>();
    const notify = (swap: UnifiedSwap): void => {
        for (const listener of listeners) {
            try {
                listener(swap);
            } catch {
                // a consumer's callback is not this client's correctness
            }
        }
    };
    manager.onSwapUpdate((swap) => notify({ family: "rfq", swap }));

    /**
     * The receive-leg claim, assembled from the record: the descriptor and
     * preimage live in `profile` (never on the live swap), so both are
     * resolved by rfqId at claim time — nothing secret is held here.
     */
    const claimLockup: RfqSwapManagerCallbacks["claimLockup"] = async (
        swap,
        vtxos,
        { partiallyClaimed },
    ) => {
        const record = await repository.getRfqSwap(swap.rfqId);
        if (!record) throw new Error(`rfq swap ${swap.rfqId} has no stored record to claim from`);
        const secret = rfqClaimSecretOf(record);
        if (!secret) throw new Error(`rfq swap ${swap.rfqId} carries no claim secret`);
        const script = swap.lockup?.script;
        if (!script) throw new Error(`rfq swap ${swap.rfqId} carries no lockup covenant`);
        const payoutAddress = (record.profile as { payoutAddress?: string }).payoutAddress;
        if (!payoutAddress) throw new Error(`rfq swap ${swap.rfqId} carries no payoutAddress`);
        return pushClaim(ark, {
            script,
            receiver: await contractSigner(wallet, secret.signingDescriptor),
            preimage: await preimageForSwapRecord(wallet, secret),
            vtxos,
            destinationPkScript: ArkAddress.decode(payoutAddress).pkScript,
            expectedAmount: swap.expectedAmount,
            partiallyClaimed,
        });
    };

    manager.setCallbacks({
        refundArkade: arkadeRefunder({ ark, indexer, wallet, repository }),
        claimLockup,
        ...(deps.claimOnchain ? { claimOnchain: deps.claimOnchain } : {}),
    });

    let watcher: OfferSwapWatcher | undefined;

    const requireCorridor = (
        market: DiscoveredMarket,
        expected: "lightning" | "onchain",
        kind: string,
    ): RfqTransport => {
        const corridor = corridorOf(market);
        if (corridor !== expected) {
            throw new Error(
                `a ${kind} quote needs a ${expected}-corridor market; this market is ${corridor}`,
            );
        }
        return transportFor(market);
    };

    const quote = async (market: DiscoveredMarket, input: SwapQuoteInput): Promise<SwapQuote> => {
        switch (input.kind) {
            case "spot": {
                const corridor = corridorOf(market);
                if (corridor !== "spot") {
                    throw new Error(
                        `a spot quote needs an arkade↔arkade market; this market is ${corridor}-corridor`,
                    );
                }
                const plan = await quoteOffer(market, {
                    give: input.give,
                    giveAmount: input.giveAmount,
                    // one fetch seam for the whole client: the same override
                    // discovery uses prices the spot quotes
                    fetchImpl: deps.discovery.fetchImpl,
                });
                return { kind: "spot", market, plan };
            }
            case "ln_send": {
                const transport = requireCorridor(market, "lightning", "ln_send");
                const request = await requestLightningSend(wallet, arkServerUrl, transport, {
                    invoice: input.invoice,
                    emulatorPubkey: deps.emulatorPubkey,
                });
                return { kind: "ln_send", market, request };
            }
            case "ln_receive": {
                const transport = requireCorridor(market, "lightning", "ln_receive");
                const request = await requestLightningReceive(wallet, arkServerUrl, transport, {
                    amount: input.amount,
                    amountSide: input.amountSide,
                    covclaimdPubkey: input.covclaimdPubkey,
                    decodeInvoice: input.decodeInvoice,
                    maxPayAmount: input.maxPayAmount,
                    emulatorPubkey: deps.emulatorPubkey,
                });
                return { kind: "ln_receive", market, request, invoice: request.invoice };
            }
            case "onchain_send": {
                const transport = requireCorridor(market, "onchain", "onchain_send");
                const request = await requestOnchainSend(wallet, arkServerUrl, transport, {
                    amount: input.amount,
                    amountSide: input.amountSide,
                    payoutPubkey: input.payoutPubkey,
                    preimage: input.preimage,
                    emulatorPubkey: deps.emulatorPubkey,
                });
                return { kind: "onchain_send", market, request };
            }
        }
    };

    /** The RFQ swap + origin pair `addSwap` needs, from a request result. */
    const admit = async (swap: RfqSwap, origin: RfqSwapOrigin): Promise<UnifiedSwap> => {
        await manager.addSwap(swap, origin);
        const unified: UnifiedSwap = { family: "rfq", swap };
        notify(unified);
        return unified;
    };

    const accept = async (accepted: SwapQuote): Promise<UnifiedSwap> => {
        const now = Math.floor(Date.now() / 1000);
        switch (accepted.kind) {
            case "spot": {
                const { plan } = accepted;
                const depositIsBtc = plan.deposit.asset.id === BTC_ASSET_ID;
                // keyed on the RECEIVE side: the covenant binds what the fill
                // must deliver, the deposit is whatever the funding tx carries
                const offer = await createOffer(wallet, arkServerUrl, {
                    wantAmount: plan.receive.atomic,
                    ...(plan.receive.asset.id === BTC_ASSET_ID
                        ? { offerAsset: asset.AssetId.fromString(plan.deposit.asset.id) }
                        : { wantAsset: asset.AssetId.fromString(plan.receive.asset.id) }),
                    emulatorPubkey: deps.emulatorPubkey,
                });
                const txid = await wallet.send({
                    address: offer.address,
                    // asset deposits ride the SDK's dust-sat carrier when omitted
                    amount: depositIsBtc ? Number(plan.deposit.atomic) : undefined,
                    assets: depositIsBtc
                        ? undefined
                        : [{ assetId: plan.deposit.asset.id, amount: plan.deposit.atomic }],
                    extensions: [offer.extension],
                });
                const swap: AssetSwap = {
                    id: txid,
                    fromAsset: plan.deposit.asset.id,
                    toAsset: plan.receive.asset.id,
                    fromAmount: plan.deposit.atomic.toString(),
                    toAmount: plan.receive.atomic.toString(),
                    swapAddress: offer.address,
                    swapPkScript: hex.encode(offer.swapPkScript),
                    offerHex: offer.offerHex,
                    fundingTxid: txid,
                    status: "pending",
                    createdAt: Date.now(),
                };
                await addAssetSwap(repository, swap);
                const unified: UnifiedSwap = { family: "offer", swap };
                notify(unified);
                return unified;
            }
            case "ln_send": {
                const { request } = accepted;
                const txid = await wallet.send({
                    address: request.address,
                    amount: request.fundAmount,
                });
                const swap: LightningSendSwap = {
                    kind: "lightning_send",
                    rfqId: request.rfqId,
                    state: "pending",
                    lockupPkScript: request.swapPkScript,
                    lockup: { script: request.script, address: request.address },
                    // the trader's OWN decode, bound into the covenant — never
                    // the solver's echo
                    paymentHash: request.treeParams.paymentHash,
                    refundLocktime: request.treeParams.refundLocktime,
                    createdAt: now,
                    updatedAt: now,
                };
                return admit(swap, {
                    kind: "lightning_send",
                    lockupAddress: request.address,
                    profile: rfqSecretsProfile(request.secrets, swap.paymentHash),
                    fundingArkTxid: txid,
                    amount: request.fundAmount,
                });
            }
            case "ln_receive": {
                // nothing to fund: the payer pays the invoice, the solver
                // funds the lockup, and the manager claims it with P
                const { request } = accepted;
                const paymentHash = hex.encode(request.secrets.paymentHash);
                const swap: LightningReceiveSwap = {
                    kind: "lightning_receive",
                    rfqId: request.rfqId,
                    state: "pending",
                    lockupPkScript: request.swapPkScript,
                    lockup: { script: request.script, address: request.address },
                    paymentHash,
                    refundLocktime: request.treeParams.refundLocktime,
                    expectedAmount: request.expectedAmount,
                    createdAt: now,
                    updatedAt: now,
                };
                return admit(swap, {
                    kind: "lightning_receive",
                    lockupAddress: request.address,
                    profile: {
                        ...rfqSecretsProfile(request.secrets, paymentHash),
                        expectedAmount: request.expectedAmount,
                        payoutAddress: request.payoutAddress,
                    },
                    amount: request.expectedAmount,
                });
            }
            case "onchain_send": {
                const { request } = accepted;
                const txid = await wallet.send({
                    address: request.address,
                    amount: request.fundAmount,
                });
                const paymentHash = hex.encode(request.secrets.paymentHash);
                const swap: OnchainSendSwap = {
                    kind: "onchain_send",
                    rfqId: request.rfqId,
                    state: "pending",
                    lockupPkScript: request.swapPkScript,
                    lockup: { script: request.script, address: request.address },
                    paymentHash,
                    refundLocktime: request.quote.refund_locktime!,
                    htlc: request.htlc,
                    minConfirmations: request.minConfirmations,
                    createdAt: now,
                    updatedAt: now,
                };
                return admit(swap, {
                    kind: "onchain_send",
                    lockupAddress: request.address,
                    profile: {
                        ...rfqSecretsProfile(request.secrets, paymentHash),
                        ...onchainSendProfile(request),
                    },
                    fundingArkTxid: txid,
                    amount: request.fundAmount,
                });
            }
        }
    };

    return {
        manager,
        markets: (useCache) => discoverMarkets({ ...deps.discovery, repository, useCache }),
        quote,
        accept,
        cancel: async (fundingTxid) => {
            const swaps = await getAssetSwaps(repository);
            const swap = swaps.find((s) => s.id === fundingTxid);
            if (!swap) throw new Error(`no offer swap with funding txid ${fundingTxid}`);
            // leave 'pending' before spending so the watcher cannot read the
            // cancel spend as a fulfillment
            await updateAssetSwap(repository, fundingTxid, { status: "cancelling" });
            await cancelOffer(wallet, arkServerUrl, swap.offerHex, {
                repository,
                fundingTxid,
            });
        },
        // Offer swaps come back whole (the store retains terminal rows); RFQ
        // swaps come back live — terminal RFQ history stays readable through
        // `repository.getAllRfqSwaps()`.
        swaps: async () => {
            const offers = await getAssetSwaps(repository);
            const rfq = await manager.getPendingSwaps();
            return [
                ...offers.map((swap): UnifiedSwap => ({ family: "offer", swap })),
                ...rfq.map((swap): UnifiedSwap => ({ family: "rfq", swap })),
            ];
        },
        onUpdate: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start: async () => {
            managerDeps.contracts ??= await wallet.getContractManager();
            await manager.restoreFromRepository();
            await manager.start();
            watcher ??= await watchOfferSwaps({
                wallet,
                arkServerUrl,
                repository,
                onUpdate: (swap) => notify({ family: "offer", swap }),
            });
        },
        stop: async () => {
            await manager.stop();
            watcher?.stop();
            watcher = undefined;
        },
    };
}
