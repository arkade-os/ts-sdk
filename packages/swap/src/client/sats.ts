/**
 * The one narrowing between P3's `bigint` law and core's `number` sats.
 *
 * Core's payment surface is `number` throughout — `RouteQuote.amount`, `.fee`,
 * `.total`, `PaymentRequest.amount`, `Wallet.send` — and converting it is the
 * router's own work, next to the asset-aware routing ts-sdk #586 already
 * assigns it. Until then the crossing happens here, checked, at the boundary
 * where both sides are sats: a sat count past 2^53 is not a payment, so the
 * narrowing is sound and its failure is a refusal rather than a rounded amount.
 *
 * Core already crosses the same boundary itself, unchecked, at
 * `payment/rails/onchain.ts`'s `BigInt(amt)`. This side refuses instead.
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
