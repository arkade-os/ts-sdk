/**
 * What survives a crash, and the public shape `accept()` hands back.
 *
 * Two types, one key. {@link SwapRecord} is the storage form — JSON-safe by
 * declaration, every amount a canonical decimal string — and {@link Swap} is the
 * answer a caller reads, with `bigint` amounts and the resolved `Route`. The
 * conversion between them is §D's record-boundary codec, and it is not a third
 * law: `toAtomicDecimal`/`fromAtomicDecimal` already ship in `./amount`, minted
 * by M1 and used by M3's wire adapter, so both sites emit the same canonical
 * form — atomic units, unsigned, no leading zeros, never a scaled display
 * decimal.
 *
 * **The key is the quote id, on every route.** That is what makes persist-first
 * representable at all: v1's `AssetSwap.id` *is* the funding txid
 * (`store.ts:70-71`), so a record could not exist before the money did, and
 * `coverage.ts` carries a process-local issuance mark precisely to paper over
 * the gap. Here the record precedes the funding and `fundingTxid` is a later,
 * best-effort write.
 *
 * **JSON-safe means no `bigint` anywhere, at any depth.** The SQLite and Realm
 * backends `JSON.stringify` the record whole, so a `bigint` throws on two
 * backends and round-trips on the third — the asymmetry
 * `test/repository.test.ts` refuses to paper over. Every amount here is an
 * {@link AtomicDecimal}; `test/client/record.types.ts` proves the absence
 * structurally rather than by review.
 */
import type { AssetSwapStatus } from "../store";
import type { RfqSwapState } from "../rfqSwapState";
import type { PersistableRfqSwap } from "../rfqRecord";
import { fromAtomicDecimal, toAtomicDecimal, type AtomicDecimal } from "./amount";
import type { AssetId } from "./assetId";
import type { Corridor, CorridorId } from "./corridor";
import type { Hex, Pubkey } from "./primitives";
import type { Artifact, Instrument, Route } from "./route";
import type { MarketRef, QuoteId, QuoteLeg } from "./quote";

/**
 * Which family a record belongs to, and the discriminant M5's `RawState` keys
 * on.
 *
 * Not a cosmetic tag. v1's two families occupied one `string` id space by
 * accident — an offer record's id a funding txid, a corridor record's an
 * `rfqId` — and keying both on `QuoteId` closes that collision (§B). The tag is
 * what lets M6 build `offer:<quoteId>` / `rfq:<quoteId>` without a repository
 * read, and what lets M5 branch its outcome table without one either.
 */
export type SwapFamily = "offer" | "rfq";

/** One leg's obligation, in the form a record holds it. */
export interface RecordedLeg {
    readonly asset: AssetId;
    /** Atomic units as a canonical decimal string — never a `bigint`. */
    readonly amount: AtomicDecimal;
}

/**
 * An endpoint as the record holds it: the corridor, the asset, the instrument.
 *
 * `Instrument`'s invoice arm carries a `bigint` amount, so it cannot be stored
 * as declared — {@link RecordedInstrument} is the same union with that one field
 * in decimal form. The rest is field for field identical, which is what keeps the
 * comparison in `acceptConflict` honest.
 */
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

/**
 * The half both families carry.
 *
 * Every field is either something `AcceptConflict` compares (§3.2's list), or
 * something M5 named as a cross-milestone ask, or the two timestamps. Nothing
 * is here for display: a record carries what no covenant and no chain read can
 * give back, which is the same rule `RfqSwapRecord` is arranged by.
 */
