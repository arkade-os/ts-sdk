/**
 * The RFQ backend: one addressed request per corridor route, verified before it
 * is returned and persisted by nobody.
 *
 * Three routes share one shape — provision what the covenant binds, build the
 * request, send it to the one solver the card names, verify the reply, derive
 * the covenant locally — and differ only in which fields the profile carries.
 * What is deliberately NOT here is everything v1's `request*` entrypoints do
 * after that: no contract registration, no record, no funding. `quote()` returns
 * terms; `accept()` (M4) is what makes any of it durable, and the covenant this
 * derived is handed forward on {@link RfqPreparation} so it is derived once
 * rather than twice.
 *
 * The responder check runs BEFORE the request rather than after the reply. An
 * attestation is a property of the wire, not of the answer, so it is knowable
 * up front — and the thing the check exists to prevent is disclosing an invoice
 * and an amount to a transport that cannot say who is listening.
 */
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
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
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { sealClaimPacket } from "../claimPacket";
import { l1ScriptForAddress } from "../onchainHtlc";
import type { OnchainHtlc, OnchainHtlcParams, OnchainNetwork } from "../onchainHtlc";
import {
    deriveLightningReceive,
    deriveLightningSend,
    deriveOnchainSend,
    l1NetworkFromArk,
    lightningReceiveRequest,
    lightningSendRequest,
    newRfqId,
    onchainSendRequest,
    unilateralClaimDelay,
    type LightningReceiveContractParams,
    type LightningSendContractParams,
} from "../rfq";
import type { DiscoveryLeg } from "./aliases";
import type { LightningCorridorDeps } from "./corridors/deps";
import type { CorridorSet } from "./corridors/registry";
import type { CardMarketRef, PinnedAmount, Quote, QuoteId, ResolvedEndpoint } from "./quote";
import type { MarketCandidate } from "./market";
import type { SwapPolicy } from "./policy";
import { parseRfqQuote, rfqPairFor, withCanonicalAmount, type ParsedRfqQuote } from "./rfqWire";
import { toRfqAmountSide } from "./rfqAmount";
import { assembleRoute } from "./resolve";
import type { AttestingRfqTransport } from "./transport";
import {
    verifyPair,
    verifyQuotedAmount,
    verifyQuoteTtl,
    verifyReceiveInvoiceFacts,
    verifyReceiveWindow,
    verifyResponder,
    verifySendInvoice,
    verifySendWindow,
    verifyingDerivation,
} from "./verify";

/** The covenant and the keys behind one quoted corridor swap. */
interface CommonPreparation {
    readonly backend: "rfq";
    readonly card: DiscoveredMarket;
    readonly rfqId: string;
    /** The solver's reply, decoded once. */
    readonly wire: ParsedRfqQuote;
    /** The trader's OWN derivation of the Arkade lockup. */
    readonly lockup: {
        readonly address: string;
        readonly script: InstanceType<typeof VHTLC.ScriptV2>;
        readonly pkScript: Uint8Array;
    };
}

/**
 * What `accept()` inherits from a quote.
 *
 * Held in memory by the client, keyed by quote id, and written nowhere: M3's
 * boundary is that `quote()` persists nothing. It exists so the covenant a
 * quote was verified against is the covenant that gets funded — re-deriving it
 * at accept from the stored quote would be a second derivation of the same tree,
 * and two derivations that can disagree is the failure this package guards
 * against everywhere else.
 */
export type RfqPreparation =
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
          /** The L1 claim key, provisioned by the wallet like every other key. */
          readonly payoutKey: ProvisionedKey;
          /** Where the claim PAYS — the take endpoint's own address, encoded.
           * Distinct from {@link payoutKey}, which only AUTHORISES the claim:
           * the claim's output is the spender's choice and the resolved
           * destination is the only thing that names it. */
          readonly payoutPkScript: Uint8Array;
          readonly htlc: OnchainHtlc;
          readonly htlcParams: OnchainHtlcParams;
          readonly l1Network: OnchainNetwork;
          readonly minConfirmations: number;
      });

