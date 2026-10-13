/**
 * The RFQ backend: one addressed request per route, verified before it is returned and persisted by
 * nobody. Three routes cross a corridor and lock a VHTLC; the fourth (arkade->arkade) derives an
 * offer covenant instead. No contract registration, record or funding here — `accept()` does that,
 * reusing the covenant derived here via {@link RfqPreparation}.
 *
 * The responder check runs BEFORE the request: what it prevents is disclosing an invoice and an
 * amount to a transport that cannot say who is listening.
 */
import { hex } from "@scure/base";
import {
    ArkAddress,
    asset,
    networkFromArkadeInfo,
    provisionClaimSecret,
    provisionRefundKey,
    toXOnly,
    type ArkadeInfo,
    type IWallet,
    type ProvisionedClaimSecret,
    type ProvisionedKey,
    type VHTLC,
} from "@arkade-os/sdk";
import { quoteOffer, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import { sealClaimPacket } from "../claimPacket";
import { QUOTE_OPTIONS } from "../markets";
import { deriveOffer, type DerivedOffer } from "../offer";
import { BTC_ASSET_ID } from "../store";
import { l1ScriptForAddress } from "../onchainHtlc";
import {
    ONCHAIN_DUST_SATS,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainNetwork,
} from "../onchainHtlc";
import { claimFeeSats } from "../payment/onchainSwap";
import {
    arkadeSwapRequest,
    deriveLightningReceive,
    deriveLightningSend,
    deriveOnchainSend,
    l1NetworkFromArk,
    lightningReceiveRequest,
    lightningSendRequest,
    newRfqId,
    offerTermsFromQuote,
    onchainSendRequest,
    unilateralClaimDelay,
    verifyOfferAddress,
    type LightningReceiveContractParams,
    type LightningSendContractParams,
} from "../rfq";
import type { DiscoveryLeg } from "./aliases";
import type { LightningCorridorDeps } from "./corridors/deps";
import type { CorridorSet } from "./corridors/registry";
import { UnsupportedRoute } from "./errors";
import { feedSpread, verifyPlanLegs, type FeedFetch } from "./quoteOffer";
import type { CardMarketRef, PinnedAmount, Quote, QuoteId, ResolvedEndpoint } from "./quote";
import type { MarketCandidate } from "./market";
import type { SwapPolicy } from "./policy";
import { parseRfqQuote, rfqPairFor, withCanonicalAmount, type ParsedRfqQuote } from "./rfqWire";
import { toRfqAmountSide } from "./rfqAmount";
import { assembleRoute } from "./resolve";
import type { AttestingRfqTransport } from "./transport";
import {
    verifiedCarrierSats,
    verifyCrossAssetAmount,
    verifyPair,
    verifyQuotedAmount,
    verifyQuoteTtl,
    verifyReceiveInvoiceFacts,
    verifyReceiveWindow,
    verifyResponder,
    verifySendInvoice,
    verifyRefundWindow,
    verifySendWindow,
    verifyingDerivation,
} from "./verify";

/** What every negotiated quote carries, whatever it settles through. */
interface NegotiatedPreparation {
    readonly backend: "rfq";
    readonly card: DiscoveredMarket;
    readonly rfqId: string;
    /** The solver's reply, decoded once. */
    readonly wire: ParsedRfqQuote;
}

/** The covenant and the keys behind one quoted corridor swap. */
interface CommonPreparation extends NegotiatedPreparation {
    /** The trader's OWN derivation of the Arkade lockup. */
    readonly lockup: {
        readonly address: string;
        readonly script: InstanceType<typeof VHTLC.ScriptV2>;
        readonly pkScript: Uint8Array;
    };
}

/**
 * What `accept()` inherits from a quote, held in memory by quote id and written nowhere. It makes
 * the covenant the quote was verified against the one that gets funded; re-deriving at accept
 * would be a second derivation that could disagree.
 */
export type RfqPreparation = CorridorRfqPreparation | AssetRfqPreparation;

/**
 * What `accept()` inherits from a negotiated asset quote.
 *
 * No `lockup`: this route settles through an offer covenant rather than a
 * VHTLC, so what travels is the whole derivation — the encoded offer, the
 * address the deposit goes to, and the covenant parameters the registration
 * needs. Derived at quote time because that is what the solver's
 * `offer_address` was compared against, and registered at accept from THIS
 * value: rebuilding the tree there would be a second derivation of the same
 * terms, which is the failure the hand-off exists to delete.
 */
export interface AssetRfqPreparation extends NegotiatedPreparation {
    readonly route: "arkade->arkade";
    /** The trader's OWN derivation of the offer covenant, registered by nobody. */
    readonly offer: DerivedOffer;
    /** The solver's carrier for an asset deposit; the deposit must carry exactly this many sats. */
    readonly carrierSats?: bigint;
}

export type CorridorRfqPreparation =
    | (CommonPreparation & {
          readonly route: "arkade->lightning";
          readonly contractParams: LightningSendContractParams;
          /** The refund key, and the address the quote named. */
          readonly secrets: ProvisionedKey;
          readonly refundAddress: string;
          /** What the lockup must carry: the quote's give amount. */
          readonly fundAmount: bigint;
      })
    | (CommonPreparation & {
          readonly route: "lightning->arkade";
          readonly contractParams: LightningReceiveContractParams;
          readonly secrets: ProvisionedClaimSecret;
          readonly payoutAddress: string;
          /** What the solver's lockup must carry — the claim refuses less. */
          readonly expectedAmount: bigint;
          /** Last moment the hold invoice can be paid, unix seconds. */
          readonly payDeadline: number;
      })
    | (CommonPreparation & {
          readonly route: "arkade->onchain";
          readonly secrets: ProvisionedClaimSecret;
          readonly refundAddress: string;
          readonly fundAmount: bigint;
          /** What the solver's HTLC must carry — the claim refuses less. */
          readonly expectedAmount: bigint;
          /** The L1 claim key, provisioned by the wallet like every other key. */
          readonly payoutKey: ProvisionedKey;
          /** Where the claim PAYS — the take endpoint's address, encoded. Distinct from
           * {@link payoutKey}, which only AUTHORISES the claim. */
          readonly payoutPkScript: Uint8Array;
          readonly htlc: OnchainHtlc;
          readonly htlcParams: OnchainHtlcParams;
          readonly l1Network: OnchainNetwork;
          readonly minConfirmations: number;
      });

export interface RfqQuoteInput {
    readonly quoteId: QuoteId;
    readonly route:
        | "arkade->arkade"
        | "arkade->lightning"
        | "lightning->arkade"
        | "arkade->onchain";
    readonly candidate: MarketCandidate;
    readonly market: CardMarketRef;
    readonly legs: { readonly give: DiscoveryLeg; readonly take: DiscoveryLeg };
    readonly endpoints: { readonly give: ResolvedEndpoint; readonly take: ResolvedEndpoint };
    readonly amount?: PinnedAmount;
    readonly wallet: IWallet;
    /** Live, per section 6: a snapshot binds a covenant to a key that may have rotated. */
    readonly info: ArkadeInfo;
    /**
     * The corridor modules, unresolved: resolution refuses a dep overridden to nothing, so each
     * route resolves only the corridors it uses.
     */
    readonly corridors: CorridorSet;
    readonly transport: AttestingRfqTransport;
    /**
     * The card's price feed, read by the asset route and by nobody else.
     *
     * A cross-asset quote's fee is a concession measured against a price, not a
     * subtraction of two legs — see {@link feedSpread} — and the card's own
     * advertised feed is the only price either asset backend has.
     */
    readonly feed: FeedFetch;
    readonly policy?: SwapPolicy;
    /** Unix seconds. */
    readonly now: number;
}

/** Everything the covenant derivations read off the trader's own connection. */
interface CovenantInputs {
    readonly operatorPubkey: Uint8Array;
    readonly emulatorPubkey: Uint8Array;
    readonly claimDelay: number;
    readonly hrp: string;
}

const lockupOf = (derived: {
    readonly address: string;
    readonly script: CommonPreparation["lockup"]["script"];
    readonly swapPkScript: Uint8Array;
}): CommonPreparation["lockup"] => ({
    address: derived.address,
    script: derived.script,
    pkScript: derived.swapPkScript,
});

const covenantInputs = (input: RfqQuoteInput): CovenantInputs => {
    const network = networkFromArkadeInfo(input.info);
    const arkade = input.corridors.get("arkade").deps;
    return {
        operatorPubkey: toXOnly(hex.decode(input.info.signerPubkey), "ark signer key"),
        // The resolved per-network pin, never operator-reported: it lands in a covenant leaf
        // that decides who can move the funds.
        emulatorPubkey: toXOnly(hex.decode(arkade.emulatorPubkey), "emulator signer key"),
        claimDelay: unilateralClaimDelay(Number(input.info.unilateralExitDelay)),
        hrp: network.hrp,
    };
};

/**
 * Who the claim packet is sealed to, or `undefined` where no covclaimd is deployed (then no
 * packet is sent and claiming before `refund_locktime` is the trader's job).
 *
 * Never seal to a throwaway key: an undecryptable packet looks like a working one on the wire,
 * and covclaimd would silently claim nothing.
 */
const sealingKey = (deps: LightningCorridorDeps): Uint8Array | undefined => {
    const configured = deps.covclaimd?.pubkey;
    if (configured === undefined) return undefined;
    const key = hex.decode(configured);
    if (key.length !== 33) {
        throw new Error(
            `the covclaimd deployment key must be 33-byte compressed hex, got ${key.length} bytes`,
        );
    }
    return key;
};

/** The pinned amount, or a refusal for a route that needs one. */
const pinnedFor = (input: RfqQuoteInput): PinnedAmount => {
    if (input.amount === undefined) {
        throw new Error(`a ${input.route} quote needs an amount and the side it pins`);
    }
    return input.amount;
};

export const quoteViaRfq = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    // Before anything is disclosed. The expected key must come from a registry-served card, not
    // the local cache, which authenticates nothing it stores.
    verifyResponder({
        attested: input.transport.attestedResponder,
        expected: input.market.discoveryPubkey,
        pinnable: input.market.snapshot.live,
    });

    switch (input.route) {
        case "arkade->arkade":
            return quoteArkadeAsset(input);
        case "arkade->lightning":
            return quoteLightningSend(input);
        case "lightning->arkade":
            return quoteLightningReceive(input);
        case "arkade->onchain":
            return quoteOnchainSend(input);
    }
};