export interface SwapRecordCommon {
    /** The client-minted quote id — the primary key, per C1 and §B. */
    readonly id: QuoteId;
    readonly family: SwapFamily;
    /**
     * Both endpoints, instruments included — `AcceptConflict` items 1 and 3.
     *
     * Nested under `route` so the record's field names are `Quote`'s field
     * names: the conflict check walks the two shapes together, and a record
     * that spelled the same fact differently would make every comparison a
     * translation.
     */
    readonly route: { readonly give: RecordedEndpoint; readonly take: RecordedEndpoint };
    /** The two obligations — `AcceptConflict` item 2. */
    readonly give: RecordedLeg;
    readonly take: RecordedLeg;
    /** The spread, as the quote precomputed it. */
    readonly fee: RecordedLeg;
    /**
     * Which card priced this, from which registry, how fresh — stored WHOLE.
     *
     * A trimmed projection could not rebuild the type {@link Swap.market}
     * promises: `CardMarketRef` requires `kind`, `pair` and `snapshot` beside
     * the fields a summary would keep. Every member is a string, number or
     * boolean, so the union round-trips through JSON untouched, and `snapshot`
     * is restated as read at accept rather than restamped — a past `fetchedAt`
     * beside the recorded `live` is the honest answer about how fresh the card
     * was when this swap was accepted.
     */
    readonly market: MarketRef;
    /**
     * The committed counterparty, from the quote's covenant role.
     *
     * NOT `CardMarketRef.solver`, which is the card's display name. Two
     * different facts that v1 spelled with one word: this one is a key that
     * ends up in a covenant leaf, the other is a label. `AcceptConflict`
     * compares this one.
     */
    readonly solver?: Pubkey;
    /** The quote's own deadline, unix seconds — what makes a stalled accept a
     * benign abandon rather than a live obligation. */
    readonly expiresAt: number;
    /**
     * The one thing a counterparty must see, when this route has one.
     *
     * Durable because a duplicate accept must return the SAME invoice, and the
     * invoice lives on the quote object — nowhere in the corridor profile. A
     * caller that re-accepts after a restart has no quote object left, so
     * without this field the only honest answer would be a second invoice,
     * which §3.2 forbids by name.
     */
    readonly artifact?: RecordedArtifact;
    /**
     * The transaction that funded this swap, once known.
     *
     * A later, best-effort write, and the field that separates M5's `accepted`
     * from `funding`. Set-where-absent is a benign resume and never an
     * `AcceptConflict` — §3.2 says so by name.
     */
    readonly fundingTxid?: string;
    /** M5's ask: the durable claim-error strings its outcome table reads, so a
     * restarted client ends a broken claim `failed` with a reason instead of
     * `lapsed` with none. v1 persists both; dropping them in the rewrite is the
     * regression §B's "floor, not ceiling" wording exists to catch. */
    readonly failure?: string;
    readonly blockedReason?: string;
    /** Unix **seconds**, both — the unit `RfqSwapRecord` carries and
     * `shouldRetainRfqSwap` compares against, not `AssetSwap`'s milliseconds. */
    readonly createdAt: number;
    readonly updatedAt: number;
}

/**
 * `arkade <-> arkade`: the offer covenant, and what cancels it.
 *
 * `offerHex` is the whole covenant — `cancelOffer` needs nothing else to
 * rebuild it — so this arm stores no tree parameters of its own.
 */
export interface OfferSwapRecord extends SwapRecordCommon {
    readonly family: "offer";
    /** v1's raw status vocabulary, which M5's `RawState` reads verbatim. */
    readonly status: AssetSwapStatus;
    /** The TLV offer, hex. The only input `cancelOffer` needs. */
    readonly offerHex: string;
    readonly swapAddress: string;
    /** The covenant's scriptPubKey, hex — the indexer's monitoring key, and
     * what §F's reconcile matches a discovered deposit against. */
    readonly swapPkScript: string;
    readonly spentTxid?: string;
    readonly completedAt?: number;
}

/**
 * The three corridor routes: a VHTLC lockup, its clocks and its secrets.
 *
 * **No covenant tree here.** Every lockup registers a contract row before its
 * address can be funded, and that row already holds the parameters, keyed by
 * the script they derive — a key `createContract` refuses to write unless the
 * params reproduce it. Storing the tree a second time would be two sources for
 * one covenant. `accept()` is what writes that row (see `./accept.ts`), which
 * is why a persisted record always has one.
 */
