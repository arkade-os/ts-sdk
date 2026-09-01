import {
    ExtendedCoin,
    ExtendedVirtualCoin,
    IWallet,
    IReadonlyWallet,
    isSubdust,
    Outpoint,
    VirtualCoin,
} from ".";
import {
    canRecoverOnchain,
    canSpendOffchain,
    hasTerminalSpend,
    isPastExpiry,
    normalizeVtxo,
    resolveTimeHeight,
    toBatchExpiry,
    toOffchainInputFeeParams,
    type NormalizedExtendedVirtualCoin,
    type TimeHeight,
} from "./vtxo";
import { ArkadeInfo, ArkProvider, SettlementEvent } from "../providers/ark";
import { ArkErrorName, isArkError, maybeArkError } from "../providers/errors";
import type { BoardingUtxoGroup } from "./wallet";
import type { ExtendedContractVtxo } from "../contracts/types";
import {
    classifyAgainstSignerSet,
    isCooperativelyMigratable,
    signerSetFromInfo,
    type SignerClassification,
    type SignerSet,
    type SignerStatus,
} from "./signerRotation";
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
import { logExcludedVtxos, outpointReasons } from "../contracts/spendability";

/**
 * Outpoints (`txid:vout`) of VTXOs that are NOT cooperatively spendable because
 * their contract's signer is past its cutoff (`EXPIRED`) and the VTXO has not
 * yet been swept by the server. Such funds are unspendable until they recover
 * (the server sweeps the batch at expiry, then the swept output re-settles under
 * the active signer), so `getBalance` buckets them under `pendingRecovery` and
 * coin selection skips them — otherwise a send would pick a VTXO the operator
 * will not co-sign and fail at submit.
 *
 * Pure + offline: classification uses a cached {@link SignerSet}, never a fresh
 * GetInfo. `MIGRATABLE` / `DUE_NOW` (still cooperatively spendable), already-
 * swept (recoverable), `CURRENT`, and `UNKNOWN_SIGNER` rows are all left alone.
 */
