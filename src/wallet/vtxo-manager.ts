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
 * Extended wallet interface for boarding input sweep operations.
 * These properties exist on the concrete Wallet class but not on IWallet.
 */
interface SweepCapableWallet extends IReadonlyWallet {
    boardingTapscript: DefaultVtxo.Script;
    onchainProvider: OnchainProvider;
    network: Network;
}

/**
 * Return whether a wallet exposes the properties required for boarding input sweep operations.
 *
 * @param wallet - Wallet to inspect
 * @returns `true` when the wallet supports boarding input sweep operations.
 */
function isSweepCapable(
    wallet: IWallet
): wallet is IWallet & SweepCapableWallet {
    return (
        "boardingTapscript" in wallet &&
        "onchainProvider" in wallet &&
        "network" in wallet
    );
}

/**
 * Assert that the wallet supports boarding input sweep operations.
 *
 * @param wallet - Wallet to inspect
 * @throws Error if the wallet does not support boarding input sweep operations.
 */
function assertSweepCapable(
    wallet: IWallet
): asserts wallet is IWallet & SweepCapableWallet {
    if (!isSweepCapable(wallet)) {
        throw new Error(
            "Boarding UTXO sweep requires a Wallet instance with boardingTapscript, onchainProvider, and network"
        );
    }
}

/**
 * Return whether a wallet exposes the surface required for VTXO renewal.
 *
 * Renewal re-submits existing VTXOs via `settle()`, so a wallet that can't
 * settle can't renew. IWallet declares `settle` at the type level, but this
 * runtime guard keeps auto-renewal paths safe when a proxy or subclass omits
 * it.
 */
function isRenewCapable(wallet: IWallet): boolean {
    return typeof wallet.settle === "function";
}

/** Default renewal threshold in seconds (3 days). */
export const DEFAULT_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;

/**
 * Default renewal threshold in milliseconds (3 days).
 */
export const DEFAULT_THRESHOLD_MS = DEFAULT_THRESHOLD_SECONDS * 1000;

/**
 * Configuration options for automatic virtual output renewal
 *
 * @see DEFAULT_RENEWAL_CONFIG
 * @deprecated Leave `renewalConfig` undefined and use `settlementConfig` instead.
 * @see SettlementConfig
 */
export interface RenewalConfig {
    /**
     * Enable automatic renewal monitoring
     *
     * @defaultValue `false`
     * @deprecated Explicitly set `settlementConfig` to `false` to disable VTXO renewal.
     */
    enabled?: boolean;

    /**
     * Threshold in milliseconds to use as threshold for renewal
     * E.g., 86_400_000 means renew when 24 hours until expiry remains
     *
     * @defaultValue `259_200_000` (3 days).
     * @deprecated Use `SettlementConfig.vtxoThreshold` (in seconds) instead.
     */
    thresholdMs?: number;
}

/**
 * Configuration for automatic settlement and renewal.
 *
 * Controls two behaviors:
 * 1. **VTXO renewal**: Automatically renew virtual outputs that are close to expiry
 * 2. **Boarding UTXO sweep**: Sweep expired boarding inputs back to a fresh boarding address
 *    via the unilateral exit path (onchain self-spend to restart the timelock)
 *
 * Enabled by default when no config is provided.
 * Pass `false` to explicitly disable all settlement behavior.
 *
 * @remarks
 * VTXO renewal and boarding UTXO sweep are both coordinated by `VtxoManager`, which periodically
 * inspects wallet virtual outputs and boarding inputs and decides whether action is needed.
 *
 * @see DEFAULT_SETTLEMENT_CONFIG
 *
 * @example
 * ```typescript
 * // Default behavior: virtual output renewal at 3 days, boarding sweep enabled, polling every minute
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkServerUrl: 'https://arkade.computer',
 * });
 *
 * // Custom expiry threshold of 24 hours
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkServerUrl: 'https://arkade.computer',
 *   settlementConfig: {
 *     vtxoThreshold: 60 * 60 * 24, // 24 hours in seconds
 *   },
 * });
 *
 * // Explicitly disable
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkServerUrl: 'https://arkade.computer',
 *   settlementConfig: false,
 * });
 * ```
 */
export interface SettlementConfig {
    /**
     * Seconds before virtual output expiry to trigger renewal.
     *
     * @defaultValue `259_200` (3 days)
     */
    vtxoThreshold?: number;

    /**
     * Sweep expired boarding inputs back to a fresh boarding address
     * via the unilateral exit path (onchain self-spend to restart the timelock).
     *
     * When enabled, expired boarding inputs are batched into a single onchain
     * transaction with multiple inputs and one output.
     *
     * A dust check ensures the sweep is only performed when the output
     * after fees is above dust.
     *
     * @defaultValue `true`
     */
    boardingUtxoSweep?: boolean;

