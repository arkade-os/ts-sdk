/**
 * One client over both swap families: RFQ corridors (driven by
 * `RfqSwapManager`) and arkade↔arkade offers (watched by `watchOfferSwaps`).
 * The market picks the backend: a non-arkade leg means RFQ over its card's
 * rendezvous, two arkade legs mean a card-priced offer covenant.
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
import { createRfqSwapRecord, type RfqSwapOrigin } from "./rfqRecord";
import type { RefundArkProvider } from "./refund";
import { rfqClaimSecretOf, rfqSecretsProfile } from "./rfqProfileParts";
import { onchainSendProfile } from "./rfqCorridors";
import { arkadeRefunder } from "./arkadeRefunder";
import { pushClaim } from "./claim";
import type { ChainSource } from "./onchainHtlc";

type SideCorridor = "arkade" | "lightning" | "onchain";

// read at runtime: solver-discovery 0.1.x types predate corridor markets
const sideCorridorsOf = (market: DiscoveredMarket): { base: SideCorridor; quote: SideCorridor } => {
    const read = (value: unknown): SideCorridor =>
        value === "lightning" || value === "onchain" ? value : "arkade";
    const m = market as { base_corridor?: string; quote_corridor?: string };
    return { base: read(m.base_corridor), quote: read(m.quote_corridor) };
};

const resolveKind = (
    market: DiscoveredMarket,
    give: "base" | "quote",
): "spot" | "ln_send" | "ln_receive" | "onchain_send" | "onchain_receive" => {
    const corridors = sideCorridorsOf(market);
    const giveCorridor = corridors[give];
    const receiveCorridor = corridors[give === "base" ? "quote" : "base"];
    if (giveCorridor === "arkade" && receiveCorridor === "arkade") return "spot";
    if (receiveCorridor === "lightning") return "ln_send";
    if (giveCorridor === "lightning") return "ln_receive";
    if (receiveCorridor === "onchain") return "onchain_send";
    return "onchain_receive";
};

export interface SwapQuoteInput {
    /** Which side of the market the trader deposits. */
    give: "base" | "quote";
    /** Size on the named side ("give" = exact-in, "receive" = exact-out).
     * Spot: display string or atomic bigint; corridors: sats. A lightning
     * send takes its amount from the invoice instead. */
    amount?: string | number | bigint;
    amountOn?: "give" | "receive";
    /** Required when the receive side is lightning. */
    invoice?: InvoiceFacts;
    /** Trader's x-only L1 claim key; required when the receive side is onchain. */
    payoutPubkey?: Uint8Array;
    preimage?: Uint8Array;
    maxPayAmount?: number;
}

const need = <T>(value: T | undefined, what: string, leg: string): T => {
    if (value === undefined) throw new Error(`a ${leg} quote needs ${what}`);
    return value;
};

const corridorAmount = (
    input: SwapQuoteInput,
    leg: string,
): { amount: number; amountSide: "from" | "to" } => {
    const raw = need(input.amount, "an amount", leg);
    const amountOn = need(input.amountOn, "amountOn ('give' or 'receive')", leg);
    const amount = Number(raw);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`a ${leg} amount must be a positive integer of sats, got ${String(raw)}`);
    }
    return { amount, amountSide: amountOn === "give" ? "from" : "to" };
};

export interface SpotQuote {
    kind: "spot";
    market: DiscoveredMarket;
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
    /** The solver's hold invoice, for the payer. */
    invoice: string;
}

export interface OnchainSendQuote {
    kind: "onchain_send";
    market: DiscoveredMarket;
    request: Awaited<ReturnType<typeof requestOnchainSend>>;
}

export type SwapQuote = SpotQuote | LightningSendQuote | LightningReceiveQuote | OnchainSendQuote;

export type UnifiedSwap = { family: "offer"; swap: AssetSwap } | { family: "rfq"; swap: RfqSwap };

