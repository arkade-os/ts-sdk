import {
    ExtendedCoin,
    ExtendedVirtualCoin,
    IWallet,
    IReadonlyWallet,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
} from ".";
import { SettlementEvent } from "../providers/ark";
import { hasBoardingTxExpired } from "../utils/arkTransaction";
import { CSVMultisigTapscript } from "../script/tapscript";
import { hex } from "@scure/base";
import { getSequence } from "../script/base";
import { Transaction } from "../utils/transaction";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import type { OnchainProvider } from "../providers/onchain";
import type { Network } from "../networks";
import type { DefaultVtxo } from "../script/default";

/**
 * Extended wallet interface for boarding UTXO sweep operations.
 * These properties exist on the concrete Wallet class but not on IWallet.
 */
interface SweepCapableWallet extends IReadonlyWallet {
    boardingTapscript: DefaultVtxo.Script;
    onchainProvider: OnchainProvider;
    network: Network;
}

/** Type guard to check if a wallet has the properties needed for sweep operations. */
function isSweepCapable(
    wallet: IWallet
): wallet is IWallet & SweepCapableWallet {
    return (
        "boardingTapscript" in wallet &&
        "onchainProvider" in wallet &&
        "network" in wallet
    );
}

/** Asserts that the wallet supports sweep operations, throwing a clear error if not. */
function assertSweepCapable(
    wallet: IWallet
): asserts wallet is IWallet & SweepCapableWallet {
    if (!isSweepCapable(wallet)) {
        throw new Error(
            "Boarding UTXO sweep requires a Wallet instance with boardingTapscript, onchainProvider, and network"
        );
    }
}

export const DEFAULT_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const DEFAULT_THRESHOLD_SECONDS = 3 * 24 * 60 * 60; // 3 days

/**
 * Configuration options for automatic VTXO renewal
 * @deprecated Use SettlementConfig instead
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
     * @deprecated Use SettlementConfig.vtxoThreshold (in seconds) instead
     */
    thresholdMs?: number;
}

/**
 * Configuration for automatic settlement and renewal.
 *
 * Controls two behaviors:
 * 1. **VTXO renewal**: Automatically renew VTXOs that are close to expiry
 * 2. **Boarding UTXO sweep**: Sweep expired boarding UTXOs back to a fresh boarding address
 *    via the unilateral exit path (on-chain self-spend to restart the timelock)
 *
 * Enabled by default when no config is provided.
 * Pass `false` to explicitly disable all settlement behavior.
 *
 * @example
 * ```typescript
 * // Default behavior: VTXO renewal at 3 days + boarding sweep enabled
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 * });
 *
 * // Custom threshold
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 *   settlementConfig: {
 *     vtxoThreshold: 86400, // 24 hours in seconds
 *   },
 * });
 *
 * // Explicitly disable
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 *   settlementConfig: false,
 * });
 * ```
 */
export interface SettlementConfig {
    /**
     * Seconds before VTXO expiry to trigger renewal.
     * @default 259200 (3 days)
     */
    vtxoThreshold?: number;

    /**
     * Sweep expired boarding UTXOs back to a fresh boarding address
     * via the unilateral exit path (on-chain self-spend to restart the timelock).
     *
     * When enabled, expired boarding UTXOs are batched into a single on-chain transaction
     * with multiple inputs and one output. A dust check ensures the sweep is only
     * performed when the output after fees is above dust.
     *
     * @default true
     */
    boardingUtxoSweep?: boolean;

    /**
     * Polling interval in milliseconds for checking boarding UTXOs.
     * The poll loop auto-settles new boarding UTXOs into Ark and
     * sweeps expired ones (when boardingUtxoSweep is enabled).
     *
     * @default 60000 (1 minute)
     */
    pollIntervalMs?: number;
}

/**
 * Default renewal configuration values
 * @deprecated Use DEFAULT_SETTLEMENT_CONFIG instead
 */
export const DEFAULT_RENEWAL_CONFIG: Required<Omit<RenewalConfig, "enabled">> =
    {
        thresholdMs: DEFAULT_THRESHOLD_MS, // 3 days
    };

/**
 * Default settlement configuration values
 */
