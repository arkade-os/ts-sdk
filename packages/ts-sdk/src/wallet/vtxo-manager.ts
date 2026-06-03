import {
    ExtendedCoin,
    ExtendedVirtualCoin,
    IWallet,
    IReadonlyWallet,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    Outpoint,
} from ".";
import { ArkProvider, SettlementEvent } from "../providers/ark";
import { maybeArkError } from "../providers/errors";
import { hasBoardingTxExpired } from "../utils/arkTransaction";
import { CSVMultisigTapscript } from "../script/tapscript";
import { hex } from "@scure/base";
import { getSequence, scriptFromTapLeafScript, VtxoScript } from "../script/base";
import { Transaction } from "../utils/transaction";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { Estimator } from "../arkfee";
import { ArkAddress } from "../script/address";
import type { OnchainProvider } from "../providers/onchain";
import type { Network } from "../networks";
import type { DefaultVtxo } from "../script/default";
import { getDustAmount } from "./utils";

/**
 * Extended wallet interface for boarding input sweep operations.
 * These properties exist on the concrete Wallet class but not on IWallet.
 */
interface SweepCapableWallet extends IReadonlyWallet {
    boardingTapscript: DefaultVtxo.Script;
    onchainProvider: OnchainProvider;
    arkProvider: ArkProvider;
    network: Network;
    /**
     * Descriptor-aware signer for on-chain boarding exit/sweep txs. Routes
     * each input to the identity (baseline) or its per-index descriptor
     * (rotated boarding), so a sweep that batches UTXOs across boarding
     * addresses signs each with the correct key (plan §6-III.3).
     */
    signOnchainBoardingTx(tx: Transaction): Promise<Transaction>;
}

/**
 * Return whether a wallet exposes the properties required for boarding input sweep operations.
 *
 * @param wallet - Wallet to inspect
 * @returns `true` when the wallet supports boarding input sweep operations.
 */
function isSweepCapable(wallet: IWallet): wallet is IWallet & SweepCapableWallet {
    return (
        "boardingTapscript" in wallet &&
        "onchainProvider" in wallet &&
        "arkProvider" in wallet &&
        "network" in wallet &&
        "signOnchainBoardingTx" in wallet
    );
}

/**
 * Assert that the wallet supports boarding input sweep operations.
 *
 * @param wallet - Wallet to inspect
 * @throws Error if the wallet does not support boarding input sweep operations.
 */
function assertSweepCapable(wallet: IWallet): asserts wallet is IWallet & SweepCapableWallet {
    if (!isSweepCapable(wallet)) {
        throw new Error(
            "Boarding UTXO sweep requires a Wallet instance with boardingTapscript, onchainProvider, arkProvider, network, and signOnchainBoardingTx",
        );
    }
}

/**
 * Web Locks name used to serialize boarding-poll work across same-origin
 * browser contexts (tabs, service worker). Static because the goal is to
 * deduplicate polls for the *same* wallet — two distinct wallets on the
 * same origin will take turns, which is acceptable.
 */
const BOARDING_POLL_LOCK_NAME = "arkade-boarding-poll";

/**
 * Run `fn` under an exclusive Web Lock when the runtime provides one
 * (browser main thread, service worker). In environments without
 * `navigator.locks` (Node, React Native) the callback runs immediately
 * with no coordination.
 *
 * Uses `ifAvailable: true`: if another context already holds the lock,
 * skip this cycle entirely rather than queueing — the other context will
 * do the work and the next poll will re-check.
 */
async function runWithCrossInstanceLock(name: string, fn: () => Promise<void>): Promise<void> {
    const locks =
        typeof globalThis !== "undefined" && typeof globalThis.navigator !== "undefined"
            ? globalThis.navigator.locks
            : undefined;
    if (!locks) {
        await fn();
        return;
    }
    await locks.request(name, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
        if (lock === null) return;
        await fn();
    });
}