/**
 * Both endpoints on arkade: one addressed request, and an offer covenant the
 * trader derives and the solver's reply is checked against.
 *
 * The two differences from a corridor arm are settlement details. There is no
 * hashlock and no refund clock — the offer covenant carries neither, so
 * `valid_until` is the only deadline and recovery is the cancel the trader can
 * sign without the solver — and the two legs carry **different assets**, which
 * is what takes `from_amount >= to_amount` off the table as a check: 10_000 sats
 * for 1_000 cents and its reverse are both correct quotes.
 *
 * Exact-in only, checked before a byte is disclosed. A take-side pin would ask
 * the solver to price backwards through its own spread across a change of
 * asset, which is exactly what it answers `exact_out_unsupported` to.
 */
const quoteArkadeAsset = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    const pinned = pinnedFor(input);
    if (pinned.on !== "give") {
        // Caller input rather than a swap-boundary refusal: the route is served,
        // the request as spelled is not one this market answers.
        throw new Error(
            "an asset swap is exact-in: pin the amount on the give leg. The legs carry " +
                "different assets, so there is no spread to price a take-side pin back " +
                "through — the solver answers `exact_out_unsupported`",
        );
    }
    const sides = assetSidesOf(input.legs);
    // The fee is measured against the card's own feed, so a card without one is refused before the
    // request discloses anything, not after the solver has already answered.
    if (input.candidate.card.price_feed === undefined) {
        throw new UnsupportedRoute(
            `card ${input.candidate.card.solver} advertises no price feed to measure an asset swap's fee against`,
            { give: "arkade", take: "arkade" },
        );
    }
    const pair = rfqPairFor(input.legs.give, input.legs.take);
    const rfqId = newRfqId();
    // One read, shared by the request and the derivation below: the profile
    // commits to this script and this key, and a second read across a rotation
    // would derive a covenant the solver never quoted.
    const maker = await makerPosition(input.wallet);

    const wire = await input.transport.requestQuote(
        arkadeSwapRequest({
            rfqId,
            ...sides,
            amount: pinned.value,
            makerPkScript: maker.pkScript,
            makerPublicKey: maker.publicKey,
        }),
    );
    verifyPair(wire.pair, pair);
    const parsed = parseRfqQuote(wire);
    verifyCrossAssetAmount({ pair, pinned, give: parsed.give, take: parsed.take });
    verifyQuoteTtl({
        quoteId: input.quoteId,
        expiresAt: parsed.validUntil,
        now: input.now,
        floorSeconds: input.policy?.quoteTtlFloorSeconds,
    });
    // The solver's own carrier, parsed before anything is derived; a card that charges for it
    // prices the reference below with it.
    const carrierSats = sides.offerAsset === undefined ? undefined : verifiedCarrierSats(wire);
    // Before deriving: a failed feed or a mismatched pair refuses with no covenant built.
    const reference = await quoteOffer(input.candidate.card, {
        give: input.candidate.give,
        giveAmount: parsed.give,
        ...(carrierSats === undefined ? {} : { carrierSats }),
        ...QUOTE_OPTIONS,
        fetchImpl: input.feed.fetch,
    });
    verifyPlanLegs(reference, input.legs, input.candidate.give);

    // The covenant binds what the fill must DELIVER, so the wanted amount is the
    // quote's own `to_amount` and the deposited asset rides the funding VTXO.
    const terms = offerTermsFromQuote(wire, sides);
    const offer = await deriveOffer(input.wallet, {
        wantAmount: terms.wantAmount,
        ...(terms.wantAsset === undefined ? {} : { wantAsset: terms.wantAsset }),
        ...(terms.offerAsset === undefined ? {} : { offerAsset: terms.offerAsset }),
        emulatorPubkey: input.corridors.get("arkade").deps.emulatorPubkey,
        maker,
        info: input.info,
    });
    // Compare-only, and never the other way round: the address the trader funds
    // is the one the trader derived, and a solver naming another one is refused
    // rather than followed.
    verifyingDerivation(() => verifyOfferAddress(wire, offer));

    return {
        quote: {
            id: input.quoteId,
            route: assembleRoute(
                { ...input.endpoints.give, instrument: { kind: "wallet" } },
                { ...input.endpoints.take, instrument: { kind: "wallet" } },
            ),
            give: { asset: input.endpoints.give.asset, amount: parsed.give },
            take: { asset: input.endpoints.take.asset, amount: parsed.take },
            market: input.market,
            solver: parsed.solver,
            expiresAt: parsed.validUntil,
            // Exactly one leg is BTC, so an asset deposit's carrier is on the payout's unit.
            fee: {
                amount: feedSpread(reference, parsed.take, carrierSats),
                asset: input.endpoints.take.asset,
            },
        },
        preparation: {
            backend: "rfq",
            route: "arkade->arkade",
            card: input.candidate.card,
            rfqId,
            wire: parsed,
            offer,
            ...(carrierSats === undefined ? {} : { carrierSats }),
        },
    };
};

