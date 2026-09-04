/**
 * RFQ v1 — the user side of quoted swaps.
 *
 * RFQ is the negotiation layer only. After the quote, **filling is
 * non-interactive** for every corridor this module serves: the user funds,
 * and the solver fills by observing that funding rather than by being told.
 * (Roles are *user* and *solver* throughout — see the README's Roles section
 * for why this package does not name the participants maker and taker.)
 *
 * - `arkade:BTC -> lightning:BTC` / `arkade:BTC -> onchain:BTC` (send) — the
 *   user funds its own locally derived VHTLC contract ({@link
 *   lightningSendVtxoScript}) and the onchain leg claims its L1 HTLC with `P`;
 *   the solver fills by observing the funding on-chain. A failed swap refunds
 *   to the user's address — by the user's own `sender` key on every
 *   interactive path, or, if the user's own key is ever lost, by the server
 *   and solver together via the `nonInteractiveRefund` leaf (no user
 *   signature, no timelock), which the emulator co-signs under a covenant
 *   provably paying only the user's pre-committed address.
 * - `lightning:BTC -> arkade:BTC` / `onchain:BTC -> arkade:BTC` (receive) —
 *   the user generates `P`, pays the solver's hold invoice or funds the L1
 *   HTLC, and may go offline; the solver funds the Arkade lockup pinned to
 *   the user's payout ({@link receiveVtxoScript}, roles inverted), and the
 *   claim — the user's own collaborative spend, or covclaimd's — reveals
 *   `P` publicly, which is what settles the user's side.
 * - `arkade:BTC|asset -> arkade:BTC|asset` — the user accepts the quote by
 *   creating and funding an Intents **offer** (`createOffer`) bound to the
 *   quoted terms; the offer covenant lets any filler deliver, so the solver
 *   fills without further interaction, or the user cancels cooperatively.
 *
 * There is deliberately NO accept message anywhere: acceptance is funding.
 * Every corridor then ends the same way — a fill, or the value back: a
 * timelocked refund on the HTLC corridors, a cooperative cancel on the
 * Arkade-only one.
 *
 * Trust model, identical to the offer side: from a quote the user uses only
 * the binding fields — `solver_pubkey`, `refund_locktime`, `valid_until`, the
 * amounts. Every other contract parameter is the user's own data (its
 * invoice, its Ark server connection, its refund address) or a trusted
 * constant — the emulator key defaults to the SDK's per-network pin (see
 * `resolveEmulatorPubkey`). Anything address-shaped the solver sends is
 * compare-only: a mismatch means refuse-to-fund, never "use theirs".
 *
 * Transport is symmetric-outbound: the reference framing below speaks the dev
 * broker (`{op:"sub"|"event"}` over WebSocket) or plain HTTP; the production
 * target is Nostr (directed kind + NIP-44), which changes only the transport
 * functions here, nothing above them.
 */
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import {
    ArkAddress,
    RestArkProvider,
    VHTLC,
    asset,
    getNetwork,
    resolveEmulatorPubkey,
    toXOnly,
    type IWallet,
    type NetworkName,
} from "@arkade-os/sdk";

import {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    ONCHAIN_SECONDS_PER_BLOCK,
    onchainHtlcScript,
    paymentHashOf,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainNetwork,
} from "./onchainHtlc";

export {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
} from "./onchainHtlc";

import {
    provisionClaimSecret,
    provisionRefundKey,
    type ProvisionedClaimSecret,
    type ProvisionedKey,
} from "@arkade-os/sdk";
import { sealClaimPacket } from "./claimPacket";
import { registerLockupContract } from "./lockupContract";

/** Decode a solver-supplied hex field, turning a malformed value (odd length,
 * non-hex chars) into a solver-blaming diagnostic instead of a bare
 * `@scure/base` internal error. */
const solverHex = (value: string, field: string): Uint8Array => {
    try {
        return hex.decode(value);
    } catch {
        throw new Error(`solver sent malformed hex for ${field}`);
    }
};

// ── Pairs ────────────────────────────────────────────────────────────────────

/** Legs are `<corridor>:<asset>`; a pair is directional, `from->to`. */
export const ARKADE_BTC = "arkade:BTC";
export const LIGHTNING_BTC = "lightning:BTC";

export const ONCHAIN_BTC = "onchain:BTC";

/** The arkade leg for an asset: the asset id itself, 68 lowercase hex. The id
 * lives in the pair rather than the profile because the pair is the field both
 * sides route and subscribe on, and a coarse leg cannot say which asset a
 * market key is for.
 *
 * Taking an `AssetId` rather than a string is what enforces the case rule:
 * `hex.decode` accepts uppercase while `hex.encode` only emits lowercase, so a
 * value that reached us as `A1B2…` leaves here as `a1b2…`. Solvers compare pair
 * strings byte for byte — a sender that normalised only in its key derivation
 * would reach the right subscription and then be skipped as an unserved pair. */
export const arkadeAssetLeg = (id: asset.AssetId): string => `arkade:${id.toString()}`;

/** @deprecated The coarse asset leg. No solver serves it: `ASSET` is neither a
 * registered ticker nor a 68-hex asset id, so a solver's market-key derivation
 * throws on it. Use {@link arkadeAssetLeg}. Removed next major. */
export const ARKADE_ASSET = "arkade:ASSET";

export const rfqPair = (from: string, to: string): string => `${from}->${to}`;

/** The implemented pair: pay a BOLT11 invoice out of an Arkade balance. */
export const LIGHTNING_SEND_PAIR = rfqPair(ARKADE_BTC, LIGHTNING_BTC);
/** On-board via Lightning: pay the solver's hold invoice, land on Arkade. */
export const LIGHTNING_RECEIVE_PAIR = rfqPair(LIGHTNING_BTC, ARKADE_BTC);
/** Off-board: Arkade sats out to a Bitcoin-L1 HTLC. */
export const ONCHAIN_SEND_PAIR = rfqPair(ARKADE_BTC, ONCHAIN_BTC);
/** On-board: a Bitcoin-L1 HTLC in, Arkade sats out. */
export const ONCHAIN_RECEIVE_PAIR = rfqPair(ONCHAIN_BTC, ARKADE_BTC);

// ── Errors and closed sets ───────────────────────────────────────────────────

/** The closed refusal set. Treat any unknown reason as a generic decline. */
export type RfqRefusalReason =
    | "unsupported_pair"
    | "unsupported_payload"
    | "amount_out_of_range"
    | "exposure_cap"
    | "invoice_expired"
    | "quote_conflict"
    | "pricing_unavailable"
    | "rate_limited";

/** Lifecycle vocabulary; states after which nothing more will happen. */
export const RFQ_TERMINAL_STATES = ["settled", "refused", "expired", "refunded", "stuck"] as const;

/** A refusal from the solver, carrying its closed-set reason. */
export class SwapRefusal extends Error {
    readonly reason: string;
    readonly rfqId: string | undefined;
    constructor(reason: string, rfqId?: string) {
        super(`solver refused: ${reason}`);
        this.name = "SwapRefusal";
        this.reason = reason;
        this.rfqId = rfqId;
    }
}

/**
 * The solver's address does not match the local derivation. NEVER fund past
 * this. `derived` is every candidate address tried — more than one when the
 * derivation itself is ambiguous, see {@link verifyLockupAddress}.
 */
export class AddressMismatch extends Error {
    readonly derived: string | string[];
    readonly quoted: string | undefined;
    constructor(derived: string | string[], quoted?: string) {
        super("solver lockup address does not match local derivation — refusing to fund");
        this.name = "AddressMismatch";
        this.derived = derived;
        this.quoted = quoted;
    }
}

// ── Messages ─────────────────────────────────────────────────────────────────

/** A fresh client-chosen negotiation id: 32 random bytes, lowercase hex. */
export const newRfqId = (): string => hex.encode(crypto.getRandomValues(new Uint8Array(32)));

export interface RfqQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    from_amount: number;
    to_amount: number;
    solver_pubkey: string;
    valid_until: number;
    /** HTLC-class quotes only; absent for arkade↔arkade. */
    refund_locktime?: number;
    profile: { [key: string]: unknown; payment_hash?: string; lockup_address?: string };
    [key: string]: unknown;
}

export interface RfqStatus {
    v: 1;
    type: "rfq_status";
    rfq_id: string;
    state: string;
    updated_at: number;
    profile: Record<string, unknown>;
    [key: string]: unknown;
}

/** The rfq_request for the lightning send profile. A BOLT11 profile is always
 * exact-out: the invoice fixes the amount, so none is restated here.
 * `senderPubkey` is the trader's own key for the VHTLC's sender-side leaves
 * (see {@link lightningSendVtxoScript}) — required, never sent anywhere else,
 * never trusted by the solver as anything but a pubkey to bind into the
 * script. On the wire it's `client_refund_pubkey` (the payload schemas are
 * public at https://docs.arkadeos.com/intents/reference/rfq — the solver's schema
 * is `.strict()`, so both the wrong name AND the missing required field would
 * refuse every request). */
export const lightningSendRequest = (input: {
    rfqId: string;
    invoice: string;
    refundAddress: string;
    senderPubkey: Uint8Array;
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: LIGHTNING_SEND_PAIR,
    amount_side: "to",
    profile: {
        invoice: input.invoice,
        refund_address: input.refundAddress,
        client_refund_pubkey: hex.encode(input.senderPubkey),
    },
});

/** The rfq_request for an arkade↔arkade swap. Exactly one side may name an
 * asset id per direction (BTC has none), and the id is the leg itself — see
 * {@link arkadeAssetLeg}. Forward-looking: the wire shape is specified, the
 * reference solver does not serve it yet. */