export const DEFAULT_SETTLEMENT_CONFIG: Required<SettlementConfig> = {
    vtxoThreshold: DEFAULT_THRESHOLD_SECONDS,
    boardingUtxoSweep: true,
    pollIntervalMs: 60_000,
};

/** Extracts the dust amount from the wallet, defaulting to 330 sats. */
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

    // we use this as a workaround to avoid issue on regtest where expiry date is
    // expressed in blockheight instead of timestamp. If expiry, as Date, is before 2025,
    // then we admit it's too small to be a timestamp
    // TODO: API should return the expiry unit
    const expireAt = new Date(batchExpiry);
    if (expireAt.getFullYear() < 2025) return false;

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
export interface IVtxoManager {
    recoverVtxos(
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;

    getRecoverableBalance(): Promise<{
        recoverable: bigint;
        subdust: bigint;
        includesSubdust: boolean;
        vtxoCount: number;
    }>;

    getExpiringVtxos(thresholdMs?: number): Promise<ExtendedVirtualCoin[]>;

    renewVtxos(
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;

    getExpiredBoardingUtxos(): Promise<ExtendedCoin[]>;

    sweepExpiredBoardingUtxos(): Promise<string>;

    dispose(): Promise<void>;
}

export class VtxoManager implements AsyncDisposable, IVtxoManager {
    readonly settlementConfig: SettlementConfig | false;
    private contractEventsSubscription?: () => void;
    private readonly contractEventsSubscriptionReady: Promise<
        (() => void) | undefined
    >;
    private disposePromise?: Promise<void>;
    private pollTimeoutId?: ReturnType<typeof setTimeout>;
    private knownBoardingUtxos = new Set<string>();
    private sweptBoardingUtxos = new Set<string>();
    private pollInProgress = false;
    private pollDone?: { promise: Promise<void>; resolve: () => void };
    private disposed = false;
    private consecutivePollFailures = 0;
    private startupPollTimeoutId?: ReturnType<typeof setTimeout>;
    private static readonly MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

    // Guards against renewal feedback loop: when renewVtxos() settles, the
    // server emits new VTXOs → vtxo_received → renewVtxos() again → infinite loop.
    private renewalInProgress = false;
    private lastRenewalTimestamp = 0;
    private static readonly RENEWAL_COOLDOWN_MS = 30_000; // 30 seconds

    constructor(
        readonly wallet: IWallet,
        /** @deprecated Use settlementConfig instead */
        readonly renewalConfig?: RenewalConfig,
        settlementConfig?: SettlementConfig | false
    ) {
        // Normalize: prefer settlementConfig, fall back to renewalConfig, default to enabled
        if (settlementConfig !== undefined) {
            this.settlementConfig = settlementConfig;
        } else if (renewalConfig && renewalConfig.enabled) {
            this.settlementConfig = {
                vtxoThreshold: renewalConfig.thresholdMs
                    ? renewalConfig.thresholdMs / 1000
                    : undefined,
            };
        } else if (renewalConfig) {
            // renewalConfig provided but not enabled → disabled
            this.settlementConfig = false;
        } else {
            // No config at all → enabled by default
            this.settlementConfig = { ...DEFAULT_SETTLEMENT_CONFIG };
        }

        this.contractEventsSubscriptionReady =
            this.initializeSubscription().then((subscription) => {
                this.contractEventsSubscription = subscription;
                return subscription;
            });
    }

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
        const { vtxosToRecover, totalAmount } = getRecoverableWithSubdust(
            allVtxos,
            dustAmount
        );

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
        // If settlementConfig is explicitly false and no override provided, renewal is disabled
        if (this.settlementConfig === false && thresholdMs === undefined) {
            return [];
        }

        const vtxos = await this.wallet.getVtxos({ withRecoverable: true });

        // Resolve threshold: method param > settlementConfig (seconds→ms) > renewalConfig > default
        let threshold: number;
        if (thresholdMs !== undefined) {
            threshold = thresholdMs;
        } else if (
            this.settlementConfig !== false &&
            this.settlementConfig &&
            this.settlementConfig.vtxoThreshold !== undefined
        ) {
            threshold = this.settlementConfig.vtxoThreshold * 1000;
        } else {
            threshold =
                this.renewalConfig?.thresholdMs ??
                DEFAULT_RENEWAL_CONFIG.thresholdMs;
        }

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
        if (this.renewalInProgress) {
            throw new Error("Renewal already in progress");
        }

        this.renewalInProgress = true;

        try {
            // Get all VTXOs (including recoverable ones)
            // Use default threshold to bypass settlementConfig gate (manual API should always work)
            const vtxos = await this.getExpiringVtxos(
                this.settlementConfig !== false &&
                    this.settlementConfig?.vtxoThreshold !== undefined
                    ? this.settlementConfig.vtxoThreshold * 1000
                    : DEFAULT_RENEWAL_CONFIG.thresholdMs
            );

            if (vtxos.length === 0) {
                throw new Error("No VTXOs available to renew");
            }

            const totalAmount = vtxos.reduce(
                (sum, vtxo) => sum + vtxo.value,
                0
            );

            // Get dust amount from wallet
            const dustAmount = getDustAmount(this.wallet);

            // Check if total amount is above dust threshold
            if (BigInt(totalAmount) < dustAmount) {
                throw new Error(
                    `Total amount ${totalAmount} is below dust threshold ${dustAmount}`
                );
            }

            const arkAddress = await this.wallet.getAddress();

            const txid = await this.wallet.settle(
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
            this.lastRenewalTimestamp = Date.now();
            return txid;
        } finally {
            this.renewalInProgress = false;
        }
    }

    // ========== Boarding UTXO Sweep Methods ==========

    /**
     * Get boarding UTXOs whose timelock has expired.
     *
     * These UTXOs can no longer be onboarded cooperatively via `settle()` and
     * must be swept back to a fresh boarding address using the unilateral exit path.
     *
     * @returns Array of expired boarding UTXOs
     *
     * @example
     * ```typescript
     * const manager = new VtxoManager(wallet);
     * const expired = await manager.getExpiredBoardingUtxos();
     * if (expired.length > 0) {
     *   console.log(`${expired.length} expired boarding UTXOs to sweep`);
     * }
     * ```
     */
    async getExpiredBoardingUtxos(
        prefetchedUtxos?: ExtendedCoin[]
    ): Promise<ExtendedCoin[]> {
        const boardingUtxos =
            prefetchedUtxos ?? (await this.wallet.getBoardingUtxos());
        const boardingTimelock = this.getBoardingTimelock();

        // For block-based timelocks, fetch the chain tip height
        let chainTipHeight: number | undefined;
        if (boardingTimelock.type === "blocks") {
            const tip = await this.getOnchainProvider().getChainTip();
            chainTipHeight = tip.height;
        }

        return boardingUtxos.filter((utxo) =>
            hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight)
        );
    }

    /**
     * Sweep expired boarding UTXOs back to a fresh boarding address via
     * the unilateral exit path (on-chain self-spend).
     *
     * This builds a raw on-chain transaction that:
     * - Uses all expired boarding UTXOs as inputs (spent via the CSV exit script path)
     * - Has a single output to the wallet's boarding address (restarts the timelock)
     * - Batches multiple expired UTXOs into one transaction
     * - Skips the sweep if the output after fees would be below dust
     *
     * No Ark server involvement is needed — this is a pure on-chain transaction.
     *
     * @returns The broadcast transaction ID
     * @throws Error if no expired boarding UTXOs found
     * @throws Error if output after fees is below dust (not economical to sweep)
     * @throws Error if boarding UTXO sweep is not enabled in settlementConfig
     *
     * @example
     * ```typescript
     * const manager = new VtxoManager(wallet, undefined, {
     *   boardingUtxoSweep: true,
     * });
     *
     * try {
     *   const txid = await manager.sweepExpiredBoardingUtxos();
     *   console.log('Swept expired boarding UTXOs:', txid);
     * } catch (e) {
     *   console.log('No sweep needed or not economical');
     * }
     * ```
     */
    async sweepExpiredBoardingUtxos(
        prefetchedUtxos?: ExtendedCoin[]
    ): Promise<string> {
        const sweepEnabled =
            this.settlementConfig !== false &&
            (this.settlementConfig?.boardingUtxoSweep ??
                DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep);
        if (!sweepEnabled) {
            throw new Error(
                "Boarding UTXO sweep is not enabled in settlementConfig"
            );
        }

        const allExpired = await this.getExpiredBoardingUtxos(prefetchedUtxos);
        // Filter out UTXOs already swept (tx broadcast but not yet confirmed)
        const expiredUtxos = allExpired.filter(
            (u) => !this.sweptBoardingUtxos.has(`${u.txid}:${u.vout}`)
        );
        if (expiredUtxos.length === 0) {
            throw new Error("No expired boarding UTXOs to sweep");
        }

        const boardingAddress = await this.wallet.getBoardingAddress();

        // Get fee rate from onchain provider
        const feeRate = (await this.getOnchainProvider().getFeeRate()) ?? 1;

        // Get the exit tap leaf script for signing
        const exitTapLeafScript = this.getBoardingExitLeaf();

        // Estimate transaction size for fee calculation
        const sequence = getSequence(exitTapLeafScript);

        // TapLeafScript: [{version, internalKey, merklePath}, scriptWithVersion]
        const leafScript = exitTapLeafScript[1];
        const leafScriptSize = leafScript.length - 1; // minus version byte
        const controlBlockSize = exitTapLeafScript[0].merklePath.length * 32;
        // Exit path witness: 1 Schnorr signature (64 bytes)
        const leafWitnessSize = 64;

        const estimator = TxWeightEstimator.create();
        for (const _ of expiredUtxos) {
            estimator.addTapscriptInput(
                leafWitnessSize,
                leafScriptSize,
                controlBlockSize
            );
        }
        estimator.addOutputAddress(boardingAddress, this.getNetwork());

        const fee = Math.ceil(Number(estimator.vsize().value) * feeRate);
        const totalValue = expiredUtxos.reduce(
            (sum, utxo) => sum + BigInt(utxo.value),
            0n
        );
        const outputAmount = totalValue - BigInt(fee);

        // Dust check: skip if output after fees is below dust
        const dustAmount = getDustAmount(this.wallet);
        if (outputAmount < dustAmount) {
            throw new Error(
                `Sweep not economical: output ${outputAmount} sats after ${fee} sats fee is below dust (${dustAmount} sats)`
            );
        }

        // Build the raw transaction
        const tx = new Transaction();

        for (const utxo of expiredUtxos) {
            tx.addInput({
                txid: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: this.getBoardingOutputScript(),
                    amount: BigInt(utxo.value),
                },
                tapLeafScript: [exitTapLeafScript],
                sequence,
            });
        }

        tx.addOutputAddress(boardingAddress, outputAmount, this.getNetwork());

        // Sign and finalize
        const signedTx = await this.getIdentity().sign(tx);
        signedTx.finalize();

        // Broadcast
        const txid = await this.getOnchainProvider().broadcastTransaction(
            signedTx.hex
        );

        // Mark UTXOs as swept to prevent duplicate broadcasts on next poll
        for (const u of expiredUtxos) {
            this.sweptBoardingUtxos.add(`${u.txid}:${u.vout}`);
        }

        // Mark the sweep output as "known" so the next poll doesn't try to
        // auto-settle it back into Ark (it lands at the same boarding address).
        this.knownBoardingUtxos.add(`${txid}:0`);

        return txid;
    }

