/**
 * Type-level assertions for the amount law. Checked by `tsconfig.test.json`,
 * which the package's `typecheck` script runs, so every `@ts-expect-error` here
 * is an assertion CI enforces — and one that stops erroring fails the build.
 */
import {
    Amount,
    type AtomicDecimal,
    type DisplayDecimal,
    fromAtomicDecimal,
    toAtomicDecimal,
} from "../../src/client/amount";

const BTC = { decimals: 8 };

/** A display decimal comes off a text input as a plain string; no constructor. */
export const fromInput: DisplayDecimal = "0.01";
export const parsed: bigint = Amount.parse(fromInput, BTC);
export const rendered: string = Amount.format(1_000_000n, BTC);

const atomic: AtomicDecimal = toAtomicDecimal(1_000_000n);

// The one defect on this surface a type can catch outright: reading a record's
// "1000000" sats back as 1,000,000 BTC.
// @ts-expect-error an atomic decimal is not a display decimal
export const misread: bigint = Amount.parse(atomic, BTC);

// ...and the safe direction stays cast-free, because a record read and a
// JSON.parse both hand back a plain string.
export const fromRecord: bigint = fromAtomicDecimal("1000000");

const claimed = "1000000";
// @ts-expect-error only the codec mints an atomic decimal
export const forged: AtomicDecimal = claimed;
