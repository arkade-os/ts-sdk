import {
    ExtendedCoin,
    ExtendedVirtualCoin,
    IWallet,
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
import { DUST_AMOUNT } from "./utils";

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
 * Pass `false` to explicitly disable all settlement behavior.
 * Pass `{}` to enable with all defaults.
 *
 * @example
 * ```typescript
 * // Enable with defaults (VTXO renewal at 3 days, no boarding sweep)
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 *   settlementConfig: {},
 * });
 *
 * // Enable both VTXO renewal and boarding UTXO sweep
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 *   settlementConfig: {
 *     vtxoThreshold: 86400, // 24 hours in seconds
 *     boardingUtxoSweep: true,
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
     * @default false
     */
    boardingUtxoSweep?: boolean;
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
    boardingUtxoSweep: false,
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
export class VtxoManager {
    readonly settlementConfig: SettlementConfig | false;

    constructor(
        readonly wallet: IWallet,
        /** @deprecated Use settlementConfig instead */
        readonly renewalConfig?: RenewalConfig,
        settlementConfig?: SettlementConfig | false
    ) {
        // Normalize: prefer settlementConfig, fall back to renewalConfig
        if (settlementConfig !== undefined) {
            this.settlementConfig = settlementConfig;
        } else if (renewalConfig) {
            this.settlementConfig =
                renewalConfig.enabled === false
                    ? false
                    : {
                          vtxoThreshold: renewalConfig.thresholdMs
                              ? renewalConfig.thresholdMs / 1000
                              : undefined,
                      };
        } else {
            this.settlementConfig = false;
        }
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
    async getExpiredBoardingUtxos(): Promise<ExtendedCoin[]> {
        const boardingUtxos = await this.wallet.getBoardingUtxos();
        const boardingTimelock = this.getBoardingTimelock();

        return boardingUtxos.filter((utxo) =>
            hasBoardingTxExpired(utxo, boardingTimelock)
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
    async sweepExpiredBoardingUtxos(): Promise<string> {
        if (
            this.settlementConfig === false ||
            !this.settlementConfig?.boardingUtxoSweep
        ) {
            throw new Error(
                "Boarding UTXO sweep is not enabled in settlementConfig"
            );
        }

        const expiredUtxos = await this.getExpiredBoardingUtxos();
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
        if (outputAmount < BigInt(DUST_AMOUNT)) {
            throw new Error(
                `Sweep not economical: output ${outputAmount} sats after ${fee} sats fee is below dust (${DUST_AMOUNT} sats)`
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
        return this.getOnchainProvider().broadcastTransaction(signedTx.hex);
    }

    // ========== Private Helpers ==========

    private getBoardingTimelock() {
        const wallet = this.wallet as unknown as {
            boardingTapscript: { exitScript: string };
        };
        const exitScript = CSVMultisigTapscript.decode(
            hex.decode(wallet.boardingTapscript.exitScript)
        );
        return exitScript.params.timelock;
    }

    private getBoardingExitLeaf() {
        const wallet = this.wallet as unknown as {
            boardingTapscript: {
                exit(): ReturnType<
                    import("../script/default").DefaultVtxo.Script["exit"]
                >;
            };
        };
        return wallet.boardingTapscript.exit();
    }

    private getBoardingOutputScript() {
        const wallet = this.wallet as unknown as {
            boardingTapscript: { pkScript: Uint8Array };
        };
        return wallet.boardingTapscript.pkScript;
    }

    private getOnchainProvider() {
        const wallet = this.wallet as unknown as {
            onchainProvider: import("../providers/onchain").OnchainProvider;
        };
        return wallet.onchainProvider;
    }

    private getNetwork() {
        const wallet = this.wallet as unknown as {
            network: import("../networks").Network;
        };
        return wallet.network;
    }

    private getIdentity() {
        return this.wallet.identity;
    }
}