export interface RfqQuoteInput {
    readonly quoteId: QuoteId;
    readonly route: "arkade->lightning" | "lightning->arkade" | "arkade->onchain";
    readonly candidate: MarketCandidate;
    readonly market: CardMarketRef;
    readonly legs: { readonly give: DiscoveryLeg; readonly take: DiscoveryLeg };
    readonly endpoints: { readonly give: ResolvedEndpoint; readonly take: ResolvedEndpoint };
    readonly amount?: PinnedAmount;
    readonly wallet: IWallet;
    /** Live, per section 6: a snapshot binds a covenant to a key that may have rotated. */
    readonly info: ArkadeInfo;
    /**
     * The corridor modules, unresolved.
     *
     * The set rather than two dep records, because resolution is what refuses a
     * dep overridden to nothing — and a route that never touches lightning must
     * not resolve its decoder to find that out. Each arm below asks for exactly
     * the corridors it uses.
     */
    readonly corridors: CorridorSet;
    readonly transport: AttestingRfqTransport;
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

const covenantInputs = (input: RfqQuoteInput): CovenantInputs => {
    const network = networkFromArkadeInfo(input.info);
    const arkade = input.corridors.get("arkade").deps;
    return {
        operatorPubkey: toXOnly(hex.decode(input.info.signerPubkey), "ark signer key"),
        // The per-network pin the arkade module already resolved, never a key
        // the operator reports about itself: this one ends up in a covenant leaf
        // that decides who can move the funds.
        emulatorPubkey: toXOnly(hex.decode(arkade.emulatorPubkey), "emulator signer key"),
        claimDelay: unilateralClaimDelay(Number(input.info.unilateralExitDelay)),
        hrp: network.hrp,
    };
};

/**
 * Who the claim packet is sealed to.
 *
 * The default is section 4's "internal ephemeral seal": a fresh key whose secret
 * is discarded, so the packet is opaque to everyone — the solver carries it
 * blindly and nobody can open it. That is the honest state of the corridor
 * today, since covclaimd cannot claim this covenant yet and the trader claims it
 * itself; the packet exists because the wire requires the field, not because
 * anything reads it. A deployment key is optional config, and naming one is what
 * makes the offline path real.
 *
 * This is not the key-provisioning rule's business: nothing here signs, and the
 * secret is destroyed before the function returns.
 */
const sealingKey = (deps: LightningCorridorDeps): Uint8Array => {
    const configured = deps.covclaimd?.pubkey;
    if (configured === undefined) {
        return secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    }
    const key = hex.decode(configured);
    if (key.length !== 33) {
        throw new Error(
            `the covclaimd deployment key must be 33-byte compressed hex, got ${key.length} bytes`,
        );
    }
    return key;
};

/** The amount a corridor request names, refusing the route that needs one and
 * was given none. */
const pinnedFor = (input: RfqQuoteInput): PinnedAmount => {
    if (input.amount === undefined) {
        throw new Error(`a ${input.route} quote needs an amount and the side it pins`);
    }
    return input.amount;
};

export const quoteViaRfq = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    // Before anything is disclosed: the transport must be able to say who
    // answers on it, and the key it is checked against must come from a card a
    // registry served rather than from the local cache, which authenticates
    // nothing it stores.
    verifyResponder({
        attested: input.transport.attestedResponder,
        expected: input.market.discoveryPubkey,
        pinnable: input.market.snapshot.live,
    });

    switch (input.route) {
        case "arkade->lightning":
            return quoteLightningSend(input);
        case "lightning->arkade":
            return quoteLightningReceive(input);
        case "arkade->onchain":
            return quoteOnchainSend(input);
    }
};