    // ========== Private Helpers ==========

    /** Asserts sweep capability and returns the typed wallet. */
    private getSweepWallet(): IWallet & SweepCapableWallet {
        assertSweepCapable(this.wallet);
        return this.wallet;
    }

    /** Decodes the boarding tapscript exit path to extract the CSV timelock. */
    private getBoardingTimelock() {
        const wallet = this.getSweepWallet();
        const exitScript = CSVMultisigTapscript.decode(
            hex.decode(wallet.boardingTapscript.exitScript)
        );
        return exitScript.params.timelock;
    }

    /** Returns the TapLeafScript for the boarding tapscript's exit (CSV) path. */
    private getBoardingExitLeaf() {
        return this.getSweepWallet().boardingTapscript.exit();
    }

    /** Returns the pkScript (output script) of the boarding tapscript. */
    private getBoardingOutputScript() {
        return this.getSweepWallet().boardingTapscript.pkScript;
    }

    /** Returns the on-chain provider for fee estimation and broadcasting. */
    private getOnchainProvider() {
        return this.getSweepWallet().onchainProvider;
    }

    /** Returns the Bitcoin network configuration from the wallet. */
    private getNetwork() {
        return this.getSweepWallet().network;
    }

    /** Returns the wallet's identity for transaction signing. */
    private getIdentity() {
        return this.wallet.identity;
    }