export const arkadeSwapRequest = (input: {
    rfqId: string;
    /** Asset the trader deposits; omit when depositing BTC. */
    offerAsset?: asset.AssetId;
    /** Asset the trader wants; omit when wanting BTC. */
    wantAsset?: asset.AssetId;
    amountSide: "from" | "to";
    /** Integer base units of the side named by `amountSide`. */
    amount: number;
}): Record<string, unknown> => {
    // Both refusals say "exactly one", but the causes differ and so do the
    // remedies: neither side named is a degenerate request, both sides named is
    // a real corridor still waiting on a counterparty.
    if (!input.wantAsset && !input.offerAsset) {
        throw new Error(
            "set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC) — " +
                "with neither set both legs are BTC, which is not a swap",
        );
    }
    if (input.wantAsset && input.offerAsset) {
        throw new Error(
            "set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC) — " +
                "asset->asset is nameable on the wire but no solver quotes it yet",
        );
    }
    const pair = rfqPair(
        input.offerAsset ? arkadeAssetLeg(input.offerAsset) : ARKADE_BTC,
        input.wantAsset ? arkadeAssetLeg(input.wantAsset) : ARKADE_BTC,
    );
    assertPairLength(pair);
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair,
        amount_side: input.amountSide,
        amount: input.amount,
        // The pair is the only place the asset ids appear. Repeating them here
        // would be a key the solver's `.strict()` profile schema does not
        // declare, and an undeclared key is `unsupported_payload` — a refusal,
        // not an ignored extra. Empty, not absent: `profile` is required on
        // every other request shape this wire carries.
        profile: {},
    };
};

// ── Guardrails ───────────────────────────────────────────────────────────────

/** Funding gate: refuse unless ≥90 min remain before the refund path opens.
 * 90 because the refund CLTV matures against median-time-past (BIP-113),
 * which lags wall clock by ~1h — a smaller wall-clock margin is no margin. */
export const MIN_HEADROOM_SECONDS = 90 * 60;

/** A gate refusal carrying a stable `reason` for callers to switch on. */
const gateError = (reason: string, message: string): Error & { reason: string } => {
    const error = new Error(message) as Error & { reason: string };
    error.reason = reason;
    return error;
};

/**
 * Refuse a number no gate can compare against.
 *
 * Every threshold on these corridors is a `<`, `>=`, or `-` over a number
 * that arrived from the solver, from a caller-injected decoder, or from a
 * caller's own configuration. `NaN` is the dangerous one: it fails EVERY
 * comparison, so an unchecked `NaN` does not fail its gate — it deletes it,
 * silently, and the flow proceeds as if the check had passed. The wire is
 * JSON, where a field typed `number` here can arrive as a string and turn the
 * first arithmetic on it into `NaN`, so the static type is not the guarantee
 * it looks like.
 *
 * The infinities happen to fail closed at each site today, and are refused
 * anyway: no clock or sats amount produces one, so it means the number's
 * source is broken, and saying that beats depending on which side of a
 * comparison it landed on.
 *
 * `undefined` passes: optional means optional, and every caller of this
 * checks for absence separately where absence is itself a refusal.
 */
const assertFinite = (value: number | undefined, reason: string, label: string): void => {
    if (value !== undefined && !Number.isFinite(value)) {
        throw gateError(reason, `${label} is not a finite number (${String(value)})`);
    }
};

/** The wire's cap on a pair string, mirrored so an over-long pair fails here
 * with a reason instead of arriving as a bare `unsupported_payload`.
 *
 * 158 = ("lightning".length + 1 + 68) * 2 + "->".length — the longest corridor
 * name, a full 68-hex asset id on each leg, and the arrow. The longest pair
 * anyone can build is `arkade:<68>->arkade:<68>`, at 152 — and until the
 * exactly-one-asset guard in {@link arkadeSwapRequest} relaxes, this package
 * tops out at 87, so the guard is dormant on purpose.
 *
 * Restated rather than re-derived from this package's own corridor names: a
 * local cap BELOW the solver's would refuse a pair the solver would have
 * served, which is worse than the remote refusal this exists to pre-empt. The
 * test pins the number so a drift is a failure, not a surprise.
 *
 * Module-level, not in `index.ts`: it mirrors a number this repo does not own,
 * and publishing it would turn a remote edit into a semver event here. */
export const MAX_PAIR_LENGTH = 158;

/** Exported for the tests — a dormant guard still needs one, and no public
 * entry point can reach it. Not in `index.ts`. */
export const assertPairLength = (pair: string): void => {
    if (pair.length > MAX_PAIR_LENGTH) {
        throw new Error(
            `pair is ${pair.length} characters, over the wire's ${MAX_PAIR_LENGTH}-character limit`,
        );
    }
};

/**
 * Compare-only check of the solver's address against YOUR OWN derivation(s)
 * — never extends trust, only narrows it.
 *
 * `derivedAddress` may be a single address or an array of candidates. Pass an
 * array when your own derivation is ambiguous — as it is for the covenant
 * lockups while solvers roll out the timelocked non-interactive refund leaf:
 * nothing on the wire says whether a given quote's covenant carries it (the
 * shape is fixed by the solver's own build, not negotiated per quote), so the
 * only safe move is to derive BOTH shapes and accept whichever one the quote's
 * own `lockup_address` matches. This loses no security: every candidate shape
 * pins the refund to the trader's own refund destination, so a solver gains
 * nothing by choosing which one to quote.
 *
 * Throws {@link AddressMismatch} only when NONE of the candidates match.
 * Returns the address that matched, so calls chain exactly as before.
 */
export const verifyLockupAddress = (quote: RfqQuote, derivedAddress: string | string[]): string => {
    const quoted = quote.profile?.lockup_address;
    const candidates = Array.isArray(derivedAddress) ? derivedAddress : [derivedAddress];
    const matched = candidates.find((address) => address === quoted);
    if (matched === undefined) throw new AddressMismatch(candidates, quoted);
    return matched;
};

/**
 * The two shapes a covenant lockup can carry while the timelocked
 * non-interactive refund leaf rolls out: the full emulator-covenant suite
 * (`undefined` — no legacy marker) and the pre-leaf shape
 * (`"preTimelockedRefund"`). See {@link verifyLockupAddress} for why callers
 * derive both. Newest first, so a matched full-suite build is the one kept.
 */
const LOCKUP_SHAPE_VARIANTS = [undefined, "preTimelockedRefund"] as const;

/**
 * Build a lockup covenant in both {@link LOCKUP_SHAPE_VARIANTS} shapes and
 * keep the one the quote's own `lockup_address` matches — throwing, via
 * {@link verifyLockupAddress}, when NEITHER does. What the matched candidate
 * carries that a bare address does not: the SCRIPT, for contract registration
 * — registering the wrong candidate would watch a tree the funded lockup is
 * not in.
 */
const matchQuotedLockup = (
    quote: RfqQuote,
    hrp: string,
    serverPubkey: Uint8Array,
    build: (legacy?: "preTimelockedRefund") => InstanceType<typeof VHTLC.ScriptV2>,
): {
    script: InstanceType<typeof VHTLC.ScriptV2>;
    address: string;
    legacy?: "preTimelockedRefund";
} => {
    const candidates = LOCKUP_SHAPE_VARIANTS.map((legacy) => {
        const script = build(legacy);
        return { script, address: script.address(hrp, serverPubkey).encode(), legacy };
    });
    const matchedAddress = verifyLockupAddress(
        quote,
        candidates.map((candidate) => candidate.address),
    );
    // `find` cannot miss: verifyLockupAddress only ever returns a candidate
    // it was given, or throws.
    return candidates.find((candidate) => candidate.address === matchedAddress)!;
};

/** The user's gates, checked immediately before funding — never at quote
 * time. Throws with a stable `reason` property. `invoiceExpiresAt` applies to
 * BOLT11 profiles only; `onchain` adds the L1-HTLC gates (§ guardrails of the
 * onchain spec) and is required for the onchain pairs.
 *
 * The lightning-receive leg does NOT use this: see {@link assertReceivable}.
 * `refund_locktime` is the SOLVER's on both receive corridors, so
 * `MIN_HEADROOM_SECONDS` gates the wrong side on either — but only the
 * lightning leg has a second clock that can actually run out (the hold
 * invoice's), which is what the split buys. The onchain-receive leg stays here
 * until its own deadline gets the same treatment; the headroom check is merely
 * over-strict there, never unsafe. */
