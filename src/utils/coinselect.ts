import type { Coin, VirtualCoin } from "../wallet";

/**
 * Select coins to reach a target amount, prioritizing those closer to expiry
 * @param coins List of coins to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected coins and change amount, or null if insufficient funds
 */
export function selectCoins(
    coins: Coin[],
    targetAmount: bigint
): {
    inputs: Coin[] | null;
    changeAmount: bigint;
} {
    // Sort coins by amount (descending)
    const sortedCoins = [...coins].sort((a, b) =>
        Number(BigInt(b.value) - BigInt(a.value))
    );

    const selectedCoins: Coin[] = [];
    let selectedAmount = 0n;

    // Select coins until we have enough
    for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        selectedAmount += BigInt(coin.value);

        if (selectedAmount >= targetAmount) {
            break;
        }
    }

    // Check if we have enough
    if (selectedAmount < targetAmount) {
        return { inputs: null, changeAmount: 0n };
    }

    // Calculate change
    const changeAmount = selectedAmount - targetAmount;

    // Ensure changeAmount is a valid BigInt
    if (typeof changeAmount !== "bigint") {
        return { inputs: null, changeAmount: 0n };
    }

    return {
        inputs: selectedCoins,
        changeAmount,
    };
}

/**
 * Select virtual coins to reach a target amount, prioritizing those closer to expiry
 * @param coins List of virtual coins to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected coins and change amount, or null if insufficient funds
 */
export function selectVirtualCoins(
    coins: VirtualCoin[],
    targetAmount: bigint
): {
    inputs: VirtualCoin[] | null;
    changeAmount: bigint;
} {
    // Sort VTXOs by expiry (ascending) and amount (descending)
    const sortedCoins = [...coins].sort((a, b) => {
        // First sort by expiry if available
        const expiryA = a.virtualStatus.batchExpiry || Number.MAX_SAFE_INTEGER;
        const expiryB = b.virtualStatus.batchExpiry || Number.MAX_SAFE_INTEGER;
        if (expiryA !== expiryB) {
            return expiryA - expiryB; // Earlier expiry first
        }

        // Then sort by amount
        return Number(BigInt(b.value) - BigInt(a.value)); // Larger amount first
    });

    const selectedCoins: VirtualCoin[] = [];
    let selectedAmount = 0n;

    // Select coins until we have enough
    for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        selectedAmount += BigInt(coin.value);

        if (selectedAmount >= targetAmount) {
            break;
        }
    }

    // Check if we have enough
    if (selectedAmount < targetAmount) {
        return { inputs: null, changeAmount: 0n };
    }

    // Calculate change
    const changeAmount = selectedAmount - targetAmount;

    // Ensure changeAmount is a valid BigInt
    if (typeof changeAmount !== "bigint") {
        return { inputs: null, changeAmount: 0n };
    }

    return {
        inputs: selectedCoins,
        changeAmount,
    };
}
