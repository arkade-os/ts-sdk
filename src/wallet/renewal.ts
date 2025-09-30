import { ExtendedVirtualCoin } from ".";

/**
 * Configuration options for automatic VTXO renewal
 */
export interface RenewalConfig {
    /**
     * Enable automatic renewal monitoring
     * @default false
     */
    enabled: boolean;

    /**
     * Percentage of expiry time to use as threshold (0-100)
     * E.g., 10 means renew when 10% of time until expiry remains
     * @default 10
     */
    thresholdPercentage?: number;

    /**
     * Interval in milliseconds for background expiration checks
     * Only used when a scheduler adapter is provided
     * @default 3600000 (1 hour)
     */
    checkIntervalMs?: number;

    /**
     * Automatically trigger renewal when expiring VTXOs detected
     * If false, only notifications are sent
     * @default false
     */
    autoRenew?: boolean;
}

/**
 * Default renewal configuration values
 */
export const DEFAULT_RENEWAL_CONFIG: Required<Omit<RenewalConfig, "enabled">> =
    {
        thresholdPercentage: 10,
        checkIntervalMs: 3600000, // 1 hour
        autoRenew: false,
    };

/**
 * Check if a VTXO is expiring soon based on threshold
 *
 * @param vtxo - The virtual coin to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @returns true if VTXO expires within threshold, false otherwise
 */
export function isVtxoExpiringSoon(
    vtxo: ExtendedVirtualCoin,
    thresholdMs: number
): boolean {
    const { batchExpiry } = vtxo.virtualStatus;

    // No expiry set means it doesn't expire
    if (!batchExpiry) {
        return false;
    }

    const now = Date.now();
    const timeUntilExpiry = batchExpiry - now;

    return timeUntilExpiry > 0 && timeUntilExpiry <= thresholdMs;
}

/**
 * Filter VTXOs that are expiring soon
 *
 * @param vtxos - Array of virtual coins to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @returns Array of VTXOs expiring within threshold
 */
export function getExpiringVtxos(
    vtxos: ExtendedVirtualCoin[],
    thresholdMs: number
): ExtendedVirtualCoin[] {
    return vtxos.filter((vtxo) => isVtxoExpiringSoon(vtxo, thresholdMs));
}

/**
 * Calculate expiry threshold in milliseconds based on batch expiry and percentage
 *
 * @param batchExpiry - Batch expiry timestamp in milliseconds
 * @param percentage - Percentage of total time (0-100)
 * @returns Threshold timestamp in milliseconds from now
 *
 * @example
 * // VTXO expires in 10 days, threshold is 10%
 * const expiry = Date.now() + 10 * 24 * 60 * 60 * 1000;
 * const threshold = calculateExpiryThreshold(expiry, 10);
 * // Returns 1 day in milliseconds (10% of 10 days)
 */
export function calculateExpiryThreshold(
    batchExpiry: number,
    percentage: number
): number {
    if (percentage < 0 || percentage > 100) {
        throw new Error("Percentage must be between 0 and 100");
    }

    const now = Date.now();
    const totalTime = batchExpiry - now;

    if (totalTime <= 0) {
        // Already expired
        return 0;
    }

    // Calculate threshold as percentage of total time
    return Math.floor((totalTime * percentage) / 100);
}

/**
 * Get the minimum expiry time from a list of VTXOs
 *
 * @param vtxos - Array of virtual coins
 * @returns Minimum batch expiry timestamp, or undefined if no VTXOs have expiry
 */
export function getMinimumExpiry(
    vtxos: ExtendedVirtualCoin[]
): number | undefined {
    const expiries = vtxos
        .map((v) => v.virtualStatus.batchExpiry)
        .filter((e): e is number => e !== undefined);

    if (expiries.length === 0) {
        return undefined;
    }

    return Math.min(...expiries);
}

/**
 * Calculate dynamic threshold based on the earliest expiring VTXO
 *
 * @param vtxos - Array of virtual coins
 * @param percentage - Percentage of time until expiry (0-100)
 * @returns Threshold in milliseconds, or undefined if no VTXOs have expiry
 */
export function calculateDynamicThreshold(
    vtxos: ExtendedVirtualCoin[],
    percentage: number
): number | undefined {
    const minExpiry = getMinimumExpiry(vtxos);

    if (!minExpiry) {
        return undefined;
    }

    return calculateExpiryThreshold(minExpiry, percentage);
}