/**
 * Which leg names an asset — the one thing the covenant commits to — and the
 * refusal when neither or both do.
 *
 * Exactly one leg must be BTC. Neither is the same asset twice, and both is a
 * pair no market prices: an asset is quoted against BTC, and a cross the solver
 * would have to warehouse two sides of is not a route it serves.
 */
const assetSidesOf = (legs: {
    readonly give: DiscoveryLeg;
    readonly take: DiscoveryLeg;
}): { wantAsset?: asset.AssetId; offerAsset?: asset.AssetId } => {
    const giveIsBtc = legs.give.assetId === BTC_ASSET_ID;
    const takeIsBtc = legs.take.assetId === BTC_ASSET_ID;
    if (giveIsBtc && takeIsBtc) {
        throw new UnsupportedRoute("arkade:BTC -> arkade:BTC moves one asset, it swaps nothing", {
            give: "arkade",
            take: "arkade",
        });
    }
    if (!giveIsBtc && !takeIsBtc) {
        throw new UnsupportedRoute(
            `arkade:${legs.give.assetId} -> arkade:${legs.take.assetId}: an asset swap prices ` +
                "one asset against BTC, so exactly one leg must be BTC",
            { give: "arkade", take: "arkade" },
        );
    }
    return giveIsBtc
        ? { wantAsset: asset.AssetId.fromString(legs.take.assetId) }
        : { offerAsset: asset.AssetId.fromString(legs.give.assetId) };
};

