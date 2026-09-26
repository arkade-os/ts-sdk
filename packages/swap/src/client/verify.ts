/**
 * Verification, as one invariant instead of four scattered habits.
 *
 * v1 spreads these checks across four request entrypoints and reaches the offer
 * path with none of them: `expectQuote` compares type, id and pair;
 * `verifyLockupAddress` compares the derived address; `assertFundable`,
 * `verifyReceiveInvoice` and `assertReceivable` gate expiry, headroom and the
 * claim window on some legs and not others; and the docs push the rest — plan
 * validation, the rendezvous choice, the invoice decode — onto the caller. This
 * module runs the whole set, once, on both backends, before any quote is
 * returned, and every failure is one error class with the check named on it.
 *
 * The gates themselves are still `rfq.ts`'s. They are audited, they carry the
 * constants (`MIN_HEADROOM_SECONDS`, `MIN_CLAIM_WINDOW_SECONDS`) that mirror the
 * covenant's own timing, and re-implementing them here would be a second
 * opinion where the whole point is that there is one. What this adds is the
 * mapping: a gate's stable `reason` becomes a {@link QuoteCheck}, so a caller
 * switches on the check rather than on a string the wire's own vocabulary
 * leaked.
 *
 * Two failures deliberately do NOT become verification failures. A solver
 * declining is `SwapRefusal` — a decision, not a fault. And a quote that has
 * expired, or is about to, is `QuoteExpired`: the terms were fine, the clock is
 * the problem, and the remedy is a fresh quote rather than a different solver.
 */
import {
    AddressMismatch,
    assertFundable,
    assertReceivable,
    type InvoiceFacts,
    type RfqQuote,
} from "../rfq";
import { QuoteExpired, QuoteVerificationFailed, type QuoteCheck } from "./errors";
import type { Pubkey } from "./primitives";
import type { QuoteId } from "./quote";

/** A gate error, as `rfq.ts` throws it: an `Error` with a stable `reason`. */
const reasonOf = (error: unknown): string | undefined =>
    error instanceof Error && typeof (error as { reason?: unknown }).reason === "string"
        ? (error as unknown as { reason: string }).reason
        : undefined;

/**
 * Which check a gate's refusal belongs to.
 *
 * `quote_expired` is absent on purpose — it is not a check at all, and is
 * turned into {@link QuoteExpired} before this table is consulted. So is
 * `invalid_gate_input`: that fires when the CLIENT hands a gate a `NaN` clock or
 * ceiling, which is a defect here rather than anything the solver did, and
 * mapping it to a check would blame the counterparty for our own bug.
 *
 * And so is `price_too_high`, on a third ground: a ceiling the caller opted
 * into is a veto on the price, not a fault in the quote. §3.1's checks have no
 * member for one — v2's price ceiling is the verbs' `maxFee`, raised as
 * `MaxFeeExceeded` — so an entry here could only file it under a timing
 * failure, which is the wrong axis and the wrong remedy.
 */
const CHECK_BY_REASON: Record<string, QuoteCheck> = {
    invoice_expired: "invoice",
    invoice_undecodable: "invoice",
    invoice_hash_mismatch: "invoice",
    invoice_amount_mismatch: "invoice",
    insufficient_headroom: "refund_window",
    missing_refund_locktime: "refund_window",
    claim_window_too_short: "refund_window",
    confirmations_out_of_range: "refund_window",
    timelock_order: "refund_window",
    quote_malformed: "refund_window",
};

/** Run a gate, and turn whatever it refuses with into this taxonomy. */
const gated = (run: () => void, quote: { id: QuoteId; expiresAt: number; now: number }): void => {
    try {
        run();
    } catch (error) {
        const reason = reasonOf(error);
        if (reason === "quote_expired") {
            throw new QuoteExpired(quote.id, quote.expiresAt, quote.now);
        }
        const check = reason === undefined ? undefined : CHECK_BY_REASON[reason];
        if (check === undefined) throw error;
        throw new QuoteVerificationFailed(
            check,
            undefined,
            error instanceof Error ? error.message : String(error),
            { cause: error },
        );
    }
};

/**
 * The fifth check: who answered.
 *
 * §3.1 calls this a transport property rather than one of the four, and it is —
 * but a property only the production transport happens to have is a check the
 * caller can turn off by handing in a different transport, and verification that
 * configuration can disable is not an invariant. So the transport delivers the
 * attestation and this runs it, in addressed mode only: published RFQ has N
 * unknown responders and attributes each bid by its own signature instead.
 *
 * `pinnable` is the trust boundary the cache leaves. The key this compares
 * against is the card's `discovery_pubkey`, which a cached card carries
 * unvalidated — so a snapshot read back out of local storage cannot supply it,
 * and the check fails closed rather than pinning against content anyone with
 * write access to the browser's storage could have chosen.
 */
