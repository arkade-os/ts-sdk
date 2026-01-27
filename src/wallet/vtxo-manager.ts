import {
    ExtendedVirtualCoin,
    IWallet,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
} from ".";
import { SettlementEvent } from "../providers/ark";
import {
    ContractManager,
    IContractManager,
} from "../contracts/contractManager";

export const DEFAULT_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Configuration options for automatic VTXO renewal
 */
export interface RenewalConfig {
    /**
     * Enable automatic renewal monitoring
     * @default false
     */
    enabled?: boolean;

    /**
     * Threshold in milliseconds to use as threshold for renewal
     * E.g., 86400000 means renew when 24 hours until expiry remains
     * @default 86400000 (24 hours)
     */
    thresholdMs?: number;
}

/**
 * Default renewal configuration values
 */
export const DEFAULT_RENEWAL_CONFIG: Required<Omit<RenewalConfig, "enabled">> =
    {
        thresholdMs: DEFAULT_THRESHOLD_MS, // 3 days
    };

function getDustAmount(wallet: IWallet): bigint {
    return "dustAmount" in wallet ? (wallet.dustAmount as bigint) : 330n;
}

/**
 * Filter VTXOs that are recoverable (swept and still spendable, or preconfirmed subdust)
 *
 * Recovery strategy:
 * - Always recover swept VTXOs (they've been taken by the server)
 * - Only recover subdust preconfirmed VTXOs (to avoid locking liquidity on settled VTXOs with long expiry)
 *
 * @param vtxos - Array of virtual coins to check
 * @param dustAmount - Dust threshold to identify subdust
 * @returns Array of recoverable VTXOs
 */
function getRecoverableVtxos(
    vtxos: ExtendedVirtualCoin[],
    dustAmount: bigint
): ExtendedVirtualCoin[] {
    return vtxos.filter((vtxo) => {
        // Always recover swept VTXOs
        if (isRecoverable(vtxo)) {
            return true;
        }

        // also include vtxos that are not swept but expired
        if (isSpendable(vtxo) && isExpired(vtxo)) {
            return true;
        }

        // Recover preconfirmed subdust to consolidate small amounts
        if (
            vtxo.virtualStatus.state === "preconfirmed" &&
            isSubdust(vtxo, dustAmount)
        ) {
            return true;
        }

        return false;
    });
}

/**
 * Get recoverable VTXOs including subdust coins if the total value exceeds dust threshold.
 *
 * Decision is based on the combined total of ALL recoverable VTXOs (regular + subdust),
 * not just the subdust portion alone.
 *
 * @param vtxos - Array of virtual coins to check
 * @param dustAmount - Dust threshold amount in satoshis
 * @returns Object containing recoverable VTXOs and whether subdust should be included
 */
function getRecoverableWithSubdust(
    vtxos: ExtendedVirtualCoin[],
    dustAmount: bigint
): {
    vtxosToRecover: ExtendedVirtualCoin[];
    includesSubdust: boolean;
    totalAmount: bigint;
} {
    const recoverableVtxos = getRecoverableVtxos(vtxos, dustAmount);

    // Separate subdust from regular recoverable
    const subdust: ExtendedVirtualCoin[] = [];
    const regular: ExtendedVirtualCoin[] = [];

    for (const vtxo of recoverableVtxos) {
        if (isSubdust(vtxo, dustAmount)) {
            subdust.push(vtxo);
        } else {
            regular.push(vtxo);
        }
    }

    // Calculate totals
    const regularTotal = regular.reduce(
        (sum, vtxo) => sum + BigInt(vtxo.value),
        0n
    );
    const subdustTotal = subdust.reduce(
        (sum, vtxo) => sum + BigInt(vtxo.value),
        0n
    );
    const combinedTotal = regularTotal + subdustTotal;

    // Include subdust only if the combined total exceeds dust threshold
    const shouldIncludeSubdust = combinedTotal >= dustAmount;
    const vtxosToRecover = shouldIncludeSubdust ? recoverableVtxos : regular;

    const totalAmount = vtxosToRecover.reduce(
        (sum, vtxo) => sum + BigInt(vtxo.value),
        0n
    );

    return {
        vtxosToRecover,
        includesSubdust: shouldIncludeSubdust,
        totalAmount,
    };
}

/**
 * Check if a VTXO is expiring soon based on threshold
 *
 * @param vtxo - The virtual coin to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @returns true if VTXO expires within threshold, false otherwise
 */
