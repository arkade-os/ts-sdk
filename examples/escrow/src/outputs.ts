/** Matches `const int DUST = 330` in escrow.ark. */
export const DUST = 330n;

export interface PayOutput {
    script: Uint8Array;
    amount: bigint;
}

/**
 * `complete` pays `amount` to the seller. A surplus above dust must be the
 * next output, back to the buyer. A smaller surplus stays on the seller
 * output so the spend does not create a dust output the covenant ignores.
 */
export function completeOutputs(
    coinValue: bigint,
    amount: bigint,
    sellerScript: Uint8Array,
    buyerScript: Uint8Array,
): PayOutput[] {
    if (coinValue < amount) {
        throw new Error(`this coin has ${coinValue} sats; complete pays ${amount}`);
    }
    const surplus = coinValue - amount;
    if (surplus > DUST) {
        return [
            { script: sellerScript, amount },
            { script: buyerScript, amount: surplus },
        ];
    }
    return [{ script: sellerScript, amount: coinValue }];
}

/** `cancel` returns the whole coin to the buyer. */
export function cancelOutputs(coinValue: bigint, buyerScript: Uint8Array): PayOutput[] {
    return [{ script: buyerScript, amount: coinValue }];
}

/** `unilateral` does not constrain outputs. The exit pays the seller. */
export function unilateralOutputs(coinValue: bigint, sellerScript: Uint8Array): PayOutput[] {
    return [{ script: sellerScript, amount: coinValue }];
}
