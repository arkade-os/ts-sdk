/**
 * What survives a crash, and the public shape `accept()` hands back.
 *
 * {@link SwapRecord} is the storage form (amounts as canonical atomic decimal strings); {@link Swap}
 * is the caller's answer with `bigint` amounts and the resolved `Route`.
 *
 * **The key is the quote id, on every route**, which is what makes persist-first possible (v1 keyed
 * on the funding txid, so no record could precede the money). `fundingTxid` is a later write.
 * **No `bigint` anywhere, at any depth**: SQLite and Realm `JSON.stringify` the record whole
 * (`test/client/record.types.ts` proves it structurally).
 */
import type { AssetSwapStatus } from "../store";
import type { RfqSwapState } from "../rfqSwapState";
import type { PersistableRfqSwap } from "../rfqRecord";
import { fromAtomicDecimal, toAtomicDecimal, type AtomicDecimal } from "./amount";
import type { AssetId } from "./assetId";
import type { Corridor, CorridorId } from "./corridor";
import type { Hex, Pubkey } from "./primitives";
import type { Outcome } from "./outcome";
import type { Artifact, Instrument, Route } from "./route";
import type { MarketRef, QuoteId, QuoteLeg } from "./quote";

/** Which family a record belongs to — what the drive's outcome table branches on without a read. */
export type SwapFamily = "offer" | "rfq";

/**
 * The public swap id, `offer:<QuoteId>` / `rfq:<QuoteId>`. Presentation, not a second identity:
 * storage, the drive and `accept()`'s idempotency key on the bare quote id. The prefix makes
 * `NotCancellable` a parse, with no repository read for a corridor id.
 */
export type AssetSwapId = `${SwapFamily}:${QuoteId}`;

/** The public id a record answers with — the tag, minted off its family. */
export const assetSwapIdOf = (family: SwapFamily, quoteId: QuoteId): AssetSwapId =>
    `${family}:${quoteId}`;

export const OFFER_SWAP_ID_PREFIX = "offer:" as const;
export const RFQ_SWAP_ID_PREFIX = "rfq:" as const;

/** The family an id names, or `undefined` for an untagged (`/protocol`-reader-era) id. */
export const familyOfSwapId = (swapId: string): SwapFamily | undefined =>
    swapId.startsWith(OFFER_SWAP_ID_PREFIX)
        ? "offer"
        : swapId.startsWith(RFQ_SWAP_ID_PREFIX)
          ? "rfq"
          : undefined;

/** The bare quote id under the tag; an untagged id passes through unchanged. */
export const quoteIdOfSwapId = (swapId: string): QuoteId => {
    const family = familyOfSwapId(swapId);
    return family === undefined ? swapId : swapId.slice(`${family}:`.length);
};

/** One leg's obligation, in the form a record holds it. */
export interface RecordedLeg {
    readonly asset: AssetId;
    /** Atomic units as a canonical decimal string — never a `bigint`. */
    readonly amount: AtomicDecimal;
}

/** An endpoint as the record holds it; field for field `Instrument`'s shape, so `acceptConflict`
 * compares like with like. */
export interface RecordedEndpoint {
    readonly corridor: CorridorId;
    readonly asset: AssetId;
    readonly instrument: RecordedInstrument;
}

/** {@link Instrument}, with the invoice arm's amount in decimal form. */
export type RecordedInstrument =
    | { readonly kind: "wallet" }
    | { readonly kind: "address"; readonly address: string }
    | {
          readonly kind: "invoice";
          readonly bolt11: string;
          readonly paymentHash: Hex;
          readonly amount?: AtomicDecimal;
          readonly expiresAt: number;
      };

/** {@link Artifact}, with the deposit arm's amount in decimal form. */
export type RecordedArtifact =
    | { readonly kind: "invoice"; readonly bolt11: string }
    | {
          readonly kind: "deposit";
          readonly corridor: CorridorId;
          readonly address: string;
          readonly asset: AssetId;
          readonly amount: AtomicDecimal;
          readonly expiresAt?: number;
      };