const quoteLightningSend = async (
    input: RfqQuoteInput,
): Promise<{ quote: Quote; preparation: RfqPreparation }> => {
    const invoice = input.endpoints.take.instrument;
    if (invoice?.kind !== "invoice" || invoice.amount === undefined) {
        // The corridor's parse refuses an amountless invoice on a send — the
        // invoice IS the amount pin there — so an instrument without one has
        // not been through it.
        throw new Error("a lightning send is quoted against the amountful invoice it pays");
    }
    const pair = rfqPairFor(input.legs.give, input.legs.take);
    const rfqId = newRfqId();

    // This leg is one we fund, so all it needs is the key that refunds it. No
    // preimage: a lightning send's P belongs to the payee. One address read
    // inside `provisionRefundKey`, so the quote's refund address and the
    // covenant's refund script cannot come from two different rotations.
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
    // The BOLT11 profile is exact-out, so the invoice IS the pin: `to_amount`
    // is the invoice verbatim and `from_amount` adds the corridor's fee.
    verifySendInvoice({ invoiced: invoice.amount, give: parsed.give, take: parsed.take });

    const covenant = covenantInputs(input);
    const derived = verifyingDerivation(() =>
        deriveLightningSend({
            quote: wire,
            paymentHash: invoice.paymentHash,
            senderPubkey: secrets.pubkey,
            refundPkScript: secrets.pkScript,
            ...covenant,
        }),
    );
    verifySendWindow({
        quote: wire,
        quoteId: input.quoteId,
        now: input.now,
        invoiceExpiresAt: invoice.expiresAt,
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
            lockup: {
                address: derived.address,
                script: derived.script,
                pkScript: derived.swapPkScript,
            },
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
    const claimPacket = await sealClaimPacket({
        preimage: secrets.preimage,
        covclaimdPubkey: sealingKey(lightning),
    });

    const wire = await input.transport.requestQuote(
        withCanonicalAmount(
            lightningReceiveRequest({
                rfqId,
                paymentHash,
                payoutAddress,
                payoutPubkey: secrets.pubkey,
                claimPacket: claimPacket.ciphertext,
                // Placeholder: the v1 builders type this field `number`, and the
                // wire adapter re-encodes it as the canonical decimal string.
                // Encoding it here as well would put the decision in two places.
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
            operatorPubkey: covenant.operatorPubkey,
            emulatorPubkey: covenant.emulatorPubkey,
            claimDelay: covenant.claimDelay,
            hrp: covenant.hrp,
        }),
    );
    // The one field the trader hands to a third party, and the only attack on
    // this corridor with no on-chain trace.
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
        // The hold invoice's window is minutes where the quote's is an hour, so
        // the deadline that binds this leg is the earlier of the two — which is
        // what `payDeadline` already is.
        expiresAt: payDeadline,
        now: input.now,
        floorSeconds: input.policy?.quoteTtlFloorSeconds,
    });

    // The give leg's instrument IS the artifact: the supply law says the quote
    // provides the non-wallet give instrument, and on this route that is the
    // solver's hold invoice.
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
            lockup: {
                address: derived.address,
                script: derived.script,
                pkScript: derived.swapPkScript,
            },
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
    // Before the request, per `l1ScriptForAddress`: a destination the claim
    // cannot pay to must be refused while nothing has been negotiated, not at
    // claim time with a funded lockup already on the table.
    const payoutPkScript = l1ScriptForAddress(destination.address, l1Network);
    const pair = rfqPairFor(input.legs.give, input.legs.take);
    const rfqId = newRfqId();

    // Two keys, both the wallet's: the claim secret carries P and the covenant's
    // sender role, and the L1 HTLC's claim leaf binds a key the wallet can sign
    // with later. Asking twice is what keeps them distinct on a wallet that
    // allocates per artifact — and minting one here instead is exactly what the
    // key-provisioning rule forbids.
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
            pinned.value,
        ),
    );
    verifyPair(wire.pair, pair);
    const parsed = parseRfqQuote(wire);
    verifyQuotedAmount({ pair, pinned, give: parsed.give, take: parsed.take });

    const covenant = covenantInputs(input);
    const derived = verifyingDerivation(() =>
        deriveOnchainSend({
            quote: wire,
            paymentHash,
            payoutPubkey: payoutKey.pubkey,
            operatorPubkey: covenant.operatorPubkey,
            emulatorPubkey: covenant.emulatorPubkey,
            claimDelay: covenant.claimDelay,
            hrp: covenant.hrp,
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
                { ...input.endpoints.take, instrument: destination },
            ),
            give: { asset: input.endpoints.give.asset, amount: parsed.give },
            take: { asset: input.endpoints.take.asset, amount: parsed.take },
            lock: { hash: paymentHash },
            market: input.market,
            solver: parsed.solver,
            expiresAt: parsed.validUntil,
            // Read off the derivation and not off the wire: the field is
            // optional there, a solver may carry it in the profile instead, and
            // the derivation is what settles which one this covenant used.
            refundLocktime: derived.refundLocktime,
            fee: { amount: parsed.give - parsed.take, asset: input.endpoints.give.asset },
        },
        preparation: {
            backend: "rfq",
            route: "arkade->onchain",
            card: input.candidate.card,
            rfqId,
            wire: parsed,
            lockup: {
                address: derived.address,
                script: derived.script,
                pkScript: derived.swapPkScript,
            },
            secrets,
            refundAddress: payoutKey.address,
            fundAmount: parsed.give,
            payoutKey,
            payoutPkScript,
            htlc: derived.htlc,
            htlcParams: derived.htlcParams,
            l1Network: derived.l1Network,
            minConfirmations: derived.minConfirmations,
        },
    };
};