export interface CorridorSwapRecord extends SwapRecordCommon {
    readonly family: "rfq";
    /** v1's raw state vocabulary, read verbatim by M5's `RawState`. */
    readonly state: RfqSwapState;
    /**
     * Which corridor, in the manager's own vocabulary.
     *
     * `PersistableRfqSwap["kind"]` rather than a `Corridor`: it is a route pair
     * — `lightning_send` and `lightning_receive` are one corridor from opposite
     * ends — and it is what resolves the handler that owns {@link profile}.
     */
    readonly kind: PersistableRfqSwap["kind"];
    /** The solver's own id for the negotiation, echoed back on the wire. */
    readonly rfqId: string;
    /** The Arkade address that was funded, and the swap's handle on its
     * covenant row. */
    readonly lockupAddress: string;
    /** Its pkScript, hex — the row's key, and §F's matching key. */
    readonly lockupPkScript: string;
    /** The hash both covenants commit to. `sha256(P)`, hex. */
    readonly lock: { readonly hash: Hex };
    /** When the trader's value comes back if the swap does not complete. */
    readonly refundLocktime: number;
    /**
     * The corridor's own half, as plain JSON.
     *
     * v1's opaque bag (`rfqRecord.ts:108-123`), written with `rfqSecretsProfile`
     * and read by `rfqCorridorHandlers.hydrate` — reused rather than
     * reinvented, so M5 rebuilds through machinery that already exists and a new
     * corridor still ships without touching this file. It is also what carries
     * `expectedAmount`, the claim value gate's request-time input.
     *
     * Amounts inside it follow v1's shapes (`expectedAmount` is a `number`),
     * which is JSON-safe and therefore fine: the decimal-string law governs
     * this record's OWN amount fields, not the bag it carries forward.
     *
     * **This is also where the swap's secrets live** — `profile.signer` and,
     * on a leg locked to a preimage, `profile.hashlock`. Deliberately not a
     * second copy at the record's top level: `rfqClaimSecretOf` and
     * `preimageForSwapRecord` already read them from here, and two homes for
     * one claim secret is two things to keep in step with one of them always
     * empty. At most one of `preimageHex`/`preimageSaltHex` is ever written,
     * and which arm exists is decided by the wallet's provisioning result, not
     * here.
     */
    readonly profile: Record<string, unknown>;
    readonly refundTxid?: string;
    readonly lockupSpendTxids?: readonly string[];
}

/** Everything `accept()` persists, both families in one key space. */
export type SwapRecord = OfferSwapRecord | CorridorSwapRecord;

/**
 * A swap, as a caller reads it.
 *
 * The quote's terms plus what has happened to them. `bigint` amounts and the
 * resolved `Route`, because this is the public answer and the record is the
 * storage form — §D's codec is the boundary between the two.
 *
 * `artifact` stays optional: M7's `ReceiveRequest` is `Swap & { artifact:
 * Artifact }`, and an intersection cannot narrow a field that is already
 * required. `id` is the bare {@link QuoteId} — M6 owns the tagged public form
 * and takes this key as given. No `outcome`: that is M5's, and declaring an
 * inert one here would occupy the name.
 */
export interface Swap {
    readonly id: QuoteId;
    readonly family: SwapFamily;
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
 * The public {@link Swap} a stored record answers with.
 *
 * The one read path, so a duplicate `accept()` answers from the record rather
 * than from the in-memory preparation cache — which is bounded, evicted in
 * insertion order, and therefore not a durable answer to anything.
 *
 * The `Route` is reassembled from the two stored endpoints. The cast is the
 * seam: `Route` is a closed union of four corridor pairs and a record read off
 * disk carries two independently-typed endpoints, so nothing in the type system
 * can re-correlate them. What guarantees the pairing is that `accept()` only
 * ever writes a record from a `Quote` whose route was already resolved through
 * that union.
 */
export const swapOf = (record: SwapRecord): Swap => ({
    id: record.id,
    family: record.family,
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
    ...(record.family === "rfq" ? { lock: record.lock } : {}),
    ...(record.family === "rfq" ? { refundLocktime: record.refundLocktime } : {}),
    ...(record.artifact === undefined ? {} : { artifact: artifactOf(record.artifact) }),
    expiresAt: record.expiresAt,
    ...(record.fundingTxid === undefined ? {} : { fundingTxid: record.fundingTxid }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
});

/**
 * Whether this swap's give leg is funded from the wallet.
 *
 * The discriminant for every funding-route decision in `accept()` — the balance
 * pre-flight, the `wallet.send`, the funding-txid write. It is the
 * **instrument** and not the asset: a `lightning -> arkade` receive gives BTC
 * too, but the give instrument is the hold invoice a third party pays, so an
 * asset-branched test would send every receive down the wallet-balance path and
 * refuse the canonical empty-wallet receive.
 */
export const fundsFromWallet = (route: {
    give: { instrument: Instrument | RecordedInstrument };
}): boolean => route.give.instrument.kind === "wallet";