export const assertFundable = (input: {
    quote: RfqQuote;
    invoiceExpiresAt?: number;
    now: number;
    onchain?: {
        htlcLocktime: number;
        minConfirmations: number;
        /** "send" = arkade->onchain (the L1 timelock-order gate applies). */
        direction: "send" | "receive";
    };
    /**
     * The most this client will pay: the GREATER of the two bounds, because a
     * flat fee is a large proportion of a small swap (420 sats is 8.4% of
     * 5_000, 0.084% of 500_000). Absent means no ceiling. OMIT a bound rather
     * than zeroing it: `{ bps: 0 }` alone is a ceiling of zero, indistinguishable
     * from "free or nothing". `{}` IS refused.
     */
    maxFee?: {
        /** Integer, 0..10_000 (10_000 = 100%). Out of range throws `max_fee_out_of_range`. */
        bps?: number;
        /** Non-negative integer. Out of range throws `max_fee_out_of_range`. */
        sats?: number;
        /**
         * To-units per from-unit, required for a CROSS-ASSET pair. Must come
         * from a source of YOUR OWN — the solver's own feed would check it
         * against its own number. Needs a looser tolerance than same-asset.
         */
        referenceRate?: number;
    };
}): void => {
    const fail = (reason: string, message: string): never => {
        throw gateError(reason, message);
    };
    if (input.invoiceExpiresAt !== undefined && input.now >= input.invoiceExpiresAt) {
        fail("invoice_expired", "invoice expired");
    }
    if (input.now >= input.quote.valid_until)
        fail("quote_expired", "quote expired — request a fresh one");
    if (
        input.quote.refund_locktime !== undefined &&
        input.quote.refund_locktime - input.now < MIN_HEADROOM_SECONDS
    ) {
        fail("insufficient_headroom", "refund deadline headroom below 90 minutes");
    }
    if (input.maxFee) {
        const { bps, sats, referenceRate } = input.maxFee;
        if (bps === undefined && sats === undefined) {
            // A ceiling naming nothing is a call-site mistake, not a bad quote.
            fail("max_fee_unbounded", "maxFee names neither bps nor sats");
        }
        if (bps !== undefined && (!Number.isInteger(bps) || bps < 0 || bps > 10_000)) {
            fail("max_fee_out_of_range", `maxFee.bps must be an integer in 0..10000, got ${bps}`);
        }
        if (sats !== undefined && (!Number.isInteger(sats) || sats < 0)) {
            fail("max_fee_out_of_range", `maxFee.sats must be a non-negative integer, got ${sats}`);
        }
        const legs = input.quote.pair.split("->");
        const assetOf = (leg: string): string => leg.slice(leg.indexOf(":") + 1);
        const sameAsset = legs.length === 2 && assetOf(legs[0]!) === assetOf(legs[1]!);
        if (!sameAsset && referenceRate === undefined) {
            fail(
                "fee_gate_unavailable",
                `maxFee cannot gate ${input.quote.pair}: its legs name different assets, so ` +
                    `from_amount - to_amount is not a fee. Supply maxFee.referenceRate ` +
                    `(to-units per from-unit) from a source of your OWN — reading it off the ` +
                    `solver's published feed would check the solver against its own number`,
            );
        }
        if (!sameAsset && (!Number.isFinite(referenceRate) || (referenceRate as number) <= 0)) {
            fail(
                "max_fee_out_of_range",
                `maxFee.referenceRate must be a positive finite number, got ${referenceRate}`,
            );
        }
        // Rounds UP: refuse a borderline quote, do not fund a rounding artefact.
        const fee = sameAsset
            ? input.quote.from_amount - input.quote.to_amount
            : Math.ceil(
                  (input.quote.from_amount * (referenceRate as number) - input.quote.to_amount) /
                      (referenceRate as number),
              );
        const allowed = Math.max(
            sats ?? 0,
            Math.floor((input.quote.from_amount * (bps ?? 0)) / 10_000),
        );
        if (fee > allowed) {
            fail("fee_too_high", `fee ${fee} exceeds the ${allowed} this client allows`);
        }
    }
    if (input.onchain) {
        const { htlcLocktime, minConfirmations, direction } = input.onchain;
        if (
            !Number.isInteger(minConfirmations) ||
            minConfirmations < 1 ||
            minConfirmations > MAX_MIN_CONFIRMATIONS
        ) {
            fail(
                "confirmations_out_of_range",
                `min_confirmations must be 1..${MAX_MIN_CONFIRMATIONS}, got ${minConfirmations}`,
            );
        }
        // Enough room to confirm the fill AND claim well before the refund
        // leaf opens (MTP lag + confirmation time).
        const needed = minConfirmations * ONCHAIN_SECONDS_PER_BLOCK + ONCHAIN_CLAIM_MARGIN_SECONDS;
        if (htlcLocktime - input.now <= needed) {
            fail("claim_window_too_short", "L1 HTLC locktime leaves no safe claim window");
        }
        if (direction === "send") {
            // The solver claims Arkade with P AFTER the user's L1 claim; the
            // user's Arkade refund must therefore open LAST, with reorg margin.
            if (
                input.quote.refund_locktime === undefined ||
                htlcLocktime + ONCHAIN_ORDER_MARGIN_SECONDS > input.quote.refund_locktime
            ) {
                fail(
                    "timelock_order",
                    "L1 HTLC locktime + margin must fall before the Arkade refund locktime",
                );
            }
        }
    }
};

// ── Transports ───────────────────────────────────────────────────────────────

export interface RfqTransport {
    requestQuote(payload: Record<string, unknown>): Promise<RfqQuote>;
    status(rfqId: string): Promise<RfqStatus | null>;
    close(): Promise<void>;
}

/**
 * Discriminate a solver reply: a refusal carries a closed-set reason and is
 * thrown as {@link SwapRefusal}; anything that is not a quote for THIS
 * negotiation is an error rather than a value. The `rfq_id` check is what stops
 * a reply to one negotiation being accepted as the answer to another — on a
 * shared relay the solver's events all arrive on the same subscription.
 *
 * `pair` is compared for the same reason the solver compares it byte for byte:
 * a solver that normalises case, or quotes a market other than the one asked
 * for, is otherwise undetectable client-side. Note the quote's pair is a
 * constant the solver restates rather than the request's echoed back, so this
 * binds every solver to the exact spellings this module builds.
 *
 * `requestedPair` is optional by value, not by parameter: callers pass a
 * payload they built, and a payload with no `pair` is not one whose pair can be
 * wrong. Comparing `String(undefined)` would refuse every quote.
 *
 * Shared with the nostr transport (`nostr.ts`), which used to carry a
 * byte-identical copy — module-level only, never re-exported from `index.ts`.
 */
export const expectQuote = (payload: unknown, rfqId: string, requestedPair?: string): RfqQuote => {
    const p = payload as { type?: string; reason?: string; rfq_id?: string; pair?: unknown } | null;
    if (p?.type === "rfq_refusal") throw new SwapRefusal(p.reason ?? "unknown", p.rfq_id ?? rfqId);
    if (p?.type !== "rfq_quote" || p.rfq_id !== rfqId) {
        throw new Error(`unexpected reply: ${p?.type ?? "no payload"}`);
    }
    if (requestedPair !== undefined && p.pair !== requestedPair) {
        throw new Error(
            `solver quoted ${JSON.stringify(p.pair)}, not the requested ${requestedPair}`,
        );
    }
    return payload as RfqQuote;
};

/** The pair of a request we built, when it named one. */
export const pairOf = (payload: Record<string, unknown>): string | undefined =>
    typeof payload.pair === "string" ? payload.pair : undefined;

/** HTTP: POST /v1/swap for quotes, GET /v1/rfq/<rfq_id> for status.
 * `fetchImpl` is injectable for tests and non-global-fetch runtimes. */
export const httpTransport = (
    baseUrl: string,
    options: { fetchImpl?: typeof fetch } = {},
): RfqTransport => {
    const fetchImpl = options.fetchImpl ?? fetch;
    /**
     * A refusal is a 4xx carrying an `rfq_refusal` body, so the status code
     * alone cannot decide whether to read it — rejecting every non-2xx would
     * throw away the closed-set reason the solver sent. What must not happen
     * is a non-JSON body (an nginx 502 page, a proxy timeout) surfacing as a
     * bare `SyntaxError` from the parser, which says nothing about what went
     * wrong. So: parse defensively, and name the status when the body is not
     * ours to interpret.
     */
    const readJson = async (response: Response, what: string): Promise<unknown> => {
        const body = await response.text();
        try {
            return JSON.parse(body) as unknown;
        } catch {
            throw new Error(
                `${what} returned HTTP ${response.status} with a non-JSON body: ${body.slice(0, 200)}`,
            );
        }
    };
    return {
        async requestQuote(payload) {
            const response = await fetchImpl(`${baseUrl}/v1/swap`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            return expectQuote(
                await readJson(response, "quote request"),
                String(payload.rfq_id),
                pairOf(payload),
            );
        },
        async status(rfqId) {
            const response = await fetchImpl(`${baseUrl}/v1/rfq/${rfqId}`, { method: "GET" });
            if (response.status === 404) return null;
            const payload = (await readJson(response, "status request")) as {
                type?: string;
            } | null;
            return payload?.type === "rfq_status" ? (payload as RfqStatus) : null;
        },
        async close() {},
    };
};

/** Minimal WebSocket surface the relay transport needs — satisfied by the DOM
 * WebSocket and by `ws` alike, so neither becomes a dependency. */
export interface RelaySocket {
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "message" | "error", listener: (event: any) => void): void;
}

/** Relay: both parties outbound, addressed by x-only pubkey, speaking the dev
 * broker framing. Nostr (directed kind + NIP-44) replaces only this function.
 * One socket; replies correlated by rfq_id. */