export interface SwapClientDeps {
    wallet: IWallet;
    /** Drops once IWallet exposes the server connection (arkade-os/ts-sdk#734). */
    arkServerUrl: string;
    repository: AssetSwapRepository;
    /** Never called for a spot market. */
    transportFor: (market: DiscoveredMarket) => RfqTransport;
    discovery: Omit<DiscoverMarketsOptions, "repository">;
    /** BOLT11 decoder for the solver's hold invoice; required to quote lightning receives. */
    decodeInvoice?: (bolt11: string) => InvoiceFacts;
    /** covclaimd's 33-byte compressed pubkey — the lightning-receive claim
     * packet seals to it; required to quote lightning receives. */
    covclaimdPubkey?: Uint8Array;
    /** L1 access; required to quote onchain sends. */
    chain?: ChainSource;
    /** L1 claim callback (fee rate and signing are environment-specific);
     * without it the manager reports onchain claims as blocked. */
    claimOnchain?: RfqSwapManagerCallbacks["claimOnchain"];
    emulatorPubkey?: string;
    ark?: RefundArkProvider;
    indexer?: RestIndexerProvider;
}

export interface SwapClient {
    markets(useCache?: boolean): Promise<DiscoveredMarket[]>;
    quote(market: DiscoveredMarket, input: SwapQuoteInput): Promise<SwapQuote>;
    accept(quote: SwapQuote): Promise<UnifiedSwap>;
    /** Spot only: the covenant's cooperative reclaim. */
    cancel(fundingTxid: string): Promise<void>;
    swaps(): Promise<UnifiedSwap[]>;
    onUpdate(listener: (swap: UnifiedSwap) => void): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
    readonly manager: RfqSwapManager;
}

