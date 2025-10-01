import { ExtendedVirtualCoin, IWallet } from ".";
import { SettlementEvent } from "../providers/ark";

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

/**
 * Renewal is a class wrapping IWallet.settle method to provide a convenient interface
 * for renewing VTXOs to prevent expiration.
 *
 * This class provides:
 * - Checking for expiring VTXOs based on configurable threshold
 * - Renewing all VTXOs (including recoverable ones) back to the wallet
 * - Future: Platform-specific automatic renewal scheduling (Expo, Browser, Service Worker)
 *
 * @example
 * ```typescript
 * const renewal = new Renewal(wallet);
 *
 * // Check for expiring VTXOs
 * const expiring = await renewal.getExpiringVtxos();
 * if (expiring.length > 0) {
 *   console.log(`${expiring.length} VTXOs expiring soon`);
 * }
 *
 * // Renew all VTXOs
 * const txid = await renewal.renewVtxos();
 * console.log(`Renewal transaction: ${txid}`);
 * ```
 */
export class Renewal {
    constructor(
        readonly wallet: IWallet,
        readonly config?: RenewalConfig
    ) {}

    /**
     * Get VTXOs that are expiring soon based on renewal configuration
     *
     * @param thresholdPercentage - Optional override for threshold percentage (0-100)
     * @returns Array of expiring VTXOs, empty array if renewal is disabled or no VTXOs expiring
     *
     * @example
     * ```typescript
     * const renewal = new Renewal(wallet, { enabled: true, thresholdPercentage: 10 });
     * const expiringVtxos = await renewal.getExpiringVtxos();
     * if (expiringVtxos.length > 0) {
     *   console.log(`${expiringVtxos.length} VTXOs expiring soon`);
     * }
     * ```
     */
    async getExpiringVtxos(
        thresholdPercentage?: number
    ): Promise<ExtendedVirtualCoin[]> {
        if (!this.config?.enabled) {
            return [];
        }

        const vtxos = await this.wallet.getVtxos();
        const percentage =
            thresholdPercentage ??
            this.config.thresholdPercentage ??
            DEFAULT_RENEWAL_CONFIG.thresholdPercentage;

        const threshold = calculateDynamicThreshold(vtxos, percentage);

        if (!threshold) {
            return [];
        }

        return getExpiringVtxos(vtxos, threshold);
    }

    /**
     * Renew VTXOs by settling them back to the wallet's address
     *
     * This method collects all spendable VTXOs (including recoverable ones) and settles
     * them back to the wallet, effectively refreshing their expiration time. This is the
     * primary way to prevent VTXOs from expiring.
     *
     * @param eventCallback - Optional callback for settlement events
     * @returns Settlement transaction ID
     * @throws Error if no VTXOs available to renew
     *
     * @example
     * ```typescript
     * const renewal = new Renewal(wallet);
     *
     * // Simple renewal
     * const txid = await renewal.renewVtxos();
     *
     * // With event callback
     * const txid = await renewal.renewVtxos((event) => {
     *   console.log('Settlement event:', event.type);
     * });
     * ```
     */
    async renewVtxos(
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        // Get all VTXOs (including recoverable ones)
        const vtxos = await this.wallet.getVtxos({ withRecoverable: true });

        if (vtxos.length === 0) {
            throw new Error("No VTXOs available to renew");
        }

        const totalAmount = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
        const arkAddress = await this.wallet.getAddress();

        return this.wallet.settle(
            {
                inputs: vtxos,
                outputs: [
                    {
                        address: arkAddress,
                        amount: BigInt(totalAmount),
                    },
                ],
            },
            eventCallback
        );
    }
}
