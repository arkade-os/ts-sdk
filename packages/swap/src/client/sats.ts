/**
 * The one narrowing between the client's `bigint` amounts and core's `number` sats
 * (core's payment surface is `number` throughout until ts-sdk #586). A sat count past
 * 2^53 is not a payment, so the narrowing is sound and its failure is a refusal, never
 * a rounded amount.
 */
import { AmountEncodingUnsupported } from "./errors";

/** A `number` of sats from atomic units, or {@link AmountEncodingUnsupported}. */
export const satsOf = (value: bigint, field: string): number => {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new AmountEncodingUnsupported(
            field,
            `${value}`,
            "outside the non-negative safe-integer window core's payment amounts are numbers in",
        );
    }
    return Number(value);
};