export function createSwapClient(deps: SwapClientDeps): SwapClient {
    const { wallet, arkServerUrl, repository, transportFor } = deps;
    const ark = deps.ark ?? new RestArkProvider(arkServerUrl);
    const indexer = deps.indexer ?? new RestIndexerProvider(arkServerUrl);

    // contracts is filled in at start(); the manager holds deps by reference
    const managerDeps: RfqSwapManagerDeps = { indexer, chain: deps.chain, repository };
    const manager = new RfqSwapManager(managerDeps);

    const listeners = new Set<(swap: UnifiedSwap) => void>();
    const notify = (swap: UnifiedSwap): void => {
        for (const listener of listeners) {
            try {
                listener(swap);
            } catch {
                // a listener must not derail the state machine
            }
        }
    };
    manager.onSwapUpdate((swap) => notify({ family: "rfq", swap }));

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

    const quote = async (market: DiscoveredMarket, input: SwapQuoteInput): Promise<SwapQuote> => {
        const kind = resolveKind(market, input.give);
        switch (kind) {
            case "spot": {
                const raw = need(input.amount, "an amount", kind);
                const amountOn = need(input.amountOn, "amountOn ('give' or 'receive')", kind);
                const plan = await quoteOffer(market, {
                    give: input.give,
                    ...(amountOn === "give" ? { giveAmount: raw } : { wantAmount: raw }),
                    fetchImpl: deps.discovery.fetchImpl,
                });
                return { kind, market, plan };
            }
            case "ln_send": {
                // inputs validated before transportFor opens a connection
                const invoice = need(input.invoice, "the invoice to pay", kind);
                const request = await requestLightningSend(
                    wallet,
                    arkServerUrl,
                    transportFor(market),
                    { invoice, emulatorPubkey: deps.emulatorPubkey },
                );
                return { kind, market, request };
            }
            case "ln_receive": {
                const params = {
                    ...corridorAmount(input, kind),
                    covclaimdPubkey: need(deps.covclaimdPubkey, "deps.covclaimdPubkey", kind),
                    decodeInvoice: need(deps.decodeInvoice, "deps.decodeInvoice", kind),
                    maxPayAmount: input.maxPayAmount,
                    emulatorPubkey: deps.emulatorPubkey,
                };
                const request = await requestLightningReceive(
                    wallet,
                    arkServerUrl,
                    transportFor(market),
                    params,
                );
                return { kind, market, request, invoice: request.invoice };
            }
            case "onchain_send": {
                // without L1 access the manager would fail the swap after funding
                need(deps.chain, "deps.chain (L1 access)", kind);
                const params = {
                    ...corridorAmount(input, kind),
                    payoutPubkey: need(input.payoutPubkey, "a payoutPubkey", kind),
                    preimage: input.preimage,
                    emulatorPubkey: deps.emulatorPubkey,
                };
                const request = await requestOnchainSend(
                    wallet,
                    arkServerUrl,
                    transportFor(market),
                    params,
                );
                return { kind, market, request };
            }
            case "onchain_receive":
                throw new Error(
                    "onchain->arkade is not driven by RfqSwapManager yet; " +
                        "quote it directly with requestOnchainReceive",
                );
        }
    };

    const admit = async (swap: RfqSwap, origin: RfqSwapOrigin): Promise<UnifiedSwap> => {
        await manager.addSwap(swap, origin);
        const unified: UnifiedSwap = { family: "rfq", swap };
        notify(unified);
        return unified;
    };

    // record (and its secrets) at rest before funding broadcasts: a crash in
    // between leaves a restorable pending record, never funded money without one
    const fundPersisted = async (
        swap: LightningSendSwap | OnchainSendSwap,
        origin: RfqSwapOrigin,
        funding: { address: string; amount: number },
    ): Promise<string> => {
        await repository.saveRfqSwap(createRfqSwapRecord(origin, swap));
        return wallet.send({ address: funding.address, amount: funding.amount });
    };

    const accept = async (accepted: SwapQuote): Promise<UnifiedSwap> => {
        const now = Math.floor(Date.now() / 1000);
        switch (accepted.kind) {
            case "spot": {
                const { plan } = accepted;
                const depositIsBtc = plan.deposit.asset.id === BTC_ASSET_ID;
                // keyed on the receive side: the covenant binds what the fill delivers
                const offer = await createOffer(wallet, arkServerUrl, {
                    wantAmount: plan.receive.atomic,
                    ...(plan.receive.asset.id === BTC_ASSET_ID
                        ? { offerAsset: asset.AssetId.fromString(plan.deposit.asset.id) }
                        : { wantAsset: asset.AssetId.fromString(plan.receive.asset.id) }),
                    emulatorPubkey: deps.emulatorPubkey,
                });
                const txid = await wallet.send({
                    address: offer.address,
                    // asset deposits ride the SDK's dust-sat carrier
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
                const swap: LightningSendSwap = {
                    kind: "lightning_send",
                    rfqId: request.rfqId,
                    state: "pending",
                    lockupPkScript: request.swapPkScript,
                    lockup: { script: request.script, address: request.address },
                    // the trader's own decode, never the solver's echo
                    paymentHash: request.treeParams.paymentHash,
                    refundLocktime: request.treeParams.refundLocktime,
                    createdAt: now,
                    updatedAt: now,
                };
                const origin: RfqSwapOrigin = {
                    kind: "lightning_send",
                    lockupAddress: request.address,
                    profile: rfqSecretsProfile(request.secrets, swap.paymentHash),
                    amount: request.fundAmount,
                };
                const txid = await fundPersisted(swap, origin, {
                    address: request.address,
                    amount: request.fundAmount,
                });
                return admit(swap, { ...origin, fundingArkTxid: txid });
            }
            case "ln_receive": {
                // nothing to fund: the solver funds the lockup once the invoice is paid
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
                const origin: RfqSwapOrigin = {
                    kind: "onchain_send",
                    lockupAddress: request.address,
                    profile: {
                        ...rfqSecretsProfile(request.secrets, paymentHash),
                        ...onchainSendProfile(request),
                    },
                    amount: request.fundAmount,
                };
                const txid = await fundPersisted(swap, origin, {
                    address: request.address,
                    amount: request.fundAmount,
                });
                return admit(swap, { ...origin, fundingArkTxid: txid });
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
            if (swap.status !== "pending") {
                throw new Error(`offer swap ${fundingTxid} is ${swap.status}, not cancellable`);
            }
            // written before spending so the watcher cannot read the cancel as a fill
            await updateAssetSwap(repository, fundingTxid, { status: "cancelling" });
            await cancelOffer(wallet, arkServerUrl, swap.offerHex, {
                repository,
                fundingTxid,
            });
        },
        // live RFQ swaps only; terminal history stays on repository.getAllRfqSwaps()
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