    private async initializeSubscription(): Promise<(() => void) | undefined> {
        if (this.settlementConfig === false) {
            return undefined;
        }

        // Start polling for boarding UTXOs independently of contract manager
        // SSE setup. Use a short delay to let the wallet finish construction.
        this.startupPollTimeoutId = setTimeout(() => {
            if (this.disposed) return;
            this.startBoardingUtxoPoll();
        }, 1000);

        try {
            const [delegatorManager, contractManager, destination] =
                await Promise.all([
                    this.wallet.getDelegatorManager(),
                    this.wallet.getContractManager(),
                    this.wallet.getAddress(),
                ]);

            const stopWatching = contractManager.onContractEvent((event) => {
                if (event.type !== "vtxo_received") {
                    return;
                }

                const msSinceLastRenewal =
                    Date.now() - this.lastRenewalTimestamp;
                const shouldRenew =
                    !this.renewalInProgress &&
                    msSinceLastRenewal >= VtxoManager.RENEWAL_COOLDOWN_MS;

                if (shouldRenew) {
                    this.renewVtxos().catch((e) => {
                        if (e instanceof Error) {
                            if (
                                e.message.includes(
                                    "No VTXOs available to renew"
                                )
                            ) {
                                // Not an error, just no VTXO eligible for renewal.
                                return;
                            }
                            if (e.message.includes("is below dust threshold")) {
                                // Not an error, just below dust threshold.
                                // As more VTXOs are received, the threshold will be raised.
                                return;
                            }
                            if (
                                e.message.includes("VTXO_ALREADY_REGISTERED") ||
                                e.message.includes("duplicated input")
                            ) {
                                // VTXO is already being used in a concurrent
                                // user-initiated operation. Skip silently — the
                                // wallet's tx lock serializes these, but the
                                // renewal will retry on the next cycle.
                                return;
                            }
                        }
                        console.error("Error renewing VTXOs:", e);
                    });
                }
                delegatorManager
                    ?.delegate(event.vtxos, destination)
                    .catch((e) => {
                        console.error("Error delegating VTXOs:", e);
                    });
            });

            return stopWatching;
        } catch (e) {
            console.error("Error renewing VTXOs from VtxoManager", e);
            return undefined;
        }
    }

