/**
 * Verification and assertion helpers for the RFQ corridors.
 *
 * These are the user-side gates checked before funding or paying an invoice.
 * None of them touch the transport layer — they are pure of network I/O.
 */
import {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    ONCHAIN_SECONDS_PER_BLOCK,
} from "./onchainHtlc";
import type { RfqQuote } from "./rfq";

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

/** The solver's address does not match the local derivation. NEVER fund past this. */
export class AddressMismatch extends Error {
    readonly derived: string;
    readonly quoted: string | undefined;
    constructor(derived: string, quoted?: string) {
        super("solver lockup address does not match local derivation — refusing to fund");
        this.name = "AddressMismatch";
        this.derived = derived;
        this.quoted = quoted;
    }
}

// ── Guardrail constants ──────────────────────────────────────────────────────

/** Funding gate: refuse unless ≥90 min remain before the refund path opens.
 * 90 because the refund CLTV matures against median-time-past (BIP-113),
 * which lags wall clock by ~1h — a smaller wall-clock margin is no margin. */
export const MIN_HEADROOM_SECONDS = 90 * 60;

/** Default floor for the window between the last moment the hold invoice can
 * be paid and the solver's refund leaf opening. */
export const MIN_CLAIM_WINDOW_SECONDS = 30 * 60;

// ── BOLT11 facts ─────────────────────────────────────────────────────────────

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

// ── Gate helpers (private) ───────────────────────────────────────────────────

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

// ── Exported verification functions ─────────────────────────────────────────

/** Compare-only check of the solver's address against YOUR derivation.
 * Throws {@link AddressMismatch}; returns the address so calls chain. */
export const verifyLockupAddress = (quote: RfqQuote, derivedAddress: string): string => {
    const quoted = quote.profile?.lockup_address;
    if (derivedAddress !== quoted) throw new AddressMismatch(derivedAddress, quoted);
    return derivedAddress;
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

/**
 * Bind the SOLVER's hold invoice to the quote and to the trader's own `H`.
 *
 * This is the only field the trader hands to a third party, and the only
 * attack on this corridor with no on-chain trace: an invoice on some other
 * payment hash is paid to the solver in full and no lockup on `H` is ever
 * funded. NEVER publish an invoice that has not passed this.
 *
 * The decoder is injected — `@arkade-os/swap` takes no BOLT11 dependency — but
 * unlike `requestLightningSend`, which takes the caller's facts about
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