    /**
     * Polling interval in milliseconds for checking boarding inputs.
     * The poll loop auto-settles new boarding inputs into Arkade and
     * sweeps expired ones (when boardingUtxoSweep is enabled).
     *
     * @defaultValue `60_000` (1 minute)
     */
    pollIntervalMs?: number;
}

/**
 * Default renewal configuration values.
 *
 * @see RenewalConfig
 * @deprecated Leave `renewalConfig` undefined and use `settlementConfig` instead.
 * @see SettlementConfig
 */
export const DEFAULT_RENEWAL_CONFIG: Required<Omit<RenewalConfig, "enabled">> =
    {
        thresholdMs: DEFAULT_THRESHOLD_MS, // 3 days
    };

/**
 * Default settlement configuration values.
 *
 * @see SettlementConfig
 *
 * @example
 * ```typescript
 * const wallet = await Wallet.create({
 *   identity,
 *   arkServerUrl: 'https://arkade.computer',
 *   settlementConfig: DEFAULT_SETTLEMENT_CONFIG,
 * })
 * ```
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
 * Filter virtual outputs that are recoverable (swept and still spendable, or preconfirmed subdust)
 *
 * Recovery strategy:
 * - Always recover swept virtual outputs (they've been taken by the server)
 * - Only recover subdust preconfirmed virtual outputs (to avoid locking liquidity on settled virtual outputs with long expiry)
 *
 * @param vtxos - Array of virtual outputs to check
 * @param dustAmount - Dust threshold to identify subdust
 * @returns Array of recoverable virtual outputs
 */