/** The half both families carry: what `AcceptConflict` compares and no chain read can give back. */
export interface SwapRecordCommon {
    /** The client-minted quote id — the primary key. */
    readonly id: QuoteId;
    readonly family: SwapFamily;
    /** Both endpoints, instruments included. Nested under `route` so field names match `Quote`'s and
     * the conflict check walks both shapes without translation. */
    readonly route: { readonly give: RecordedEndpoint; readonly take: RecordedEndpoint };
    /** The two obligations — `AcceptConflict` item 2. */
    readonly give: RecordedLeg;
    readonly take: RecordedLeg;
    /** The spread, as the quote precomputed it. */
    readonly fee: RecordedLeg;
    /** Which card priced this, from which registry, how fresh — stored WHOLE (a projection could not
     * rebuild `CardMarketRef`); `snapshot` is as read at accept, not restamped. */
    readonly market: MarketRef;
    /** The committed counterparty key from the quote's covenant role — NOT `CardMarketRef.solver`,
     * which is a display name. `AcceptConflict` compares this one. */
    readonly solver?: Pubkey;
    /** The quote's own deadline, unix seconds — what makes a stalled accept a
     * benign abandon rather than a live obligation. */
    readonly expiresAt: number;
    /** The one thing a counterparty must see, when the route has one. Durable because a duplicate
     * accept after a restart must return the SAME invoice, and the quote object is gone by then. */
    readonly artifact?: RecordedArtifact;
    /** The funding transaction, once known. A later best-effort write; set-where-absent is a benign
     * resume, never an `AcceptConflict`. */
    readonly fundingTxid?: string;
    /** Last retryable receive-claim error; becomes the terminal failure if the claim window closes. */
    readonly claimFailure?: string;
    /** Terminal failure reason. */
    readonly failure?: string;
    /** Refusal reason while `state` is `needs_counterparty`. */
    readonly blockedReason?: string;
    /** Unix **seconds**, both — the unit `RfqSwapRecord` carries and
     * `shouldRetainRfqSwap` compares against, not `AssetSwap`'s milliseconds. */
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** `arkade <-> arkade`: the offer covenant. `offerHex` is the whole covenant, so no tree params. */
export interface OfferSwapRecord extends SwapRecordCommon {
    readonly family: "offer";
    /** v1's raw status vocabulary, read verbatim by the drive's `RawState`. */
    readonly status: AssetSwapStatus;
    /** The TLV offer, hex. The only input `cancelOffer` needs. */
    readonly offerHex: string;
    readonly swapAddress: string;
    /** The covenant's scriptPubKey, hex — the indexer's monitoring key and the reconcile's match key. */
    readonly swapPkScript: string;
    /** Sats riding an asset deposit, decimal: the solver's published carrier, which the fill is
     * priced against. Absent for a BTC deposit and for feed-priced swaps (the SDK default). */
    readonly carrierSats?: string;
    readonly spentTxid?: string;
    readonly completedAt?: number;
}

/**
 * The three corridor routes: a VHTLC lockup, its clocks and its secrets.
 *
 * **No covenant tree here.** `accept()` registers a contract row before the lockup can be funded,
 * keyed by the script its params derive (`createContract` refuses params that don't reproduce it);
 * storing the tree again would be two sources for one covenant.
 */
export interface CorridorSwapRecord extends SwapRecordCommon {
    readonly family: "rfq";
    /** v1's raw state vocabulary, read verbatim by the drive's `RawState`. */
    readonly state: RfqSwapState;
    /** The route pair in the manager's vocabulary (`lightning_send`/`lightning_receive` are one
     * corridor from opposite ends); resolves the handler that owns {@link profile}. */
    readonly kind: PersistableRfqSwap["kind"];
    /** The solver's own id for the negotiation, echoed back on the wire. */
    readonly rfqId: string;
    /** The Arkade address that was funded, and the swap's handle on its
     * covenant row. */
    readonly lockupAddress: string;
    /** Its pkScript, hex — the row's key and the reconcile's match key. */
    readonly lockupPkScript: string;
    /** The hash both covenants commit to. `sha256(P)`, hex. */
    readonly lock: { readonly hash: Hex };
    /** When the trader's value comes back if the swap does not complete. */
    readonly refundLocktime: number;
    /**
     * The corridor's own half, as plain JSON (written by `rfqSecretsProfile`, read by
     * `rfqCorridorHandlers.hydrate`), so a new corridor ships without touching this file. Its
     * `expectedAmount` is a `number`; the decimal-string rule covers only this record's own fields.
     *
     * **The swap's secrets live here** (`profile.signer`, and `profile.hashlock` on a preimage-locked
     * leg), deliberately not duplicated at top level.
     */
    readonly profile: Record<string, unknown>;
    readonly refundTxid?: string;
    readonly lockupSpendTxids?: readonly string[];
    /**
     * `P`, hex — the preimage the solver revealed to settle a Lightning send. Not a copy of our claim
     * secret (the payee mints `P` on that leg), and already public: read from the spending witness.
     */
    readonly settlementPreimageHex?: string;
}

/** Everything `accept()` persists, both families in one key space. */
export type SwapRecord = OfferSwapRecord | CorridorSwapRecord;

/**
 * A swap, as a caller reads it: the quote's terms plus what has happened to them. `artifact` stays
 * optional because `ReceiveRequest` is `Swap & { artifact: Artifact }`; the reason strings live here
 * because `SwapUpdate.detail` is only the `RawState` word.
 */
export interface Swap {
    readonly id: AssetSwapId;
    readonly family: SwapFamily;
    /** Where this swap stands, in the one vocabulary both families share. */
    readonly outcome: Outcome;
    /** Both endpoints resolved, instruments included. */
    readonly route: Route;
    /** What the trader gives, fee included. */
    readonly give: QuoteLeg;
    /** What the trader takes. */
    readonly take: QuoteLeg;
    /** The spread, denominated on the leg where it is exact. */
    readonly fee: QuoteLeg;
    readonly market: MarketRef;
    readonly solver?: Pubkey;
    /** Corridor routes: the hash both covenants commit to. */
    readonly lock?: { readonly hash: Hex };
    /** Corridor routes: when the trader's value comes back. */
    readonly refundLocktime?: number;
    readonly artifact?: Artifact;
    readonly expiresAt: number;
    /** Absent until the funding is broadcast and its txid written. */
    readonly fundingTxid?: string;
    /** Why the swap `failed`, when it did — only the record knows why. */
    readonly failure?: string;
    /** Why this wallet will not act, while `needs_recovery`. Under `drive: "manual"`/`"readonly"` the
     * configuration refusals are not translated to `needs_recovery`, and this still carries them. */
    readonly blockedReason?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
}

// ── §D's codec, at the record boundary and nowhere else ──

/** An endpoint into its stored form. */
export const recordEndpoint = (endpoint: {
    corridor: CorridorId;
    asset: string;
    instrument: Instrument;
}): RecordedEndpoint => ({
    corridor: endpoint.corridor,
    asset: endpoint.asset as AssetId,
    instrument: recordInstrument(endpoint.instrument),
});

/** An instrument into its stored form: only the invoice arm's amount moves. */
export const recordInstrument = (instrument: Instrument): RecordedInstrument => {
    switch (instrument.kind) {
        case "wallet":
            return { kind: "wallet" };
        case "address":
            return { kind: "address", address: instrument.address };
        case "invoice":
            return {
                kind: "invoice",
                bolt11: instrument.bolt11,
                paymentHash: instrument.paymentHash,
                ...(instrument.amount === undefined
                    ? {}
                    : { amount: toAtomicDecimal(instrument.amount) }),
                expiresAt: instrument.expiresAt,
            };
    }
};

/** A stored instrument back into the live union. */
export const instrumentOf = (instrument: RecordedInstrument): Instrument => {
    switch (instrument.kind) {
        case "wallet":
            return { kind: "wallet" };
        case "address":
            return { kind: "address", address: instrument.address };
        case "invoice":
            return {
                kind: "invoice",
                bolt11: instrument.bolt11,
                paymentHash: instrument.paymentHash,
                ...(instrument.amount === undefined
                    ? {}
                    : { amount: fromAtomicDecimal(instrument.amount) }),
                expiresAt: instrument.expiresAt,
            };
    }
};

/** An artifact into its stored form. */
export const recordArtifact = (artifact: Artifact): RecordedArtifact =>
    artifact.kind === "invoice"
        ? { kind: "invoice", bolt11: artifact.bolt11 }
        : {
              kind: "deposit",
              corridor: artifact.corridor,
              address: artifact.address,
              asset: artifact.asset as AssetId,
              amount: toAtomicDecimal(artifact.amount),
              ...(artifact.expiresAt === undefined ? {} : { expiresAt: artifact.expiresAt }),
          };

/** A stored artifact back into the live union. */
export const artifactOf = (artifact: RecordedArtifact): Artifact =>
    artifact.kind === "invoice"
        ? { kind: "invoice", bolt11: artifact.bolt11 }
        : ({
              kind: "deposit",
              corridor: artifact.corridor as Corridor,
              address: artifact.address,
              asset: artifact.asset,
              amount: fromAtomicDecimal(artifact.amount),
              ...(artifact.expiresAt === undefined ? {} : { expiresAt: artifact.expiresAt }),
          } as Artifact);

/** A leg into its stored form. */
export const recordLeg = (leg: QuoteLeg): RecordedLeg => ({
    asset: leg.asset,
    amount: toAtomicDecimal(leg.amount),
});

/** A stored leg back into `bigint` units. */
export const legOf = (leg: RecordedLeg): QuoteLeg => ({
    asset: leg.asset,
    amount: fromAtomicDecimal(leg.amount),
});

/**
 * The public {@link Swap} a stored record answers with — the one read path, so a duplicate
 * `accept()` answers from the record, not the evictable preparation cache. `outcome` is a parameter
 * because only the drive knows whether it holds live state. The `Route` cast is safe because
 * `accept()` only writes records from a `Quote` whose route was already resolved.
 */
export const swapOf = (record: SwapRecord, outcome: Outcome): Swap => ({
    id: assetSwapIdOf(record.family, record.id),
    family: record.family,
    outcome,
    route: {
        give: {
            corridor: record.route.give.corridor,
            asset: record.route.give.asset,
            instrument: instrumentOf(record.route.give.instrument),
        },
        take: {
            corridor: record.route.take.corridor,
            asset: record.route.take.asset,
            instrument: instrumentOf(record.route.take.instrument),
        },
    } as Route,
    give: legOf(record.give),
    take: legOf(record.take),
    fee: legOf(record.fee),
    market: record.market,
    ...(record.solver === undefined ? {} : { solver: record.solver }),
    ...(record.family === "rfq"
        ? { lock: record.lock, refundLocktime: record.refundLocktime }
        : {}),
    ...(record.artifact === undefined ? {} : { artifact: artifactOf(record.artifact) }),
    expiresAt: record.expiresAt,
    ...(record.fundingTxid === undefined ? {} : { fundingTxid: record.fundingTxid }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.blockedReason === undefined ? {} : { blockedReason: record.blockedReason }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
});

/**
 * Whether the give leg is funded from the wallet (gates `accept()`'s balance check and send). The
 * **instrument**, not the asset: a `lightning -> arkade` receive gives BTC via a hold invoice a third
 * party pays, and an asset test would refuse the canonical empty-wallet receive.
 */
export const fundsFromWallet = (route: {
    give: { instrument: Instrument | RecordedInstrument };
}): boolean => route.give.instrument.kind === "wallet";