export const relayTransport = (
    relayUrl: string,
    options: {
        solverPubkey: string;
        clientPubkey: string;
        WebSocketCtor?: new (url: string) => RelaySocket;
        timeoutMs?: number;
    },
): RfqTransport => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const Ctor =
        options.WebSocketCtor ?? (WebSocket as unknown as new (url: string) => RelaySocket);
    const pending = new Map<string, (payload: unknown) => void>();
    let sequence = 0;

    const socketReady = new Promise<RelaySocket>((resolve, reject) => {
        const ws = new Ctor(relayUrl);
        ws.addEventListener("open", () => {
            ws.send(
                JSON.stringify({
                    op: "sub",
                    id: "s1",
                    filter: { recipient: options.clientPubkey },
                }),
            );
            resolve(ws);
        });
        ws.addEventListener("error", () => reject(new Error("relay connection failed")));
        ws.addEventListener("message", (event: { data: unknown }) => {
            let frame: { op?: string; event?: { payload?: { rfq_id?: string } } };
            try {
                frame = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (frame.op !== "event") return;
            const payload = frame.event?.payload;
            const rfqId = payload?.rfq_id;
            const settle = rfqId !== undefined ? pending.get(rfqId) : undefined;
            if (settle && rfqId !== undefined) {
                pending.delete(rfqId);
                settle(payload);
            }
        });
    });

    const roundTrip = async (payload: Record<string, unknown>, rfqId: string): Promise<unknown> => {
        const ws = await socketReady;
        const reply = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(rfqId);
                reject(new Error(`no reply within ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(rfqId, (p) => {
                clearTimeout(timer);
                resolve(p);
            });
        });
        ws.send(
            JSON.stringify({
                op: "event",
                event: {
                    id: `${options.clientPubkey}:${(sequence += 1)}`,
                    author: options.clientPubkey,
                    recipient: options.solverPubkey,
                    createdAtMs: Date.now(),
                    payload,
                },
            }),
        );
        return reply;
    };

    return {
        async requestQuote(payload) {
            return expectQuote(
                await roundTrip(payload, String(payload.rfq_id)),
                String(payload.rfq_id),
                pairOf(payload),
            );
        },
        async status(rfqId) {
            const payload = (await roundTrip(
                { v: 1, type: "rfq_status_request", rfq_id: rfqId },
                rfqId,
            )) as { type?: string } | null;
            return payload?.type === "rfq_status" ? (payload as RfqStatus) : null;
        },
        async close() {
            try {
                (await socketReady).close();
            } catch {
                // socket never opened; nothing to close
            }
        },
    };
};

// ── Lightning send: derivation + the user flow ──────────────────────────────

/** BIP68 sequence granularity; the delay derivation rounds up to it. */
const SEQUENCE_GRANULARITY_SECONDS = 512;

/**
 * How long the sender's SOLO refund opens after the receiver's claim, seconds.
 *
 * This is the window in which a claimant holding the preimage must be able to
 * finish taking their money before the funder could take it back. On a live
 * Arkade server that is one collaborative spend; with the server gone it is a
 * full unilateral exit — an unroll broadcast per chain step, each waiting on a
 * confirmation, then the CSV spend.
 *
 * 4096s (eight 512s units, ~68 minutes) is sized for that worst case. It is
 * REASONED, not measured, and it mirrors `SOLO_REFUND_HEADROOM_SECONDS` in the
 * reference solver's `src/core/timelocks.ts` — the two must move together or a
 * trader derives an address the solver never quoted.
 *
 * A multiple of the granularity on purpose: BIP68 would round anything else,
 * making the encoded timelock differ from the number written here.
 */
export const SOLO_REFUND_HEADROOM_SECONDS = 8 * SEQUENCE_GRANULARITY_SECONDS;

/** The solver's unilateral-claim delay, derived from the Ark server's reported
 * exit delay exactly as the reference solver derives it — both sides read the
 * SAME server, so the derivation (not a quote field) is what keeps the two
 * scripts identical. */
export const unilateralClaimDelay = (serverExitDelaySeconds: number): number => {
    if (
        !Number.isFinite(serverExitDelaySeconds) ||
        serverExitDelaySeconds < SEQUENCE_GRANULARITY_SECONDS
    ) {
        throw new Error(
            `server exit delay must be at least ${SEQUENCE_GRANULARITY_SECONDS}s of seconds, got ${serverExitDelaySeconds}`,
        );
    }
    // the headroom below BIP68's ceiling, not at it: the solo refund stacks
    // SOLO_REFUND_HEADROOM_SECONDS on top of this value, and it must encode too
    if (
        serverExitDelaySeconds >
        0xffff * SEQUENCE_GRANULARITY_SECONDS - SOLO_REFUND_HEADROOM_SECONDS
    ) {
        throw new Error(
            `server exit delay ${serverExitDelaySeconds}s exceeds what BIP68 can encode ` +
                `once the solo refund's headroom is stacked above it`,
        );
    }
    return (
        Math.ceil(serverExitDelaySeconds / SEQUENCE_GRANULARITY_SECONDS) *
        SEQUENCE_GRANULARITY_SECONDS
    );
};

/** VHTLC's `unilateralRefund` tier: sender + receiver, no server — LEVEL with
 * `claimDelay`, not above it. Neither party can spend a two-signature leaf
 * alone, so separating it buys no safety, and every second spent separating it
 * is a second taken off the headroom that does matter. */
export const unilateralRefundDelay = (claimDelay: number): number => claimDelay;

/** VHTLC's `unilateralRefundWithoutReceiver` tier: sender alone, needing
 * nobody. The only leaf whose timing can steal — a funder able to refund
 * before the claimant can claim takes money from someone holding the preimage
 * — so it opens last, by {@link SOLO_REFUND_HEADROOM_SECONDS}. */
export const unilateralRefundWithoutReceiverDelay = (claimDelay: number): number =>
    claimDelay + SOLO_REFUND_HEADROOM_SECONDS;

/** Compile the lightning-send VHTLC from the quote's binding fields plus the
 * trader's own data. `paymentHash` is the BOLT11 payment hash (`sha256(P)`,
 * hex); the script's HASH160 commitment is derived from it here, which is why
 * the trader never needs to see `P`.
 *
 * Every quote gets the full emulator-covenant suite on top of VHTLC's own six
 * (`claim`/`refund`/`refundWithoutReceiver`/`unilateralClaim`/
 * `unilateralRefund`/`unilateralRefundWithoutReceiver`): `nonInteractiveClaim`
 * (server + emulator, pays the solver's own `receiverPkScript`, no solver
 * signature needed), `nonInteractiveRefund` (server + solver + emulator, pays
 * the trader's own `refundPkScript`, no timelock and no trader signature
 * needed — see {@link VHTLC.Options.nonInteractiveParameters}'s doc comment for why
 * that matters), and its timelocked twin `nonInteractiveRefundWithoutReceiver`
 * (server + emulator alone, after `refundLocktime` — the only refund tier
 * needing no participant at all). Nine leaves in all, unless `legacy` says
 * otherwise.
 */
export function lightningSendVtxoScript(params: {
    /** Binding field #1: the solver's x-only key, from the quote. */
    solverPubkey: Uint8Array;
    /** Binding field #2: when the trader's refund path opens, from the quote. */
    refundLocktime: number;
    /** The Ark server's x-only key — the trader's OWN connection. */
    serverPubkey: Uint8Array;
    /** BOLT11 payment hash, hex — from the trader's OWN invoice decode. */
    paymentHash: string;
    /** From {@link unilateralClaimDelay} over the trader's OWN server info.
     * {@link unilateralRefundDelay} and {@link unilateralRefundWithoutReceiverDelay}
     * derive from this same value — one rounding, shared across all three tiers. */
    claimDelay: number;
    /** Emulator x-only key (32 bytes). */
    emulatorPubkey: Uint8Array;
    /** Where a refund must pay: the trader's P2TR pkScript (34 bytes). Also
     * the refund covenants' destination. */
    refundPkScript: Uint8Array;
    /** The trader's own key — VHTLC's `sender` role. Required on every
     * interactive refund-side leaf; the trader generates and persists it
     * (see {@link requestLightningSend}'s own obligations). */
    senderPubkey: Uint8Array;
    /** The solver's own claim destination, from the quote
     * (`profile.receiver_pk_script`) — needed only so `nonInteractiveClaim`'s
     * covenant key can be derived; the trader does not otherwise use or trust
     * this value. P2TR pkScript, 34 bytes. */
    receiverPkScript: Uint8Array;
    /** LEGACY REBUILD ONLY — see {@link VHTLC.Options.nonInteractiveParameters}'s
     * `legacy` field. Set only to re-derive a lockup funded before the
     * timelocked refund leaf shipped; {@link matchQuotedLockup} passes it when
     * the quote's own address says the solver quoted that shape. */
    legacy?: "preTimelockedRefund";
}): InstanceType<typeof VHTLC.ScriptV2> {
    const seconds = (value: number): { type: "seconds"; value: bigint } => ({
        type: "seconds",
        value: BigInt(value),
    });
    return new VHTLC.ScriptV2({
        sender: params.senderPubkey,
        receiver: params.solverPubkey,
        server: params.serverPubkey,
        preimageHash: ripemd160(hex.decode(params.paymentHash)),
        refundLocktime: BigInt(params.refundLocktime),
        unilateralClaimDelay: seconds(params.claimDelay),
        unilateralRefundDelay: seconds(unilateralRefundDelay(params.claimDelay)),
        unilateralRefundWithoutReceiverDelay: seconds(
            unilateralRefundWithoutReceiverDelay(params.claimDelay),
        ),
        nonInteractiveParameters: {
            receiverPkScript: params.receiverPkScript,
            senderPkScript: params.refundPkScript,
            emulatorPubkey: params.emulatorPubkey,
            ...(params.legacy !== undefined && { legacy: params.legacy }),
        },
    });
}

/** Every input {@link lightningSendVtxoScript} builds from. Derived from the
 * builder rather than restated, so the two cannot drift. */
export type LightningSendTreeParams = Parameters<typeof lightningSendVtxoScript>[0];

/** The BOLT11 facts the trader read from its OWN decode — this module takes
 * the facts, not the decoder, so any wallet's existing decoder serves. */
export interface InvoiceFacts {
    /** The raw BOLT11 — what travels in the request profile. */
    raw: string;
    /** `sha256(P)`, LOWERCASE hex (64 chars) — {@link verifyReceiveInvoice}
     * compares it byte-for-byte against `paymentHashOf`, which emits lowercase. */
    paymentHash: string;
    amountSats: number;
    /** Absolute expiry, unix seconds. */
    expiresAt: number;
}

/**
 * The lightning-send user flow, mirroring `createOffer`'s shape: quote →
 * derive locally → verify → gate. Pure of funding on purpose — it returns the
 * address and amount, and the caller funds with its own wallet
 * (`wallet.send({ address, amount })`) before `quote.valid_until`, after
 * which the user may go OFFLINE: filling is non-interactive. Success reveals
 * the preimage in the solver's claim witness (also served via status as
 * `settled`); failure refunds to `refundAddress`.
 *
 * Throws {@link SwapRefusal} (closed reason), {@link AddressMismatch} (never
 * fund), a gate error with a stable `reason`, or
 * {@link LockupRegistrationFailed} — the last one alone means the quote is
 * still good and the same call can be retried once local storage is.
 *
 * Broadcasts nothing, but does write locally: the lockup is registered with the
 * wallet's contract manager before the address is returned, exactly as
 * `createOffer` registers its covenant — so the lockup is watched from the
 * moment it lands and out of generic coin selection, and a persistence failure
 * throws while nothing is funded. `RfqSwapManager` re-registers as a backstop
 * for older records; a repeat write is a no-op.
 *
 * The `sender` key is the wallet's identity key, reused by {@link
 * provisionRefundKey} — returned as `senderPubkey` plus `secrets`. `secrets`
 * holds only a public descriptor; the signer re-derives from the wallet, so
 * nothing secret is at rest. Persist `secrets` with the record anyway: it is
 * how the refund signer is found again. `nonInteractiveRefund` recovers the funds even without it — but it needs the SOLVER's active
 * cooperation, not just infrastructure uptime.
 */
export async function requestLightningSend(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        invoice: InvoiceFacts;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The trader's OWN derivation — the only address to fund. */
    address: string;
    /** What the lockup must carry: the quote's `from_amount` (the invoice
     * amount plus the corridor's fee), in sats. */
    fundAmount: number;
    /** The covenant's scriptPubKey, for watching the lockup and its spend. */
    swapPkScript: Uint8Array;
    /** The covenant itself. Hand it to `RfqSwapManager` as the record's
     * `lockup` (with `address`): without it the manager can only poll, and
     * cannot retire the row this call just wrote. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** Where a failed swap refunds — the same address `secrets.pkScript` was
     * decoded from, so the quote and the covenant always name one script. */
    refundAddress: string;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the `sender` key is recovered later. Persist it with the record;
     * it holds nothing secret. */
    secrets: ProvisionedKey;
    /**
     * Every input the covenant was built from, as it was AT REQUEST TIME.
     *
     * Returned so a consumer can persist the swap without re-deriving any of
     * it. Half of these are not on the quote: `serverPubkey` and `claimDelay`
     * come from this wallet's own `getInfo()`, `emulatorPubkey` from a
     * per-network pin, `refundPkScript` from `secrets` — decoded from the
     * refund address at provisioning time, the same address this call returns
     * as `refundAddress`.
     *
     * All public. Persisting them is optional: this call also registers the
     * lockup as a contract, and that row is where `rebuildRfqSwap` takes its
     * covenant from — see `rfqRecord.ts`. Keep a copy only to hold a record
     * that rebuilds without the wallet's contract store, and keep it as
     * `VHTLCV2ContractHandler.serializeParams(script.options)`, the shape the
     * rebuild accepts.
     */
    treeParams: LightningSendTreeParams;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // This leg is one we fund, so all it needs is the key that refunds it.
    // No preimage: a lightning send's P belongs to the payee.
    const secrets = await provisionRefundKey(wallet);
    const senderPubkey = secrets.pubkey;
    // One address read, inside provisionRefundKey: the quote's refund address
    // and the covenant's refundPkScript come from it together, so a wallet
    // that rotates its receive address between two reads cannot pair the
    // solver's refund_address with a different script.
    const refundAddress = secrets.address;
    const info = await new RestArkProvider(arkServerUrl).getInfo();

    const quote = await transport.requestQuote(
        lightningSendRequest({ rfqId, invoice: params.invoice.raw, refundAddress, senderPubkey }),
    );
    if (quote.refund_locktime === undefined) {
        throw new Error("lightning-send quote is missing refund_locktime");
    }
    const receiverPkScriptHex = quote.profile?.receiver_pk_script as string | undefined;
    if (receiverPkScriptHex === undefined) {
        throw new Error("lightning-send quote is missing profile.receiver_pk_script");
    }
    // The BOLT11 profile is exact-out: `to_amount` is the invoice, verbatim,
    // and `from_amount` adds the corridor's fee on top. Funding anything but
    // `from_amount` underfunds by exactly the fee and is refused — and a quote
    // repricing the invoice itself is not a quote for this invoice at all.
    if (quote.to_amount !== params.invoice.amountSats) {
        throw new Error(
            `quote to_amount ${quote.to_amount} does not match the invoice's ${params.invoice.amountSats}`,
        );
    }
    if (quote.from_amount < quote.to_amount) {
        throw new Error(
            `quote from_amount ${quote.from_amount} is below the invoice amount — a negative spread is not a quote`,
        );
    }

    const serverPubkey = toXOnly(hex.decode(info.signerPubkey), "ark signer key");
    const network = getNetwork(info.network as NetworkName);
    // Named rather than inlined so the exact inputs the covenant was built from
    // can be returned to the caller — see `treeParams` on the return type.
    const treeParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime: quote.refund_locktime,
        serverPubkey,
        paymentHash: params.invoice.paymentHash,
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: secrets.pkScript,
    };
    // Two candidates in, one match out — see matchQuotedLockup's own doc
    // comment for why there are two. The MATCHED script is what gets
    // registered and returned: anything downstream re-derives from these, so
    // they must describe the lockup actually funded, not a shape we guessed.
    const matched = matchQuotedLockup(quote, network.hrp, serverPubkey, (legacy) =>
        lightningSendVtxoScript({ ...treeParams, ...(legacy !== undefined && { legacy }) }),
    );
    const script = matched.script;
    const address = matched.address;
    const matchedTreeParams: LightningSendTreeParams = {
        ...treeParams,
        ...(matched.legacy !== undefined && { legacy: matched.legacy }),
    };
    assertFundable({
        quote,
        invoiceExpiresAt: params.invoice.expiresAt,
        now: Math.floor(Date.now() / 1000),
    });

    // Last, so a refused quote leaves no row behind, but still before the
    // caller holds an address to fund: registration throws here, where nothing
    // is at stake, rather than stranding a funded lockup unwatched.
    await registerLockupContract(await wallet.getContractManager(), script, address);

    return {
        rfqId,
        quote,
        address,
        // What the lockup must carry: the quote's `from_amount` — the invoice
        // PLUS the corridor's fee, never the bare invoice amount.
        fundAmount: quote.from_amount,
        swapPkScript: script.pkScript,
        script,
        refundAddress,
        senderPubkey,
        secrets,
        treeParams: matchedTreeParams,
    };
}