/** The trader's own covenant position: the script a fill pays, and the key that
 * signs the cancel. */
const makerPosition = async (
    wallet: IWallet,
): Promise<{ pkScript: Uint8Array; publicKey: Uint8Array }> => {
    const [address, publicKey] = await Promise.all([
        wallet.getAddress(),
        wallet.identity.xOnlyPublicKey(),
    ]);
    return { pkScript: ArkAddress.decode(address).pkScript, publicKey };
};

const quoteLightningSend = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    const invoice = input.endpoints.take.instrument;
    if (invoice?.kind !== "invoice" || invoice.amount === undefined) {
        // The corridor's parse refuses amountless send invoices, so this one bypassed it.
        throw new Error("a lightning send is quoted against the amountful invoice it pays");
    }
    const pair = rfqPairFor(input.legs.give, input.legs.take);
    const rfqId = newRfqId();

    // A leg we fund needs only the refund key (P belongs to the payee). One address read, so
    // the refund address and refund script cannot come from two different rotations.
    const secrets = await provisionRefundKey(input.wallet);

    const wire = await input.transport.requestQuote(
        lightningSendRequest({
            rfqId,
            invoice: invoice.bolt11,
            refundAddress: secrets.address,
            senderPubkey: secrets.pubkey,
        }),
    );
    verifyPair(wire.pair, pair);
    const parsed = parseRfqQuote(wire);
    // Exact-out: `to_amount` is the invoice verbatim and `from_amount` adds the fee.
    verifySendInvoice({ invoiced: invoice.amount, give: parsed.give, take: parsed.take });

    const covenant = covenantInputs(input);
    const derived = verifyingDerivation(() =>
        deriveLightningSend({
            quote: wire,
            paymentHash: invoice.paymentHash,
            senderPubkey: secrets.pubkey,
            refundPkScript: secrets.pkScript,
            now: input.now,
            ...covenant,
        }),
    );
    verifySendWindow({
        quote: wire,
        quoteId: input.quoteId,
        now: input.now,
        invoiceExpiresAt: invoice.expiresAt,
    });
    verifyRefundWindow({
        refundLocktime: derived.refundLocktime,
        refundWithoutReceiverDelay: derived.contractParams.refundWithoutReceiverDelay,
        now: input.now,
        maxSeconds: input.policy?.maxRefundWindowSeconds,
    });
    verifyQuoteTtl({
        quoteId: input.quoteId,
        expiresAt: parsed.validUntil,
        now: input.now,
        floorSeconds: input.policy?.quoteTtlFloorSeconds,
    });

    return {
        quote: {
            id: input.quoteId,
            route: assembleRoute(
                { ...input.endpoints.give, instrument: { kind: "wallet" } },
                { ...input.endpoints.take, instrument: invoice },
            ),
            give: { asset: input.endpoints.give.asset, amount: parsed.give },
            take: { asset: input.endpoints.take.asset, amount: parsed.take },
            lock: { hash: invoice.paymentHash },
            market: input.market,
            solver: parsed.solver,
            expiresAt: parsed.validUntil,
            refundLocktime: derived.refundLocktime,
            fee: { amount: parsed.give - parsed.take, asset: input.endpoints.give.asset },
        },
        preparation: {
            backend: "rfq",
            route: "arkade->lightning",
            card: input.candidate.card,
            rfqId,
            wire: parsed,
            lockup: lockupOf(derived),
            contractParams: derived.contractParams,
            secrets,
            refundAddress: secrets.address,
            fundAmount: parsed.give,
        },
    };
};