/** Default renewal threshold in seconds (3 days). */
export const DEFAULT_THRESHOLD_SECONDS = 259_200;

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
 *   arkProvider: new RestArkProvider(),
 * });
 *
 * // Custom expiry threshold of 24 hours
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
 *   settlementConfig: {
 *     vtxoThreshold: 60 * 60 * 24, // 24 hours in seconds
 *   },
 * });
 *
 * // Explicitly disable
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
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
export const DEFAULT_RENEWAL_CONFIG: Required<Omit<RenewalConfig, "enabled">> = {
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
 *   arkProvider: new RestArkProvider(),
 *   settlementConfig: {
 *     vtxoThreshold: 259_200,
 *     boardingUtxoSweep: true,
 *     pollIntervalMs: 60_000,
 *   },
 * })
 * ```
 */
export const DEFAULT_SETTLEMENT_CONFIG: Required<SettlementConfig> = {
    vtxoThreshold: DEFAULT_THRESHOLD_SECONDS,
    boardingUtxoSweep: true,
    pollIntervalMs: 60_000,
};

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
    dustAmount: bigint,
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
        if (vtxo.virtualStatus.state === "preconfirmed" && isSubdust(vtxo, dustAmount)) {
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
    dustAmount: bigint,
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
    const regularTotal = regular.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
    const subdustTotal = subdust.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
    const combinedTotal = regularTotal + subdustTotal;

    // Include subdust only if the combined total exceeds dust threshold
    const shouldIncludeSubdust = combinedTotal >= dustAmount;
    const vtxosToRecover = shouldIncludeSubdust ? recoverableVtxos : regular;

    const totalAmount = vtxosToRecover.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);

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
    thresholdMs: number, // in milliseconds
): boolean {
    const realThresholdMs = thresholdMs <= 100 ? DEFAULT_THRESHOLD_MS : thresholdMs;

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
    dustAmount: bigint,
): ExtendedVirtualCoin[] {
    return vtxos.filter(
        (vtxo) =>
            isVtxoExpiringSoon(vtxo, thresholdMs) ||
            isRecoverable(vtxo) ||
            (isSpendable(vtxo) && isExpired(vtxo)) ||
            isSubdust(vtxo, dustAmount),
    );
}

/**
 * Optional arguments for {@link IVtxoManager.renewVtxos}.
 */
export interface RenewVtxosOptions {
    /**
     * Override the renewal threshold for this call only, in seconds.
     *
     * When provided, takes precedence over `SettlementConfig.vtxoThreshold`
     * and the default (3 days). Useful for renewing only VTXOs that are
     * more urgently expiring than the globally configured threshold.
     */
    thresholdSeconds?: number;
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
 *   arkProvider: new RestArkProvider(),
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
    recoverVtxos(eventCallback?: (event: SettlementEvent) => void): Promise<string>;

    getRecoverableBalance(): Promise<{
        recoverable: bigint;
        subdust: bigint;
        includesSubdust: boolean;
        vtxoCount: number;
    }>;

    getExpiringVtxos(thresholdMs?: number): Promise<ExtendedVirtualCoin[]>;

    renewVtxos(
        eventCallback?: (event: SettlementEvent) => void,
        options?: RenewVtxosOptions,
    ): Promise<string>;

    getExpiredBoardingUtxos(): Promise<ExtendedCoin[]>;

    sweepExpiredBoardingUtxos(): Promise<string>;

    dispose(): Promise<void>;
}

export class VtxoManager implements AsyncDisposable, IVtxoManager {
    readonly settlementConfig: SettlementConfig | false;
    private contractEventsSubscription?: () => void;
    private readonly contractEventsSubscriptionReady: Promise<(() => void) | undefined>;
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

    // Guards against a retry treadmill on the periodic-settle path: a failing
    // settle would otherwise re-submit identical intents on every 60s poll,
    // producing per-minute DeleteIntent RPCs forever. Mirrors the renewal
    // cooldown but with exponential backoff on consecutive failures, so a
    // persistently broken input eventually drops to the backoff cap instead
    // of hammering the server. Shared across boarding + expiring-VTXO work
    // because they now ride on the same settle intent.
    private lastPeriodicSettleTimestamp = 0;
    private consecutivePeriodicSettleFailures = 0;
    private static readonly PERIODIC_SETTLE_COOLDOWN_MS = 30_000;
    private static readonly PERIODIC_SETTLE_MAX_BACKOFF_MS = 5 * 60 * 1000;

    // Throttle for the VTXO_ALREADY_SPENT -> refreshVtxos() reconciliation.
    // The server's authoritative view says our local cache is stale, so we
    // trigger a full refresh to advance the global sync cursor. Rate-limit
    // to guard against a buggy indexer cycling us into a refresh storm.
    private lastVtxoSpentRefreshTimestamp = 0;
    private vtxoSpentRefreshPromise?: Promise<void>;
    private static readonly VTXO_SPENT_REFRESH_COOLDOWN_MS = 30_000;

    constructor(
        readonly wallet: IWallet,
        /** @deprecated Use settlementConfig instead */
        readonly renewalConfig?: RenewalConfig,
        settlementConfig?: SettlementConfig | false,
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

        this.contractEventsSubscriptionReady = this.initializeSubscription().then(
            (subscription) => {
                this.contractEventsSubscription = subscription;
                return subscription;
            },
        );
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
    async recoverVtxos(eventCallback?: (event: SettlementEvent) => void): Promise<string> {
        // Get all virtual outputs including recoverable ones
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        // Get dust amount from wallet
        const dustAmount = getDustAmount(this.wallet);

        // Filter recoverable virtual outputs and handle subdust logic
        const { vtxosToRecover, totalAmount } = getRecoverableWithSubdust(allVtxos, dustAmount);

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
            eventCallback,
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

        const { vtxosToRecover, includesSubdust, totalAmount } = getRecoverableWithSubdust(
            allVtxos,
            dustAmount,
        );

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
     *  arkProvider: new RestArkProvider(),
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
    async getExpiringVtxos(thresholdMs?: number): Promise<ExtendedVirtualCoin[]> {
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
            threshold = this.renewalConfig?.thresholdMs ?? DEFAULT_RENEWAL_CONFIG.thresholdMs;
        }

        return getExpiringAndRecoverableVtxos(vtxos, threshold, getDustAmount(this.wallet));
    }

    /**
     * Renew expiring virtual outputs by settling them back to the wallet's address
     *
     * This method collects all expiring spendable virtual outputs (including recoverable ones) and settles
     * them back to the wallet, effectively refreshing their expiration time. This is the
     * primary way to prevent virtual outputs from expiring.
     *
     * @param eventCallback - Optional callback for settlement events
     * @param options - Optional per-call overrides; see {@link RenewVtxosOptions}
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
     *
     * // Renew only VTXOs that expire within 6 hours
     * const txid = await manager.renewVtxos(undefined, { thresholdSeconds: 6 * 60 * 60 });
     * ```
     */
    async renewVtxos(
        eventCallback?: (event: SettlementEvent) => void,
        options?: RenewVtxosOptions,
    ): Promise<string> {
        // Validate the per-call override before touching any state. The payload
        // can arrive over the worker MessageBus, so `thresholdSeconds` is not
        // guaranteed to be a number at runtime despite its type. Reject
        // NaN/Infinity/non-positive values, which would otherwise corrupt the
        // expiry threshold (and a 0/<=100ms threshold silently reverts to the
        // 3-day default via the guard in isVtxoExpiringSoon).
        if (options?.thresholdSeconds !== undefined) {
            const { thresholdSeconds } = options;
            if (
                typeof thresholdSeconds !== "number" ||
                !Number.isFinite(thresholdSeconds) ||
                thresholdSeconds <= 0
            ) {
                throw new TypeError(
                    `Invalid thresholdSeconds: expected a positive finite number, got ${String(thresholdSeconds)}`,
                );
            }
        }

        if (this.renewalInProgress) {
            throw new Error("Renewal already in progress");
        }

        this.renewalInProgress = true;

        try {
            // Get all virtual outputs (including recoverable ones)
            // Resolution order: explicit options.thresholdSeconds > settlementConfig.vtxoThreshold > default.
            // Manual API should always work, so we bypass the settlementConfig === false gate.
            let threshold: number;
            if (options?.thresholdSeconds !== undefined) {
                threshold = options.thresholdSeconds * 1000;
            } else if (
                this.settlementConfig !== false &&
                this.settlementConfig?.vtxoThreshold !== undefined
            ) {
                threshold = this.settlementConfig.vtxoThreshold * 1000;
            } else {
                threshold = DEFAULT_RENEWAL_CONFIG.thresholdMs;
            }
            let vtxos = await this.getExpiringVtxos(threshold);

            if (vtxos.length === 0) {
                throw new Error("No VTXOs available to renew");
            }

            // Pre-flight: validate the chosen inputs against the indexer's
            // authoritative state before submitting. The cursor-derived
            // delta sync filters by `created_at`, so a VTXO created
            // before the cursor and spent recently can sit in the local
            // cache forever; settling against it yields a guaranteed
            // VTXO_ALREADY_SPENT 400. Refreshing the candidates here
            // catches that BEFORE the network round-trip.
            vtxos = await this.revalidateBeforeSettle(vtxos, threshold);
            if (vtxos.length === 0) {
                throw new Error("No VTXOs available to renew");
            }

            const totalAmount = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

            // Get dust amount from wallet
            const dustAmount = getDustAmount(this.wallet);

            // Check if total amount is above dust threshold
            if (BigInt(totalAmount) < dustAmount) {
                throw new Error(
                    `Total amount ${totalAmount} is below dust threshold ${dustAmount}`,
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
                eventCallback,
            );
            return txid;
        } finally {
            // Update cooldown on EVERY attempt (success or failure) so transient
            // settle failures (stream close, connector mismatch, duplicated input)
            // don't allow the next vtxo_received event to re-enter renewal
            // immediately. Without this, a failed settle leaves lastRenewalTimestamp
            // at its previous value and the cooldown check becomes a no-op.
            this.lastRenewalTimestamp = Date.now();
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
    async getExpiredBoardingUtxos(prefetchedUtxos?: ExtendedCoin[]): Promise<ExtendedCoin[]> {
        const boardingUtxos = prefetchedUtxos ?? (await this.wallet.getBoardingUtxos());
        const boardingTimelock = this.getBoardingTimelock();

        // For block-based timelocks, fetch the chain tip height
        let chainTipHeight: number | undefined;
        if (boardingTimelock.type === "blocks") {
            const tip = await this.getOnchainProvider().getChainTip();
            chainTipHeight = tip.height;
        }

        return boardingUtxos.filter((utxo) =>
            hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight),
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
     *   arkProvider: new RestArkProvider(),
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
    async sweepExpiredBoardingUtxos(prefetchedUtxos?: ExtendedCoin[]): Promise<string> {
        const sweepEnabled =
            this.settlementConfig !== false &&
            (this.settlementConfig?.boardingUtxoSweep ??
                DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep);
        if (!sweepEnabled) {
            throw new Error("Boarding UTXO sweep is not enabled in settlementConfig");
        }

        const allExpired = await this.getExpiredBoardingUtxos(prefetchedUtxos);
        // Filter out inputs already swept (tx broadcast but not yet confirmed).
        const expiredUtxos = allExpired.filter(
            (u) => !this.sweptBoardingUtxos.has(`${u.txid}:${u.vout}`),
        );
        if (expiredUtxos.length === 0) {
            throw new Error("No expired boarding UTXOs to sweep");
        }

        const boardingAddress = await this.wallet.getBoardingAddress();

        // Get fee rate from onchain provider
        const feeRate = (await this.getOnchainProvider().getFeeRate()) ?? 1;

        // Representative exit leaf for fee estimation only. Every boarding
        // exit leaf shares the same template (Alice + CSV) and so has an
        // identical serialized size regardless of HD index — the actual
        // per-UTXO leaf is resolved in the input loop below.
        const exitTapLeafScript = this.getBoardingExitLeaf();

        // TapLeafScript: [{version, internalKey, merklePath}, scriptWithVersion]
        const leafScript = exitTapLeafScript[1];
        const leafScriptSize = leafScript.length - 1; // minus version byte
        const controlBlockSize = exitTapLeafScript[0].merklePath.length * 32;
        // Exit path witness: 1 Schnorr signature (64 bytes)
        const leafWitnessSize = 64;

        const estimator = TxWeightEstimator.create();
        for (const _ of expiredUtxos) {
            estimator.addTapscriptInput(leafWitnessSize, leafScriptSize, controlBlockSize);
        }
        estimator.addOutputAddress(boardingAddress, this.getNetwork());

        const fee = Math.ceil(Number(estimator.vsize().value) * feeRate);
        const totalValue = expiredUtxos.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
        const outputAmount = totalValue - BigInt(fee);

        // Dust check: skip if output after fees is below dust
        const dustAmount = getDustAmount(this.wallet);
        if (outputAmount < dustAmount) {
            throw new Error(
                `Sweep not economical: output ${outputAmount} sats after ${fee} sats fee is below dust (${dustAmount} sats)`,
            );
        }

        // Build the raw transaction
        const tx = new Transaction();

        for (const utxo of expiredUtxos) {
            // Resolve the exit (CSV) leaf and output script of the boarding
            // address THIS UTXO actually sits on — not necessarily the current
            // boarding address, since per-derivation rotation can leave unspent
            // UTXOs at previous boarding addresses (plan §6-III.2). The per-UTXO
            // boarding tapscript is carried on the ExtendedCoin's tapTree.
            const utxoScript = VtxoScript.decode(utxo.tapTree);
            const utxoExitLeaf = utxoScript.leaves.find((leaf) =>
                CSVMultisigTapscript.isScriptValid(scriptFromTapLeafScript(leaf)),
            );
            if (!utxoExitLeaf) {
                throw new Error(
                    `Boarding sweep: no CSV exit leaf for UTXO ${utxo.txid}:${utxo.vout}`,
                );
            }
            tx.addInput({
                txid: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: utxoScript.pkScript,
                    amount: BigInt(utxo.value),
                },
                tapLeafScript: [utxoExitLeaf],
                sequence: getSequence(utxoExitLeaf),
            });
        }

        tx.addOutputAddress(boardingAddress, outputAmount, this.getNetwork());

        // Sign and finalize. Route each input to the correct key — the
        // identity for index-0 / static boarding, the per-index descriptor for
        // a rotated boarding UTXO (plan §6-III.3) — instead of signing every
        // input with the index-0 identity key.
        const signedTx = await this.getSweepWallet().signOnchainBoardingTx(tx);
        signedTx.finalize();

        // Broadcast
        const txid = await this.getOnchainProvider().broadcastTransaction(signedTx.hex);

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
            hex.decode(wallet.boardingTapscript.exitScript),
        );
        return exitScript.params.timelock;
    }

    /** Returns the TapLeafScript for the boarding tapscript's exit (CSV) path. */
    private getBoardingExitLeaf() {
        return this.getSweepWallet().boardingTapscript.exit();
    }

    /** Returns the onchain provider for fee estimation and broadcasting. */
    private getOnchainProvider() {
        return this.getSweepWallet().onchainProvider;
    }

    /** Returns the Ark provider for intent fee and server info lookups. */
    private getArkProvider() {
        return this.getSweepWallet().arkProvider;
    }

    /** Returns the Bitcoin network configuration from the wallet. */
    private getNetwork() {
        return this.getSweepWallet().network;
    }

    private async initializeSubscription(): Promise<(() => void) | undefined> {
        if (this.settlementConfig === false) {
            return undefined;
        }

        // Start polling for boarding inputs independently of contract manager
        // SSE setup. Use a short delay to let the wallet finish construction.
        this.startupPollTimeoutId = setTimeout(() => {
            if (this.disposed) return;
            this.startBoardingUtxoPoll();
        }, 1000);

        try {
            const [delegateManager, contractManager, destination] = await Promise.all([
                this.wallet.getDelegateManager(),
                this.wallet.getContractManager(),
                this.wallet.getAddress(),
            ]);

            const stopWatching = contractManager.onContractEvent((event) => {
                if (event.type !== "vtxo_received") {
                    return;
                }

                const msSinceLastRenewal = Date.now() - this.lastRenewalTimestamp;
                const shouldRenew =
                    !this.renewalInProgress &&
                    msSinceLastRenewal >= VtxoManager.RENEWAL_COOLDOWN_MS;

                if (shouldRenew) {
                    this.renewVtxos().catch((e) => {
                        if (e instanceof Error) {
                            if (e.message.includes("No VTXOs available to renew")) {
                                // Not an error, just no virtual outputs eligible for renewal.
                                return;
                            }
                            if (e.message.includes("is below dust threshold")) {
                                // Not an error, just below dust threshold.
                                // As more virtual outputs are received, the threshold will be raised.
                                return;
                            }
                            if (
                                e.message.includes("VTXO_ALREADY_REGISTERED") ||
                                e.message.includes("duplicated input")
                            ) {
                                // Virtual output is already being used in a concurrent
                                // user-initiated operation. Skip silently — the
                                // wallet's tx lock serializes these, but the
                                // renewal will retry on the next cycle.
                                return;
                            }
                            if (e.message.includes("VTXO_ALREADY_SPENT")) {
                                // Our local VTXO cache is stale vs. the
                                // server's authoritative view. Trigger a
                                // throttled, targeted refresh on the
                                // offending outpoint (if the server told
                                // us which one), then skip — the next
                                // cycle will see fresh data.
                                void this.maybeRefreshAfterVtxoSpent(this.extractSpentOutpoint(e));
                                return;
                            }
                        }
                        console.error("Error renewing VTXOs:", e);
                    });
                }

                if (delegateManager) {
                    delegateManager.delegate(event.vtxos, destination).catch((e) => {
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

    /**
     * VTXO_ALREADY_SPENT means the server's authoritative view of VTXO state
     * is ahead of ours — cross-instance race, pre-lock snapshot drift, or an
     * SSE gap left stale data in the local cache. Silent-swallowing
     * guarantees the same error on the next cycle because nothing
     * reconciles the cache.
     *
     * The cursor-derived delta sync filters by `created_at`, so a VTXO that
     * was created before the cursor but spent recently can never be
     * reconciled by `refreshVtxos()`. Use `refreshOutpoints` for surgical
     * recovery: query the indexer for the specific stale outpoint and
     * upsert its authoritative state into the wallet repository.
     *
     * Throttled because the same VTXO can fire repeatedly before the
     * upsert observably propagates through the renewal selector.
     */
    private maybeRefreshAfterVtxoSpent(spentOutpoint?: Outpoint): Promise<void> {
        if (this.vtxoSpentRefreshPromise) {
            return this.vtxoSpentRefreshPromise;
        }

        const now = Date.now();
        if (now - this.lastVtxoSpentRefreshTimestamp < VtxoManager.VTXO_SPENT_REFRESH_COOLDOWN_MS) {
            return Promise.resolve();
        }
        this.lastVtxoSpentRefreshTimestamp = now;
        this.vtxoSpentRefreshPromise = (async () => {
            try {
                const contractManager = await this.wallet.getContractManager();
                if (spentOutpoint) {
                    await contractManager.refreshOutpoints([spentOutpoint]);
                } else {
                    // No outpoint metadata — fall back to the broader refresh.
                    await contractManager.refreshVtxos();
                }
            } catch (e) {
                console.error("Error refreshing VTXOs after VTXO_ALREADY_SPENT:", e);
            } finally {
                this.vtxoSpentRefreshPromise = undefined;
            }
        })();

        return this.vtxoSpentRefreshPromise;
    }

    /**
     * Extract the offending VTXO outpoint from a `VTXO_ALREADY_SPENT` error,
     * if the server attached one in `metadata.vtxo_outpoint`. Returns
     * `undefined` when the error isn't a parsed ArkError, isn't this code,
     * or doesn't carry the metadata.
     */
    private extractSpentOutpoint(error: unknown): Outpoint | undefined {
        const ark = maybeArkError(error);
        if (!ark || ark.name !== "VTXO_ALREADY_SPENT") return undefined;
        const raw = ark.metadata?.vtxo_outpoint;
        if (typeof raw !== "string") return undefined;
        const [txid, voutStr] = raw.split(":");
        if (!txid || !voutStr) return undefined;
        const vout = Number(voutStr);
        if (!Number.isInteger(vout) || vout < 0) return undefined;
        return { txid, vout };
    }

    /**
     * Reconcile the chosen VTXOs with the indexer's authoritative state
     * before submitting a settle intent. Pulls the canonical record for
     * each candidate outpoint via {@link IContractManager.refreshOutpoints}
     * (which upserts the result into the wallet repository), then
     * re-selects through the standard expiring-vtxo filter so anything
     * the refresh flagged as spent is dropped.
     *
     * Best-effort: a failed refresh just falls back to the original
     * candidates and lets the post-submit `VTXO_ALREADY_SPENT` recovery
     * handle whatever slipped through.
     */
    private async revalidateBeforeSettle(
        candidates: ExtendedVirtualCoin[],
        thresholdMs?: number,
    ): Promise<ExtendedVirtualCoin[]> {
        if (candidates.length === 0) return candidates;
        try {
            const cm = await this.wallet.getContractManager();
            await cm.refreshOutpoints(candidates.map((v) => ({ txid: v.txid, vout: v.vout })));
        } catch (e) {
            console.error("Error pre-validating VTXOs before settle:", e);
            return candidates;
        }
        // Re-select from the now-fresh local cache. Anything previously
        // selected but spent gets filtered out by the standard
        // `isSpendable`/`isSpent` checks inside getVtxos / getExpiringVtxos.
        try {
            const refreshed = await this.getExpiringVtxos(thresholdMs);
            const candidateKeys = new Set(candidates.map((v) => `${v.txid}:${v.vout}`));
            // Restrict to vtxos that were also in the original candidate set
            // — `getExpiringVtxos` may surface NEW vtxos and we don't want
            // pre-flight to silently expand the input set.
            return refreshed.filter((v) => candidateKeys.has(`${v.txid}:${v.vout}`));
        } catch (e) {
            console.error("Error re-selecting VTXOs after pre-validate:", e);
            return candidates;
        }
    }

    /** Computes the next poll delay, applying exponential backoff on failures. */
    private getNextPollDelay(): number {
        if (this.settlementConfig === false) return 0;
        const baseMs =
            this.settlementConfig.pollIntervalMs ?? DEFAULT_SETTLEMENT_CONFIG.pollIntervalMs;
        if (this.consecutivePollFailures === 0) return baseMs;
        const backoff = Math.min(
            baseMs * Math.pow(2, this.consecutivePollFailures),
            VtxoManager.MAX_BACKOFF_MS,
        );
        return backoff;
    }

    /**
     * Starts a polling loop that:
     * 1. Auto-settles new boarding inputs into Arkade
     * 2. Sweeps expired boarding inputs (when boardingUtxoSweep is enabled)
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
        // Guard: wallet must support boarding input + sweep operations
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
            // Cross-instance guard: in browser / service worker environments,
            // serialize the poll body across tabs and SW contexts so only one
            // of them registers intents per interval. Without this, every tab
            // submits a parallel RegisterIntent for the same boarding input
            // and N-1 of them collide on the server's duplicated-input check,
            // each producing a DeleteIntent RPC. No-op outside the browser.
            await runWithCrossInstanceLock(BOARDING_POLL_LOCK_NAME, async () => {
                // Fetch boarding inputs once for the entire poll cycle so that
                // settle and sweep don't each hit the network independently.
                const boardingUtxos = await this.wallet.getBoardingUtxos();

                // Settle new (unexpired) boarding inputs + any near-expiry
                // VTXOs in a single intent, then sweep expired boarding
                // inputs. Sequential to avoid racing for the same inputs.
                try {
                    await this.runPeriodicSettle(boardingUtxos);
                } catch (e) {
                    hadError = true;
                    console.error("Error during periodic settle:", e);
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
            });
        } catch (e) {
            hadError = true;
            console.error("Error fetching boarding UTXOs:", e);
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
     * Auto-settle new (unexpired) boarding inputs AND near-expiry VTXOs into
     * Arkade in a single intent. Skips boarding UTXOs that are already expired
     * (those are handled by sweep) and those already in-flight (tracked in
     * knownBoardingUtxos). If the event-driven renewal path is currently
     * running, VTXOs are omitted from this cycle to avoid double-spending.
     *
     * Failure bookkeeping: after every settle *attempt*, lastPeriodicSettleTimestamp
     * is armed and consecutive failures are counted so the next attempt is
     * blocked by an exponentially growing cooldown (capped). This stops a
     * persistently failing input from producing identical RegisterIntent +
     * DeleteIntent retries on every 60s poll.
     */
    private async runPeriodicSettle(boardingUtxos: ExtendedCoin[]): Promise<void> {
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
                hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight),
            );
            expiredSet = new Set(expired.map((u) => `${u.txid}:${u.vout}`));
        } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
        }

        const unsettledBoarding = boardingUtxos.filter(
            (u) =>
                u.status.confirmed &&
                !this.knownBoardingUtxos.has(`${u.txid}:${u.vout}`) &&
                !expiredSet.has(`${u.txid}:${u.vout}`),
        );

        // Collect near-expiry VTXOs unless the event-driven path is mid-renewal.
        // Skipping when renewalInProgress avoids double-submitting the same VTXOs.
        let expiringVtxos: ExtendedVirtualCoin[] = [];
        if (!this.renewalInProgress) {
            try {
                expiringVtxos = await this.getExpiringVtxos();
                // Pre-flight validation: see comment in `renewVtxos`. The
                // local cache may carry vtxos that the indexer already
                // marks spent because the cursor-derived delta sync only
                // catches `created_at`-recent updates, not status changes
                // for older VTXOs.
                expiringVtxos = await this.revalidateBeforeSettle(expiringVtxos);
            } catch (e) {
                // Non-fatal: fall back to boarding-only settle.
                console.error("Error fetching expiring VTXOs:", e);
            }
        }

        if (unsettledBoarding.length === 0 && expiringVtxos.length === 0) {
            return;
        }

        // Respect the cooldown armed by the previous attempt. Cooldown grows
        // exponentially with consecutive failures and is capped by
        // PERIODIC_SETTLE_MAX_BACKOFF_MS.
        const cooldownMs = Math.min(
            VtxoManager.PERIODIC_SETTLE_COOLDOWN_MS *
                Math.pow(2, this.consecutivePeriodicSettleFailures),
            VtxoManager.PERIODIC_SETTLE_MAX_BACKOFF_MS,
        );
        if (Date.now() - this.lastPeriodicSettleTimestamp < cooldownMs) {
            return;
        }

        const dustAmount = getDustAmount(this.wallet);

        // Fetch server intent-fee config so each input/output can be priced.
        // Without this, settle sends `outputAmount = sum(inputs)` and the
        // server rejects with INTENT_INSUFFICIENT_FEE whenever the operator
        // charges non-zero intent fees.
        const { fees } = await this.getArkProvider().getInfo();
        const estimator = new Estimator(fees.intentFee);

        let totalAmount = 0n;

        const filteredBoarding: ExtendedCoin[] = [];
        for (const u of unsettledBoarding) {
            const inputFee = estimator.evalOnchainInput({
                amount: BigInt(u.value),
            });
            if (inputFee.value >= BigInt(u.value)) {
                // Fee exceeds input value — including it would drain the output.
                continue;
            }
            filteredBoarding.push(u);
            totalAmount += BigInt(u.value) - BigInt(inputFee.satoshis);
        }

        const filteredVtxos: ExtendedVirtualCoin[] = [];
        for (const v of expiringVtxos) {
            const inputFee = estimator.evalOffchainInput({
                amount: BigInt(v.value),
                type: v.virtualStatus.state === "swept" ? "recoverable" : "vtxo",
                weight: 0,
                birth: v.createdAt,
                expiry: v.virtualStatus.batchExpiry
                    ? new Date(v.virtualStatus.batchExpiry)
                    : undefined,
            });
            if (inputFee.satoshis >= v.value) {
                continue;
            }
            filteredVtxos.push(v);
            totalAmount += BigInt(v.value) - BigInt(inputFee.satoshis);
        }

        if (filteredBoarding.length === 0 && filteredVtxos.length === 0) {
            return;
        }

        const arkAddress = await this.wallet.getAddress();

        const outputFee = estimator.evalOffchainOutput({
            amount: totalAmount,
            script: hex.encode(ArkAddress.decode(arkAddress).pkScript),
        });
        totalAmount -= BigInt(outputFee.satoshis);

        if (totalAmount < dustAmount) return;

        const includesVtxos = filteredVtxos.length > 0;

        // Block the event-driven renewal path while this settle is in flight
        // when VTXOs are part of the intent. Mirrors renewVtxos()'s guard so
        // the two paths can't race on the same VTXO inputs.
        if (includesVtxos) {
            this.renewalInProgress = true;
        }

        let success = false;
        let staleCacheSkip = false;
        try {
            try {
                await this.wallet.settle({
                    inputs: [...filteredBoarding, ...filteredVtxos],
                    outputs: [{ address: arkAddress, amount: totalAmount }],
                });

                // Mark boarding inputs as known only after successful settle.
                for (const u of filteredBoarding) {
                    this.knownBoardingUtxos.add(`${u.txid}:${u.vout}`);
                }
                success = true;
            } catch (e) {
                if (e instanceof Error && e.message.includes("VTXO_ALREADY_SPENT")) {
                    // Local VTXO cache is stale vs. the server's
                    // authoritative view — not a transient failure.
                    // Trigger a throttled, targeted refresh on the
                    // offending outpoint and skip this cycle without
                    // bumping the failure counter, so the next poll
                    // can retry once the cache reconciles.
                    staleCacheSkip = true;
                    void this.maybeRefreshAfterVtxoSpent(this.extractSpentOutpoint(e));
                } else {
                    throw e;
                }
            }
        } finally {
            this.lastPeriodicSettleTimestamp = Date.now();
            if (includesVtxos) {
                // Match event-path semantics: bump the renewal cooldown
                // whether we succeeded or failed so a failed periodic settle
                // doesn't let the next vtxo_received event re-enter renewal
                // immediately.
                this.lastRenewalTimestamp = Date.now();
                this.renewalInProgress = false;
            }
            if (success) {
                this.consecutivePeriodicSettleFailures = 0;
            } else if (!staleCacheSkip) {
                // Don't bump on stale-cache skip: it's not a transient
                // failure, and the next cycle should try immediately
                // after the refresh lands.
                this.consecutivePeriodicSettleFailures++;
            }
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
                const timeout = new Promise<void>((r) => (timer = setTimeout(r, 30_000)));
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
