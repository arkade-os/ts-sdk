/**
 * The RFQ wire's amount encoding, and the one place the wire's side vocabulary is
 * translated.
 *
 * The wire contract is canonical decimal strings; this emits strings unconditionally and
 * accepts either on the way in, a JSON number only while it is a non-negative safe
 * integer. Past 2^53 a JSON number has already lost the amount, so it is refused
 * ({@link AmountEncodingUnsupported}), never rounded.
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
 * @param field - Named in the error, to tell `from_amount` from `to_amount`.
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
 * An amount in from the wire: the canonical string, or a JSON number inside the
 * safe-integer window (the only place v2 tolerates a number).
 *
 * @throws {@link AmountEncodingUnsupported} for a non-canonical string too; this fires
 * before verification's semantic checks, not as one of them.
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
 * A `bigint` amount into a foreign `number` one, checked rather than a bare `Number()`
 * (a sat count past 2^53 is not a payment, so refusing it is sound).
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
