/** Used for parsing asset amounts */
export const toSafeNumber = (value: string | bigint | number): number => {
    const num = Number(value);

    if (!Number.isFinite(num)) return Number.MAX_SAFE_INTEGER;

    if (num > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    if (num < Number.MIN_SAFE_INTEGER) return Number.MIN_SAFE_INTEGER;

    return num;
};