export function isVtxoExpiringSoon(
    vtxo: ExtendedVirtualCoin,
    thresholdMs: number // in milliseconds
): boolean {
    const realThresholdMs =
        thresholdMs <= 100 ? DEFAULT_THRESHOLD_MS : thresholdMs;

    const { batchExpiry } = vtxo.virtualStatus;

    if (!batchExpiry) return false; // it doesn't expire

    const now = Date.now();

    if (batchExpiry <= now) return false; // already expired

    return batchExpiry - now <= realThresholdMs;
}

/**
 * Filter VTXOs that are expiring soon or are recoverable/subdust
 *
 * @param vtxos - Array of virtual coins to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @param dustAmount - Dust threshold amount in satoshis
 * @returns Array of VTXOs expiring within threshold
 */
export function getExpiringAndRecoverableVtxos(
    vtxos: ExtendedVirtualCoin[],
    thresholdMs: number,
    dustAmount: bigint
): ExtendedVirtualCoin[] {
    return vtxos.filter(
        (vtxo) =>
            isVtxoExpiringSoon(vtxo, thresholdMs) ||
            isRecoverable(vtxo) ||
            (isSpendable(vtxo) && isExpired(vtxo)) ||
            isSubdust(vtxo, dustAmount)
    );
}

/**
 * VtxoManager is a unified class for managing VTXO lifecycle operations including
 * recovery of swept/expired VTXOs and renewal to prevent expiration.
 *
 * Key Features:
 * - **Recovery**: Reclaim swept or expired VTXOs back to the wallet
 * - **Renewal**: Refresh VTXO expiration time before they expire
 * - **Smart subdust handling**: Automatically includes subdust VTXOs when economically viable
 * - **Expiry monitoring**: Check for VTXOs that are expiring soon
 *
 * VTXOs become recoverable when:
 * - The Ark server sweeps them (virtualStatus.state === "swept") and they remain spendable
 * - They are preconfirmed subdust (to consolidate small amounts without locking liquidity on settled VTXOs)
 *
 * @example
 * ```typescript
 * // Initialize with renewal config
 * const manager = new VtxoManager(wallet, {
 *   enabled: true,
 *   thresholdMs: 86400000
 * });
 *
 * // Check recoverable balance
 * const balance = await manager.getRecoverableBalance();
 * if (balance.recoverable > 0n) {
 *   console.log(`Can recover ${balance.recoverable} sats`);
 *   const txid = await manager.recoverVtxos();
 * }
 *
 * // Check for expiring VTXOs
 * const expiring = await manager.getExpiringVtxos();
 * if (expiring.length > 0) {
 *   console.log(`${expiring.length} VTXOs expiring soon`);
 *   const txid = await manager.renewVtxos();
 * }
 * ```
 */
export class VtxoManager {
    constructor(
        readonly wallet: IWallet,
        readonly renewalConfig?: RenewalConfig
    ) {}

    // ========== Recovery Methods ==========

    /**
     * Recover swept/expired VTXOs by settling them back to the wallet's Ark address.
     *
     * This method:
     * 1. Fetches all VTXOs (including recoverable ones)
     * 2. Filters for swept but still spendable VTXOs and preconfirmed subdust
     * 3. Includes subdust VTXOs if the total value >= dust threshold
     * 4. Settles everything back to the wallet's Ark address
     *
     * Note: Settled VTXOs with long expiry are NOT recovered to avoid locking liquidity unnecessarily.
     * Only preconfirmed subdust is recovered to consolidate small amounts.
     *
     * @param eventCallback - Optional callback to receive settlement events
     * @returns Settlement transaction ID
     * @throws Error if no recoverable VTXOs found
     *
     * @example
     * ```typescript
     * const manager = new VtxoManager(wallet);
     *
     * // Simple recovery
     * const txid = await manager.recoverVtxos();
     *
     * // With event callback
     * const txid = await manager.recoverVtxos((event) => {
     *   console.log('Settlement event:', event.type);
     * });
     * ```
     */
    async recoverVtxos(
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        // Get all VTXOs including recoverable ones
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        // Get dust amount from wallet
        const dustAmount = getDustAmount(this.wallet);

        // Filter recoverable VTXOs and handle subdust logic
        const { vtxosToRecover, includesSubdust, totalAmount } =
            getRecoverableWithSubdust(allVtxos, dustAmount);

        if (vtxosToRecover.length === 0) {
            throw new Error("No recoverable VTXOs found");
        }

        const arkAddress = await this.wallet.getAddress();

        // Settle all recoverable VTXOs back to the wallet
        return this.wallet.settle(
            {
                inputs: vtxosToRecover,
                outputs: [
                    {
                        address: arkAddress,
                        amount: totalAmount,
                    },
                ],
            },
            eventCallback
        );
    }