// ── Arkade ↔ arkade: quote, then take by funding an offer ───────────────────

/**
 * Map an arkade↔arkade quote onto `createOffer` terms. The trader takes the
 * quote by creating and funding the offer covenant before `valid_until` —
 * the non-interactive fill: the covenant only releases the deposit to a
 * transaction that delivers the quoted want-amount to the trader, so the
 * solver fills or nothing moves. There is no rfq_fill message and no refund
 * timelock; an unfilled offer is cancelled cooperatively (`cancelOffer`).
 */
export const offerTermsFromQuote = (
    quote: RfqQuote,
    assets: { wantAsset?: asset.AssetId; offerAsset?: asset.AssetId },
): { wantAmount: bigint; wantAsset?: asset.AssetId; offerAsset?: asset.AssetId } => {
    if (Boolean(assets.wantAsset) === Boolean(assets.offerAsset)) {
        throw new Error("set exactly one of wantAsset or offerAsset");
    }
    return { wantAmount: BigInt(quote.to_amount), ...assets };
};

// ── Onchain corridor: off-board (arkade->onchain) and on-board wire ─────────

/** The Arkade lockup for an onchain send uses the SAME {@link
 * lightningSendVtxoScript} the Lightning leg does — only the SOURCE of the
 * payment hash differs (user-generated P instead of a BOLT11). One function,
 * one golden test. */

const l1NetworkFromArk = (network: string): OnchainNetwork =>
    network === "bitcoin" ? "bitcoin" : network === "regtest" ? "regtest" : "testnet";

/** The rfq_request for `arkade:BTC->onchain:BTC`. Exact-out means "this much
 * lands in the L1 HTLC". `senderPubkey` is the user's own key for the
 * VHTLC's sender-side leaves — same role as in {@link lightningSendRequest}.
 * On the wire it's `client_refund_pubkey`, same as there. */
export const onchainSendRequest = (input: {
    rfqId: string;
    /** `sha256(P)`, hex — user-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** User's x-only L1 key for the HTLC's claim leaf. */
    payoutPubkey: Uint8Array;
    /** User's arkade address — where the covenant refund must pay. */
    refundAddress: string;
    senderPubkey: Uint8Array;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: ONCHAIN_SEND_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        payout_pubkey: hex.encode(input.payoutPubkey),
        refund_address: input.refundAddress,
        client_refund_pubkey: hex.encode(input.senderPubkey),
    },
});

/** The rfq_request for `lightning:BTC->arkade:BTC`: pay the solver's hold
 * invoice, land on Arkade. The trader generates `P`, keeps it, and sends only
 * `H` plus `P` sealed to covclaimd — the solver never sees `P` until it
 * appears in a claim witness. `payoutPubkey` is the trader's own x-only
 * Arkade key — the covenant's `receiver` role on this leg, so the trader can
 * claim the lockup itself without covclaimd. */
export const lightningReceiveRequest = (input: {
    rfqId: string;
    /** `H = sha256(P)`, hex — trader-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** Trader's arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** Trader's x-only arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
    /** `P` sealed to covclaimd, base64 — `sealClaimPacket(...).ciphertext`. */
    claimPacket: string;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: LIGHTNING_RECEIVE_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        payout_address: input.payoutAddress,
        payout_pubkey: hex.encode(input.payoutPubkey),
        claim_packet: input.claimPacket,
    },
});

/** The rfq_request for `onchain:BTC->arkade:BTC`. The user funds the L1 HTLC
 * (holding its refund role) and receives Arkade; P travels sealed to
 * covclaimd (see `sealClaimPacket`) so the user can go offline after
 * funding. `payoutPubkey` is the trader's own x-only Arkade key — the
 * covenant's `receiver` role, same as the Lightning receive leg's. */
export const onchainReceiveRequest = (input: {
    rfqId: string;
    paymentHash: string;
    /** Trader's arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** Trader's x-only arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
    /** Trader's x-only L1 key for the HTLC's refund leaf. */
    refundPubkey: Uint8Array;
    /** `P` sealed to covclaimd, base64 — `sealClaimPacket(...).ciphertext`. */
    claimPacket: string;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: ONCHAIN_RECEIVE_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        claim_packet: input.claimPacket,
        refund_pubkey: hex.encode(input.refundPubkey),
        payout_address: input.payoutAddress,
        payout_pubkey: hex.encode(input.payoutPubkey),
    },
});

