/**
 * The amount law: `bigint` atomic units in memory, decimal strings at the edges, and exactly two
 * conversion sites — this module and the RFQ adapter beside it.
 *
 * Two decimal strings must never be conflated. The *scaled* decimal (`"0.01"` BTC) is human-facing,
 * produced and consumed only by {@link Amount.parse}/{@link Amount.format}. The *atomic-unit* decimal
 * is what records and the wire hold — the `bigint` written out, never scaled. {@link AtomicDecimal}
 * is branded so `Amount.parse(record.fromAmount, btc)` (reading `"10000"` sats as 10,000 BTC) is a
 * compile error; the display side is unbranded since it arrives from text inputs.
 *
 * Arithmetic delegates to discovery's `toAtomic`/`fromAtomic`; this module is the narrower door:
 * that codec accepts a JS `number`, exponents, `+` and whitespace, and a `100000` meaning sats is the
 * v1 defect that quoted 100,000 BTC. After these checks the delegated call cannot throw.
 */
import {
    AMOUNT_PATTERN,
    MAX_ASSET_DECIMALS,
    fromAtomic,
    isAmount,
    toAtomic,
} from "@arkade-os/solver-discovery";

/** What the codec needs from an asset. Structural, so discovery's `AssetInfo` satisfies it. */
export interface AssetScale {
    decimals: number;
}

declare const ATOMIC_DECIMAL: unique symbol;

/** Atomic units written out: the form records and the wire hold. */
export type AtomicDecimal = string & { readonly [ATOMIC_DECIMAL]: true };

/** A string that is provably not an {@link AtomicDecimal}; plain strings qualify. */
export type DisplayDecimal = string & { readonly [ATOMIC_DECIMAL]?: never };

/** Why an amount was refused. */
export type AmountRefusal =
    | "not_decimal"
    | "negative"
    | "too_precise"
    | "too_large"
    | "invalid_decimals"
    | "not_canonical";

/**
 * An amount that cannot be represented in the form asked for. Not a `SwapError` (that taxonomy is
 * the client's, thrown before value moves); the wire's compatibility failure is
 * `AmountEncodingUnsupported`, in `rfqAmount.ts`.
 */
export class AmountFormatError extends Error {
    override readonly name = "AmountFormatError";
    constructor(
        readonly reason: AmountRefusal,
        message: string,
    ) {
        super(message);
    }
}

/** Unsigned, digits on both sides of any point. No sign, no exponent, no space. */
const SCALED_DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;

/** One past the largest amount `AMOUNT_PATTERN`'s 30 digits can hold. */
const ATOMIC_CEILING = 10n ** 30n;

/** Discovery's own significant-digit bound, checked here so its codec is total. */
const MAX_SIGNIFICANT_DIGITS = 64;

const assertDecimals = (decimals: number): void => {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
        throw new AmountFormatError(
            "invalid_decimals",
            `decimals must be an integer in [0, ${MAX_ASSET_DECIMALS}], got ${decimals}`,
        );
    }
};

const assertRepresentable = (value: bigint, what: string): void => {
    if (value >= ATOMIC_CEILING) {
        throw new AmountFormatError(
            "too_large",
            `${what} does not fit the canonical 30-digit encoding`,
        );
    }
};

export const Amount = {
    /**
     * A human decimal into atomic units.
     *
     * `string` only, no exponent: a `number` makes `100000` ambiguous between sats and BTC, and the
     * ambiguity resolves only after funding. Refuses rather than rounds input finer than the asset
     * (a truncated amount is a swap for the wrong size), and refuses results that would not survive
     * the record boundary.
     */
    parse(display: DisplayDecimal, asset: AssetScale): bigint {
        assertDecimals(asset.decimals);
        const parts = SCALED_DECIMAL.exec(display);
        if (!parts) {
            throw new AmountFormatError(
                "not_decimal",
                `not an unsigned decimal amount: ${JSON.stringify(display)}` +
                    " (write 0.5, not .5; no sign, exponent, separator or space)",
            );
        }
        const [, whole, fraction = ""] = parts;
        if (fraction.length > asset.decimals) {
            throw new AmountFormatError(
                "too_precise",
                `${display} has more precision than ${asset.decimals} decimals allow`,
            );
        }
        if (whole.length + fraction.length > MAX_SIGNIFICANT_DIGITS) {
            throw new AmountFormatError("too_large", `${display} has too many digits`);
        }
        const value = toAtomic(display, asset.decimals);
        assertRepresentable(value, `${display} at ${asset.decimals} decimals`);
        return value;
    },

    /** Atomic units into a human decimal, trailing zeros trimmed. Refuses a negative: every amount
     * here is an obligation, so a negative one is an upstream defect. */
    format(value: bigint, asset: AssetScale): string {
        assertDecimals(asset.decimals);
        if (value < 0n) {
            throw new AmountFormatError("negative", `amount must be non-negative, got ${value}`);
        }
        assertRepresentable(value, `${value}`);
        return fromAtomic(value, asset.decimals);
    },
};

/**
 * Atomic units into the canonical decimal string records and the wire hold:
 * discovery's `AMOUNT_PATTERN` — unsigned, no leading zeros, at most 30 digits.
 */
export const toAtomicDecimal = (value: bigint): AtomicDecimal => {
    if (value < 0n) {
        throw new AmountFormatError("negative", `amount must be non-negative, got ${value}`);
    }
    assertRepresentable(value, `${value}`);
    return value.toString() as AtomicDecimal;
};

/** The canonical decimal string back into atomic units. Takes a plain `string`, as record reads and
 * `JSON.parse` hand back, so the safe direction needs no cast. */
export const fromAtomicDecimal = (text: string): bigint => {
    if (!isAmount(text)) {
        throw new AmountFormatError(
            "not_canonical",
            `not a canonical atomic amount: ${JSON.stringify(text)}`,
        );
    }
    return BigInt(text);
};

/** Whether `value` is already in the canonical atomic form. */
export const isAtomicDecimal = (value: unknown): value is AtomicDecimal =>
    typeof value === "string" && AMOUNT_PATTERN.test(value);