function getRecoverableVtxos(
    vtxos: ExtendedVirtualCoin[],
    dustAmount: bigint
): ExtendedVirtualCoin[] {
    return vtxos.filter((vtxo) => {
        // Always recover swept virtual outputs
        if (isRecoverable(vtxo)) {
            return true;
        }

        // also include virtual outputs that are not swept but expired
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
 * Get recoverable virtual outputs including subdust outputs if the total value exceeds dust threshold.
 *
 * Decision is based on the combined total of ALL recoverable virtual outputs (regular + subdust),
 * not just the subdust portion alone.
 *
 * @param vtxos - Array of virtual outputs to check
 * @param dustAmount - Dust threshold amount in satoshis
 * @returns Object containing recoverable virtual outputs and whether subdust should be included
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
 * Check if a virtual output is expiring soon based on threshold
 *
 * @param vtxo - The virtual output to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @returns true if virtual output expires within threshold, false otherwise
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
 * Filter virtual outputs that are expiring soon or are recoverable/subdust
 *
 * @param vtxos - Array of virtual outputs to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @param dustAmount - Dust threshold amount in satoshis
 * @returns Array of virtual outputs expiring within threshold
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
 * VtxoManager is a unified class for managing virtual output lifecycle operations including
 * recovery of swept/expired virtual outputs and renewal to prevent expiration.
 *
 * Key Features:
 * - **Recovery**: Reclaim swept or expired virtual outputs back to the wallet
 * - **Renewal**: Refresh virtual output expiration time before they expire
 * - **Smart subdust handling**: Automatically includes subdust virtual outputs when economically viable
 * - **Expiry monitoring**: Check for virtual outputs that are expiring soon
 *
 * Virtual outputs become recoverable when:
 * - The Arkade server sweeps them (virtualStatus.state === "swept") and they remain spendable
 * - They are preconfirmed subdust (to consolidate small amounts without locking liquidity on settled virtual outputs)
 *
 * @example
 * ```typescript
 * const wallet = await Wallet.create({
 *   identity,
 *   arkServerUrl: 'https://arkade.computer',
 *   settlementConfig: {
 *      // Seconds before virtual output expiry to trigger renewal
 *      vtxoThreshold: 259_200, // 3 days
 *      // Whether to sweep expired boarding inputs back to a fresh boarding address
 *      boardingUtxoSweep: true,
 *      // Polling interval in milliseconds for checking boarding inputs
 *      pollIntervalMs: 60_000 // 1 minute
 *  },
 * });
 * const manager = await wallet.getVtxoManager();
 *
 * // Check recoverable balance
 * const balance = await manager.getRecoverableBalance();
 * if (balance.recoverable > 0n) {
 *   console.log(`Can recover ${balance.recoverable} sats`);
 *   const txid = await manager.recoverVtxos();
 * }
 *
 * // Check for expiring virtual outputs
 * const expiring = await manager.getExpiringVtxos();
 * if (expiring.length > 0) {
 *   console.log(`${expiring.length} virtual outputs expiring soon`);
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
     * Recover swept/expired virtual outputs by settling them back to the wallet's Arkade address.
     *
     * This method:
     * 1. Fetches all virtual outputs (including recoverable ones)
     * 2. Filters for swept but still spendable virtual outputs and preconfirmed subdust
     * 3. Includes subdust virtual outputs if the total value >= dust threshold
     * 4. Settles everything back to the wallet's Arkade address
     *
     * Note: Settled virtual outputs with long expiry are NOT recovered to avoid locking liquidity unnecessarily.
     * Only preconfirmed subdust is recovered to consolidate small amounts.
     *
     * @param eventCallback - Optional callback to receive settlement events
     * @returns Settlement transaction ID
     * @throws Error if no recoverable virtual outputs found
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
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
        // Get all virtual outputs including recoverable ones
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        // Get dust amount from wallet
        const dustAmount = getDustAmount(this.wallet);

        // Filter recoverable virtual outputs and handle subdust logic
        const { vtxosToRecover, totalAmount } = getRecoverableWithSubdust(
            allVtxos,
            dustAmount
        );

        if (vtxosToRecover.length === 0) {
            throw new Error("No recoverable VTXOs found");
        }

        const arkAddress = await this.wallet.getAddress();

        // Settle all recoverable virtual outputs back to the wallet
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
     * const manager = await wallet.getVtxoManager();
     * const balance = await manager.getRecoverableBalance();
     *
     * if (balance.recoverable > 0n) {
     *   console.log(`You can recover ${balance.recoverable} sats`);
     *   if (balance.includesSubdust) {
     *     console.log(`This includes ${balance.subdust} sats from subdust virtual outputs`);
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
     * Get virtual outputs that are expiring soon based on renewal configuration
     *
     * @param thresholdMs - Optional override for threshold in milliseconds
     * @returns Array of expiring virtual outputs, empty array if renewal is disabled or no virtual outputs expiring
     *
     * @example
     * ```typescript
     * const wallet = await Wallet.create({
     *  identity,
     *  arkServerUrl: 'https://arkade.computer',
     *  settlementConfig: {
     *      vtxoThreshold: 86_400 // 24 hours
     *  },
     * });
     * const manager = await wallet.getVtxoManager();
     * const expiringVtxos = await manager.getExpiringVtxos();
     * if (expiringVtxos.length > 0) {
     *   console.log(`${expiringVtxos.length} virtual outputs expiring soon`);
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
     * Renew expiring virtual outputs by settling them back to the wallet's address
     *
     * This method collects all expiring spendable virtual outputs (including recoverable ones) and settles
     * them back to the wallet, effectively refreshing their expiration time. This is the
     * primary way to prevent virtual outputs from expiring.
     *
     * @param eventCallback - Optional callback for settlement events
     * @returns Settlement transaction ID
     * @throws Error if no virtual outputs available to renew
     * @throws Error if total amount is below dust threshold
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
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
            // Get all virtual outputs (including recoverable ones)
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

    // ========== Boarding Input Sweep Methods ==========

    /**
     * Get boarding inputs whose timelock has expired.
     *
     * These inputs can no longer be onboarded cooperatively via `settle()` and
     * must be swept back to a fresh boarding address using the unilateral exit path.
     *
     * @returns Array of expired boarding inputs
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
     * const expired = await manager.getExpiredBoardingUtxos();
     * if (expired.length > 0) {
     *   console.log(`${expired.length} expired boarding inputs to sweep`);
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
     * Sweep expired boarding inputs back to a fresh boarding address via
     * the unilateral exit path (onchain self-spend).
     *
     * This builds a raw onchain transaction that:
     * - Uses all expired boarding inputs as inputs (spent via the CSV exit script path)
     * - Has a single output to the wallet's boarding address (restarts the timelock)
     * - Batches multiple expired boarding inputs into one transaction
     * - Skips the sweep if the output after fees would be below dust
     *
     * No Arkade server involvement is needed — this is a pure onchain transaction.
     *
     * @returns The broadcast transaction ID
     * @throws Error if no expired boarding inputs are found
     * @throws Error if output after fees is below dust (not economical to sweep)
     * @throws Error if boarding input sweep is not enabled in settlementConfig
     *
     * @example
     * ```typescript
     * const wallet = await Wallet.create({
     *   identity,
     *   arkServerUrl: 'https://arkade.computer',
     *   settlementConfig: {
     *     boardingUtxoSweep: true,
     *   },
     * });
     * const manager = await wallet.getVtxoManager();
     *
     * try {
     *   const txid = await manager.sweepExpiredBoardingUtxos();
     *   console.log('Swept expired boarding inputs:', txid);
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
        // Filter out inputs already swept (tx broadcast but not yet confirmed).
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

        // Mark boarding inputs as swept to prevent duplicate broadcasts on next poll
        for (const u of expiredUtxos) {
            this.sweptBoardingUtxos.add(`${u.txid}:${u.vout}`);
        }

        // Mark the sweep output as "known" so the next poll doesn't try to
        // auto-settle it back into Arkade (it lands at the same boarding address).
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

    /** Returns the onchain provider for fee estimation and broadcasting. */
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

        // Start polling for wallet settlement tasks independently of contract
        // manager SSE setup. Use a short delay to let the wallet finish construction.
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
                // Mirror the filter used by renewVtxos so the trigger set can't
                // be broader than the action set — otherwise a vtxo_spent event
                // for a fully-spent vtxo would fire a no-op renewal and burn
                // the cooldown.
                const shouldRenew =
                    event.type === "vtxo_received" ||
                    (event.type === "vtxo_spent" &&
                        event.vtxos.some(
                            (vtxo) =>
                                isRecoverable(vtxo) ||
                                (isSpendable(vtxo) && isExpired(vtxo))
                        ));

                if (shouldRenew) {
                    this.maybeRenewVtxos().catch((e) => {
                        console.error("Error renewing VTXOs:", e);
                    });
                }

                if (event.type === "vtxo_received") {
                    delegatorManager
                        ?.delegate(event.vtxos, destination)
                        .catch((e) => {
                            console.error("Error delegating VTXOs:", e);
                        });
                }
            });

            return stopWatching;
        } catch (e) {
            console.error("Error renewing VTXOs from VtxoManager", e);
            return undefined;
        }
    }

    private shouldAttemptRenewal(): boolean {
        const msSinceLastRenewal = Date.now() - this.lastRenewalTimestamp;
        return (
            !this.renewalInProgress &&
            msSinceLastRenewal >= VtxoManager.RENEWAL_COOLDOWN_MS
        );
    }

    private isIgnorableRenewalError(error: unknown): boolean {
        return (
            error instanceof Error &&
            (this.isNoopRenewalError(error) ||
                error.message.includes("VTXO_ALREADY_REGISTERED") ||
                error.message.includes("VTXO_ALREADY_SPENT") ||
                error.message.includes("duplicated input") ||
                error.message.includes("Renewal already in progress"))
        );
    }

    private isNoopRenewalError(error: unknown): boolean {
        return (
            error instanceof Error &&
            (error.message.includes("No VTXOs available to renew") ||
                error.message.includes("is below dust threshold"))
        );
    }

    private async maybeRenewVtxos(): Promise<void> {
        if (!isRenewCapable(this.wallet)) {
            return;
        }
        if (!this.shouldAttemptRenewal()) {
            return;
        }

        try {
            await this.renewVtxos();
        } catch (error) {
            if (this.isIgnorableRenewalError(error)) {
                if (this.isNoopRenewalError(error)) {
                    // A no-op renewal still means we checked recently, so apply
                    // the cooldown to avoid repeated scans on every event.
                    this.lastRenewalTimestamp = Date.now();
                }
                return;
            }
            throw error;
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
     * 1. Auto-renews expiring or recoverable VTXOs
     * 2. Auto-settles new boarding inputs into Arkade
     * 3. Sweeps expired boarding inputs (when boardingUtxoSweep is enabled)
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
            try {
                await this.maybeRenewVtxos();
            } catch (e) {
                hadError = true;
                console.error("Error auto-renewing VTXOs:", e);
            }

            if (isSweepCapable(this.wallet)) {
                try {
                    // Fetch boarding inputs once for the entire poll cycle so that
                    // settle and sweep don't each hit the network independently.
                    const boardingUtxos = await this.wallet.getBoardingUtxos();

                    // Settle new (unexpired) boarding inputs first, then sweep expired ones.
                    // Sequential to avoid racing for the same inputs.
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
                                console.error(
                                    "Error auto-sweeping boarding UTXOs:",
                                    e
                                );
                            }
                        }
                    }
                } catch (e) {
                    hadError = true;
                    console.error("Error fetching boarding UTXOs:", e);
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
     * Auto-settle new (unexpired) boarding inputs into Arkade.
     * Skips UTXOs that are already expired (those are handled by sweep).
     * Only settles UTXOs not already in-flight (tracked in knownBoardingUtxos).
     * UTXOs are marked as known only after a successful settle, so failed
     * attempts will be retried on the next poll.
     */
    private async settleBoardingUtxos(
        boardingUtxos: ExtendedCoin[]
    ): Promise<void> {
        // Exclude expired boarding inputs — those should be swept, not settled.
        // If we can't determine expired status, bail out entirely to avoid
        // accidentally settling expired inputs (which would conflict with sweep).
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