/**
 * The pure core of {@link requestOnchainSend}: derive BOTH contracts locally
 * from the quote's binding fields plus the user's own data, and refuse on any
 * mismatch. Binding: `solver_pubkey`, `refund_locktime`, `htlc_pubkey`,
 * `htlc_locktime`, `min_confirmations`; `lockup_address` and `htlc_address`
 * are compare-only.
 */
export function deriveOnchainSend(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    l1Network: OnchainNetwork;
    refundAddress: string;
    /** The user's own key for the VHTLC's sender-side leaves — same role as
     * in {@link requestLightningSend}. */
    senderPubkey: Uint8Array;
}): {
    address: string;
    swapPkScript: Uint8Array;
    /** The lockup covenant itself — what the contract row is registered from,
     * so the row can never key on a script other than the derived one. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    htlc: OnchainHtlc;
    /** The inputs {@link htlc} was built from. Returned because nothing else
     * can give them back: `OnchainHtlc` exposes only derived values, and this
     * contract is Bitcoin L1 — there is no Arkade contract row for it, so a
     * consumer persisting the swap has no other route to rebuilding it. */
    htlcParams: OnchainHtlcParams;
    /** Echoed from the input, so a result is a complete description of the L1
     * half rather than one a caller has to re-assemble from what it passed in.
     * {@link onchainSendProfile} reads it from here. */
    l1Network: OnchainNetwork;
    refundLocktime: number;
    htlcLocktime: number;
    minConfirmations: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime ?? (profile.refund_locktime as number | undefined);
    const htlcPubkey = profile.htlc_pubkey as string | undefined;
    const htlcLocktime = profile.htlc_locktime as number | undefined;
    const htlcAddress = profile.htlc_address as string | undefined;
    const minConfirmations = profile.min_confirmations as number | undefined;
    const receiverPkScriptHex = profile.receiver_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        htlcPubkey === undefined ||
        htlcLocktime === undefined ||
        minConfirmations === undefined ||
        receiverPkScriptHex === undefined
    ) {
        throw new Error("onchain-send quote is missing a binding field");
    }

    const treeParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        senderPubkey: input.senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: ArkAddress.decode(input.refundAddress).pkScript,
    };
    // Two candidates, one match — see matchQuotedLockup.
    const { script, address } = matchQuotedLockup(quote, input.hrp, input.serverPubkey, (legacy) =>
        lightningSendVtxoScript({ ...treeParams, ...(legacy !== undefined && { legacy }) }),
    );

    // Named so the inputs can be handed back: `OnchainHtlc` carries only
    // derived values, and unlike the Arkade lockup this HTLC has no contract
    // row, so these are the only route to rebuilding it after a restart.
    const htlcParams = {
        paymentHash: input.paymentHash,
        claimKey: input.payoutPubkey,
        refundKey: toXOnly(hex.decode(htlcPubkey), "solver L1 htlc key"),
        refundLocktime: htlcLocktime,
    };
    const htlc = onchainHtlcScript(htlcParams, input.l1Network);
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        htlcParams,
        l1Network: input.l1Network,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
    };
}

/**
 * The `arkade:BTC->onchain:BTC` user flow, mirroring `requestLightningSend`:
 * quote → derive BOTH contracts locally → verify → gate. Pure of funding —
 * the caller funds `address` with its own wallet before `quote.valid_until`.
 *
 * Registers the arkade lockup before returning the address, on the same terms
 * as {@link requestLightningSend} — including {@link LockupRegistrationFailed},
 * the one throw here that does not mean "walk away from this quote". The L1
 * HTLC is not a contract row: it lives on bitcoin, not on Ark, and the wallet's
 * contract manager knows nothing of it.
 *
 * Two obligations, both LOUD:
 * - **Persist `secrets` (with the record) BEFORE funding.** On an HD wallet it
 *   is a public descriptor and both the preimage and the `sender` key
 *   re-derive from the seed; otherwise it carries the raw secrets, and losing
 *   them forfeits the L1 claim and every interactive refund path — leaving
 *   recovery dependent on the solver via `nonInteractiveRefund`.
 * - **Stay claim-capable.** Unlike lightning-send the user cannot go fully
 *   offline: it must claim the L1 HTLC (`awaitOnchainFill` →
 *   `claimOnchainFill`) before `htlc.refundLocktime`. Missing that window
 *   forfeits the fill and falls back to the Arkade covenant refund.
 */
export async function requestOnchainSend(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** User's x-only L1 key that will claim the HTLC. */
        payoutPubkey: Uint8Array;
        /** Optional caller-owned P. Persist it with the returned secrets before funding. */
        preimage?: Uint8Array;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The user's OWN arkade lockup derivation — the only address to fund. */
    address: string;
    fundAmount: number;
    swapPkScript: Uint8Array;
    /** The arkade covenant itself — the record's `lockup` for
     * `RfqSwapManager`, same role as {@link requestLightningSend}'s. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    refundAddress: string;
    /** The EXPECTED L1 fill, derived locally — watch and claim against this. */
    htlc: OnchainHtlc;
    /** The inputs {@link htlc} was built from — persist these to rebuild it
     * after a restart. Nothing else gives them back: `OnchainHtlc` exposes only
     * derived values, and this contract is Bitcoin L1, so unlike the arkade
     * lockup there is no contract row holding its parameters. Persist
     * `htlc.address` alongside them (`OnchainSendProfile.htlcAddress`): the
     * rebuild checks the two against each other, which is the only check
     * available on a leg with no second copy of its covenant.
     *
     * `onchainSendProfile(result)` does all of that mapping for you; prefer it
     * to reading these fields across by hand. */
    htlcParams: OnchainHtlcParams;
    /**
     * Which bitcoin network the L1 HTLC was derived for.
     *
     * Returned because it is NOT the ark network name and cannot be recovered
     * from one by inspection: this call maps `info.network` through a private
     * narrowing where signet, mutinynet and testnet4 all become `"testnet"`.
     * A caller reconstructing it from context would be re-deriving a mapping
     * it cannot see, and a value the profile needs verbatim.
     */
    l1Network: OnchainNetwork;
    /** `profile.min_confirmations`; gates when the L1 fill becomes claimable,
     * and part of what a restored swap needs to drive its own claim. */
    minConfirmations: number;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the preimage and the `sender` key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE funding. Public unless
     * `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // We fund the arkade leg and claim the L1 one, so this needs both halves:
    // the key that refunds the lockup and the P that claims the HTLC. A
    // supplied P is length-checked before an index is consumed — the L1 claim
    // leaf pins OP_SIZE 32, and any other length funds an unclaimable HTLC.
    const secrets = await provisionClaimSecret(wallet, { preimage: params.preimage });
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before funding",
        );
    }
    const paymentHash = hex.encode(secrets.paymentHash);
    const senderPubkey = secrets.pubkey;
    const [info, refundAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);

    const quote = await transport.requestQuote(
        onchainSendRequest({
            rfqId,
            paymentHash,
            payoutPubkey: params.payoutPubkey,
            refundAddress,
            senderPubkey,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    // `fundAmount` below is `quote.from_amount` verbatim, so without this a
    // quote naming a different amount is funded at the solver's number.
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const network = getNetwork(info.network as NetworkName);
    const derived = deriveOnchainSend({
        quote,
        paymentHash,
        payoutPubkey: params.payoutPubkey,
        serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
        l1Network: l1NetworkFromArk(info.network),
        refundAddress,
        senderPubkey,
    });
    assertFundable({
        quote,
        now: Math.floor(Date.now() / 1000),
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "send",
        },
    });

    // Before the caller can fund, and loud on failure — see the same call in
    // `requestLightningSend`.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        address: derived.address,
        fundAmount: quote.from_amount,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        refundAddress,
        htlc: derived.htlc,
        htlcParams: derived.htlcParams,
        l1Network: derived.l1Network,
        minConfirmations: derived.minConfirmations,
        senderPubkey,
        secrets,
    };
}

/** The fixed side of the quote must equal the amount the request named;
 * anything else is a quote for a different trade. Above both corridors because
 * it belongs to neither. `requestLightningSend` is the one caller that does
 * not reach for it: a BOLT11 profile carries no `amountSide`, so it makes the
 * same two comparisons against the invoice instead. */
const assertQuotedAmount = (quote: RfqQuote, amountSide: "from" | "to", amount: number): void => {
    const quoted = amountSide === "from" ? quote.from_amount : quote.to_amount;
    if (quoted !== amount) {
        throw new Error(
            `quote ${amountSide === "from" ? "from_amount" : "to_amount"} ${quoted} ` +
                `does not match the requested ${amount} — not this trade's quote`,
        );
    }
    if (quote.to_amount > quote.from_amount) {
        throw new Error("quote pays out more than it takes in — not a quote to fund");
    }
};

// ── Receive corridors: the solver funds Arkade, the trader pays outside ─────

/** Default floor for the window between the last moment the hold invoice can
 * be paid and the solver's refund leaf opening. */
export const MIN_CLAIM_WINDOW_SECONDS = 30 * 60;

/**
 * Bind the SOLVER's hold invoice to the quote and to the trader's own `H`.
 *
 * This is the only field the trader hands to a third party, and the only
 * attack on this corridor with no on-chain trace: an invoice on some other
 * payment hash is paid to the solver in full and no lockup on `H` is ever
 * funded. NEVER publish an invoice that has not passed this.
 *
 * The decoder is injected — `@arkade-os/swap` takes no BOLT11 dependency — but
 * unlike {@link requestLightningSend}, which takes the caller's facts about
 * the caller's OWN invoice, the comparison lives here: a caller-supplied
 * summary of an adversary's invoice checks nothing.
 *
 * There is no check for "is this actually a hold invoice": on the wire it is
 * indistinguishable from an ordinary one.
 *
 * Reasons: `invoice_undecodable` | `invoice_hash_mismatch` |
 * `invoice_amount_mismatch` | `quote_malformed`.
 */