const quoteLightningReceive = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    const pinned = pinnedFor(input);
    const pair = rfqPairFor(input.legs.give, input.legs.take);
    const rfqId = newRfqId();

    // A leg we claim: the key that receives it, and the P that unlocks it.
    const secrets = await provisionClaimSecret(input.wallet);
    const paymentHash = hex.encode(secrets.paymentHash);
    const payoutAddress = await input.wallet.getAddress();
    const lightning = input.corridors.get("lightning").deps;
    const sealTo = sealingKey(lightning);
    const claimPacket = sealTo
        ? await sealClaimPacket({ preimage: secrets.preimage, covclaimdPubkey: sealTo })
        : undefined;

    const wire = await input.transport.requestQuote(
        withCanonicalAmount(
            lightningReceiveRequest({
                rfqId,
                paymentHash,
                payoutAddress,
                payoutPubkey: secrets.pubkey,
                claimPacket: claimPacket?.packet,
                // Placeholder: `withCanonicalAmount` writes the canonical decimal string.
                amount: 0,
                amountSide: toRfqAmountSide(pinned.on),
            }),
            pinned.value,
        ),
    );
    verifyPair(wire.pair, pair);
    const parsed = parseRfqQuote(wire);
    verifyQuotedAmount({ pair, pinned, give: parsed.give, take: parsed.take });

    const covenant = covenantInputs(input);
    const derived = verifyingDerivation(() =>
        deriveLightningReceive({
            quote: wire,
            paymentHash,
            payoutPubkey: secrets.pubkey,
            payoutAddress,
            ...covenant,
        }),
    );
    // The invoice is handed to a third party: the only attack here with no on-chain trace.
    const { payDeadline } = verifyReceiveInvoiceFacts({
        invoice: derived.invoice,
        decode: lightning.decode,
        paymentHash,
        payAmount: parsed.give,
        validUntil: parsed.validUntil,
    });
    verifyReceiveWindow({
        quote: wire,
        quoteId: input.quoteId,
        payDeadline,
        now: input.now,
    });
    verifyQuoteTtl({
        quoteId: input.quoteId,
        // The hold invoice's window (minutes) binds, not the quote's (an hour).
        expiresAt: payDeadline,
        now: input.now,
        floorSeconds: input.policy?.quoteTtlFloorSeconds,
    });

    // The give leg's instrument IS the artifact: the solver's hold invoice.
    const artifact = { kind: "invoice", bolt11: derived.invoice } as const;
    return {
        quote: {
            id: input.quoteId,
            route: assembleRoute(
                {
                    ...input.endpoints.give,
                    instrument: {
                        kind: "invoice",
                        bolt11: derived.invoice,
                        paymentHash,
                        amount: parsed.give,
                        expiresAt: payDeadline,
                    },
                },
                { ...input.endpoints.take, instrument: { kind: "wallet" } },
            ),
            give: { asset: input.endpoints.give.asset, amount: parsed.give },
            take: { asset: input.endpoints.take.asset, amount: parsed.take },
            lock: { hash: paymentHash },
            market: input.market,
            solver: parsed.solver,
            expiresAt: payDeadline,
            refundLocktime: derived.refundLocktime,
            artifact,
            fee: { amount: parsed.give - parsed.take, asset: input.endpoints.give.asset },
        },
        preparation: {
            backend: "rfq",
            route: "lightning->arkade",
            card: input.candidate.card,
            rfqId,
            wire: parsed,
            lockup: lockupOf(derived),
            contractParams: derived.contractParams,
            secrets,
            payoutAddress,
            expectedAmount: parsed.take,
            payDeadline,
        },
    };
};

