import type { InputExpiryFloor, VirtualCoin } from "./index";

export function captureInputExpiryFloor(
    value: unknown,
    required = false,
): InputExpiryFloor | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(
            "inputExpiryFloor must specify a time or height and positive bigint value",
        );
    }
    const { kind, value: floor } = value as Partial<InputExpiryFloor>;
    if ((kind !== "time" && kind !== "height") || typeof floor !== "bigint" || floor <= 0n) {
        throw new TypeError(
            "inputExpiryFloor must specify a time or height and positive bigint value",
        );
    }
    return Object.freeze({ kind, value: floor });
}

export function meetsInputExpiryFloor(coin: VirtualCoin, floor: InputExpiryFloor): boolean {
    if ((coin.expiresAt === undefined) === (coin.expiresAtHeight === undefined)) return false;
    if (floor.kind === "height") {
        const height = coin.expiresAtHeight;
        return (
            typeof height === "number" &&
            Number.isSafeInteger(height) &&
            height > 0 &&
            BigInt(height) >= floor.value
        );
    }
    if (!(coin.expiresAt instanceof Date)) return false;
    const milliseconds = coin.expiresAt.getTime();
    return (
        Number.isSafeInteger(milliseconds) &&
        milliseconds > 0 &&
        BigInt(milliseconds) >= floor.value * 1000n
    );
}