    /** Computes the next poll delay, applying exponential backoff on failures. */
    private getNextPollDelay(): number {
        if (this.settlementConfig === false) return 0;
        const baseMs =
            this.settlementConfig.pollIntervalMs ??
            DEFAULT_SETTLEMENT_CONFIG.pollIntervalMs;
        if (this.consecutivePollFailures === 0) return baseMs;
        const backoff = Math.min(
            baseMs * Math.pow(2, this.consecutivePollFailures),
            VtxoManager.MAX_BACKOFF_MS
        );
        return backoff;
    }

    /**
     * Starts a polling loop that:
     * 1. Auto-settles new boarding UTXOs into Ark
     * 2. Sweeps expired boarding UTXOs (when boardingUtxoSweep is enabled)
     *
     * Uses setTimeout chaining (not setInterval) so a slow/blocked poll
     * cannot stack up and the next delay can incorporate backoff.
     */
    private startBoardingUtxoPoll(): void {
        if (this.settlementConfig === false) return;

        // Run once immediately, then schedule next
        this.pollBoardingUtxos();
    }

    private schedulePoll(): void {
        if (this.disposed || this.settlementConfig === false) return;
        const delay = this.getNextPollDelay();
        this.pollTimeoutId = setTimeout(() => this.pollBoardingUtxos(), delay);
    }