export function selectPendingRecoveryOutpoints(
    contractsWithVtxos: ReadonlyArray<{
        contract: { params: { serverPubKey?: string } };
        vtxos: ReadonlyArray<VirtualCoin>;
    }>,
    signerSet: SignerSet,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Set<string> {
    const out = new Set<string>();
    for (const { contract, vtxos } of contractsWithVtxos) {
        const serverPubKey = contract.params.serverPubKey;
        if (!serverPubKey) continue;
        if (classifyAgainstSignerSet(serverPubKey, signerSet, nowSeconds).status !== "EXPIRED") {
            continue;
        }
        for (const v of vtxos) {
            // Exited coins are excluded: their remedy is `completeUnroll`,
            // not a signer rotation, and reporting them here would blame the
            // rotation for a coin the user took onchain themselves.
            if (!hasTerminalSpend(v) && !v.isSwept && !v.isUnrolled) {
                out.add(`${v.txid}:${v.vout}`);
            }
        }
    }
    return out;
}

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

/**
 * Maximum number of VTXOs included in a single settlement intent.
 *
 * arkd has no fixed per-intent VTXO count limit; it rejects an intent with
 * `TX_TOO_LARGE` once the resulting ark transaction exceeds its weight budget
 * (`maxTxWeight`, ~40k weight units by default). 50 is a conservative count
 * that stays well under that weight, leaving headroom for boarding inputs
 * (added uncapped) plus transaction-size overhead. When more VTXOs are
 * eligible, the overflow is left for the next settlement cycle.
 *
 * This cap is a ts-sdk-specific safeguard: neither go-sdk nor NArk caps the
 * settlement batch — go-sdk submits every spendable VTXO in a single intent.
 * Because the reference SDKs impose no selection order (go-sdk's query has no
 * `ORDER BY`), we are free to order the candidates before capping so the most
 * important VTXOs survive the cut — see {@link byValueDescending} and
 * {@link byExpiryAscending}.
 */
export const MAX_VTXOS_PER_SETTLEMENT = 50;

/**
 * Maximum number of inputs the server accepts in a single intent proof
 * (get-pending-tx and friends). Larger input sets must be split into batches.
 */
export const MAX_INPUTS_PER_INTENT = 20;

/**
 * Order VTXOs so the highest-value ones come first. New array; input untouched.
 *
 * Used by the value-driven paths (recovery, manual full settle): when the
 * {@link MAX_VTXOS_PER_SETTLEMENT} cap defers the overflow to a later cycle,
 * the batch should carry the most value. For recovery this also gives the
 * capped subset the best chance of clearing the dust threshold.
 */
export function byValueDescending<T extends { value: number }>(vtxos: T[]): T[] {
    return [...vtxos].sort((a, b) => b.value - a.value);
}

/**
 * The {@link TimeHeight} for one expiry-driven pass. Only digs the provider out of whichever wallet
 * we were handed — `onchainProvider` lives on the concrete wallets, not on `IReadonlyWallet`.
 */
async function fetchTimeHeight(wallet: IReadonlyWallet): Promise<TimeHeight> {
    return resolveTimeHeight((wallet as Partial<SweepCapableWallet>).onchainProvider);
}

/**
 * Whether {@link Wallet.sendSelectedVtxosToSelf} will accept this input at `now`.
 *
 * @remarks
 * Mirrors that method's two rejection conditions exactly, so the migration leg never submits an
 * input the send path throws on — see {@link MigrationLegReport.notSpendableOffchain} for why that
 * matters. The same `TimeHeight` goes down to the send path with the inputs, so the two sides
 * cannot disagree at the expiry boundary.
 */
function canMigrateBySend(vtxo: NormalizedExtendedVirtualCoin, now: TimeHeight): boolean {
    // The send path spends cooperatively, so swept/expired inputs belong to recovery instead.
    if (!canSpendOffchain(vtxo, now)) return false;
    // No batch expiry means nothing to migrate *from*: the DB-update path only persists a
    // wallet-owned output when an input expiry exists (unrolled/settled inputs carry none).
    return vtxo.expiresAt !== undefined || vtxo.expiresAtHeight !== undefined;
}

/**
 * Order VTXOs so the soonest-expiring ones come first. New array; input
 * untouched. Already recoverable/expired VTXOs sort first. VTXOs without a
 * batch expiry, or with a block-height-looking expiry value, sort last because
 * they do not have a usable wall-clock expiry.
 *
 * Used by the expiry-driven paths (renewal, periodic settle): when the
 * {@link MAX_VTXOS_PER_SETTLEMENT} cap defers the overflow to a later cycle,
 * the most urgent VTXOs must make the cut so none miss their renewal window
 * and get forced into a unilateral exit.
 */
export function byExpiryAscending(
    vtxos: NormalizedExtendedVirtualCoin[],
    now: TimeHeight,
): NormalizedExtendedVirtualCoin[] {
    const expiryKey = (vtxo: NormalizedExtendedVirtualCoin) => {
        // Swept: maximally urgent, and carries no wall-clock instant to order by.
        if (vtxo.isSwept) return -Infinity;
        if (vtxo.expiresAt !== undefined) return vtxo.expiresAt.getTime();
        // A height-encoded expiry has no place on the millisecond scale, so it can only be
        // ranked as urgent or not. Needs `now.height`; without one it reads as not expired.
        if (vtxo.expiresAtHeight !== undefined) {
            return isPastExpiry(vtxo, now) ? -Infinity : Infinity;
        }
        return Infinity;
    };

    // Compared rather than subtracted: two swept VTXOs (both `-Infinity`), or two without a
    // wall-clock expiry (both `Infinity`), subtract to NaN, and a NaN comparator leaves the order
    // unspecified — the urgent-first guarantee would hold only by luck.
    return [...vtxos].sort((a, b) => {
        const ka = expiryKey(a);
        const kb = expiryKey(b);
        if (ka === kb) return 0;
        return ka < kb ? -1 : 1;
    });
}

/**
 * Select inputs from `sorted` that fit in a single settlement: at most
 * {@link MAX_VTXOS_PER_SETTLEMENT} inputs AND a cumulative `value` no greater
 * than `maxAmount`. `maxAmount < 0` disables the amount bound — it is the
 * server's `-1` "no limit" sentinel for `ArkadeInfo.vtxoMaxAmount`.
 *
 * Each settlement path builds a single output equal to the (fee-adjusted) sum
 * of its inputs, and the server rejects any virtual output above `vtxoMaxAmount`
 * with `AMOUNT_TOO_HIGH`. Capping the input total therefore keeps that output
 * within bounds; the overflow is settled on the next cycle, mirroring the
 * count-cap behaviour.
 *
 * The bound is applied to each input's gross `value`, not its fee-adjusted net
 * contribution. This is intentional and strictly conservative: the real output
 * is smaller once the offchain output fee is removed, so a batch that fits on
 * gross value always fits post-fee. The helper has no fee context, and erring
 * toward fewer inputs per cycle is safe. Do not "tighten" this by subtracting
 * fees here. (The periodic-settle / manual-settle paths, which do have a fee
 * estimator on hand, cap on net instead — a deliberate, harmless asymmetry.)
 *
 * `sorted` must already be ordered by the caller's priority (value-descending
 * for recovery / manual full settle, expiry-ascending for renewal) so the
 * inputs that matter most are tried first. An input that would breach the
 * amount cap is skipped — not a stopping point — so a smaller input behind an
 * oversized or awkwardly-sized one still gets in (a break would strand it and
 * could leave the batch below dust). The count cap is a hard stop. Uses
 * `> maxAmount` to mirror the server's strict check, so a batch whose total
 * equals the limit still fits.
 */
export function capSettlementBatch<T extends { value: number }>(
    sorted: T[],
    maxAmount: bigint,
): T[] {
    const batch: T[] = [];
    let total = 0n;
    for (const vtxo of sorted) {
        if (batch.length >= MAX_VTXOS_PER_SETTLEMENT) break;
        // Gross value, intentionally not fee-adjusted — see the note above.
        const next = total + BigInt(vtxo.value);
        if (maxAmount >= 0n && next > maxAmount) continue;
        batch.push(vtxo);
        total = next;
    }
    return batch;
}

/**
 * Price a settlement's VTXO inputs against the operator's intent-fee policy,
 * dropping any input that cannot pay for itself.
 *
 * An intent's fee IS `sum(inputs) - sum(outputs)`, so a single-output settlement
 * asking for the gross input sum offers exactly zero and the server rejects the
 * whole intent with `INTENT_INSUFFICIENT_FEE` wherever the operator prices
 * offchain inputs at all. `subtotal` is what the inputs are worth once each has
 * paid its own way; the caller still owes {@link deductOffchainOutputFee} on top.
 *
 * An input whose fee meets or exceeds its value is skipped rather than settled —
 * it would take more out of the output than it puts in. Callers filter with this
 * BEFORE {@link capSettlementBatch} so an uneconomic input cannot occupy a slot
 * that a viable one behind it could have used.
 *
 * Each survivor's net is returned alongside it so a caller that then narrows the
 * batch can total the survivors through {@link subtotalOf} without pricing
 * anything twice.
 */
function priceSettlementInputs<T extends NormalizedExtendedVirtualCoin>(
    vtxos: T[],
    estimator: Estimator,
): { payable: T[]; net: ReadonlyMap<string, bigint> } {
    const payable: T[] = [];
    const net = new Map<string, bigint>();
    for (const vtxo of vtxos) {
        const inputFee = estimator.evalOffchainInput(toOffchainInputFeeParams(vtxo));
        if (inputFee.satoshis >= vtxo.value) {
            continue;
        }
        payable.push(vtxo);
        net.set(`${vtxo.txid}:${vtxo.vout}`, BigInt(vtxo.value - inputFee.satoshis));
    }
    return { payable, net };
}

/**
 * Total what a settlement's inputs are worth once each has paid its own intent
 * fee, from the nets {@link priceSettlementInputs} already computed.
 *
 * `vtxos` must come from that call's `payable` — a batch cap may have narrowed
 * it, nothing else may. An input with no priced net throws rather than counting
 * as zero: silently dropping one understates the output, which offers the server
 * MORE fee than asked and quietly overpays out of the user's own funds.
 */
function subtotalOf(
    vtxos: readonly { txid: string; vout: number }[],
    net: ReadonlyMap<string, bigint>,
): bigint {
    let subtotal = 0n;
    for (const vtxo of vtxos) {
        const priced = net.get(`${vtxo.txid}:${vtxo.vout}`);
        if (priced === undefined) {
            throw new Error(`Unpriced settlement input ${vtxo.txid}:${vtxo.vout}`);
        }
        subtotal += priced;
    }
    return subtotal;
}

/**
 * Take the operator's offchain output fee off a settlement's single output.
 *
 * The fee is evaluated on `subtotal` — the amount before this deduction — rather
 * than on the amount finally committed, matching what
 * {@link VtxoManager.runPeriodicSettle} and the no-argument `Wallet.settle()`
 * branch already do. Under a percentage rate `r` that implies a fee of
 * `r * subtotal` where the server asks only `r * subtotal * (1 - r)`, i.e. an
 * over-payment of `r^2 * subtotal`. Deliberate: paying over is always accepted,
 * whereas solving the fixed point exactly to recover those satoshis risks
 * landing one under the minimum — which is the rejection this pricing exists to
 * avoid.
 *
 * Can return a value below dust, or below zero, when a flat output fee outweighs
 * the inputs; every caller checks the result against the dust threshold.
 */
function deductOffchainOutputFee(
    subtotal: bigint,
    estimator: Estimator,
    arkAddress: string,
): bigint {
    // Mirror the estimator's own early return rather than reaching it through
    // `ArkAddress.decode`: with no output program the script is never read, and
    // an operator that doesn't price outputs shouldn't make a decodable address
    // a precondition for renewing or recovering.
    if (!estimator.config.offchainOutput) {
        return subtotal;
    }
    const outputFee = estimator.evalOffchainOutput({
        amount: subtotal,
        script: hex.encode(ArkAddress.decode(arkAddress).pkScript),
    });
    return subtotal - BigInt(outputFee.satoshis);
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

    /**
     * Automatically migrate VTXOs minted under a now-deprecated server signer
     * back to the wallet's active-signer address before their cutoff window
     * closes (planned arkd key rotation).
     *
     * When enabled, each poll cycle cooperatively migrates stale-signer VTXOs
     * via the normal `settle()` path, applying a mid-session server-signer
     * rotation first when the wallet's own snapshot signer has been deprecated.
     * The explicit {@link IVtxoManager.migrateDeprecatedSignerVtxos} method
     * remains available for manual migration regardless of this flag.
     *
     * Setting `settlementConfig: false` disables all background settlement,
     * including migration. Set this field to `false` to keep renewal/sweep but
     * skip automatic deprecated-signer migration specifically.
     *
     * @defaultValue `true`
     */
    deprecatedSignerMigration?: boolean;
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
    deprecatedSignerMigration: true,
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
    vtxos: NormalizedExtendedVirtualCoin[],
    dustAmount: bigint,
    now: TimeHeight,
): NormalizedExtendedVirtualCoin[] {
    return vtxos.filter((vtxo) => {
        // Swept, or past expiry but not yet swept — both recover the same way.
        if (canRecoverOnchain(vtxo, now)) {
            return true;
        }

        // Recover preconfirmed subdust to consolidate small amounts
        if (canSpendOffchain(vtxo, now) && vtxo.isPreconfirmed && isSubdust(vtxo, dustAmount)) {
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
    vtxos: NormalizedExtendedVirtualCoin[],
    dustAmount: bigint,
    now: TimeHeight,
): {
    vtxosToRecover: NormalizedExtendedVirtualCoin[];
    includesSubdust: boolean;
    totalAmount: bigint;
} {
    const recoverableVtxos = getRecoverableVtxos(vtxos, dustAmount, now);

    // Separate subdust from regular recoverable
    const subdust: NormalizedExtendedVirtualCoin[] = [];
    const regular: NormalizedExtendedVirtualCoin[] = [];

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

    // Being synchronous, this has no chain tip to compare a height-encoded expiry against, so
    // `expiresAtHeight` reads as "doesn't expire" — as it always has.
    const expiresAt = normalizeVtxo(vtxo).expiresAt;
    if (expiresAt === undefined) return false;

    const now = Date.now();
    const batchExpiry = expiresAt.getTime();

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
    vtxos: NormalizedExtendedVirtualCoin[],
    thresholdMs: number,
    dustAmount: bigint,
    now: TimeHeight,
): NormalizedExtendedVirtualCoin[] {
    return vtxos.filter(
        (vtxo) =>
            isVtxoExpiringSoon(vtxo, thresholdMs) ||
            canRecoverOnchain(vtxo, now) ||
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
 * Optional arguments for {@link IVtxoManager.migrateDeprecatedSignerVtxos}.
 */
export interface MigrateDeprecatedSignerOptions {
    /** Callback to receive settlement events during the migration intent. */
    eventCallback?: (event: SettlementEvent) => void;
}

/**
 * A single VTXO referenced in a {@link DeprecatedSignerMigrationReport}.
 */
export interface MigrationVtxoRef {
    txid: string;
    vout: number;
    value: number;
    /** The deprecated signer the VTXO was minted under (x-only hex). */
    signerPubKey: string;
    /** Absolute cutoff (Unix seconds) when the server advertised one. */
    cutoffDate?: bigint;
}

/**
 * Machine-readable status for a single deprecated signer the wallet holds
 * funds under (Section 6). Derived at read time from contract params plus a
 * fresh {@link ArkadeInfo} snapshot — never persisted.
 */
export interface DeprecatedSignerReport {
    /** Deprecated signer key (x-only hex). */
    signerPubKey: string;
    /** One of `migratable` | `dueNow` | `expired` | `unknownSigner`. */
    status: SignerStatus;
    /** Absolute cutoff (Unix seconds), present only when advertised. */
    cutoffDate?: bigint;
    /** Derived seconds until cutoff; negative once passed. */
    secondsUntilCutoff?: number;
    /** Number of spendable VTXOs the wallet holds under this signer. */
    vtxoCount: number;
    /** Total value of those VTXOs in satoshis. */
    totalValue: number;
    /**
     * Number of spendable boarding UTXOs the wallet holds under this signer
     * (Section 7). Counts every confirmed boarding coin, including those whose
     * own CSV exit window has elapsed (they leave via the unilateral sweep).
     */
    boardingCount: number;
    /** Total value of those boarding UTXOs in satoshis (Section 7). */
    boardingValue: number;
    /**
     * Expired-signer VTXOs already swept and queued for recovery to the active
     * signer (the recover-on-sweep default — see {@link SignerStatus} `EXPIRED`).
     * Non-zero only on `EXPIRED` rows; these drain on the next recovery pass
     * (Section 6 / post-cutoff).
     */
    recoverableCount: number;
    recoverableValue: number;
    /**
     * Expired-signer VTXOs not yet swept; awaiting the server batch sweep before
     * they become recoverable. Non-zero only on `EXPIRED` rows — nothing for the
     * user to do but wait (Section 6 / post-cutoff).
     */
    awaitingSweepCount: number;
    awaitingSweepValue: number;
    /**
     * Soonest batch expiry (ms since epoch) among the awaiting-sweep VTXOs, as a
     * recovery ETA hint. Present only when an `EXPIRED` row has awaiting-sweep
     * VTXOs that carry a batch expiry (Section 6 / post-cutoff).
     */
    nextSweepEta?: number;
}

/**
 * Why a single migration leg (VTXO send or boarding settle) submitted nothing.
 * `oversized-only` means every migratable input in that leg individually
 * exceeds the server's per-output ceiling (`vtxoMaxAmount`) — see
 * {@link MigrationLegReport.oversized}.
 */
export type MigrationLegSkipReason = "below-dust" | "oversized-only" | "not-spendable-only";

/**
 * Why the whole pass submitted nothing, before either leg was built.
 * `no-deprecated-vtxos` means BOTH migratable sets (VTXO and boarding) were
 * empty; `unknown-wallet-signer` means the wallet's own snapshot signer is
 * neither active nor advertised deprecated, so the pass refuses to rotate.
 */
export type MigrationGlobalSkipReason = "no-deprecated-vtxos" | "unknown-wallet-signer";

/**
 * Outcome of one migration leg. The VTXO leg migrates through the Ark send path
 * ({@link Wallet.sendSelectedVtxosToSelf}); the boarding leg keeps its
 * settle-backed migration (boarding coins are on-chain inputs with no send
 * path). Each leg owns its full sizing pipeline (oversized filtering, count +
 * amount caps, its own dust floor) and reports independently — a failure or skip
 * in one leg never suppresses the other.
 */
export interface MigrationLegReport {
    /** VTXO leg: Ark transaction id from send. Boarding leg: settle commitment txid. */
    txid?: string;
    /** Inputs submitted and accepted in this leg's transaction; empty on error/skip. */
    migrated: MigrationVtxoRef[];
    /** Why this leg submitted nothing (every candidate below dust or oversized). */
    skipped?: MigrationLegSkipReason;
    /**
     * Migratable inputs deferred to a later pass by this leg's own caps (the
     * input count {@link MAX_VTXOS_PER_SETTLEMENT} or the per-output amount
     * ceiling `vtxoMaxAmount`). Present and non-zero only when a cap bound and
     * the leg actually submitted; makes the truncation visible.
     */
    deferred?: number;
    /**
     * Inputs whose value alone exceeds the per-output ceiling (`vtxoMaxAmount`):
     * a single ≤-ceiling output can never hold them, so they never migrate
     * cooperatively and require a unilateral exit. Present only when non-empty;
     * absent when the server advertises no ceiling (`vtxoMaxAmount < 0`).
     */
    oversized?: MigrationVtxoRef[];
    /**
     * Inputs the leg's submit path would have rejected — for the VTXO leg, no longer
     * cooperatively spendable at this pass's chain tip (past batch expiry, since swept and spent
     * inputs are already excluded upstream) or carrying no batch expiry at all.
     *
     * Partitioned out rather than submitted, because the send path validates the batch as a
     * whole: one rejected input would abort the entire leg and strand every other migratable
     * VTXO until the next pass. Present only when non-empty.
     */
    notSpendableOffchain?: MigrationVtxoRef[];
    /** Error message when this leg's submission failed; the other leg still runs. */
    error?: string;
}

/**
 * Result of a {@link IVtxoManager.migrateDeprecatedSignerVtxos} pass, split into
 * two symmetric legs: VTXOs migrate through the send path, boarding UTXOs keep a
 * separate settle-backed migration. They are never combined into one intent.
 */
export interface DeprecatedSignerMigrationReport {
    /**
     * Whether this pass moved the wallet's receive state onto the active
     * signer — directly, or through the server-info refresh it opens with.
     * `false` when the wallet was already there, which includes a rotation an
     * earlier refresh elsewhere in the session already applied.
     */
    rotated: boolean;
    /** Global skip; when set, neither leg is present. */
    skipped?: MigrationGlobalSkipReason;
    /** Send leg. Present iff ≥1 cooperatively-migratable VTXO existed this pass. */
    vtxos?: MigrationLegReport;
    /** Settle leg. Present iff ≥1 cooperatively-migratable boarding UTXO existed this pass. */
    boarding?: MigrationLegReport;
    /**
     * Cutoff-expired inputs of both kinds (a classification outcome, not a leg
     * outcome). Skipped because their signer cutoff has passed: cooperative
     * migration is closed for them. They are NOT pushed to a unilateral exit —
     * each keeps its own batch expiry, the server sweeps it at expiry, and the
     * recovery path then re-mints it under the active signer. The per-signer
     * sweep/recovery lifecycle is surfaced on {@link signers}
     * ({@link DeprecatedSignerReport.recoverableCount} /
     * {@link DeprecatedSignerReport.awaitingSweepCount}).
     */
    expired: MigrationVtxoRef[];
    /** Per-deprecated-signer status snapshot (Section 6). */
    signers: DeprecatedSignerReport[];
}

/**
 * Extra surface the migration path needs beyond {@link IWallet}: a fresh
 * server-info source, the wallet's current signer snapshot, the mid-session
 * server-signer rotation write path, and the selected-input self-send primitive
 * that migrates VTXOs through the Ark send path. Implemented by the concrete
 * `Wallet`; absent on watch-only or mock wallets.
 */
interface MigrationCapableWallet {
    arkProvider: ArkProvider;
    arkServerPublicKey: Uint8Array;
    onchainProvider: OnchainProvider;
    rotateServerSigner(newServerPubKey: Uint8Array, checkpointTapscript: string): Promise<void>;
    /** Refresh the wallet's cached deprecated-signer set from a fresh {@link ArkadeInfo} snapshot. */
    refreshDeprecatedSigners(info: ArkadeInfo): void;
    /**
     * Drain a rotation the wallet is applying off an `onServerInfoChanged`
     * emit, so this pass classifies against a settled signer snapshot instead
     * of a half-rotated one. Optional: only the concrete `Wallet` subscribes to
     * server-info events, so proxy / mock implementations omit it.
     */
    settleServerInfoChanges?(): Promise<void>;
    /**
     * Spend an explicit set of the wallet's own deprecated-signer VTXOs into a
     * single full-value active-signer output through the Ark send path (not
     * `settle`), preserving input assets. The pre-cutoff VTXO migration primitive
     * (plan step 1); never accepts boarding inputs.
     */
    sendSelectedVtxosToSelf(inputs: ExtendedVirtualCoin[], now?: TimeHeight): Promise<string>;
    /**
     * Grouped boarding discovery over a given signer set, returning the
     * address↔signer association {@link ExtendedCoin} cannot carry. Consumed
     * in-process by the boarding migration (Section 7); proxy/watch-only
     * wallets don't implement it, so {@link isMigrationCapable} routes them away.
     */
    getBoardingUtxosForSigners(allowedSigners: Set<string>): Promise<BoardingUtxoGroup[]>;
}

/** Return whether a wallet exposes the deprecated-signer migration surface. */
function isMigrationCapable(wallet: IWallet): wallet is IWallet & MigrationCapableWallet {
    return (
        "arkProvider" in wallet &&
        "arkServerPublicKey" in wallet &&
        "onchainProvider" in wallet &&
        typeof (wallet as Partial<MigrationCapableWallet>).rotateServerSigner === "function" &&
        typeof (wallet as Partial<MigrationCapableWallet>).refreshDeprecatedSigners ===
            "function" &&
        typeof (wallet as Partial<MigrationCapableWallet>).sendSelectedVtxosToSelf === "function" &&
        typeof (wallet as Partial<MigrationCapableWallet>).getBoardingUtxosForSigners === "function"
    );
}

/** A deprecated-signer VTXO paired with its signer classification. */
interface ClassifiedVtxo {
    vtxo: ExtendedContractVtxo;
    classification: SignerClassification;
}

/**
 * A deprecated-signer boarding UTXO paired with its signer classification
 * (Section 7). Mirrors {@link ClassifiedVtxo}, substituting the on-chain
 * boarding coin for the offchain VTXO.
 */
interface ClassifiedBoarding {
    coin: ExtendedCoin;
    classification: SignerClassification;
}

/** Project a {@link ClassifiedVtxo} into the report's {@link MigrationVtxoRef}. */
function classifiedToRef(c: ClassifiedVtxo): MigrationVtxoRef {
    return {
        txid: c.vtxo.txid,
        vout: c.vtxo.vout,
        value: c.vtxo.value,
        signerPubKey: c.classification.signerPubKey,
        cutoffDate: c.classification.cutoffDate,
    };
}

/** Project a {@link ClassifiedBoarding} into the report's {@link MigrationVtxoRef}. */
function classifiedBoardingToRef(c: ClassifiedBoarding): MigrationVtxoRef {
    return {
        txid: c.coin.txid,
        vout: c.coin.vout,
        value: c.coin.value,
        signerPubKey: c.classification.signerPubKey,
        cutoffDate: c.classification.cutoffDate,
    };
}

/**
 * Merge per-signer report rows from several classifiers (VTXO + boarding) into
 * one row per signer, summing the respective counts/values. A signer that
 * appears in only one classifier still produces a row (Section 7).
 */
function mergeSignerReports(...reportLists: DeprecatedSignerReport[][]): DeprecatedSignerReport[] {
    const bySigner = new Map<string, DeprecatedSignerReport>();
    for (const list of reportLists) {
        for (const r of list) {
            const existing = bySigner.get(r.signerPubKey);
            if (existing) {
                existing.vtxoCount += r.vtxoCount;
                existing.totalValue += r.totalValue;
                existing.boardingCount += r.boardingCount;
                existing.boardingValue += r.boardingValue;
                existing.recoverableCount += r.recoverableCount;
                existing.recoverableValue += r.recoverableValue;
                existing.awaitingSweepCount += r.awaitingSweepCount;
                existing.awaitingSweepValue += r.awaitingSweepValue;
                if (r.nextSweepEta !== undefined) {
                    existing.nextSweepEta =
                        existing.nextSweepEta === undefined
                            ? r.nextSweepEta
                            : Math.min(existing.nextSweepEta, r.nextSweepEta);
                }
            } else {
                bySigner.set(r.signerPubKey, { ...r });
            }
        }
    }
    return Array.from(bySigner.values());
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
 * - The Arkade server sweeps them (`isSwept`) and they remain spendable
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

    /**
     * Cooperatively migrate VTXOs minted under a now-deprecated server signer
     * to the wallet's active-signer address (planned arkd key rotation).
     *
     * Applies a mid-session server-signer rotation first when the wallet's own
     * snapshot signer has been deprecated, so the migration output commits to
     * the active signer. Selects spendable VTXOs under deprecated-signer
     * contracts, prioritizing those closest to their cutoff, and settles them
     * back to the (rotated) Ark address. VTXOs whose cutoff has already passed
     * are reported as `expired` rather than migrated.
     *
     * Available regardless of the `deprecatedSignerMigration` config flag (that
     * flag only gates the automatic poll-loop pass).
     *
     * As a side effect, refreshes the wallet's cached deprecated-signer set from
     * fresh server info, so a subsequent `settle()` correctly excludes EXPIRED
     * deprecated-signer inputs. To refresh that filter without migrating, call
     * `wallet.refreshDeprecatedSigners(await wallet.arkProvider.getInfo())` instead.
     *
     * @returns A report of what was migrated, skipped, expired, or failed.
     */
    migrateDeprecatedSignerVtxos(
        options?: MigrateDeprecatedSignerOptions,
    ): Promise<DeprecatedSignerMigrationReport>;

    /**
     * Machine-readable status of every deprecated server signer the wallet
     * currently holds funds under, without performing any migration. Lets
     * consumers surface cutoff warnings on their own schedule.
     */
    getDeprecatedSignerStatus(): Promise<DeprecatedSignerReport[]>;

    dispose(): Promise<void>;
}

export class VtxoManager implements AsyncDisposable, IVtxoManager {
    readonly settlementConfig: SettlementConfig | false;
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

    // Cooldown/backoff for the automatic deprecated-signer migration pass.
    // Mirrors the periodic-settle machinery so a server-side migration failure
    // (e.g. arkd not yet accepting old-key inputs, or a closed cutoff window)
    // backs off exponentially instead of re-submitting an identical intent on
    // every poll. The manual migrateDeprecatedSignerVtxos() bypasses this.
    private lastMigrationTimestamp = 0;
    private consecutiveMigrationFailures = 0;
    private static readonly MIGRATION_COOLDOWN_MS = 30_000;
    private static readonly MIGRATION_MAX_BACKOFF_MS = 5 * 60 * 1000;

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

        this.contractEventsSubscriptionReady = this.initializeSubscription();
    }

    // ========== Recovery Methods ==========

    /**
     * Outpoints recovery must not name yet, with the reason each was refused.
     * Empty when the manager offers no opinion — an embedder's may not implement
     * the predicate, and every contract type but VHTLC never answers.
     *
     * Reaches only a lockup whose `sender` is this wallet's own key: role
     * resolution matches that key against the contract's params, so a
     * descriptor-derived sender (every RFQ lockup) is not matched and such a row
     * still fails its batch at submit.
     *
     * The key stays a thunk so an ordinary recovery never touches the identity,
     * and the full coins are passed rather than bare outpoints because only they
     * carry the confirmation a relative timelock is measured from.
     */
    private async unspendableNow(
        vtxos: readonly NormalizedExtendedVirtualCoin[],
    ): Promise<Map<string, string>> {
        const contractManager = await this.wallet.getContractManager();
        return (
            (await contractManager.unspendableNowReasons?.(vtxos, async () =>
                hex.encode(await this.wallet.identity.xOnlyPublicKey()),
            )) ?? new Map()
        );
    }

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
     * Inputs whose contract refuses a spend right now — an immature VHTLC refund
     * path — are skipped rather than failing the batch that holds them, and
     * {@link getRecoverableBalance} skips the same set. See
     * {@link unspendableNow} for which rows that reaches.
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
        const now = await fetchTimeHeight(this.wallet);
        let { vtxosToRecover } = getRecoverableWithSubdust(allVtxos, dustAmount, now);

        if (vtxosToRecover.length === 0) {
            throw new Error("No recoverable VTXOs found");
        }

        // Before pricing: the cap below fills slots highest-value-first, so a
        // refused input filtered after it would occupy a slot and then vanish,
        // under-filling the settlement.
        const refused = await this.unspendableNow(vtxosToRecover);
        if (refused.size > 0) {
            logExcludedVtxos("recoverVtxos", vtxosToRecover, [outpointReasons(refused)]);
            const held = vtxosToRecover.length;
            vtxosToRecover = vtxosToRecover.filter(
                (vtxo) => !refused.has(`${vtxo.txid}:${vtxo.vout}`),
            );
            // Neither message may reuse "No recoverable VTXOs found": the coins
            // were found and declined, and the handler's text says when to retry.
            if (vtxosToRecover.length === 0) {
                // Every reason, not the first: lockups at different maturities
                // become recoverable at different times, and naming one of them
                // dates the whole wallet by the wrong clock. Same shape as
                // `IContractManager.assertSpendableNow`'s multi-input refusal.
                const why =
                    refused.size === 1
                        ? [...refused.values()][0]
                        : [...refused]
                              .map(([outpoint, reason]) => `${outpoint}: ${reason}`)
                              .join("; ");
                throw new Error(
                    `All ${held} recoverable VTXO(s) are held by a contract that refuses a ` +
                        `spend right now: ${why}`,
                );
            }
            ({ vtxosToRecover } = getRecoverableWithSubdust(vtxosToRecover, dustAmount, now));
            if (vtxosToRecover.length === 0) {
                throw new Error(
                    `Excluding ${refused.size} VTXO(s) not yet spendable, the remaining ` +
                        `recoverable amount is below the dust threshold ${dustAmount}`,
                );
            }
        }

        // Cap the recovery batch to stay under both the server's intent-size
        // limit (MAX_VTXOS_PER_SETTLEMENT inputs) and its per-output ceiling
        // (vtxoMaxAmount; -1 means no limit). Recover the highest-value VTXOs
        // first: the subdust inclusion decision above was made on the full set's
        // combined total, so a naive prefix can drop the capped batch below
        // dust — which the server rejects, leaving the next cycle to re-pick the
        // same prefix forever. Ordering by value maximizes the recovered amount
        // and gives the capped subset the best chance of clearing dust. We
        // re-run the subdust/dust eligibility on that exact capped subset; the
        // overflow is recovered next cycle.
        const info = await this.getInfoProvider()?.getInfo();
        const vtxoMaxAmount = info?.vtxoMaxAmount ?? -1n;

        // Price the batch before capping so a VTXO that cannot pay its own intent
        // fee is dropped here rather than occupying a slot in the capped batch
        // ahead of one that can. Subdust inputs survive this whenever they are
        // still worth more than their own fee, which is what keeps consolidating
        // them possible. `info` is undefined only when no ark provider is wired,
        // which prices as zero and leaves the gross behaviour untouched.
        const estimator = new Estimator(info?.fees.intentFee ?? {});
        const { payable, net } = priceSettlementInputs(vtxosToRecover, estimator);
        const capped = capSettlementBatch(byValueDescending(payable), vtxoMaxAmount);
        // Compared against the pre-pricing count deliberately: this fires when
        // EITHER filter narrowed the batch, fee pricing or a size cap, since both
        // mean the subdust decision above was made over a set we are no longer
        // settling and has to be re-run. Not just the cap, despite the name.
        if (capped.length < vtxosToRecover.length) {
            const recoverableCount = vtxosToRecover.length;
            // Two different things can narrow the batch, and an operator
            // debugging a stuck wallet needs to know which one did: a size cap
            // defers the overflow to the next cycle, whereas fee filtering means
            // the coins cost more to move than they are worth and no later cycle
            // will change that on its own.
            const cappedAway = capped.length < payable.length;
            ({ vtxosToRecover } = getRecoverableWithSubdust(capped, dustAmount, now));
            if (vtxosToRecover.length === 0) {
                // Recoverable VTXOs exist, but what survives stays below dust, so
                // submitting it would be rejected and the next cycle would pick
                // the same prefix. Distinct from the "none recoverable" case
                // above so operators can tell a stuck-but-funded wallet from an
                // empty one.
                if (!cappedAway) {
                    throw new Error(
                        `All ${recoverableCount} recoverable VTXOs that can pay their own ` +
                            `intent fee total less than the dust threshold ${dustAmount}`,
                    );
                }
                throw new Error(
                    `Capped recovery batch (highest-value subset of ${recoverableCount} ` +
                        `recoverable VTXOs within the ${MAX_VTXOS_PER_SETTLEMENT}-input and ` +
                        `${vtxoMaxAmount}-sat limits, net of intent fees) is below the ` +
                        `dust threshold ${dustAmount}`,
                );
            }
        }

        // Post-cutoff recovery: if any recoverable input was minted under a
        // now-deprecated signer and the wallet's own snapshot is still that old
        // signer, rotate to the active signer FIRST so the recovered output
        // re-mints under the current key instead of re-committing to the
        // deprecated one (Section 6 / post-cutoff). No-op on current-snapshot
        // wallets; skipped for non-rotatable (watch-only/proxy) wallets so the
        // hot recovery path adds no work for them.
        if (info && isMigrationCapable(this.wallet)) {
            await this.rotateForRecoverableInputs(vtxosToRecover, info);
        }

        // Read AFTER any rotation above, so the output fee is priced against the
        // script the recovered VTXO actually lands on.
        const arkAddress = await this.wallet.getAddress();

        // The fee an intent offers IS `sum(inputs) - sum(outputs)`, so the output
        // has to come back short by what the operator's programs price. Asking
        // for the gross recoverable sum offers zero and the server rejects with
        // INTENT_INSUFFICIENT_FEE — see `priceSettlementInputs`.
        const totalAmount = deductOffchainOutputFee(
            subtotalOf(vtxosToRecover, net),
            estimator,
            arkAddress,
        );

        // getRecoverableWithSubdust judges subdust inclusion on gross value, but
        // the fees come off after that decision, so a batch that cleared dust
        // gross can still land under it here. The server would reject such an
        // output; say so instead, and let the next cycle retry once the
        // recoverable set is worth more.
        if (totalAmount < dustAmount) {
            throw new Error(
                `Recoverable amount ${totalAmount} net of intent fees is below ` +
                    `dust threshold ${dustAmount}`,
            );
        }

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
     * Both amounts are net of the operator's intent fees, so `recoverable` is
     * what {@link recoverVtxos} would actually hand back rather than the gross
     * sum of the inputs. `subdust` is net of the per-input fees only — the
     * output fee is charged on the batch as a whole and is not attributed per
     * coin — so it reports what the subdust coins are worth once each has paid
     * its own way, and is not strictly a slice of `recoverable`. It can exceed
     * `recoverable` where a flat output fee meets a wholly subdust wallet.
     *
     * The batch size caps are not applied here: they defer the overflow to the
     * next cycle rather than reducing what is recoverable.
     *
     * Inputs a contract refuses right now are excluded, so this and
     * {@link recoverVtxos} answer over the same set. `Balance.recoverable` still
     * counts them: that field reports what the wallet owns, this one what a
     * batch would hand back today.
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
        const now = await fetchTimeHeight(this.wallet);

        let { vtxosToRecover, includesSubdust } = getRecoverableWithSubdust(
            allVtxos,
            dustAmount,
            now,
        );

        // Excluded outright rather than reported in a field of their own: this
        // answers what a recovery batch would hand back, and `Balance.recoverable`
        // keeps counting the funds, so nothing disappears. Mirrors `recoverVtxos`
        // so the preview and the sweep agree by construction — and it is the only
        // channel through which a caller sees a partial drop.
        const refused = await this.unspendableNow(vtxosToRecover);
        if (refused.size > 0) {
            logExcludedVtxos("getRecoverableBalance", vtxosToRecover, [outpointReasons(refused)]);
            const remaining = vtxosToRecover.filter(
                (vtxo) => !refused.has(`${vtxo.txid}:${vtxo.vout}`),
            );
            ({ vtxosToRecover, includesSubdust } = getRecoverableWithSubdust(
                remaining,
                dustAmount,
                now,
            ));
        }

        // Priced the same way `recoverVtxos` prices what it settles. This exists
        // to tell a user what recovery would hand back, so it has to answer net
        // of the operator's intent fees — reporting the gross sum would promise
        // more than the sweep delivers under any non-zero fee policy, and the two
        // are reachable from the same worker call.
        //
        // Not applied here: the batch caps. They defer the overflow to the next
        // cycle rather than reducing what is recoverable, and matching them would
        // mean re-running the subdust decision over a capped subset. That gap
        // predates the fee pricing and is left alone.
        const info = await this.getInfoProvider()?.getInfo();
        const estimator = new Estimator(info?.fees.intentFee ?? {});
        const { payable, net } = priceSettlementInputs(vtxosToRecover, estimator);
        const priced = deductOffchainOutputFee(
            subtotalOf(payable, net),
            estimator,
            await this.wallet.getAddress(),
        );
        // A flat output fee can outweigh the inputs; recovery refuses that rather
        // than settling it, so report nothing recoverable instead of a negative.
        const recoverable = priced > 0n ? priced : 0n;

        // Subdust is CLASSIFIED on gross value — that is what makes a coin
        // subdust, and what `getRecoverableWithSubdust` judged inclusion on — but
        // REPORTED net of the per-input fees, so it is on the same footing as
        // `recoverable` rather than a figure on a different basis. Summing it
        // gross overstated it under every non-zero input-fee policy.
        //
        // Net of the INPUT fees only, though: the output fee comes off the whole
        // batch at once and does not decompose per coin, so it is not attributed
        // here. `subdust <= recoverable` therefore holds whenever no output fee
        // is configured or the non-subdust coins cover it, but NOT in general —
        // a flat output fee against an all-subdust wallet still leaves `subdust`
        // the larger of the two. Read this as "what the subdust coins are worth
        // once each has paid its own way", not as a slice of `recoverable`.
        //
        // Totalled through `subtotalOf` so an unpriced input throws instead of
        // silently contributing zero.
        const subdustAmount = subtotalOf(
            payable.filter((v) => BigInt(v.value) < dustAmount),
            net,
        );

        return {
            recoverable,
            subdust: subdustAmount,
            includesSubdust,
            vtxoCount: payable.length,
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
    async getExpiringVtxos(thresholdMs?: number): Promise<NormalizedExtendedVirtualCoin[]> {
        return this.selectExpiringVtxos(thresholdMs);
    }

    /**
     * {@link getExpiringVtxos}, against a caller-supplied chain tip.
     *
     * The settle paths select, re-select after pre-flight, and sort by expiry within one pass;
     * each of those judges expiry, so they share one tip rather than fetching (and possibly
     * disagreeing on) one apiece. Fetches its own when `now` is omitted.
     */
    private async selectExpiringVtxos(
        thresholdMs?: number,
        now?: TimeHeight,
    ): Promise<NormalizedExtendedVirtualCoin[]> {
        // If settlementConfig is explicitly false and no override provided, renewal is disabled
        if (this.settlementConfig === false && thresholdMs === undefined) {
            return [];
        }

        const vtxos = await this.wallet.getSpendableVtxos({ withRecoverable: true });

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

        return getExpiringAndRecoverableVtxos(
            vtxos,
            threshold,
            getDustAmount(this.wallet),
            now ?? (await fetchTimeHeight(this.wallet)),
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
            // One chain tip for the whole pass — see `selectExpiringVtxos`.
            const now = await fetchTimeHeight(this.wallet);
            let vtxos = await this.selectExpiringVtxos(threshold, now);

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
            vtxos = await this.revalidateBeforeSettle(vtxos, threshold, now);
            if (vtxos.length === 0) {
                throw new Error("No VTXOs available to renew");
            }

            // Cap the renewal batch to stay under both the server's intent-size
            // limit (MAX_VTXOS_PER_SETTLEMENT inputs) and its per-output ceiling
            // (vtxoMaxAmount; -1 means no limit). Renew the soonest-expiring
            // VTXOs first so the most urgent ones make the cut — otherwise a
            // viable VTXO past the cap could miss its renewal window and be
            // forced into a unilateral exit. The output amount is summed from
            // the capped set below, so it stays consistent; the overflow is
            // renewed on the next cycle.
            const info = await this.getInfoProvider()?.getInfo();
            const vtxoMaxAmount = info?.vtxoMaxAmount ?? -1n;

            // Price the candidates before capping so a VTXO that cannot pay its
            // own intent fee is dropped here rather than occupying a slot in the
            // capped batch ahead of one that can. `info` is undefined only when no
            // ark provider is wired, which prices as zero and leaves the gross
            // behaviour untouched.
            const estimator = new Estimator(info?.fees.intentFee ?? {});
            const { payable, net } = priceSettlementInputs(vtxos, estimator);
            vtxos = payable;
            if (vtxos.length === 0) {
                // Worded to match the benign cases the vtxo_received subscription
                // already swallows: nothing is wrong, there is just nothing worth
                // renewing at this fee policy.
                throw new Error(
                    "No VTXOs available to renew: every expiring VTXO is worth less than its own intent fee",
                );
            }

            const capped = capSettlementBatch(byExpiryAscending(vtxos, now), vtxoMaxAmount);
            if (vtxoMaxAmount >= 0n) {
                // A VTXO whose value alone exceeds the per-output ceiling can
                // never be renewed by this path (the server would reject it) and
                // will drift toward a unilateral exit as it nears expiry. The
                // routine count-cap overflow is benign (deferred next cycle), but
                // this is not — surface it so operators can act (e.g. split it).
                const oversized = vtxos.filter((vtxo) => BigInt(vtxo.value) > vtxoMaxAmount);
                if (oversized.length > 0) {
                    console.warn(
                        `Renewal: ${oversized.length} VTXO(s) exceed the per-output limit ` +
                            `${vtxoMaxAmount} and cannot be renewed; they risk unilateral exit`,
                    );
                }
            }
            if (capped.length < vtxos.length) {
                // A cap dropped inputs: settle the soonest-expiring subset now
                // and renew the overflow next cycle. When neither cap bites we
                // keep the original selection (and order) untouched.
                vtxos = capped;
                if (vtxos.length === 0) {
                    // The soonest-expiring VTXO alone exceeds vtxoMaxAmount, so
                    // no batch fits. Only reachable if the server lowered the
                    // ceiling below an existing VTXO; it would reject it anyway.
                    throw new Error(
                        `No VTXOs available to renew within the per-output limit ${vtxoMaxAmount}`,
                    );
                }
            }

            // Get dust amount from wallet
            const dustAmount = getDustAmount(this.wallet);

            // Renewal includes recoverable VTXOs (getExpiringVtxos pulls them
            // in). If any carries a now-deprecated signer and the wallet's own
            // snapshot is still that old signer, rotate to the active signer
            // FIRST so the renewed output re-mints under the current key
            // (Section 6 / post-cutoff). rotateServerSigner is independently
            // serialized and does not consult renewalInProgress, so calling it
            // inside this window cannot deadlock against the receive rotator.
            // Skipped for non-rotatable wallets (no extra work on the hot path).
            if (info && isMigrationCapable(this.wallet)) {
                await this.rotateForRecoverableInputs(vtxos, info);
            }

            // Read AFTER any rotation above, so the output fee is priced against
            // the script the renewed VTXO actually lands on.
            const arkAddress = await this.wallet.getAddress();

            // The fee an intent offers IS `sum(inputs) - sum(outputs)`, so the
            // output has to come back short by what the operator's programs
            // price. Asking for the gross sum offers zero and the server rejects
            // with INTENT_INSUFFICIENT_FEE — see `priceSettlementInputs`.
            const totalAmount = deductOffchainOutputFee(
                subtotalOf(vtxos, net),
                estimator,
                arkAddress,
            );

            // Dust is judged on the NET output, not the gross input sum: the fees
            // come off after selection, so a batch that clears dust gross can
            // land under it here.
            if (totalAmount < dustAmount) {
                throw new Error(
                    `Total amount ${totalAmount} is below dust threshold ${dustAmount}`,
                );
            }

            const txid = await this.wallet.settle(
                {
                    inputs: vtxos,
                    outputs: [
                        {
                            address: arkAddress,
                            amount: totalAmount,
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
            const utxoExitLeaf = utxoScript.leaves.find(
                (leaf) =>
                    CSVMultisigTapscript.isScriptValid(scriptFromTapLeafScript(leaf)) === true,
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

    // ========== Deprecated-Signer Migration Methods ==========

    /**
     * Cooperatively migrate VTXOs minted under a now-deprecated server signer
     * to the wallet's active-signer address. See {@link IVtxoManager}.
     */
    async migrateDeprecatedSignerVtxos(
        options?: MigrateDeprecatedSignerOptions,
    ): Promise<DeprecatedSignerMigrationReport> {
        return this.migrateCore(options);
    }

    /**
     * Machine-readable status of every deprecated server signer the wallet
     * currently holds funds under (Section 6), without migrating. Covers both
     * VTXO and boarding holdings (Section 7), merged per signer.
     *
     * @remarks This is no longer a pure repository/info read: surfacing boarding
     * holdings fans out per boarding address (`getCoins` round trips) and
     * refreshes the UTXO cache via `saveUtxos`.
     */
    async getDeprecatedSignerStatus(): Promise<DeprecatedSignerReport[]> {
        const wallet = this.requireMigrationCapableWallet();
        const info = await wallet.arkProvider.getInfo();
        // This refresh can itself surface a rotated operator config, which the
        // wallet applies off the emit. Let it settle so the counts below are
        // read from one signer epoch rather than a half-rotated wallet.
        await wallet.settleServerInfoChanges?.();
        const { reports: vtxoReports } = await this.classifyDeprecatedSignerContracts(info);
        const { reports: boardingReports } = await this.classifyDeprecatedSignerBoarding(info);
        return mergeSignerReports(vtxoReports, boardingReports);
    }

    /**
     * Core migration routine shared by the manual API and the automatic poll
     * pass. Fetches a fresh {@link ArkadeInfo}, applies a mid-session signer
     * rotation when the wallet's own snapshot signer has been deprecated,
     * selects spendable VTXOs under deprecated-signer contracts (cutoff-first),
     * and settles them to the active-signer Ark address.
     */
    private async migrateCore(
        options?: MigrateDeprecatedSignerOptions,
    ): Promise<DeprecatedSignerMigrationReport> {
        const wallet = this.requireMigrationCapableWallet();
        // Read BEFORE the refresh: the refresh itself can surface a rotated
        // operator config, which the wallet applies off the emit — so the
        // rotation this pass reports may be the one that handler performed
        // rather than the one `ensureReceiveOnActiveSigner` performs below.
        const signerBeforeRefresh = hex.encode(wallet.arkServerPublicKey);
        const info = await wallet.arkProvider.getInfo();
        // Drain that handler before reading anything signer-derived: mid-rotation
        // the active signer's contract rows are already persisted while
        // `arkServerPublicKey` still holds the deprecated one, and both chains
        // would otherwise race to rotate.
        await wallet.settleServerInfoChanges?.();
        const rotatedOnRefresh = signerBeforeRefresh !== hex.encode(wallet.arkServerPublicKey);
        // Refresh the wallet's cached deprecated-signer set from this fresh
        // snapshot before any classification or early-exit, so the spendability
        // filter that excludes EXPIRED deprecated-signer inputs from settle() is
        // consistent for the rest of this pass. Placed ahead of the no-deprecated
        // exit so a pass that finds nothing deprecated still clears a stale cache.
        wallet.refreshDeprecatedSigners(info);
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);

        // Classify the wallet's own construction-time signer snapshot.
        const walletSignerHex = hex.encode(wallet.arkServerPublicKey);
        const walletClass = classifyAgainstSignerSet(walletSignerHex, signerSet, nowSeconds);

        // Common cheap exit: nothing deprecated advertised and our own snapshot
        // is current → no contract sweep, no indexer round-trip.
        if (signerSet.deprecated.size === 0 && walletClass.status === "CURRENT") {
            return { rotated: rotatedOnRefresh, expired: [], signers: [] };
        }

        // The wallet's own signer is neither active nor advertised deprecated:
        // do not rotate or migrate automatically (treat as unknownSigner). Still
        // surface every holding (VTXO + boarding) under other deprecated signers.
        if (walletClass.status === "UNKNOWN_SIGNER") {
            const { reports: vtxoReports } = await this.classifyDeprecatedSignerContracts(info);
            const { reports: boardingReports } = await this.classifyDeprecatedSignerBoarding(info);
            return {
                // Normally false here — a drained rotation targets the active
                // signer, which classifies CURRENT, not UNKNOWN. It is true only
                // when a second rotation landed inside the drain, leaving us on a
                // signer newer than `info`: still a rotation this pass applied.
                rotated: rotatedOnRefresh,
                expired: [],
                signers: mergeSignerReports(vtxoReports, boardingReports),
                skipped: "unknown-wallet-signer",
            };
        }

        // The wallet's own snapshot signer has been deprecated → re-derive the
        // receive state under the active signer before building the migration
        // output, otherwise the server would reject an old-signer destination.
        // (UNKNOWN_SIGNER already returned above, so the guard rotates here iff
        // the snapshot is MIGRATABLE/DUE_NOW/EXPIRED — identical to the prior
        // `!== CURRENT` test.)
        const rotated = (await this.ensureReceiveOnActiveSigner(info)) || rotatedOnRefresh;

        // Collect stale VTXOs AND boarding UTXOs AFTER any rotation, so the
        // just-deprecated former receive/boarding contracts are included in the
        // migration set. Both classifiers reuse the same fresh `info` (no second
        // getInfo round-trip).
        const {
            reports: vtxoReports,
            migratable: vtxoMigratable,
            expired: vtxoExpired,
        } = await this.classifyDeprecatedSignerContracts(info);
        const {
            reports: boardingReports,
            migratable: boardingMigratable,
            expired: boardingExpired,
        } = await this.classifyDeprecatedSignerBoarding(info);

        const reports = mergeSignerReports(vtxoReports, boardingReports);

        const expiredRefs = [
            ...vtxoExpired.map(classifiedToRef),
            ...boardingExpired.map(classifiedBoardingToRef),
        ];

        // Fire the no-deprecated-vtxos skip only when BOTH migratable sets are
        // empty, so a boarding-only migration still proceeds.
        if (vtxoMigratable.length === 0 && boardingMigratable.length === 0) {
            return {
                rotated,
                expired: expiredRefs,
                signers: reports,
                skipped: "no-deprecated-vtxos",
            };
        }

        const vtxoMaxAmount = info.vtxoMaxAmount;
        const dustAmount = getDustAmount(this.wallet);

        const report: DeprecatedSignerMigrationReport = {
            rotated,
            expired: expiredRefs,
            signers: reports,
        };

        // Two independent legs, run sequentially (each acquires the wallet tx
        // lock itself): VTXOs migrate through the Ark send path; boarding UTXOs
        // keep a SEPARATE settle-backed migration — they are on-chain inputs
        // with no send path. They are never combined into one intent, each owns
        // its full sizing pipeline (oversized + caps + its own dust floor), and a
        // failure/skip in one never suppresses the other. A leg is present iff it
        // had ≥1 cooperatively-migratable candidate before sizing.

        // VTXO leg — send to the active-signer self output. No settlement events.
        if (vtxoMigratable.length > 0) {
            // One chain tip for the leg, shared with the send path below — see
            // {@link canMigrateBySend}.
            const now = await fetchTimeHeight(this.wallet);
            report.vtxos = await this.runMigrationLeg(
                vtxoMigratable,
                (c) => c.vtxo.value,
                classifiedToRef,
                vtxoMaxAmount,
                dustAmount,
                "VTXO",
                (capped) =>
                    wallet.sendSelectedVtxosToSelf(
                        capped.map((c) => c.vtxo),
                        now,
                    ),
                (c) => canMigrateBySend(c.vtxo, now),
            );
        }

        // Boarding leg — separate settle. Keeps firing settlement events. Its
        // single output is the active-signer Ark address (post any rotation).
        if (boardingMigratable.length > 0) {
            report.boarding = await this.runMigrationLeg(
                boardingMigratable,
                (c) => c.coin.value,
                classifiedBoardingToRef,
                vtxoMaxAmount,
                dustAmount,
                "boarding",
                async (capped) => {
                    const arkAddress = await this.wallet.getAddress();
                    const totalAmount = capped.reduce((sum, c) => sum + BigInt(c.coin.value), 0n);
                    return this.wallet.settle(
                        {
                            inputs: capped.map((c) => c.coin),
                            outputs: [{ address: arkAddress, amount: totalAmount }],
                        },
                        options?.eventCallback,
                    );
                },
            );
        }

        return report;
    }

    /**
     * Size and submit one migration leg. Filters inputs whose value alone
     * exceeds the per-output ceiling (`vtxoMaxAmount`; `< 0` means no limit) —
     * those can never form a ≤-ceiling output and must exit unilaterally — then
     * caps the rest (highest-value first; bounded by {@link MAX_VTXOS_PER_SETTLEMENT}
     * AND a gross total within `vtxoMaxAmount`), applies the protocol dust floor,
     * and submits the capped batch through `submit`. A throw from `submit` lands
     * in `error`; the caller's other leg still runs.
     *
     * Migration is mandatory and fee-exempt: every selected input moves at its
     * full value, so the gross total IS the aggregated output amount (kept under
     * the server ceiling by the cap). The dust floor guards the degenerate cases
     * where every input was oversized or the whole holding sums below dust.
     */
    private async runMigrationLeg<C>(
        candidates: C[],
        valueOf: (c: C) => number,
        toRef: (c: C) => MigrationVtxoRef,
        vtxoMaxAmount: bigint,
        dustAmount: bigint,
        legName: string,
        submit: (capped: C[]) => Promise<string>,
        /**
         * Inputs this leg's submit path would reject. Filtered out *before* sizing so they
         * neither consume batch capacity nor count toward the dust floor. Omit when the leg's
         * submit path has no such gate — the boarding leg settles, and settle validates per-input
         * server-side.
         */
        eligible?: (c: C) => boolean,
    ): Promise<MigrationLegReport> {
        const notSpendableRefs: MigrationVtxoRef[] = [];
        const migratable = eligible
            ? candidates.filter((c) => {
                  if (eligible(c)) return true;
                  notSpendableRefs.push(toRef(c));
                  return false;
              })
            : candidates;
        if (notSpendableRefs.length > 0) {
            console.warn(
                `Deprecated-signer migration (${legName}): ${notSpendableRefs.length} input(s) ` +
                    `are no longer cooperatively spendable at the current chain tip and were ` +
                    `excluded; they recover through the sweep/recovery path instead.`,
            );
        }
        const notSpendableField =
            notSpendableRefs.length > 0 ? { notSpendableOffchain: notSpendableRefs } : {};

        const oversizedRefs: MigrationVtxoRef[] = [];
        const sized: C[] = [];
        for (const c of migratable) {
            if (vtxoMaxAmount >= 0n && BigInt(valueOf(c)) > vtxoMaxAmount) {
                oversizedRefs.push(toRef(c));
            } else {
                sized.push(c);
            }
        }
        if (oversizedRefs.length > 0) {
            console.warn(
                `Deprecated-signer migration (${legName}): ${oversizedRefs.length} input(s) ` +
                    `exceed the per-output limit ${vtxoMaxAmount} and cannot be migrated ` +
                    `cooperatively; they require a unilateral exit.`,
            );
        }
        const oversizedField = oversizedRefs.length > 0 ? { oversized: oversizedRefs } : {};

        const capped = capSettlementBatch(
            byValueDescending(sized.map((c) => ({ value: valueOf(c), c }))),
            vtxoMaxAmount,
        ).map((w) => w.c);
        const deferred = sized.length - capped.length;
        const totalAmount = capped.reduce((sum, c) => sum + BigInt(valueOf(c)), 0n);

        if (totalAmount < dustAmount) {
            // Attribute the skip to whichever filter emptied the set, so "nothing migrated" is
            // not silently reported as a dust problem when it was really an eligibility one.
            const skipped: MigrationLegSkipReason =
                sized.length > 0
                    ? "below-dust"
                    : oversizedRefs.length > 0
                      ? "oversized-only"
                      : notSpendableRefs.length > 0
                        ? "not-spendable-only"
                        : "below-dust";
            return {
                migrated: [],
                skipped,
                ...oversizedField,
                ...notSpendableField,
            };
        }

        try {
            const txid = await submit(capped);
            return {
                txid,
                migrated: capped.map(toRef),
                ...(deferred > 0 ? { deferred } : {}),
                ...oversizedField,
                ...notSpendableField,
            };
        } catch (e) {
            return {
                migrated: [],
                error: e instanceof Error ? e.message : String(e),
                ...oversizedField,
                ...notSpendableField,
            };
        }
    }

    /**
     * Enumerate the wallet's `default`/`delegate` contracts, classify each
     * against the fresh signer set, and split their spendable VTXOs into
     * cooperatively-migratable and cutoff-expired sets while building the
     * per-signer status report. Current-signer contracts are skipped; swept
     * (recoverable) VTXOs are excluded from the settle sets — those follow the
     * recovery path — but are still counted on EXPIRED report rows
     * (`recoverableCount`) so post-cutoff funds in flight stay visible.
     */
    private async classifyDeprecatedSignerContracts(info: ArkadeInfo): Promise<{
        reports: DeprecatedSignerReport[];
        migratable: ClassifiedVtxo[];
        expired: ClassifiedVtxo[];
    }> {
        const cm = await this.wallet.getContractManager();
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);

        const contractsWithVtxos = await cm.getContractsWithVtxos({
            type: ["default", "delegate"],
        });

        const reportsBySigner = new Map<string, DeprecatedSignerReport>();
        const migratable: ClassifiedVtxo[] = [];
        const expired: ClassifiedVtxo[] = [];

        for (const { contract, vtxos } of contractsWithVtxos) {
            const serverPubKey = contract.params.serverPubKey;
            if (!serverPubKey) continue;

            const cls = classifyAgainstSignerSet(serverPubKey, signerSet, nowSeconds);
            if (cls.status === "CURRENT") continue;

            // Swept (recoverable) VTXOs are reclaimed by the recovery path, not
            // cooperative migration (open point 11), so they stay OUT of the
            // migratable/expired settle sets. For EXPIRED signers, though, they
            // are exactly the funds already draining into the active signer, so
            // the report still counts them (recoverableCount) alongside the
            // not-yet-swept holdings (awaitingSweepCount) (Section 6 / post-cutoff).
            // Exited coins are on neither leg — `completeUnroll` is their only
            // remedy — so they belong in no migration bucket. Without this the
            // report over-counts migratable value and announces the coin as
            // recovering through the sweep path, which will never happen.
            const live = vtxos.filter((v) => !v.isUnrolled);
            const recoverable = live.filter((v) => v.isSwept && !hasTerminalSpend(v));
            const spendable = live.filter((v) => !hasTerminalSpend(v) && !v.isSwept);

            const value = spendable.reduce((sum, v) => sum + v.value, 0);

            // Post-cutoff lifecycle split, only meaningful for EXPIRED rows: the
            // not-yet-swept spendable set is awaiting the server batch sweep, the
            // swept set is recoverable now. nextSweepEta is the soonest batch
            // expiry among the awaiting set, used as a recovery ETA hint.
            let recoverableCount = 0;
            let recoverableValue = 0;
            let awaitingSweepCount = 0;
            let awaitingSweepValue = 0;
            let nextSweepEta: number | undefined;
            if (cls.status === "EXPIRED") {
                recoverableCount = recoverable.length;
                recoverableValue = recoverable.reduce((sum, v) => sum + v.value, 0);
                awaitingSweepCount = spendable.length;
                awaitingSweepValue = value;
                for (const v of spendable) {
                    const exp = toBatchExpiry(v);
                    if (exp !== undefined && (nextSweepEta === undefined || exp < nextSweepEta)) {
                        nextSweepEta = exp;
                    }
                }
            }

            const existing = reportsBySigner.get(cls.signerPubKey);
            if (existing) {
                existing.vtxoCount += spendable.length;
                existing.totalValue += value;
                existing.recoverableCount += recoverableCount;
                existing.recoverableValue += recoverableValue;
                existing.awaitingSweepCount += awaitingSweepCount;
                existing.awaitingSweepValue += awaitingSweepValue;
                if (nextSweepEta !== undefined) {
                    existing.nextSweepEta =
                        existing.nextSweepEta === undefined
                            ? nextSweepEta
                            : Math.min(existing.nextSweepEta, nextSweepEta);
                }
            } else {
                reportsBySigner.set(cls.signerPubKey, {
                    signerPubKey: cls.signerPubKey,
                    status: cls.status,
                    cutoffDate: cls.cutoffDate,
                    secondsUntilCutoff: cls.secondsUntilCutoff,
                    vtxoCount: spendable.length,
                    totalValue: value,
                    boardingCount: 0,
                    boardingValue: 0,
                    recoverableCount,
                    recoverableValue,
                    awaitingSweepCount,
                    awaitingSweepValue,
                    nextSweepEta,
                });
            }

            if (isCooperativelyMigratable(cls.status)) {
                for (const v of spendable) {
                    // Send migration requires a batch expiry: sendSelectedVtxosToSelf
                    // rejects no-expiry inputs (the DB-update path only persists a
                    // wallet-owned output when one exists), and a single unrolled/
                    // settled input here would otherwise throw and fail the whole
                    // VTXO leg. Such holdings stay counted in the per-signer report
                    // above; they exit via on-chain/recovery paths, not cooperative
                    // send.
                    if (v.expiresAt === undefined && v.expiresAtHeight === undefined) continue;
                    migratable.push({ vtxo: v, classification: cls });
                }
            } else if (cls.status === "EXPIRED") {
                for (const v of spendable) expired.push({ vtxo: v, classification: cls });
            }
            // unknownSigner: reported for visibility, never migrated.
        }

        return {
            reports: Array.from(reportsBySigner.values()),
            migratable,
            expired,
        };
    }

    /**
     * Boarding sibling of {@link classifyDeprecatedSignerContracts} (Section 7):
     * fan out over the wallet's boarding addresses (current + historical), group
     * the on-chain UTXOs per address, classify each address's signer against the
     * fresh signer set, and split the confirmed boarding coins into cooperatively-
     * migratable and cutoff-expired sets while building the per-signer report.
     *
     * Discovery sees the active signer plus EVERY deprecated key (EXPIRED
     * included), so expired-signer boarding is still reported; migration
     * eligibility is gated afterwards by {@link isCooperativelyMigratable} and a
     * per-row boarding-output CSV check — never by the fetch. Current-signer
     * coins are classified `CURRENT` and ignored; foreign-ASP rows are excluded
     * because their keys are not in the signer set.
     */
    private async classifyDeprecatedSignerBoarding(info: ArkadeInfo): Promise<{
        reports: DeprecatedSignerReport[];
        migratable: ClassifiedBoarding[];
        expired: ClassifiedBoarding[];
    }> {
        const wallet = this.requireMigrationCapableWallet();
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);

        // Allowed set = active signer + every deprecated key (EXPIRED included).
        // Discovery MUST see expired-signer coins or they could never be
        // reported; including `active` lets a single fetch cover both.
        const allowed = new Set<string>([signerSet.active, ...signerSet.deprecated.keys()]);

        const groups = await wallet.getBoardingUtxosForSigners(allowed);

        // Boarding-output expiry is PER GROUP (each row persists its own CSV
        // delay; a rotation may change the boarding exit delay). Fetch the chain
        // tip once iff any group's timelock is block-typed.
        let chainTipHeight: number | undefined;
        if (groups.some((g) => g.csvTimelock.type === "blocks")) {
            const tip = await wallet.onchainProvider.getChainTip();
            chainTipHeight = tip.height;
        }

        const reportsBySigner = new Map<string, DeprecatedSignerReport>();
        const migratable: ClassifiedBoarding[] = [];
        const expired: ClassifiedBoarding[] = [];

        for (const group of groups) {
            const cls = classifyAgainstSignerSet(group.serverPubKey, signerSet, nowSeconds);
            if (cls.status === "CURRENT") continue;

            // Only confirmed boarding coins can settle.
            const confirmed = group.coins.filter((c) => c.status.confirmed);
            if (confirmed.length === 0) continue;

            // Report row: count ALL confirmed coins under this signer, including
            // CSV-expired ones (still holdings; they leave via the unilateral
            // sweep, not cooperative migration).
            const value = confirmed.reduce((sum, c) => sum + c.value, 0);
            const existing = reportsBySigner.get(cls.signerPubKey);
            if (existing) {
                existing.boardingCount += confirmed.length;
                existing.boardingValue += value;
            } else {
                reportsBySigner.set(cls.signerPubKey, {
                    signerPubKey: cls.signerPubKey,
                    status: cls.status,
                    cutoffDate: cls.cutoffDate,
                    secondsUntilCutoff: cls.secondsUntilCutoff,
                    vtxoCount: 0,
                    totalValue: 0,
                    boardingCount: confirmed.length,
                    boardingValue: value,
                    // Boarding UTXOs don't carry an offchain sweep lifecycle; the
                    // post-cutoff recover-on-sweep fields apply to VTXOs only and
                    // are merged in from the VTXO classifier (mergeSignerReports).
                    recoverableCount: 0,
                    recoverableValue: 0,
                    awaitingSweepCount: 0,
                    awaitingSweepValue: 0,
                });
            }

            for (const coin of confirmed) {
                // Both gates are independent and both must pass: the signer
                // cutoff (via classification) AND the boarding-output CSV expiry
                // judged against THIS row's delay.
                const boardingExpired = hasBoardingTxExpired(
                    coin,
                    group.csvTimelock,
                    chainTipHeight,
                );
                if (isCooperativelyMigratable(cls.status) && !boardingExpired) {
                    migratable.push({ coin, classification: cls });
                } else if (cls.status === "EXPIRED") {
                    expired.push({ coin, classification: cls });
                }
                // MIGRATABLE/DUE_NOW but boarding-output CSV expired: reported,
                // not migrated; it leaves via the unilateral sweep instead.
                // unknownSigner: reported for visibility, never migrated.
            }
        }

        return {
            reports: Array.from(reportsBySigner.values()),
            migratable,
            expired,
        };
    }

    /**
     * Automatic migration pass invoked from the poll loop. Self-contained:
     * respects an exponential cooldown and logs failures rather than throwing,
     * so a persistently failing migration backs off instead of re-submitting
     * an identical intent every cycle.
     */
    private async runMigrationPass(): Promise<void> {
        const cooldownMs = Math.min(
            VtxoManager.MIGRATION_COOLDOWN_MS * Math.pow(2, this.consecutiveMigrationFailures),
            VtxoManager.MIGRATION_MAX_BACKOFF_MS,
        );
        if (Date.now() - this.lastMigrationTimestamp < cooldownMs) return;

        try {
            const report = await this.migrateCore();
            // Either leg reporting an error fails the whole pass (shared cooldown
            // + backoff); the legs themselves never throw out of migrateCore.
            const legError = report.vtxos?.error ?? report.boarding?.error;
            if (legError) {
                this.consecutiveMigrationFailures++;
                console.error("Deprecated-signer migration leg failed:", legError);
            } else {
                this.consecutiveMigrationFailures = 0;
            }
        } catch (e) {
            this.consecutiveMigrationFailures++;
            console.error("Error during deprecated-signer migration:", e);
        } finally {
            this.lastMigrationTimestamp = Date.now();
        }
    }

    /** Asserts migration capability and returns the typed wallet. */
    private requireMigrationCapableWallet(): IWallet & MigrationCapableWallet {
        if (!isMigrationCapable(this.wallet)) {
            throw new Error(
                "Deprecated-signer migration requires a Wallet instance with arkProvider, " +
                    "arkServerPublicKey, and rotateServerSigner",
            );
        }
        return this.wallet;
    }

    /**
     * If the wallet's own construction-time signer snapshot has been deprecated,
     * re-derive its receive/boarding state under the active signer so any output
     * built afterwards commits to the active key. No-op when the snapshot is
     * already current. Returns whether a rotation was applied. Treats an
     * unknown-signer snapshot as "do not rotate" (caller decides).
     *
     * Shared by the migration pass (where the wallet's own snapshot is the thing
     * being migrated) and the recovery/renewal/periodic-settle paths (via
     * {@link rotateForRecoverableInputs}), so a swept old-signer VTXO recovered
     * after cutoff re-mints under the active signer rather than re-committing to
     * the deprecated key (Section 6 / post-cutoff). `rotateServerSigner` is
     * idempotent and serializes itself against HD receive rotation, so repeated
     * calls across passes are safe.
     */
    private async ensureReceiveOnActiveSigner(info: ArkadeInfo): Promise<boolean> {
        const wallet = this.requireMigrationCapableWallet();
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const walletClass = classifyAgainstSignerSet(
            hex.encode(wallet.arkServerPublicKey),
            signerSet,
            nowSeconds,
        );
        if (walletClass.status === "CURRENT" || walletClass.status === "UNKNOWN_SIGNER") {
            return false;
        }
        // Thread the fresh epoch's checkpoint script through so the rotated
        // wallet builds send-path checkpoints against the active server signer.
        await wallet.rotateServerSigner(hex.decode(info.signerPubkey), info.checkpointTapscript);
        return true;
    }

    /**
     * Rotation guard for the recovery-bearing settle paths (recover / renew /
     * periodic settle). Pins the wallet's receive snapshot to the active signer
     * before they build their output, but ONLY when this pass actually carries
     * an input minted under a deprecated signer — so a routine current-signer
     * settle on a long-lived pre-rotation instance does not eagerly rotate.
     *
     * Cheap in the common case: a watch-only/proxy wallet (not migration-capable)
     * and a current/unknown wallet snapshot both short-circuit before the
     * contract round-trip, so the only instance that pays for the input scan is
     * the long-lived deprecated-snapshot one that genuinely needs rotating.
     *
     * Runs OUTSIDE any `renewalInProgress` window the caller sets, and
     * `rotateServerSigner` does not depend on that flag, so it cannot deadlock
     * against the receive rotator. Returns whether a rotation was applied.
     */
    private async rotateForRecoverableInputs(
        inputs: { txid: string; vout: number }[],
        info: ArkadeInfo,
    ): Promise<boolean> {
        if (!isMigrationCapable(this.wallet)) return false;

        // Cheap in-memory gate first: only a deprecated wallet snapshot can ever
        // need rotation, and ensureReceiveOnActiveSigner would no-op otherwise —
        // so skip the contract scan entirely for current/unknown snapshots.
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const walletClass = classifyAgainstSignerSet(
            hex.encode(this.wallet.arkServerPublicKey),
            signerSet,
            nowSeconds,
        );
        if (walletClass.status === "CURRENT" || walletClass.status === "UNKNOWN_SIGNER") {
            return false;
        }

        if (!(await this.anyInputUnderDeprecatedSigner(inputs, signerSet, nowSeconds))) {
            return false;
        }

        return this.ensureReceiveOnActiveSigner(info);
    }

    /**
     * Whether any of the given input outpoints belongs to a contract whose
     * server signer classifies as non-`CURRENT` against the fresh signer set —
     * i.e. a deprecated-signer (incl. EXPIRED) input. Maps outpoints to their
     * owning contract via the ContractManager so it works on the typed
     * {@link ExtendedVirtualCoin}/{@link ExtendedCoin} inputs the recovery paths
     * carry (which don't expose `contractScript`).
     */
    private async anyInputUnderDeprecatedSigner(
        inputs: { txid: string; vout: number }[],
        signerSet: SignerSet,
        nowSeconds: number,
    ): Promise<boolean> {
        if (inputs.length === 0) return false;
        const wanted = new Set(inputs.map((i) => `${i.txid}:${i.vout}`));
        const cm = await this.wallet.getContractManager();
        const contractsWithVtxos = await cm.getContractsWithVtxos({
            type: ["default", "delegate"],
        });
        for (const { contract, vtxos } of contractsWithVtxos) {
            const serverPubKey = contract.params.serverPubKey;
            if (!serverPubKey) continue;
            if (
                classifyAgainstSignerSet(serverPubKey, signerSet, nowSeconds).status === "CURRENT"
            ) {
                continue;
            }
            for (const v of vtxos) {
                if (wanted.has(`${v.txid}:${v.vout}`)) return true;
            }
        }
        return false;
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

    /**
     * Read-only access to the ark provider for fetching server limits. Unlike
     * {@link getArkProvider}, this does not require full boarding-sweep
     * capability — recovery and renewal only need it to read `vtxoMaxAmount`.
     * Returns undefined when no provider is wired, which callers treat as
     * "no limit".
     */
    private getInfoProvider(): ArkProvider | undefined {
        // Narrow cast: reach only for an optional arkProvider rather than the
        // full sweep-capable shape, so an incompatible future IWallet.arkProvider
        // surfaces here as a type error instead of being silently absorbed.
        return (this.wallet as { arkProvider?: ArkProvider }).arkProvider;
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
        if (!isArkError(ark, ArkErrorName.VTXO_ALREADY_SPENT)) return undefined;
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
        candidates: NormalizedExtendedVirtualCoin[],
        thresholdMs?: number,
        now?: TimeHeight,
    ): Promise<NormalizedExtendedVirtualCoin[]> {
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
            const refreshed = await this.selectExpiringVtxos(thresholdMs, now);
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

                // Migrate VTXOs under a deprecated server signer (planned arkd
                // key rotation). Gated by the opt-out flag; runMigrationPass is
                // self-contained (own cooldown/backoff, swallows + logs errors)
                // so it neither stacks the poll backoff nor retries continuously.
                const migrationEnabled =
                    this.settlementConfig !== false &&
                    (this.settlementConfig?.deprecatedSignerMigration ??
                        DEFAULT_SETTLEMENT_CONFIG.deprecatedSignerMigration);
                if (migrationEnabled && isMigrationCapable(this.wallet)) {
                    await this.runMigrationPass();
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
        let expiringVtxos: NormalizedExtendedVirtualCoin[] = [];
        // Fetched here rather than at the top of the method so a boarding-only pass stays offline.
        let now: TimeHeight | undefined;
        if (!this.renewalInProgress) {
            try {
                now = await fetchTimeHeight(this.wallet);
                expiringVtxos = await this.selectExpiringVtxos(undefined, now);
                // Pre-flight validation: see comment in `renewVtxos`. The
                // local cache may carry vtxos that the indexer already
                // marks spent because the cursor-derived delta sync only
                // catches `created_at`-recent updates, not status changes
                // for older VTXOs.
                expiringVtxos = await this.revalidateBeforeSettle(expiringVtxos, undefined, now);
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
        const info = await this.getArkProvider().getInfo();
        const { fees, vtxoMaxAmount } = info;
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

        // Cap the VTXOs per settlement to stay under the server's intent-size
        // limit (MAX_VTXOS_PER_SETTLEMENT inputs) and its per-output ceiling
        // (vtxoMaxAmount; -1 means no limit). Settle the soonest-expiring VTXOs
        // first so the most urgent ones make the cut. Apply the cap to
        // economically viable VTXOs only: skipping uneconomic inputs and
        // continuing past the cap avoids an uneconomic prefix permanently
        // starving valid VTXOs behind it. Boarding inputs are added uncapped
        // above; the amount cap accounts for them via the running total (so if
        // boarding alone already exceeds vtxoMaxAmount no VTXO fits and the
        // server rejects the over-limit output — a multi-output split would be
        // needed to settle that, which is out of scope here). Any overflow is
        // settled on the next cycle.
        const filteredVtxos: NormalizedExtendedVirtualCoin[] = [];
        // `now` is unset only when the selection block above was skipped, which leaves
        // `expiringVtxos` empty — nothing to sort, so the fallback tip is never read.
        for (const v of byExpiryAscending(expiringVtxos, now ?? { timestamp: new Date() })) {
            if (filteredVtxos.length >= MAX_VTXOS_PER_SETTLEMENT) {
                break;
            }
            const inputFee = estimator.evalOffchainInput(toOffchainInputFeeParams(v));
            if (inputFee.satoshis >= v.value) {
                continue;
            }
            const net = BigInt(v.value) - BigInt(inputFee.satoshis);
            // Skip (don't stop at) a VTXO that would push the output past the
            // ceiling; a smaller VTXO behind it can still fit.
            if (vtxoMaxAmount >= 0n && totalAmount + net > vtxoMaxAmount) {
                continue;
            }
            filteredVtxos.push(v);
            totalAmount += net;
        }

        if (filteredBoarding.length === 0 && filteredVtxos.length === 0) {
            return;
        }

        // Pin the destination to the active signer when this cycle carries a
        // recoverable input minted under a now-deprecated signer (the
        // post-cutoff recover-on-sweep drain): rotate the wallet's own snapshot
        // BEFORE reading getAddress(), so the periodic settle re-mints those
        // funds under the current key rather than the deprecated one. Runs
        // before the renewalInProgress window below, so it cannot deadlock
        // against the receive rotator (Section 6 / post-cutoff). Skipped for
        // non-rotatable wallets so the hot poll path adds no work for them.
        if (isMigrationCapable(this.wallet)) {
            await this.rotateForRecoverableInputs([...filteredBoarding, ...filteredVtxos], info);
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
            subscription?.();
        })();

        return this.disposePromise;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}