export const verifyResponder = (input: {
    /** The key this transport proves every reply came from, if it proves one. */
    readonly attested?: Pubkey;
    /** The card's `discovery_pubkey`. */
    readonly expected?: Pubkey;
    /** Whether `expected` came from a source that can be trusted to name it. */
    readonly pinnable: boolean;
}): void => {
    if (!input.pinnable || input.expected === undefined) {
        throw new QuoteVerificationFailed(
            "responder",
            "a registry-served card naming the solver's discovery key",
            input.expected === undefined
                ? "the card names no discovery key"
                : "the card came out of the local cache, which does not authenticate it",
        );
    }
    if (input.attested === undefined) {
        throw new QuoteVerificationFailed(
            "responder",
            input.expected,
            "the transport attests nobody",
        );
    }
    if (input.attested !== input.expected) {
        throw new QuoteVerificationFailed("responder", input.expected, input.attested);
    }
};

/**
 * The pair check, run here as well as in the transport.
 *
 * `expectQuote` already compares it — this is not a gap being filled but the
 * layer that OWNS the string doing its own comparison, so a transport that
 * skips the check (or one a caller injected) cannot make the quote path skip it
 * too. v1 documented this one as the caller's job, in bold.
 */
export const verifyPair = (quoted: unknown, requested: string): void => {
    if (quoted !== requested) {
        throw new QuoteVerificationFailed("pair", requested, String(quoted));
    }
};

/**
 * Derive the covenant, and fold every way that can fail into one check.
 *
 * `AddressMismatch` is the case §8 promised would fold in here: it is the
 * `lockup_address` check under its v1 name, and keeping it as a seventeenth
 * error would leave two classes for one condition across the v1/v2 seam. The
 * other failures — a missing binding field, malformed hex from the solver — are
 * the same check reached from further back: an address that cannot be derived
 * cannot be compared, and both mean the same thing to a caller, which is do not
 * fund this.
 */
export const verifyingDerivation = <T>(derive: () => T): T => {
    try {
        return derive();
    } catch (error) {
        if (error instanceof AddressMismatch) {
            // `derived` is plural whenever the derivation itself is ambiguous —
            // every candidate shape tried. All of them are what disagreed, so
            // all of them go in `expected`; the array stays on the `cause`.
            const derived = Array.isArray(error.derived) ? error.derived.join(", ") : error.derived;
            throw new QuoteVerificationFailed("lockup_address", derived, error.quoted, {
                cause: error,
            });
        }
        if (error instanceof Error) {
            throw new QuoteVerificationFailed("lockup_address", undefined, error.message, {
                cause: error,
            });
        }
        throw error;
    }
};

/**
 * The send legs' window gate: the quote's own expiry, the refund headroom, and
 * — on `arkade -> onchain` — the L1 confirmation window and the timelock order
 * between the two contracts.
 */
export const verifySendWindow = (input: {
    readonly quote: RfqQuote;
    readonly quoteId: QuoteId;
    readonly now: number;
    readonly invoiceExpiresAt?: number;
    readonly onchain?: {
        htlcLocktime: number;
        minConfirmations: number;
        direction: "send" | "receive";
    };
}): void => {
    gated(
        () =>
            assertFundable({
                quote: input.quote,
                now: input.now,
                ...(input.invoiceExpiresAt === undefined
                    ? {}
                    : { invoiceExpiresAt: input.invoiceExpiresAt }),
                ...(input.onchain === undefined ? {} : { onchain: input.onchain }),
            }),
        { id: input.quoteId, expiresAt: input.quote.valid_until, now: input.now },
    );
};

/**
 * The receive legs' window gate, measured from the pay deadline rather than
 * from now.
 *
 * The semantics invert on these legs: `refund_locktime` is the SOLVER's, so
 * BIP-113's lag extends the trader's claim window instead of shrinking it, and
 * what can actually run out is the hold invoice. The window that matters is
 * therefore the one left after a payer pays at the last possible moment.
 */
export const verifyReceiveWindow = (input: {
    readonly quote: RfqQuote;
    readonly quoteId: QuoteId;
    readonly payDeadline: number;
    readonly now: number;
}): void => {
    gated(
        () =>
            assertReceivable({
                quote: input.quote,
                payDeadline: input.payDeadline,
                now: input.now,
            }),
        { id: input.quoteId, expiresAt: input.payDeadline, now: input.now },
    );
};

/**
 * The invoice check on a send: the solver quoted THIS invoice, and quoted it at
 * a price that is a price.
 *
 * Both halves matter. A quote whose `to_amount` is not the invoice's amount is
 * not a quote for this invoice — the BOLT11 profile is exact-out and the
 * invoice is the amount pin. A `from_amount` below it is a negative spread,
 * which is not a quote at all.
 */
export const verifySendInvoice = (input: {
    /** The amount the trader's own decode read off the invoice. */
    readonly invoiced: bigint;
    readonly give: bigint;
    readonly take: bigint;
}): void => {
    const invoiced = input.invoiced;
    if (input.take !== invoiced) {
        throw new QuoteVerificationFailed("invoice", `${invoiced}`, `${input.take}`);
    }
    if (input.give < input.take) {
        throw new QuoteVerificationFailed(
            "invoice",
            `at least the invoice's ${invoiced}`,
            `${input.give}, a negative spread`,
        );
    }
};

