/**
 * The RFQ wire's amount encoding, and the one place the wire's side vocabulary
 * is translated.
 *
 * The target contract is canonical decimal strings in both directions, and the
 * solver already landed them; ts-sdk is the lagging side and still emits and
 * reads JSON numbers (`rfq.ts`'s `amount`, `from_amount`, `to_amount`). So this
 * adapter emits strings unconditionally — emitting one is never a narrowing —
 * and accepts either on the way in, a number only while it is a non-negative
 * safe integer. Past 2^53 a JSON number has already lost the amount and there is
 * nothing to narrow: {@link AmountEncodingUnsupported}, refused rather than
 * rounded.
 */
import { isAmount } from "@arkade-os/solver-discovery";
import { type AtomicDecimal, toAtomicDecimal } from "./amount";
import { AmountEncodingUnsupported } from "./errors";

/** Which side of the trade an amount pins, in v2's vocabulary. */
export type AmountOn = "give" | "take";

/** The same axis on the wire, where the key is `amount_side`. */
export type RfqAmountSide = "from" | "to";

/** v2 to the wire. One translation point, so the rename cannot spread. */
export const toRfqAmountSide = (on: AmountOn): RfqAmountSide => (on === "give" ? "from" : "to");

/** The wire back to v2. */
export const fromRfqAmountSide = (side: RfqAmountSide): AmountOn =>
    side === "from" ? "give" : "take";

/**
 * An amount out to the wire, as the canonical decimal string.
 *
 * `field` has no default: every throw on a quote would otherwise say `"amount"`,
 * and telling `from_amount` from `to_amount` is the only thing it is for.
 */
export const encodeRfqAmount = (value: bigint, field: string): AtomicDecimal => {
    try {
        return toAtomicDecimal(value);
    } catch (cause) {
        throw new AmountEncodingUnsupported(
            field,
            `${value}`,
            "the wire's canonical encoding cannot carry it",
            { cause },
        );
    }
};

/**
 * An amount in from the wire.
 *
 * Accepts the canonical string, or a JSON number inside the safe-integer window
 * — the migration's compatibility arm, and the only place a number is tolerated
 * anywhere in v2. A non-canonical string is this error too, not a verification
 * failure: verification is the four semantic checks over a well-formed quote,
 * and this fires before them.
 */
export const decodeRfqAmount = (raw: unknown, field: string): bigint => {
    if (typeof raw === "string") {
        if (!isAmount(raw)) {
            throw new AmountEncodingUnsupported(
                field,
                raw,
                "not a canonical decimal amount (unsigned, no leading zeros, 30 digits)",
            );
        }
        return BigInt(raw);
    }
    if (typeof raw === "number") {
        if (!Number.isSafeInteger(raw) || raw < 0) {
            throw new AmountEncodingUnsupported(
                field,
                `${raw}`,
                // Past 2^53 the number arrived already rounded — there is no
                // "narrow carefully" branch, only a wrong amount.
                "a JSON number amount is only readable as a non-negative safe integer",
            );
        }
        return BigInt(raw);
    }
    throw new AmountEncodingUnsupported(
        field,
        typeof raw === "bigint" || typeof raw === "boolean" ? `${raw}` : String(raw),
        `expected a decimal string, got ${typeof raw}`,
    );
};

/**
 * A `bigint` amount into a foreign `number` one, checked.
 *
 * Core's payment router types its amounts as `number` sats and M7's swap-backed
 * rail narrows at that boundary rather than changing a published core type. The
 * narrowing is sound because both sides are sats and a sat count past 2^53 is
 * not a payment — but it has to be checked, which is why it lives here beside
 * the error rather than as a bare `Number()` at the call site.
 */
export const toSafeNumber = (value: bigint, field: string): number => {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new AmountEncodingUnsupported(
            field,
            `${value}`,
            "does not fit a non-negative safe integer",
        );
    }
    return Number(value);
};