export const verifyReceiveInvoice = (input: {
    invoice: string;
    decode: (bolt11: string) => InvoiceFacts;
    /** `sha256(P)`, hex — the trader's OWN. */
    paymentHash: string;
    quote: RfqQuote;
}): { payDeadline: number } => {
    let decoded: InvoiceFacts;
    try {
        decoded = input.decode(input.invoice);
    } catch (error) {
        throw gateError(
            "invoice_undecodable",
            `solver sent an undecodable invoice: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    // Both operands of the `payDeadline` min, before either reaches it: a
    // decoder that reports the expiry of an invoice with no expiry tag as NaN,
    // or a solver that sends a `valid_until` JSON never typechecked, would
    // otherwise disarm every gate downstream — see {@link assertFinite}.
    assertFinite(decoded.expiresAt, "invoice_undecodable", "the decoded invoice expiry");
    assertFinite(input.quote.valid_until, "quote_malformed", "quote valid_until");
    if (decoded.paymentHash !== input.paymentHash) {
        throw gateError(
            "invoice_hash_mismatch",
            `solver's invoice pays ${decoded.paymentHash}, not this swap's ${input.paymentHash}`,
        );
    }
    // BOLT11 permits an amountless invoice, which lets a payer pay anything;
    // decoders surface that as 0, so a nullish check would miss it.
    if (decoded.amountSats <= 0) {
        throw gateError("invoice_amount_mismatch", "solver's invoice names no amount");
    }
    if (decoded.amountSats !== input.quote.from_amount) {
        throw gateError(
            "invoice_amount_mismatch",
            `solver's invoice asks for ${decoded.amountSats}, not the quoted from_amount ${input.quote.from_amount}`,
        );
    }
    // No `amountSats` in the return: the check above pins it to
    // `quote.from_amount`, which the caller already has.
    return { payDeadline: Math.min(decoded.expiresAt, input.quote.valid_until) };
};

/**
 * The receive leg's gate, checked before the invoice is published. Separate
 * from {@link assertFundable} because the semantics invert: `refund_locktime`
 * belongs to the SOLVER here, so BIP-113's median-time-past lag extends the
 * trader's claim window instead of shrinking it. What can actually run out is
 * the hold invoice's own window — minutes, not the quote's hour — which is why
 * the claim window is measured from `payDeadline`, the last moment a payer can
 * arm the swap, and not from `now`.
 *
 * `maxPayAmount` is an opt-in absolute ceiling on what the payer is asked for:
 * `assertQuotedAmount` pins the side the request named, so with
 * `amountSide: "to"` the price is the free variable. Optional because a bad
 * price is visible to the caller before anything is published — unlike an
 * opaque invoice or an underfunded lockup.
 *
 * Reasons: `quote_expired` | `missing_refund_locktime` | `claim_window_too_short` |
 * `price_too_high` | `quote_malformed` | `invalid_gate_input`.
 */
export const assertReceivable = (input: {
    quote: RfqQuote;
    /** From {@link verifyReceiveInvoice}: `min(invoice expiry, valid_until)`. */
    payDeadline: number;
    now: number;
    minClaimWindowSeconds?: number;
    /** Absolute sats ceiling on `from_amount`. */
    maxPayAmount?: number;
}): void => {
    // Ahead of the comparisons, never inside them: this function is exported,
    // so it cannot assume verifyReceiveInvoice vetted `payDeadline`, and the
    // clock and the two knobs are the caller's own — a `NaN` ceiling would
    // leave `from_amount > NaN` false and delete the price gate it was asked
    // for, and a `NaN` clock would do the same to the expiry gate below.
    assertFinite(input.payDeadline, "quote_malformed", "payDeadline");
    assertFinite(input.now, "invalid_gate_input", "now");
    assertFinite(input.minClaimWindowSeconds, "invalid_gate_input", "minClaimWindowSeconds");
    assertFinite(input.maxPayAmount, "invalid_gate_input", "maxPayAmount");
    const minClaimWindow = input.minClaimWindowSeconds ?? MIN_CLAIM_WINDOW_SECONDS;
    if (input.now >= input.payDeadline) {
        throw gateError("quote_expired", "quote or invoice already expired — request a fresh one");
    }
    if (input.quote.refund_locktime === undefined) {
        throw gateError("missing_refund_locktime", "receive quote carries no refund_locktime");
    }
    assertFinite(input.quote.refund_locktime, "quote_malformed", "quote refund_locktime");
    if (input.quote.refund_locktime - input.payDeadline < minClaimWindow) {
        throw gateError(
            "claim_window_too_short",
            `a payment at the deadline would leave under ${minClaimWindow}s to claim before the solver's refund opens`,
        );
    }
    if (input.maxPayAmount !== undefined && input.quote.from_amount > input.maxPayAmount) {
        throw gateError(
            "price_too_high",
            `quote asks ${input.quote.from_amount} sats, above the ${input.maxPayAmount} ceiling`,
        );
    }
};

/** Compile the RECEIVE-direction VHTLC: the same suite-carrying tree as {@link
 * lightningSendVtxoScript} with the roles inverted — the trader is the
 * `receiver` (it generated `P` and claims the lockup with it), the solver is
 * the `sender` (it funds the lockup and holds the refund recourse). One
 * function shared by both receive corridors, mirroring the send legs' sharing
 * of `lightningSendVtxoScript`. */
export function receiveVtxoScript(params: {
    /** Binding field #1: the solver's x-only key, from the quote — VHTLC's
     * `sender` role on the receive corridors. */
    solverPubkey: Uint8Array;
    /** Binding field #2: the SOLVER's own refund deadline on these legs, from
     * the quote — after it the solver may reclaim an unclaimed lockup. */
    refundLocktime: number;
    /** The Ark server's x-only key — the trader's OWN connection. */
    serverPubkey: Uint8Array;
    /** `sha256(P)`, hex — the trader's OWN preimage hash. */
    paymentHash: string;
    /** From {@link unilateralClaimDelay} over the trader's OWN server info. */
    claimDelay: number;
    /** Emulator x-only key — see {@link requestLightningSend}'s parameter. */
    emulatorPubkey: Uint8Array;
    /** The solver's covenant refund destination, from the quote
     * (`profile.solver_refund_pk_script`) — the one tree parameter nothing
     * else on the wire determines. */
    solverRefundPkScript: Uint8Array;
    /** The trader's own x-only Arkade key — VHTLC's `receiver` role on these
     * legs, so the trader can claim without covclaimd. */
    payoutPubkey: Uint8Array;
    /** The trader's own Arkade payout pkScript (decoded from its payout
     * address) — `nonInteractiveClaim`'s pinned destination. */
    payoutPkScript: Uint8Array;
    /** LEGACY REBUILD ONLY — see {@link lightningSendVtxoScript}'s `legacy`. */
    legacy?: "preTimelockedRefund";
}): InstanceType<typeof VHTLC.ScriptV2> {
    const seconds = (value: number): { type: "seconds"; value: bigint } => ({
        type: "seconds",
        value: BigInt(value),
    });
    return new VHTLC.ScriptV2({
        sender: params.solverPubkey,
        receiver: params.payoutPubkey,
        server: params.serverPubkey,
        preimageHash: ripemd160(hex.decode(params.paymentHash)),
        refundLocktime: BigInt(params.refundLocktime),
        unilateralClaimDelay: seconds(params.claimDelay),
        unilateralRefundDelay: seconds(unilateralRefundDelay(params.claimDelay)),
        unilateralRefundWithoutReceiverDelay: seconds(
            unilateralRefundWithoutReceiverDelay(params.claimDelay),
        ),
        nonInteractiveParameters: {
            receiverPkScript: params.payoutPkScript,
            senderPkScript: params.solverRefundPkScript,
            emulatorPubkey: params.emulatorPubkey,
            ...(params.legacy !== undefined && { legacy: params.legacy }),
        },
    });
}

/** Every input {@link receiveVtxoScript} builds from; see
 * {@link LightningSendTreeParams}. */
export type LightningReceiveTreeParams = Parameters<typeof receiveVtxoScript>[0];

/**
 * The pure core of {@link requestLightningReceive}: derive the solver-funded
 * covenant locally from the quote's binding fields plus the trader's own data
 * and refuse on any address mismatch. The trader funds nothing on Arkade on
 * this leg — verification is still what makes paying the hold invoice safe:
 * the lockup the solver will fund must be the tree whose claim paths pay the
 * trader.
 */
export function deriveLightningReceive(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    payoutAddress: string;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
}): {
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The solver's hold invoice on `H` — what the trader pays to arm the swap. */
    invoice: string;
    refundLocktime: number;
    /** Every input the covenant was built from — see the same field on
     * `requestLightningSend`'s result for why a consumer needs them. */
    treeParams: LightningReceiveTreeParams;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime;
    const invoice = profile.invoice as string | undefined;
    const solverRefundPkScriptHex = profile.solver_refund_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        invoice === undefined ||
        solverRefundPkScriptHex === undefined
    ) {
        throw new Error("lightning-receive quote is missing a binding field");
    }

    // Named rather than inlined so the exact inputs can be handed back — see
    // `treeParams` on the return type.
    const treeParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        solverRefundPkScript: solverHex(solverRefundPkScriptHex, "profile.solver_refund_pk_script"),
        payoutPubkey: input.payoutPubkey,
        payoutPkScript: ArkAddress.decode(input.payoutAddress).pkScript,
    };
    // Two candidates, one match — see matchQuotedLockup. `treeParams` echoes
    // the MATCHED build, so a record persisted from it rebuilds the lockup
    // the solver actually funded.
    const matched = matchQuotedLockup(quote, input.hrp, input.serverPubkey, (legacy) =>
        receiveVtxoScript({ ...treeParams, ...(legacy !== undefined && { legacy }) }),
    );
    return {
        address: matched.address,
        swapPkScript: matched.script.pkScript,
        script: matched.script,
        invoice,
        refundLocktime,
        treeParams: {
            ...treeParams,
            ...(matched.legacy !== undefined && { legacy: matched.legacy }),
        },
    };
}