    /**
     * Get information about recoverable balance without executing recovery.
     *
     * Useful for displaying to users before they decide to recover funds.
     *
     * @returns Object containing recoverable amounts and subdust information
     *
     * @example
     * ```typescript
     * const manager = new VtxoManager(wallet);
     * const balance = await manager.getRecoverableBalance();
     *
     * if (balance.recoverable > 0n) {
     *   console.log(`You can recover ${balance.recoverable} sats`);
     *   if (balance.includesSubdust) {
     *     console.log(`This includes ${balance.subdust} sats from subdust VTXOs`);
     *   }
     * }
     * ```
     */
    async getRecoverableBalance(): Promise<{
        recoverable: bigint;
        subdust: bigint;
        includesSubdust: boolean;
        vtxoCount: number;
    }> {
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        const dustAmount = getDustAmount(this.wallet);

        const { vtxosToRecover, includesSubdust, totalAmount } =
            getRecoverableWithSubdust(allVtxos, dustAmount);

        // Calculate subdust amount separately for reporting
        const subdustAmount = vtxosToRecover
            .filter((v) => BigInt(v.value) < dustAmount)
            .reduce((sum, v) => sum + BigInt(v.value), 0n);

        return {
            recoverable: totalAmount,
            subdust: subdustAmount,
            includesSubdust,
            vtxoCount: vtxosToRecover.length,
        };
    }

    // ========== Renewal Methods ==========

    /**
     * Get VTXOs that are expiring soon based on renewal configuration
     *
     * @param thresholdMs - Optional override for threshold in milliseconds
     * @returns Array of expiring VTXOs, empty array if renewal is disabled or no VTXOs expiring
     *
     * @example
     * ```typescript
     * const manager = new VtxoManager(wallet, { enabled: true, thresholdMs: 86400000 });
     * const expiringVtxos = await manager.getExpiringVtxos();
     * if (expiringVtxos.length > 0) {
     *   console.log(`${expiringVtxos.length} VTXOs expiring soon`);
     * }
     * ```
     */
    async getExpiringVtxos(
        thresholdMs?: number
    ): Promise<ExtendedVirtualCoin[]> {
        const vtxos = await this.wallet.getVtxos({ withRecoverable: true });
        const threshold =
            thresholdMs ??
            this.renewalConfig?.thresholdMs ??
            DEFAULT_RENEWAL_CONFIG.thresholdMs;

        return getExpiringAndRecoverableVtxos(
            vtxos,
            threshold,
            getDustAmount(this.wallet)
        );
    }

    /**
     * Renew expiring VTXOs by settling them back to the wallet's address
     *
     * This method collects all expiring spendable VTXOs (including recoverable ones) and settles
     * them back to the wallet, effectively refreshing their expiration time. This is the
     * primary way to prevent VTXOs from expiring.
     *
     * @param eventCallback - Optional callback for settlement events
     * @returns Settlement transaction ID
     * @throws Error if no VTXOs available to renew
     * @throws Error if total amount is below dust threshold
     *
     * @example
     * ```typescript
     * const manager = new VtxoManager(wallet);
     *
     * // Simple renewal
     * const txid = await manager.renewVtxos();
     *
     * // With event callback
     * const txid = await manager.renewVtxos((event) => {
     *   console.log('Settlement event:', event.type);
     * });
     * ```
     */
    async renewVtxos(
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        // Get all VTXOs (including recoverable ones)
        const vtxos = await this.getExpiringVtxos();

        if (vtxos.length === 0) {
            throw new Error("No VTXOs available to renew");
        }

        const totalAmount = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

        // Get dust amount from wallet
        const dustAmount = getDustAmount(this.wallet);

        // Check if total amount is above dust threshold
        if (BigInt(totalAmount) < dustAmount) {
            throw new Error(
                `Total amount ${totalAmount} is below dust threshold ${dustAmount}`
            );
        }

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