/**
 * The invoice check on a receive: bind the SOLVER's hold invoice to this swap's
 * hash and to the quote.
 *
 * This is the only field the trader hands to a third party and the only attack
 * on this corridor with no on-chain trace — an invoice on some other payment
 * hash is paid to the solver in full and no lockup on `H` is ever funded. It is
 * re-implemented here rather than delegated to `verifyReceiveInvoice` for one
 * reason: that gate compares the decoded amount against `quote.from_amount` as a
 * JS number, and under the amount migration that field arrives as either a
 * number or a string. A `!==` between a string and a number is always true, and
 * a check that always fails is not safer than one that compares the decoded
 * bigint — it just refuses every quote from a solver that already migrated.
 */
export const verifyReceiveInvoiceFacts = (input: {
    readonly invoice: string;
    readonly decode: (bolt11: string) => InvoiceFacts;
    /** `sha256(P)`, hex — the trader's OWN. */
    readonly paymentHash: string;
    /** The quote's `from_amount`: what the payer is asked for. */
    readonly payAmount: bigint;
    readonly validUntil: number;
}): { payDeadline: number } => {
    let decoded: InvoiceFacts;
    try {
        decoded = input.decode(input.invoice);
    } catch (cause) {
        throw new QuoteVerificationFailed(
            "invoice",
            "a decodable BOLT11",
            cause instanceof Error ? cause.message : String(cause),
            { cause },
        );
    }
    // Both operands of the deadline, before either reaches it: a decoder that
    // reports a missing expiry tag as NaN, or a `valid_until` that was never
    // typechecked, would disarm every gate downstream — NaN fails every
    // comparison, so it does not fail a check, it deletes one.
    if (!Number.isFinite(decoded.expiresAt)) {
        throw new QuoteVerificationFailed("invoice", "a finite expiry", `${decoded.expiresAt}`);
    }
    if (!Number.isFinite(input.validUntil)) {
        throw new QuoteVerificationFailed(
            "refund_window",
            "a finite valid_until",
            `${input.validUntil}`,
        );
    }
    if (decoded.paymentHash !== input.paymentHash) {
        throw new QuoteVerificationFailed("invoice", input.paymentHash, decoded.paymentHash);
    }
    // BOLT11 permits an amountless invoice, which lets a payer pay anything;
    // decoders surface that as 0, so a nullish check would miss it.
    if (!Number.isSafeInteger(decoded.amountSats) || decoded.amountSats <= 0) {
        throw new QuoteVerificationFailed(
            "invoice",
            `${input.payAmount}`,
            "the invoice names no amount",
        );
    }
    if (BigInt(decoded.amountSats) !== input.payAmount) {
        throw new QuoteVerificationFailed("invoice", `${input.payAmount}`, `${decoded.amountSats}`);
    }
    return { payDeadline: Math.min(decoded.expiresAt, input.validUntil) };
};

/**
 * The policy floor on a quote's remaining life.
 *
 * One layer above the wire's own refusal of a quote already past `valid_until`:
 * that one says the terms are dead, this one says they will be before the caller
 * can use them. Only the caller knows how long their flow takes between seeing
 * terms and accepting them, so the floor is theirs to set — and with none set,
 * only expiry itself refuses.
 */
export const verifyQuoteTtl = (input: {
    readonly quoteId: QuoteId;
    readonly expiresAt: number;
    readonly now: number;
    readonly floorSeconds?: number;
}): void => {
    const floor = input.floorSeconds ?? 0;
    if (input.expiresAt - input.now <= floor) {
        throw new QuoteExpired(input.quoteId, input.expiresAt, input.now);
    }
};

/**
 * The quote answers the request that was made.
 *
 * `expectQuote` compares the pair, which says the quote is for this market;
 * this says it is for this trade. The request names a side and an amount, and a
 * quote that reprices the side the caller pinned is a quote for a different
 * size — v1 checks it on two legs out of four and calls it `assertQuotedAmount`.
 *
 * It reports as the `pair` check rather than as a fifth-and-a-half one, because
 * what it establishes is the same thing: the identity of the trade being
 * quoted, which on the wire is the pair plus the pinned side. The closed
 * {@link QuoteCheck} union gains no member for it, and the strings say exactly
 * what disagreed.
 */
export const verifyQuotedAmount = (input: {
    readonly pair: string;
    readonly pinned: { on: "give" | "take"; value: bigint };
    readonly give: bigint;
    readonly take: bigint;
}): void => {
    const quoted = input.pinned.on === "give" ? input.give : input.take;
    if (quoted !== input.pinned.value) {
        throw new QuoteVerificationFailed(
            "pair",
            `${input.pair} ${input.pinned.on}=${input.pinned.value}`,
            `${input.pair} ${input.pinned.on}=${quoted}`,
        );
    }
    if (input.take > input.give) {
        // A quote that pays out more than it takes in is not a quote to fund:
        // on every corridor these two legs are the same asset.
        throw new QuoteVerificationFailed(
            "pair",
            `${input.pair} give >= take`,
            `give=${input.give} take=${input.take}`,
        );
    }
};
