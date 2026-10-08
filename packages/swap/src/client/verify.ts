/**
 * Quote verification as one invariant: every check runs once, on both backends, before any quote
 * is returned, and every failure is one error class naming the check.
 *
 * The gates themselves stay `rfq.ts`'s (audited, and carrying the covenant-mirroring timing
 * constants); this only maps a gate's stable `reason` to a {@link QuoteCheck}.
 *
 * Two failures are deliberately NOT verification failures: a solver declining is `SwapRefusal`,
 * and an expired or expiring quote is `QuoteExpired` (the remedy is a fresh quote, not a
 * different solver).
 */
import {
    AddressMismatch,
    assertFundable,
    assertReceivable,
    type InvoiceFacts,
    quoteCarrierSats,
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
 * Absent on purpose: `quote_expired` (becomes {@link QuoteExpired}), `invalid_gate_input` (a NaN
 * clock or ceiling from the CLIENT, our bug, not the solver's), and `price_too_high` (an opt-in
 * price veto, raised as `MaxFeeExceeded`, not a fault in the quote).
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
 * Run here, not left to the transport, so swapping in a different transport cannot disable it.
 * Addressed mode only: published RFQ attributes each bid by its own signature.
 *
 * `pinnable` is the trust boundary: a cached card's `discovery_pubkey` is unvalidated (anyone with
 * write access to browser storage could choose it), so a cache-sourced key fails closed.
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
 * The pair check, run here as well as in the transport's `expectQuote`, so a transport that skips
 * it (or one a caller injected) cannot make the quote path skip it too.
 */
export const verifyPair = (quoted: unknown, requested: string): void => {
    if (quoted !== requested) {
        throw new QuoteVerificationFailed("pair", requested, String(quoted));
    }
};

/**
 * Derive the covenant, and fold every way that can fail into the `lockup_address` check.
 *
 * `AddressMismatch` is that check under its v1 name; a missing binding field or malformed solver
 * hex is the same check reached earlier. All mean "do not fund this".
 */
export const verifyingDerivation = <T>(derive: () => T): T => {
    try {
        return derive();
    } catch (error) {
        if (error instanceof AddressMismatch) {
            // Plural when the derivation is ambiguous: every candidate disagreed. Array stays on
            // `cause`.
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
 * `refund_locktime` is the SOLVER's here, so BIP-113 lag extends the trader's claim window; what
 * can run out is the hold invoice, so the window that matters is after a last-moment payment.
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
 * The invoice check on a send: `to_amount` must equal the invoice amount (BOLT11 is exact-out),
 * and `from_amount` below it is a negative spread.
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
 * The one attack on this corridor with no on-chain trace: an invoice on another payment hash is
 * paid to the solver in full and no lockup on `H` is ever funded. Not delegated to
 * `verifyReceiveInvoice`, which compares against `quote.from_amount` as a JS number; mid amount
 * migration that field may be a string, and `!==` would refuse every migrated solver.
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
    // NaN fails every comparison, so it would delete every downstream gate rather than fail one.
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
 * The policy floor on a quote's remaining life: refuses terms that will expire before the caller
 * can use them. With no floor set, only expiry itself refuses.
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
 * The quote answers the request that was made: the pinned side must not be repriced.
 *
 * Reported as the `pair` check, since the trade's identity on the wire is the pair plus the pinned
 * side; {@link QuoteCheck} gains no member for it.
 */
export const verifyQuotedAmount = (input: {
    readonly pair: string;
    readonly pinned: { on: "give" | "take"; value: bigint };
    readonly give: bigint;
    readonly take: bigint;
}): void => {
    verifyPinnedAmount(input);
    if (input.take > input.give) {
        // On every corridor the two legs are the same asset, so paying out more is never fundable.
        throw new QuoteVerificationFailed(
            "pair",
            `${input.pair} give >= take`,
            `give=${input.give} take=${input.take}`,
        );
    }
};

/**
 * The quote answers the request, on a pair whose two legs carry **different
 * assets**.
 *
 * Everything {@link verifyQuotedAmount} establishes except the one check that
 * does not survive the change of asset: `take > give` is a mispricing when both
 * legs are BTC and is the normal shape of a trade when they are not — 10_000
 * sats for 1_000 cents reads one way round, and the reverse trade reads the
 * other. Comparing them would refuse a correct quote on one direction of every
 * asset market, which is why this is a separate function rather than a flag.
 *
 * What replaces it is positivity on both legs: a zero payout is not a trade,
 * and it is the only cross-asset statement about the two numbers that means
 * anything without a price.
 */
export const verifyCrossAssetAmount = (input: {
    readonly pair: string;
    readonly pinned: { on: "give" | "take"; value: bigint };
    readonly give: bigint;
    readonly take: bigint;
}): void => {
    verifyPinnedAmount(input);
    if (input.give <= 0n || input.take <= 0n) {
        throw new QuoteVerificationFailed(
            "pair",
            `${input.pair} give > 0 take > 0`,
            `give=${input.give} take=${input.take}`,
        );
    }
};

/**
 * The solver's carrier for an asset deposit, well-formed. Reported as the `pair` check, like the
 * amounts: it is sats the trader funds on top of the quoted give leg.
 */
export const verifiedCarrierSats = (quote: RfqQuote): bigint => {
    try {
        return quoteCarrierSats(quote);
    } catch (error) {
        if (reasonOf(error) !== "carrier_malformed") throw error;
        throw new QuoteVerificationFailed(
            "pair",
            "carrier_sats a non-negative integer",
            String(quote.carrier_sats),
            { cause: error },
        );
    }
};

/** The quote priced the side the request pinned, at the size it pinned. */
const verifyPinnedAmount = (input: {
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
};