/**
 * The `lightning:BTC->arkade:BTC` user flow: quote → derive the covenant
 * locally → verify → gate. Returns the solver's hold invoice to PAY — the
 * payment itself is the trader's own Lightning wallet's job, exactly as
 * funding is the caller's job on the send corridors. Once the paid HTLC is
 * held, the solver funds the lockup; the trader claims it with `P` (its own,
 * generated here) — itself via the collaborative claim leaf
 * ({@link claimReceiveLockup} in `claim.ts`), or via covclaimd if it is
 * offline.
 *
 * Three obligations, all of them before the invoice is handed to a payer:
 *
 * 1. Persist `secrets` and `expectedAmount`. The preimage and the payout key
 *    re-derive from `secrets` (or, on a non-HD wallet, are carried by it), and
 *    without `expectedAmount` the claim has nothing to compare the funded
 *    value against.
 * 2. Stay online. covclaimd cannot claim this covenant today, so the offline
 *    path the claim packet exists for does not run yet: an unclaimed lockup is
 *    reclaimed by the solver at `refund_locktime` and the payer refunded.
 * 3. On {@link LockupRegistrationFailed}, call this function again once the
 *    store is working. The failed attempt is inert — it returned no invoice,
 *    so nothing can be paid into the lockup nobody is watching — and the new
 *    call derives its own preimage and `rfq_id`. Re-registering `error.script`
 *    does NOT resume it: the invoice and `secrets` were never handed back.
 *
 * The invoice is the solver's, so it is verified here against the trader's own
 * `H` and the quote ({@link verifyReceiveInvoice}) before it is returned —
 * nothing publishable comes back from a failed check, registration included.
 * Pay before `invoiceExpiresAt`: the hold-invoice window is minutes, not the
 * quote's `valid_until`.
 */
export async function requestLightningReceive(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** covclaimd's 33-byte compressed pubkey (from its own info endpoint)
         * — the claim packet seals to it and only it can ever read `P` early. */
        covclaimdPubkey: Uint8Array;
        /** The caller's own BOLT11 decoder, applied to the SOLVER's invoice.
         * Required: an optional verifier is one integrators skip, and this is
         * the check whose absence loses the whole payment. */
        decodeInvoice: (bolt11: string) => InvoiceFacts;
        /** Opt-in ceiling, in sats, on what the payer will be asked for. */
        maxPayAmount?: number;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The solver's hold invoice — what the trader pays, for `payAmount`.
     * Verified against this swap's `H` and the quote's `from_amount`. */
    invoice: string;
    /** What the trader pays: the quote's `from_amount`. */
    payAmount: number;
    /** What the solver's lockup must carry: the quote's `to_amount`. Persist
     * it with the record — `pushClaim` refuses to publish `P` for less, and
     * captured at claim time instead it would be whatever the solver funded. */
    expectedAmount: number;
    /** Last moment the invoice can be paid, unix seconds: `min(invoice
     * expiry, valid_until)`. Absolute on purpose — a countdown returned from
     * here is stale before the caller reads it; derive one at display time. */
    invoiceExpiresAt: number;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    payoutAddress: string;
    /** The trader's covenant `receiver` key, bound into the tree. Public. */
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE paying the invoice.
     * Public unless `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
    /** Every input the covenant was built from; see the same field on
     * `requestLightningSend`'s result. */
    treeParams: LightningReceiveTreeParams;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // A leg we claim: the key that receives it, and the P that unlocks it.
    const secrets = await provisionClaimSecret(wallet);
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before paying",
        );
    }
    const preimage = secrets.preimage;
    const paymentHash = hex.encode(secrets.paymentHash);
    const payoutPubkey = secrets.pubkey;
    const [info, payoutAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);
    const claimPacket = await sealClaimPacket({
        preimage,
        covclaimdPubkey: params.covclaimdPubkey,
    });

    const quote = await transport.requestQuote(
        lightningReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress,
            payoutPubkey,
            claimPacket: claimPacket.ciphertext,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const network = getNetwork(info.network as NetworkName);
    const derived = deriveLightningReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
    });
    const now = Math.floor(Date.now() / 1000);
    const { payDeadline } = verifyReceiveInvoice({
        invoice: derived.invoice,
        decode: params.decodeInvoice,
        paymentHash,
        quote,
    });
    assertReceivable({ quote, payDeadline, now, maxPayAmount: params.maxPayAmount });

    // Watch the solver-funded lockup from the moment its address exists.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        invoice: derived.invoice,
        payAmount: quote.from_amount,
        expectedAmount: quote.to_amount,
        invoiceExpiresAt: payDeadline,
        address: derived.address,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        payoutAddress,
        payoutPubkey,
        secrets,
        treeParams: derived.treeParams,
    };
}

/**
 * The pure core of {@link requestOnchainReceive}: derive BOTH contracts
 * locally — the solver-funded Arkade covenant and the L1 HTLC the trader
 * funds — and refuse on any mismatch. Binding: `solver_pubkey`,
 * `refund_locktime`, `claim_pubkey`, `htlc_locktime`, `min_confirmations`;
 * `lockup_address` and `htlc_address` are compare-only.
 */
export function deriveOnchainReceive(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    payoutAddress: string;
    /** The trader's own x-only L1 key — the HTLC's refund role. */
    refundPubkey: Uint8Array;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    l1Network: OnchainNetwork;
}): {
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The L1 HTLC the trader funds, derived locally — fund only this. */
    htlc: OnchainHtlc;
    refundLocktime: number;
    htlcLocktime: number;
    minConfirmations: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime;
    const claimPubkey = profile.claim_pubkey as string | undefined;
    const htlcLocktime = profile.htlc_locktime as number | undefined;
    const htlcAddress = profile.htlc_address as string | undefined;
    const minConfirmations = profile.min_confirmations as number | undefined;
    const solverRefundPkScriptHex = profile.solver_refund_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        claimPubkey === undefined ||
        htlcLocktime === undefined ||
        minConfirmations === undefined ||
        solverRefundPkScriptHex === undefined
    ) {
        throw new Error("onchain-receive quote is missing a binding field");
    }

    const treeParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        solverRefundPkScript: solverHex(solverRefundPkScriptHex, "profile.solver_refund_pk_script"),
        payoutPubkey: input.payoutPubkey,
        payoutPkScript: ArkAddress.decode(input.payoutAddress).pkScript,
    };
    // Two candidates, one match — see matchQuotedLockup.
    const { script, address } = matchQuotedLockup(quote, input.hrp, input.serverPubkey, (legacy) =>
        receiveVtxoScript({ ...treeParams, ...(legacy !== undefined && { legacy }) }),
    );

    const htlc = onchainHtlcScript(
        {
            paymentHash: input.paymentHash,
            claimKey: toXOnly(hex.decode(claimPubkey), "solver L1 claim key"),
            refundKey: input.refundPubkey,
            refundLocktime: htlcLocktime,
        },
        input.l1Network,
    );
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
    };
}

/**
 * The `onchain:BTC->arkade:BTC` user flow: quote → derive BOTH contracts
 * locally → verify → gate. Returns the L1 HTLC to fund (`htlc.address`, for
 * `fundAmount`) — the funding transaction itself is the trader's own L1
 * wallet's job, exactly as on the send corridors. After `min_confirmations`
 * the solver funds the Arkade lockup; the trader claims it with `P` (its
 * own), itself or via covclaimd.
 *
 * Persist `secrets` BEFORE funding, and note the direction's own deadline:
 * if the swap never settles, the L1 HTLC's refund leaf (the trader's
 * `refundPubkey`) opens at `htlc.refundLocktime` — `buildHtlcRefund` takes it
 * back from there.
 */
export async function requestOnchainReceive(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** Trader's x-only L1 key for the HTLC's refund leaf. */
        refundPubkey: Uint8Array;
        /** covclaimd's 33-byte compressed pubkey — see {@link requestLightningReceive}. */
        covclaimdPubkey: Uint8Array;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    /** What the trader's L1 funding must carry: the quote's `from_amount`. */
    fundAmount: number;
    /** What the solver's lockup must carry: the quote's `to_amount`. Persist
     * it with the record — see {@link requestLightningReceive}. */
    expectedAmount: number;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The EXPECTED L1 contract, derived locally — fund only this address. */
    htlc: OnchainHtlc;
    payoutAddress: string;
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE funding. Public unless
     * `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // A leg we claim: the key that receives it, and the P that unlocks it.
    const secrets = await provisionClaimSecret(wallet);
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before funding",
        );
    }
    const preimage = secrets.preimage;
    const paymentHash = hex.encode(secrets.paymentHash);
    const payoutPubkey = secrets.pubkey;
    const [info, payoutAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);
    const claimPacket = await sealClaimPacket({
        preimage,
        covclaimdPubkey: params.covclaimdPubkey,
    });

    const quote = await transport.requestQuote(
        onchainReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress,
            payoutPubkey,
            refundPubkey: params.refundPubkey,
            claimPacket: claimPacket.ciphertext,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const network = getNetwork(info.network as NetworkName);
    const derived = deriveOnchainReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        refundPubkey: params.refundPubkey,
        serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
        l1Network: l1NetworkFromArk(info.network),
    });
    assertFundable({
        quote,
        now: Math.floor(Date.now() / 1000),
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "receive",
        },
    });

    // Watch the solver-funded lockup from the moment its address exists.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        address: derived.address,
        fundAmount: quote.from_amount,
        expectedAmount: quote.to_amount,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        htlc: derived.htlc,
        payoutAddress,
        payoutPubkey,
        secrets,
    };
}