const quoteOnchainSend = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    const pinned = pinnedFor(input);
    const destination = input.endpoints.take.instrument;
    if (destination?.kind !== "address") {
        throw new Error("an onchain send is quoted against the L1 address it pays");
    }
    const l1Network = l1NetworkFromArk(input.info.network);
    // Refuse an unpayable destination before negotiating, not at claim time with funds locked.
    const payoutPkScript = l1ScriptForAddress(destination.address, l1Network);
    const pair = rfqPairFor(input.legs.give, input.legs.take);
    const rfqId = newRfqId();

    // **The take pin is recipient-EXACT.** The claim's miner fee comes out of the HTLC output
    // (`payout = utxo.amount - fee`), so with a take pin and a resolvable
    // {@link OnchainCorridorDeps.claimFeeRateSatVb} the solver is asked for
    // `pinned.value + claimFee` (same arithmetic as the `onchain-swap` rail). No rate: verbatim,
    // no invented fee. A give pin is untouched: the take leg is the solver's to size.
    const onchain = input.corridors.get("onchain").deps;
    const claimFee =
        pinned.on === "take" && onchain.claimFeeRateSatVb !== undefined
            ? claimFeeSats({
                  claimFeeRateSatVb: onchain.claimFeeRateSatVb,
                  claimVsize: onchain.claimVsize,
              })
            : undefined;
    // What the SOLVER is shown and the reply is verified against. The recipient's own number
    // never reaches the wire: a solver who knew it would know what to short us by.
    const quoted: PinnedAmount =
        claimFee === undefined
            ? pinned
            : { on: pinned.on, value: pinned.value + claimFee, source: pinned.source };

    // Two wallet keys: the claim secret (P, covenant sender role) and the L1 HTLC claim key.
    // Asking twice keeps them distinct; minting one here is what key provisioning forbids.
    const secrets = await provisionClaimSecret(input.wallet);
    const payoutKey = await provisionRefundKey(input.wallet);
    const paymentHash = hex.encode(secrets.paymentHash);

    const wire = await input.transport.requestQuote(
        withCanonicalAmount(
            onchainSendRequest({
                rfqId,
                paymentHash,
                payoutPubkey: payoutKey.pubkey,
                refundAddress: payoutKey.address,
                senderPubkey: secrets.pubkey,
                amount: 0,
                amountSide: toRfqAmountSide(pinned.on),
            }),
            quoted.value,
        ),
    );
    verifyPair(wire.pair, pair);
    const parsed = parseRfqQuote(wire);
    // Against the pin the solver was SHOWN (grossed when a claim fee is active).
    verifyQuotedAmount({ pair, pinned: quoted, give: parsed.give, take: parsed.take });

    if (claimFee !== undefined) {
        // What the recipient NETS. `buildHtlcClaim` applies this floor only at claim time, when
        // the only way out is a refund; here it refuses before anything moves.
        const payout = parsed.take - claimFee;
        if (payout < ONCHAIN_DUST_SATS) {
            throw new Error(
                `arkade -> onchain: the take leg of ${parsed.take} sat leaves ${payout} sat ` +
                    `after the ${claimFee} sat claim fee, under the ${ONCHAIN_DUST_SATS} sat ` +
                    "dust limit the claim is built against — refusing before anything is funded",
            );
        }
    }

    const covenant = covenantInputs(input);
    const derived = verifyingDerivation(() =>
        deriveOnchainSend({
            quote: wire,
            paymentHash,
            payoutPubkey: payoutKey.pubkey,
            ...covenant,
            l1Network,
            refundAddress: payoutKey.address,
            senderPubkey: secrets.pubkey,
        }),
    );
    verifySendWindow({
        quote: wire,
        quoteId: input.quoteId,
        now: input.now,
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "send",
        },
    });
    verifyRefundWindow({
        refundLocktime: derived.refundLocktime,
        now: input.now,
        maxSeconds: input.policy?.maxRefundWindowSeconds,
    });
    verifyQuoteTtl({
        quoteId: input.quoteId,
        expiresAt: parsed.validUntil,
        now: input.now,
        floorSeconds: input.policy?.quoteTtlFloorSeconds,
    });

    // Recipient-exact restatement (as the rail's `receiverExact`): take is what the recipient
    // nets and `fee` is spread + claim fee, so `give = take + fee` holds either way.
    const reportedTake = parsed.take - (claimFee ?? 0n);
    const reportedFee = parsed.give - parsed.take + (claimFee ?? 0n);

    return {
        quote: {
            id: input.quoteId,
            route: assembleRoute(
                { ...input.endpoints.give, instrument: { kind: "wallet" } },
                { ...input.endpoints.take, instrument: destination },
            ),
            give: { asset: input.endpoints.give.asset, amount: parsed.give },
            take: { asset: input.endpoints.take.asset, amount: reportedTake },
            lock: { hash: paymentHash },
            market: input.market,
            solver: parsed.solver,
            expiresAt: parsed.validUntil,
            // Off the derivation, not the wire: it settles which locktime this covenant used.
            refundLocktime: derived.refundLocktime,
            fee: { amount: reportedFee, asset: input.endpoints.give.asset },
        },
        preparation: {
            backend: "rfq",
            route: "arkade->onchain",
            card: input.candidate.card,
            rfqId,
            wire: parsed,
            lockup: lockupOf(derived),
            secrets,
            refundAddress: payoutKey.address,
            fundAmount: parsed.give,
            // Gross, not `reportedTake`: netting would accept an HTLC short by the fee.
            expectedAmount: parsed.take,
            payoutKey,
            payoutPkScript,
            htlc: derived.htlc,
            htlcParams: derived.htlcParams,
            l1Network: derived.l1Network,
            minConfirmations: derived.minConfirmations,
        },
    };
};