    private async pollBoardingUtxos(): Promise<void> {
        // Guard: wallet must support boarding UTXO + sweep operations
        if (!isSweepCapable(this.wallet)) return;
        // Skip if disposed or a previous poll is still running
        if (this.disposed) return;
        if (this.pollInProgress) return;
        this.pollInProgress = true;

        // Create a promise that dispose() can await
        let resolve: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        this.pollDone = { promise, resolve: resolve! };

        let hadError = false;

        try {
            // Fetch boarding UTXOs once for the entire poll cycle so that
            // settle and sweep don't each hit the network independently.
            const boardingUtxos = await this.wallet.getBoardingUtxos();

            // Settle new (unexpired) UTXOs first, then sweep expired ones.
            // Sequential to avoid racing for the same UTXOs.
            try {
                await this.settleBoardingUtxos(boardingUtxos);
            } catch (e) {
                hadError = true;
                console.error("Error auto-settling boarding UTXOs:", e);
            }

            const sweepEnabled =
                this.settlementConfig !== false &&
                (this.settlementConfig?.boardingUtxoSweep ??
                    DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep);
            if (sweepEnabled) {
                try {
                    await this.sweepExpiredBoardingUtxos(boardingUtxos);
                } catch (e) {
                    if (
                        !(e instanceof Error) ||
                        !e.message.includes("No expired boarding UTXOs")
                    ) {
                        hadError = true;
                        console.error("Error auto-sweeping boarding UTXOs:", e);
                    }
                }
            }
        } finally {
            if (hadError) {
                this.consecutivePollFailures++;
            } else {
                this.consecutivePollFailures = 0;
            }
            this.pollInProgress = false;
            this.pollDone.resolve();
            this.pollDone = undefined;
            this.schedulePoll();
        }
    }

    /**
     * Auto-settle new (unexpired) boarding UTXOs into the Ark.
     * Skips UTXOs that are already expired (those are handled by sweep).
     * Only settles UTXOs not already in-flight (tracked in knownBoardingUtxos).
     * UTXOs are marked as known only after a successful settle, so failed
     * attempts will be retried on the next poll.
     */
    private async settleBoardingUtxos(
        boardingUtxos: ExtendedCoin[]
    ): Promise<void> {
        // Exclude expired UTXOs — those should be swept, not settled.
        // If we can't determine expired status, bail out entirely to avoid
        // accidentally settling expired UTXOs (which would conflict with sweep).
        let expiredSet: Set<string>;
        try {
            const boardingTimelock = this.getBoardingTimelock();
            let chainTipHeight: number | undefined;
            if (boardingTimelock.type === "blocks") {
                const tip = await this.getOnchainProvider().getChainTip();
                chainTipHeight = tip.height;
            }
            const expired = boardingUtxos.filter((utxo) =>
                hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight)
            );
            expiredSet = new Set(expired.map((u) => `${u.txid}:${u.vout}`));
        } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
        }

        const unsettledUtxos = boardingUtxos.filter(
            (u) =>
                !this.knownBoardingUtxos.has(`${u.txid}:${u.vout}`) &&
                !expiredSet.has(`${u.txid}:${u.vout}`)
        );

        if (unsettledUtxos.length === 0) return;

        const dustAmount = getDustAmount(this.wallet);
        const totalAmount = unsettledUtxos.reduce(
            (sum, u) => sum + BigInt(u.value),
            0n
        );
        if (totalAmount < dustAmount) return;

        const arkAddress = await this.wallet.getAddress();
        await this.wallet.settle({
            inputs: unsettledUtxos,
            outputs: [{ address: arkAddress, amount: totalAmount }],
        });

        // Mark as known only after successful settle
        for (const u of unsettledUtxos) {
            this.knownBoardingUtxos.add(`${u.txid}:${u.vout}`);
        }
    }

    async dispose(): Promise<void> {
        this.disposePromise ??= (async () => {
            this.disposed = true;
            if (this.startupPollTimeoutId) {
                clearTimeout(this.startupPollTimeoutId);
                this.startupPollTimeoutId = undefined;
            }
            if (this.pollTimeoutId) {
                clearTimeout(this.pollTimeoutId);
                this.pollTimeoutId = undefined;
            }
            // Wait for any in-flight poll to finish (with timeout to avoid hanging)
            if (this.pollDone) {
                let timer: ReturnType<typeof setTimeout>;
                const timeout = new Promise<void>(
                    (r) => (timer = setTimeout(r, 30_000))
                );
                await Promise.race([this.pollDone.promise, timeout]);
                clearTimeout(timer!);
            }
            const subscription = await this.contractEventsSubscriptionReady;
            this.contractEventsSubscription = undefined;
            subscription?.();
        })();

        return this.disposePromise;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}
