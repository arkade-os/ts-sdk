/**
 * The amount law: `bigint` atomic units in memory, decimal strings at the
 * edges, and exactly two conversion sites — this module and the RFQ adapter
 * beside it.
 *
 * Two different decimal strings live at those edges and conflating them is how
 * the v1 units footgun comes back. The *scaled* decimal is human-facing and only
 * {@link Amount.parse} and {@link Amount.format} produce or consume it: `"0.01"`
 * BTC, read against the asset's `decimals`. The *atomic-unit* decimal is what
 * records and the wire hold — the same integer the `bigint` carries, written
 * out, never scaled. Records and the RFQ wire take the second form and never the
 * first, which is why there is no display-amount code path to deprecate later.
 *
 * {@link AtomicDecimal} is branded, so the confusion that actually loses money —
 * `Amount.parse(record.fromAmount, btc)`, reading `"10000"` sats as 10,000 BTC —
 * is a compile error rather than a comment. The display side is not branded: it
 * arrives from a text input as a plain `string`, and requiring a constructor
 * there would tax every UI caller for nothing.
 *
 * The exact arithmetic is discovery's `toAtomic` / `fromAtomic`, not a second
 * implementation. What this module adds is the narrower door: discovery's codec
 * accepts a JS `number`, scientific notation, a leading `+` and surrounding
 * whitespace, and a display amount arriving as `100000` meaning sats is exactly
 * the v1 defect where it quoted 100,000 BTC. Validate here, delegate there —
 * after this module's checks the delegated call cannot throw.
 */
import {
    AMOUNT_PATTERN,
    MAX_ASSET_DECIMALS,
    fromAtomic,
    isAmount,
    toAtomic,
} from "@arkade-os/solver-discovery";

/**
 * What the codec needs from an asset, and nothing else. Structural, so
 * discovery's `AssetInfo` satisfies it directly and this module reaches for no
 * network layer. There is no id-to-decimals lookup at M1: that needs the
 * registry M3 builds, and M3 adds an id-taking convenience on top of this rather
 * than replacing it.
 */
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
 * An amount that cannot be represented in the form asked for.
 *
 * Not a member of the §7 `SwapError` taxonomy: that taxonomy is the client
 * surface's, thrown by a verb before value moves, and this is a codec refusing
 * its input before a swap exists. The wire's compatibility failure is different
 * and does have a member — `AmountEncodingUnsupported`, in `rfqAmount.ts`.
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
     * `string` only, and no exponent. Accepting a `number` is the whole v1
     * footgun: it makes `100000` ambiguous between sats and whole BTC, and by
     * the time the ambiguity resolves the offer is funded. Exponent form goes
     * for the same reason — a UI never produces `1e-4`, so accepting it only
     * widens what a mistake can look like.
     *
     * Refuses rather than rounds when the input is finer than the asset: a
     * silently truncated amount is a swap for the wrong size, and nothing
     * downstream can tell it was ever a different number. Refuses too when the
     * result would not survive the record boundary, so one law holds in both
     * directions.
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

    /**
     * Atomic units into a human decimal, trailing zeros trimmed.
     *
     * Refuses a negative: every amount on this surface is an obligation, and a
     * negative one is a defect upstream rather than a number to render.
     */
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

/**
 * The canonical decimal string back into atomic units.
 *
 * Takes a plain `string` on purpose: it is what a record read and a `JSON.parse`
 * hand back, and demanding a cast would put one on the safe direction.
 */
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
