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
    isVtxoSpent,
    isPastExpiry,
    normalizeVtxo,
    resolveTimeHeight,
    toOffchainInputFeeParams,
    type NormalizedExtendedVirtualCoin,
    type TimeHeight,
} from "./vtxo";
import { ArkadeInfo, ArkProvider, SettlementEvent } from "../providers/ark";
import { ArkErrorName, isArkError, maybeArkError } from "../providers/errors";
import type { BoardingUtxoGroup } from "./wallet";
import type { ExtendedContractVtxo } from "../contracts/types";
import { isContractVtxoEvent } from "../contracts/types";
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
 * Outpoints (`txid:vout`) of VTXOs whose contract signer is past its cutoff (`EXPIRED`) and that
 * the server has not swept yet. The operator will not co-sign them, so `getBalance` buckets them
 * under `pendingRecovery` and coin selection skips them (a send would fail at submit); they
 * recover once swept and re-settled under the active signer.
 *
 * Pure + offline: classifies against a cached {@link SignerSet}, never a fresh GetInfo.
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
            // Exited coins are excluded: their remedy is `completeUnroll`, not a rotation.
            if (!isVtxoSpent(v) && !v.isSwept && !v.isUnrolled) {
                out.add(`${v.txid}:${v.vout}`);
            }
        }
    }
    return out;
}

/** Members boarding sweeps need that exist on the concrete Wallet but not on IWallet. */
interface SweepCapableWallet extends IReadonlyWallet {
    boardingTapscript: DefaultVtxo.Script;
    onchainProvider: OnchainProvider;
    arkProvider: ArkProvider;
    network: Network;
    /**
     * Descriptor-aware signer: routes each input to the identity or its per-index descriptor
     * (rotated boarding), so a sweep batching several boarding addresses signs each correctly.
     */
    signOnchainBoardingTx(tx: Transaction): Promise<Transaction>;
}

function isSweepCapable(wallet: IWallet): wallet is IWallet & SweepCapableWallet {
    return (
        "boardingTapscript" in wallet &&
        "onchainProvider" in wallet &&
        "arkProvider" in wallet &&
        "network" in wallet &&
        "signOnchainBoardingTx" in wallet
    );
}

function assertSweepCapable(wallet: IWallet): asserts wallet is IWallet & SweepCapableWallet {
    if (!isSweepCapable(wallet)) {
        throw new Error(
            "Boarding UTXO sweep requires a Wallet instance with boardingTapscript, onchainProvider, arkProvider, network, and signOnchainBoardingTx",
        );
    }
}

/**
 * Web Locks name serializing boarding polls across same-origin contexts (tabs, service worker).
 * Static: two distinct wallets on one origin just take turns, which is acceptable.
 */
const BOARDING_POLL_LOCK_NAME = "arkade-boarding-poll";

/**
 * Run `fn` under an exclusive Web Lock when `navigator.locks` exists, else (Node, React Native)
 * uncoordinated. `ifAvailable`: if another context holds the lock, skip this cycle rather than
 * queue — that context does the work and the next poll re-checks.
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
 * Maximum number of VTXOs in a single settlement intent; the overflow waits for the next cycle.
 *
 * arkd has no count limit but rejects an intent with `TX_TOO_LARGE` past `maxTxWeight` (~40k WU
 * by default); 50 stays well under it with headroom for (uncapped) boarding inputs. ts-sdk-only:
 * go-sdk and NArk submit every spendable VTXO in one unordered intent, so we are free to order
 * candidates before capping — see {@link byValueDescending} and {@link byExpiryAscending}.
 */
export const MAX_VTXOS_PER_SETTLEMENT = 50;

/**
 * Maximum number of inputs the server accepts in a single intent proof
 * (get-pending-tx and friends). Larger input sets must be split into batches.
 */
export const MAX_INPUTS_PER_INTENT = 20;

/**
 * Order VTXOs highest-value first (new array). For value-driven paths (recovery, manual full
 * settle), so a {@link MAX_VTXOS_PER_SETTLEMENT}-capped batch carries the most value — for
 * recovery, the best chance of clearing dust.
 */
export function byValueDescending<T extends { value: number }>(vtxos: T[]): T[] {
    return [...vtxos].sort((a, b) => b.value - a.value);
}

/** {@link TimeHeight} for one expiry-driven pass; `onchainProvider` is on concrete wallets only. */
async function fetchTimeHeight(wallet: IReadonlyWallet): Promise<TimeHeight> {
    return resolveTimeHeight((wallet as Partial<SweepCapableWallet>).onchainProvider);
}

/**
 * Whether {@link Wallet.sendSelectedVtxosToSelf} will accept this input at `now`: mirrors its two
 * rejection conditions exactly (see {@link MigrationLegReport.notSpendableOffchain}). The same
 * `TimeHeight` goes to the send path, so both sides agree at the expiry boundary.
 */
function canMigrateBySend(vtxo: NormalizedExtendedVirtualCoin, now: TimeHeight): boolean {
    // The send path spends cooperatively, so swept/expired inputs belong to recovery instead.
    if (!canSpendOffchain(vtxo, now)) return false;
    // No batch expiry means nothing to migrate *from*: the DB-update path only persists a
    // wallet-owned output when an input expiry exists (unrolled/settled inputs carry none).
    return vtxo.expiresAt !== undefined || vtxo.expiresAtHeight !== undefined;
}

/**
 * Order VTXOs soonest-expiring first (new array); swept/expired first, no expiry last. For
 * expiry-driven paths (renewal, periodic settle), so the {@link MAX_VTXOS_PER_SETTLEMENT} cap
 * never defers an urgent VTXO past its renewal window into a forced unilateral exit.
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

    // Compared, not subtracted: equal infinities subtract to NaN, and a NaN comparator leaves the
    // order unspecified.
    return [...vtxos].sort((a, b) => {
        const ka = expiryKey(a);
        const kb = expiryKey(b);
        if (ka === kb) return 0;
        return ka < kb ? -1 : 1;
    });
}

/**
 * Select inputs from `sorted` for one settlement: at most {@link MAX_VTXOS_PER_SETTLEMENT} inputs
 * with cumulative `value` no greater than `maxAmount` (`< 0` is the server's `-1` "no limit" for
 * `ArkadeInfo.vtxoMaxAmount`). The single output equals the inputs' sum and the server rejects
 * outputs above `vtxoMaxAmount` with `AMOUNT_TOO_HIGH`; the overflow waits for the next cycle.
 *
 * Bounds gross `value`, not fee-adjusted net: strictly conservative, since the post-fee output is
 * smaller. Do not "tighten" by subtracting fees here (periodic/manual settle cap on net instead —
 * a deliberate, harmless asymmetry).
 *
 * `sorted` must be in caller priority order. An input that would breach the amount cap is
 * skipped, not a stop, so smaller inputs behind it still fit; the count cap is a hard stop.
 * `> maxAmount` mirrors the server's strict check.
 */
export function capSettlementBatch<T extends { value: number }>(
    sorted: T[],
    maxAmount: bigint,
): T[] {
    const batch: T[] = [];
    let total = 0n;
    for (const vtxo of sorted) {
        if (batch.length >= MAX_VTXOS_PER_SETTLEMENT) break;
        const next = total + BigInt(vtxo.value);
        if (maxAmount >= 0n && next > maxAmount) continue;
        batch.push(vtxo);
        total = next;
    }
    return batch;
}

/**
 * Price a settlement's VTXO inputs against the operator's intent-fee policy, dropping any input
 * whose fee meets or exceeds its value.
 *
 * An intent's fee IS `sum(inputs) - sum(outputs)`, so an output asking for the gross input sum
 * offers zero fee and gets `INTENT_INSUFFICIENT_FEE`. Callers still owe
 * {@link deductOffchainOutputFee}, and must filter BEFORE {@link capSettlementBatch} so an
 * uneconomic input cannot take a viable one's slot. Nets are returned for {@link subtotalOf}.
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
 * Sum the nets {@link priceSettlementInputs} computed; `vtxos` must be (a cap-narrowed) `payable`.
 * An unpriced input throws rather than counting as zero: understating the output would silently
 * overpay the fee out of the user's funds.
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
 * Evaluated on the pre-deduction `subtotal`, matching {@link VtxoManager.runPeriodicSettle} and
 * no-arg `Wallet.settle()`. Under a percentage rate `r` this overpays by `r^2 * subtotal`;
 * deliberate, since solving the fixed point exactly risks landing one sat under the minimum.
 *
 * May return below dust or below zero under a flat fee; every caller checks against dust.
 */
function deductOffchainOutputFee(
    subtotal: bigint,
    estimator: Estimator,
    arkAddress: string,
): bigint {
    // Mirror the estimator's early return before `ArkAddress.decode`: an operator that doesn't
    // price outputs shouldn't make a decodable address a precondition for renewing/recovering.
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

/** Default renewal threshold in milliseconds (3 days). */
export const DEFAULT_THRESHOLD_MS = DEFAULT_THRESHOLD_SECONDS * 1000;

/**
 * Configuration for automatic settlement and renewal, coordinated by `VtxoManager`'s poll loop:
 * 1. **VTXO renewal**: Automatically renew virtual outputs that are close to expiry
 * 2. **Boarding UTXO sweep**: Sweep expired boarding inputs back to a fresh boarding address
 *    via the unilateral exit path (onchain self-spend to restart the timelock)
 *
 * Enabled by default when no config is provided; pass `false` to disable all settlement behavior.
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
     * Sweep expired boarding inputs back to a fresh boarding address, batched into one onchain
     * tx (many inputs, one output), only when the output after fees is above dust.
     *
     * @defaultValue `true`
     */
    boardingUtxoSweep?: boolean;

    /**
     * Polling interval in milliseconds. Each poll auto-settles new boarding inputs into Arkade
     * and sweeps expired ones (when `boardingUtxoSweep` is enabled).
     *
     * @defaultValue `60_000` (1 minute)
     */
    pollIntervalMs?: number;

    /**
     * Automatically migrate VTXOs under a deprecated server signer (planned arkd key rotation) to
     * the active-signer address before their cutoff, first applying a mid-session signer rotation
     * if the wallet's own snapshot signer was deprecated.
     * {@link IVtxoManager.migrateDeprecatedSignerVtxos} works regardless of this flag;
     * `settlementConfig: false` disables migration along with everything else.
     *
     * @defaultValue `true`
     */
    deprecatedSignerMigration?: boolean;
}

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
 * Recoverable virtual outputs: swept (or past expiry) always; subdust only when preconfirmed —
 * settled subdust with a long expiry is left alone to avoid locking liquidity.
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

        if (canSpendOffchain(vtxo, now) && vtxo.isPreconfirmed && isSubdust(vtxo, dustAmount)) {
            return true;
        }

        return false;
    });
}

/**
 * Recoverable virtual outputs, including subdust only when the combined total of ALL recoverable
 * outputs (regular + subdust, not subdust alone) reaches the dust threshold.
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

    const subdust: NormalizedExtendedVirtualCoin[] = [];
    const regular: NormalizedExtendedVirtualCoin[] = [];

    for (const vtxo of recoverableVtxos) {
        if (isSubdust(vtxo, dustAmount)) {
            subdust.push(vtxo);
        } else {
            regular.push(vtxo);
        }
    }

    const regularTotal = regular.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
    const subdustTotal = subdust.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
    const combinedTotal = regularTotal + subdustTotal;

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
 * Check if a virtual output is expiring soon based on threshold. Always `false` for an unrolled
 * output: no batch can renew an output that already lives onchain.
 *
 * @param vtxo - The virtual output to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @returns true if virtual output expires within threshold, false otherwise
 */
export function isVtxoExpiringSoon(
    vtxo: ExtendedVirtualCoin,
    thresholdMs: number, // in milliseconds
): boolean {
    // Bare, not off the normalized coin: `normalizeVtxo` never defaults this flag.
    if (vtxo.isUnrolled) return false;

    const realThresholdMs = thresholdMs <= 100 ? DEFAULT_THRESHOLD_MS : thresholdMs;

    // Synchronous, so no chain tip: a height-encoded expiry reads as "doesn't expire".
    const expiresAt = normalizeVtxo(vtxo).expiresAt;
    if (expiresAt === undefined) return false;

    const now = Date.now();
    const batchExpiry = expiresAt.getTime();

    if (batchExpiry <= now) return false; // already expired

    return batchExpiry - now <= realThresholdMs;
}

/**
 * Filter virtual outputs that are expiring soon or are recoverable/subdust; never unrolled ones,
 * which no batch can take.
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
        // The leading exclusion covers the `isSubdust` arm too, which is a value
        // property and would otherwise re-admit an exited coin on its own.
        (vtxo) =>
            !vtxo.isUnrolled &&
            (isVtxoExpiringSoon(vtxo, thresholdMs) ||
                canRecoverOnchain(vtxo, now) ||
                isSubdust(vtxo, dustAmount)),
    );
}

/**
 * Optional arguments for {@link IVtxoManager.renewVtxos}.
 */
export interface RenewVtxosOptions {
    /**
     * Override the renewal threshold for this call only, in seconds. Takes precedence over
     * `SettlementConfig.vtxoThreshold` and the default (3 days).
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
 * Machine-readable status for a single deprecated signer the wallet holds funds under. Derived at
 * read time from contract params plus a fresh {@link ArkadeInfo} snapshot — never persisted.
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
     * Number of confirmed boarding UTXOs the wallet holds under this signer, including those
     * whose own CSV exit window has elapsed (they leave via the unilateral sweep).
     */
    boardingCount: number;
    /** Total value of those boarding UTXOs in satoshis. */
    boardingValue: number;
    /**
     * Expired-signer VTXOs already swept and queued for recovery to the active signer (see
     * {@link SignerStatus} `EXPIRED`). Non-zero only on `EXPIRED` rows; drain on the next
     * recovery pass.
     */
    recoverableCount: number;
    recoverableValue: number;
    /**
     * Expired-signer VTXOs not yet swept, awaiting the server batch sweep before they become
     * recoverable. Non-zero only on `EXPIRED` rows — nothing for the user to do but wait.
     */
    awaitingSweepCount: number;
    awaitingSweepValue: number;
    /**
     * Soonest batch expiry (ms since epoch) among the awaiting-sweep VTXOs, as a recovery ETA
     * hint. Present only when such VTXOs carry a batch expiry.
     */
    nextSweepEta?: number;
}

/**
 * Why a single migration leg submitted nothing. `oversized-only`: every migratable input alone
 * exceeds `vtxoMaxAmount` — see {@link MigrationLegReport.oversized}.
 */
export type MigrationLegSkipReason = "below-dust" | "oversized-only" | "not-spendable-only";

/**
 * Why the whole pass submitted nothing. `no-deprecated-vtxos`: BOTH migratable sets were empty;
 * `unknown-wallet-signer`: the wallet's own signer is neither active nor advertised deprecated,
 * so the pass refuses to rotate.
 */
export type MigrationGlobalSkipReason = "no-deprecated-vtxos" | "unknown-wallet-signer";

/**
 * Outcome of one migration leg. VTXOs migrate via the Ark send path
 * ({@link Wallet.sendSelectedVtxosToSelf}); boarding coins, being on-chain inputs with no send
 * path, via settle. Each leg sizes and reports independently — one leg's failure or skip never
 * suppresses the other.
 */
export interface MigrationLegReport {
    /** VTXO leg: Ark transaction id from send. Boarding leg: settle commitment txid. */
    txid?: string;
    /** Inputs submitted and accepted in this leg's transaction; empty on error/skip. */
    migrated: MigrationVtxoRef[];
    /** Why this leg submitted nothing (every candidate below dust or oversized). */
    skipped?: MigrationLegSkipReason;
    /**
     * Migratable inputs deferred to a later pass by this leg's count
     * ({@link MAX_VTXOS_PER_SETTLEMENT}) or amount (`vtxoMaxAmount`) cap. Present and non-zero
     * only when a cap bound and the leg submitted.
     */
    deferred?: number;
    /**
     * Inputs whose value alone exceeds `vtxoMaxAmount`: they can never migrate cooperatively and
     * require a unilateral exit. Present only when non-empty; absent when the server advertises
     * no ceiling (`vtxoMaxAmount < 0`).
     */
    oversized?: MigrationVtxoRef[];
    /**
     * Inputs the leg's submit path would reject — for the VTXO leg, past batch expiry at this
     * pass's chain tip, or carrying no batch expiry. Partitioned out because the send path
     * validates the batch as a whole: one rejected input would abort the leg and strand every
     * other VTXO until the next pass. Present only when non-empty.
     */
    notSpendableOffchain?: MigrationVtxoRef[];
    /** Error message when this leg's submission failed; the other leg still runs. */
    error?: string;
}

/**
 * Result of a {@link IVtxoManager.migrateDeprecatedSignerVtxos} pass: two legs (see
 * {@link MigrationLegReport}), never combined into one intent.
 */
export interface DeprecatedSignerMigrationReport {
    /**
     * Whether this pass (directly or via its opening server-info refresh) moved the wallet's
     * receive state onto the active signer. `false` when already there, including via a rotation
     * an earlier refresh elsewhere in the session applied.
     */
    rotated: boolean;
    /** Global skip; when set, neither leg is present. */
    skipped?: MigrationGlobalSkipReason;
    /** Send leg. Present iff ≥1 cooperatively-migratable VTXO existed this pass. */
    vtxos?: MigrationLegReport;
    /** Settle leg. Present iff ≥1 cooperatively-migratable boarding UTXO existed this pass. */
    boarding?: MigrationLegReport;
    /**
     * Cutoff-expired inputs of both kinds, for which cooperative migration is closed. They are
     * NOT pushed to a unilateral exit: the server sweeps each at its batch expiry and recovery
     * re-mints it under the active signer — a lifecycle surfaced on {@link signers}.
     */
    expired: MigrationVtxoRef[];
    /** Per-deprecated-signer status snapshot. */
    signers: DeprecatedSignerReport[];
}

/**
 * Extra surface the migration path needs beyond {@link IWallet}. Implemented by the concrete
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
     * Drain a rotation the wallet is applying off an `onServerInfoChanged` emit, so this pass
     * classifies against a settled, not half-rotated, signer snapshot. Optional: only the
     * concrete `Wallet` subscribes to server-info events.
     */
    settleServerInfoChanges?(): Promise<void>;
    /**
     * Spend the given own deprecated-signer VTXOs into one full-value active-signer output via
     * the Ark send path (not `settle`), preserving input assets. Never accepts boarding inputs.
     */
    sendSelectedVtxosToSelf(inputs: ExtendedVirtualCoin[], now?: TimeHeight): Promise<string>;
    /**
     * Grouped boarding discovery over a signer set, returning the address↔signer association
     * {@link ExtendedCoin} cannot carry.
     */
    getBoardingUtxosForSigners(allowedSigners: Set<string>): Promise<BoardingUtxoGroup[]>;
}

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

/** Boarding-UTXO counterpart of {@link ClassifiedVtxo}. */
interface ClassifiedBoarding {
    coin: ExtendedCoin;
    classification: SignerClassification;
}

function classifiedToRef(c: ClassifiedVtxo): MigrationVtxoRef {
    return {
        txid: c.vtxo.txid,
        vout: c.vtxo.vout,
        value: c.vtxo.value,
        signerPubKey: c.classification.signerPubKey,
        cutoffDate: c.classification.cutoffDate,
    };
}

function classifiedBoardingToRef(c: ClassifiedBoarding): MigrationVtxoRef {
    return {
        txid: c.coin.txid,
        vout: c.coin.vout,
        value: c.coin.value,
        signerPubKey: c.classification.signerPubKey,
        cutoffDate: c.classification.cutoffDate,
    };
}

/** Merge per-signer rows from several classifiers (VTXO + boarding) into one row per signer. */
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
 * Manages virtual output lifecycle: recovery of swept/expired outputs, renewal before expiry
 * (including subdust when economically viable), and expiry monitoring.
 *
 * Virtual outputs become recoverable when the Arkade server sweeps them (`isSwept`) while still
 * spendable, or when they are preconfirmed subdust (consolidated without locking the liquidity of
 * settled outputs).
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
     * Cooperatively migrate VTXOs minted under a now-deprecated server signer to the wallet's
     * active-signer address (planned arkd key rotation), soonest cutoff first. First applies a
     * mid-session signer rotation when the wallet's own snapshot signer was deprecated, so the
     * output commits to the active signer. VTXOs past their cutoff are reported as `expired`.
     *
     * Available regardless of `deprecatedSignerMigration` (which only gates the poll-loop pass).
     *
     * Side effect: refreshes the wallet's cached deprecated-signer set, so a later `settle()`
     * excludes EXPIRED deprecated-signer inputs. To refresh without migrating, call
     * `wallet.refreshDeprecatedSigners(await wallet.arkProvider.getInfo())` instead.
     *
     * @returns A report of what was migrated, skipped, expired, or failed.
     */
    migrateDeprecatedSignerVtxos(
        options?: MigrateDeprecatedSignerOptions,
    ): Promise<DeprecatedSignerMigrationReport>;

    /**
     * Status of every deprecated server signer the wallet holds funds under, without migrating,
     * so consumers can surface cutoff warnings on their own schedule.
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

    // Periodic-settle cooldown with exponential backoff, so a failing settle doesn't re-submit an
    // identical intent (plus a DeleteIntent RPC) every poll forever. Shared by boarding and
    // expiring-VTXO work, which ride the same settle intent.
    private lastPeriodicSettleTimestamp = 0;
    private consecutivePeriodicSettleFailures = 0;
    private static readonly PERIODIC_SETTLE_COOLDOWN_MS = 30_000;
    private static readonly PERIODIC_SETTLE_MAX_BACKOFF_MS = 5 * 60 * 1000;

    // Throttles the VTXO_ALREADY_SPENT -> refreshVtxos() reconciliation (the server says our
    // cache is stale) so a buggy indexer can't cycle us into a refresh storm.
    private lastVtxoSpentRefreshTimestamp = 0;
    private vtxoSpentRefreshPromise?: Promise<void>;
    private static readonly VTXO_SPENT_REFRESH_COOLDOWN_MS = 30_000;

    // Same cooldown/backoff for the automatic deprecated-signer migration pass (e.g. arkd not yet
    // accepting old-key inputs); the manual migrateDeprecatedSignerVtxos() bypasses it.
    private lastMigrationTimestamp = 0;
    private consecutiveMigrationFailures = 0;
    private static readonly MIGRATION_COOLDOWN_MS = 30_000;
    private static readonly MIGRATION_MAX_BACKOFF_MS = 5 * 60 * 1000;

    constructor(
        readonly wallet: IWallet,
        settlementConfig?: SettlementConfig | false,
    ) {
        this.settlementConfig =
            settlementConfig !== undefined ? settlementConfig : { ...DEFAULT_SETTLEMENT_CONFIG };

        this.contractEventsSubscriptionReady = this.initializeSubscription();
    }

    // ========== Recovery Methods ==========

    /**
     * Outpoints recovery must not name yet, with each refusal reason; empty when the contract
     * manager offers no opinion (only VHTLC answers). Reaches only lockups whose `sender` is this
     * wallet's own key — a descriptor-derived sender (every RFQ lockup) isn't matched and still
     * fails its batch at submit. The key is a thunk so ordinary recovery never touches the
     * identity; full coins carry the confirmation a relative timelock counts from.
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
     * Includes preconfirmed subdust when the total reaches the dust threshold; settled outputs
     * with a long expiry are NOT recovered, to avoid locking liquidity. Inputs whose contract
     * refuses a spend right now (an immature VHTLC refund path) are skipped rather than failing
     * the batch, matching {@link getRecoverableBalance}.
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
        const allVtxos = await this.wallet.getVtxos({
            withRecoverable: true,
            withUnrolled: false,
        });

        const dustAmount = getDustAmount(this.wallet);

        const now = await fetchTimeHeight(this.wallet);
        let { vtxosToRecover } = getRecoverableWithSubdust(allVtxos, dustAmount, now);

        if (vtxosToRecover.length === 0) {
            throw new Error("No recoverable VTXOs found");
        }

        // Before pricing/capping, else a refused input would take a slot and then vanish.
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
                // Every reason, not the first: lockups mature at different times. Same shape
                // as `IContractManager.assertSpendableNow`'s multi-input refusal.
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

        // Highest-value first: the subdust decision above used the full set's total, so a naive
        // capped prefix could fall below dust, be rejected, and be re-picked every cycle.
        // Eligibility is re-run on the capped subset below; the overflow waits a cycle.
        const info = await this.getInfoProvider()?.getInfo();
        const vtxoMaxAmount = info?.vtxoMaxAmount ?? -1n;

        // `info` is undefined only with no ark provider wired, which prices as zero (gross).
        const estimator = new Estimator(info?.fees.intentFee ?? {});
        const { payable, net } = priceSettlementInputs(vtxosToRecover, estimator);
        const capped = capSettlementBatch(byValueDescending(payable), vtxoMaxAmount);
        // Against the pre-pricing count on purpose: fee pricing OR the cap narrowing the batch
        // both invalidate the subdust decision above.
        if (capped.length < vtxosToRecover.length) {
            const recoverableCount = vtxosToRecover.length;
            // A size cap defers overflow to the next cycle; fee filtering means the coins cost
            // more to move than they're worth, which no later cycle fixes. Operators need which.
            const cappedAway = capped.length < payable.length;
            ({ vtxosToRecover } = getRecoverableWithSubdust(capped, dustAmount, now));
            if (vtxosToRecover.length === 0) {
                // Funded but stuck below dust: distinct from "none recoverable" so operators
                // can tell it from an empty wallet.
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

        // Post-cutoff: if an input is under a deprecated signer the wallet snapshot still uses,
        // rotate FIRST so the recovered output re-mints under the active key. Skipped for
        // non-rotatable (watch-only/proxy) wallets.
        if (info && isMigrationCapable(this.wallet)) {
            await this.rotateForRecoverableInputs(vtxosToRecover, info);
        }

        // Read AFTER any rotation above, so the output fee is priced against the
        // script the recovered VTXO actually lands on.
        const arkAddress = await this.wallet.getAddress();

        const totalAmount = deductOffchainOutputFee(
            subtotalOf(vtxosToRecover, net),
            estimator,
            arkAddress,
        );

        // Subdust inclusion was judged on gross value; net of fees the batch can still land
        // under dust, which the server would reject.
        if (totalAmount < dustAmount) {
            throw new Error(
                `Recoverable amount ${totalAmount} net of intent fees is below ` +
                    `dust threshold ${dustAmount}`,
            );
        }

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
     * `recoverable` is net of the operator's intent fees — what {@link recoverVtxos} would
     * actually hand back. `subdust` is net of per-input fees only (the output fee is charged per
     * batch, not per coin), so it is not strictly a slice of `recoverable` and can exceed it when
     * a flat output fee meets a wholly subdust wallet. Batch size caps are not applied: they
     * defer overflow rather than reduce what is recoverable.
     *
     * Inputs a contract refuses right now are excluded, matching {@link recoverVtxos};
     * `Balance.recoverable` still counts them (what the wallet owns vs. what a batch returns
     * today).
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

        // Mirrors `recoverVtxos` so the preview and the sweep agree by construction.
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

        // Priced exactly as `recoverVtxos` prices what it settles; batch caps not applied (see
        // the JSDoc).
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

        // Subdust is CLASSIFIED on gross value (what makes a coin subdust) but REPORTED net of
        // per-input fees, on the same footing as `recoverable`.
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

    /** `settlementConfig.vtxoThreshold` in ms, else {@link DEFAULT_THRESHOLD_MS}. */
    private configuredThresholdMs(): number {
        return this.settlementConfig !== false && this.settlementConfig?.vtxoThreshold !== undefined
            ? this.settlementConfig.vtxoThreshold * 1000
            : DEFAULT_THRESHOLD_MS;
    }

    /**
     * {@link getExpiringVtxos} against a caller-supplied chain tip, so a settle pass's select,
     * re-select and expiry sort share one tip instead of fetching (and disagreeing on) one each.
     */
    private async selectExpiringVtxos(
        thresholdMs?: number,
        now?: TimeHeight,
    ): Promise<NormalizedExtendedVirtualCoin[]> {
        if (this.settlementConfig === false && thresholdMs === undefined) {
            return [];
        }

        const vtxos = await this.wallet.getSpendableVtxos({
            withRecoverable: true,
            genericallySpendableOnly: true,
        });

        // Not `??`: a runtime `null` must still reach isVtxoExpiringSoon's default guard.
        const threshold = thresholdMs !== undefined ? thresholdMs : this.configuredThresholdMs();

        return getExpiringAndRecoverableVtxos(
            vtxos,
            threshold,
            getDustAmount(this.wallet),
            now ?? (await fetchTimeHeight(this.wallet)),
        );
    }

    /**
     * Renew expiring virtual outputs (including recoverable ones) by settling them back to the
     * wallet's address, refreshing their expiration time.
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
        // The payload can arrive over the worker MessageBus, so validate at runtime: a bad value
        // corrupts the threshold (and <=100ms silently reverts to the 3-day default).
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
            // Manual API bypasses the settlementConfig === false gate.
            const threshold =
                options?.thresholdSeconds !== undefined
                    ? options.thresholdSeconds * 1000
                    : this.configuredThresholdMs();
            // One chain tip for the whole pass — see `selectExpiringVtxos`.
            const now = await fetchTimeHeight(this.wallet);
            let vtxos = await this.selectExpiringVtxos(threshold, now);

            if (vtxos.length === 0) {
                throw new Error("No VTXOs available to renew");
            }

            vtxos = await this.revalidateBeforeSettle(vtxos, threshold, now);
            if (vtxos.length === 0) {
                throw new Error("No VTXOs available to renew");
            }

            const info = await this.getInfoProvider()?.getInfo();
            const vtxoMaxAmount = info?.vtxoMaxAmount ?? -1n;

            const estimator = new Estimator(info?.fees.intentFee ?? {});
            const { payable, net } = priceSettlementInputs(vtxos, estimator);
            vtxos = payable;
            if (vtxos.length === 0) {
                // Worded to match the benign cases the vtxo_received subscription swallows.
                throw new Error(
                    "No VTXOs available to renew: every expiring VTXO is worth less than its own intent fee",
                );
            }

            const capped = capSettlementBatch(byExpiryAscending(vtxos, now), vtxoMaxAmount);
            if (vtxoMaxAmount >= 0n) {
                // Unlike count-cap overflow, a VTXO alone above the ceiling can never renew here
                // and drifts toward a unilateral exit — surface it so operators can act.
                const oversized = vtxos.filter((vtxo) => BigInt(vtxo.value) > vtxoMaxAmount);
                if (oversized.length > 0) {
                    console.warn(
                        `Renewal: ${oversized.length} VTXO(s) exceed the per-output limit ` +
                            `${vtxoMaxAmount} and cannot be renewed; they risk unilateral exit`,
                    );
                }
            }
            if (capped.length < vtxos.length) {
                // When neither cap bites, the original selection (and order) is kept untouched.
                vtxos = capped;
                if (vtxos.length === 0) {
                    // Only reachable if the server lowered the ceiling below every VTXO.
                    throw new Error(
                        `No VTXOs available to renew within the per-output limit ${vtxoMaxAmount}`,
                    );
                }
            }

            const dustAmount = getDustAmount(this.wallet);

            // Renewal pulls in recoverable VTXOs too, so rotate first as `recoverVtxos` does.
            // rotateServerSigner is serialized independently of renewalInProgress: no deadlock.
            if (info && isMigrationCapable(this.wallet)) {
                await this.rotateForRecoverableInputs(vtxos, info);
            }

            // Read AFTER any rotation above, so the output fee is priced against
            // the script the renewed VTXO actually lands on.
            const arkAddress = await this.wallet.getAddress();

            const totalAmount = deductOffchainOutputFee(
                subtotalOf(vtxos, net),
                estimator,
                arkAddress,
            );

            // Dust is judged on the NET output: a batch clearing dust gross can land under it.
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
            // Cooldown on EVERY attempt, so a transient settle failure doesn't let the next
            // vtxo_received re-enter renewal immediately.
            this.lastRenewalTimestamp = Date.now();
            this.renewalInProgress = false;
        }
    }

    // ========== Boarding Input Sweep Methods ==========

    /**
     * Get boarding inputs whose timelock has expired: they can no longer be onboarded via
     * `settle()` and must be swept back to a fresh boarding address via the unilateral exit path.
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
     * Sweep expired boarding inputs back to a fresh boarding address via the unilateral exit path:
     * one pure onchain tx (no Arkade server) spending every expired input via the CSV exit script
     * into a single boarding-address output, which restarts the timelock. Skipped if the output
     * after fees would be below dust.
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

        const feeRate = (await this.getOnchainProvider().getFeeRate()) ?? 1;

        // Representative leaf, for size estimation only: every boarding exit leaf shares one
        // template (Alice + CSV). The per-UTXO leaf is resolved in the input loop below.
        const exitTapLeafScript = this.getSweepWallet().boardingTapscript.exit();

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

        const dustAmount = getDustAmount(this.wallet);
        if (outputAmount < dustAmount) {
            throw new Error(
                `Sweep not economical: output ${outputAmount} sats after ${fee} sats fee is below dust (${dustAmount} sats)`,
            );
        }

        const tx = new Transaction();

        for (const utxo of expiredUtxos) {
            // Use the tapTree of the boarding address THIS UTXO sits on: per-derivation rotation
            // can leave unspent UTXOs at previous boarding addresses.
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

        const signedTx = await this.getSweepWallet().signOnchainBoardingTx(tx);
        signedTx.finalize();

        const txid = await this.getOnchainProvider().broadcastTransaction(signedTx.hex);

        // Prevents duplicate broadcasts on the next poll while the sweep is unconfirmed.
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
     * Status of every deprecated server signer the wallet holds funds under (VTXO and boarding,
     * merged per signer), without migrating.
     *
     * @remarks Not a pure repository/info read: boarding holdings fan out per boarding address
     * (`getCoins` round trips) and refresh the UTXO cache via `saveUtxos`.
     */
    async getDeprecatedSignerStatus(): Promise<DeprecatedSignerReport[]> {
        const wallet = this.requireMigrationCapableWallet();
        const info = await wallet.arkProvider.getInfo();
        // The refresh may trigger a rotation off the emit; let it settle so counts come from one
        // signer epoch.
        await wallet.settleServerInfoChanges?.();
        const { reports: vtxoReports } = await this.classifyDeprecatedSignerContracts(info);
        const { reports: boardingReports } = await this.classifyDeprecatedSignerBoarding(info);
        return mergeSignerReports(vtxoReports, boardingReports);
    }

    /**
     * Core migration routine shared by the manual API and the automatic poll pass; see
     * {@link IVtxoManager.migrateDeprecatedSignerVtxos}.
     */
    private async migrateCore(
        options?: MigrateDeprecatedSignerOptions,
    ): Promise<DeprecatedSignerMigrationReport> {
        const wallet = this.requireMigrationCapableWallet();
        // Read BEFORE the refresh: the reported rotation may be one the wallet's server-info
        // handler performs off the refresh, not `ensureReceiveOnActiveSigner` below.
        const signerBeforeRefresh = hex.encode(wallet.arkServerPublicKey);
        const info = await wallet.arkProvider.getInfo();
        // Drain that handler before reading anything signer-derived: mid-rotation the active
        // signer's rows are persisted while `arkServerPublicKey` is still the deprecated one, and
        // both chains would race to rotate.
        await wallet.settleServerInfoChanges?.();
        const rotatedOnRefresh = signerBeforeRefresh !== hex.encode(wallet.arkServerPublicKey);
        // Before any early exit, so settle()'s EXPIRED-input filter is consistent for this pass
        // and a pass that finds nothing deprecated still clears a stale cache.
        wallet.refreshDeprecatedSigners(info);
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);

        const walletSignerHex = hex.encode(wallet.arkServerPublicKey);
        const walletClass = classifyAgainstSignerSet(walletSignerHex, signerSet, nowSeconds);

        if (signerSet.deprecated.size === 0 && walletClass.status === "CURRENT") {
            return { rotated: rotatedOnRefresh, expired: [], signers: [] };
        }

        // Own signer neither active nor advertised deprecated: never rotate or migrate
        // automatically, but still surface holdings under other deprecated signers.
        if (walletClass.status === "UNKNOWN_SIGNER") {
            const { reports: vtxoReports } = await this.classifyDeprecatedSignerContracts(info);
            const { reports: boardingReports } = await this.classifyDeprecatedSignerBoarding(info);
            return {
                // True only if a second rotation landed inside the drain, leaving us on a signer
                // newer than `info` (a drained rotation otherwise classifies CURRENT).
                rotated: rotatedOnRefresh,
                expired: [],
                signers: mergeSignerReports(vtxoReports, boardingReports),
                skipped: "unknown-wallet-signer",
            };
        }

        // Rotate receive state onto the active signer before building the migration output, else
        // the server rejects an old-signer destination.
        const rotated = (await this.ensureReceiveOnActiveSigner(info)) || rotatedOnRefresh;

        // Classify AFTER any rotation, so the just-deprecated former receive/boarding contracts
        // are included.
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

        // Two independent legs (see MigrationLegReport), run sequentially: each acquires the
        // wallet tx lock itself.

        // VTXO leg: no settlement events.
        if (vtxoMigratable.length > 0) {
            // One chain tip shared with the send path — see {@link canMigrateBySend}.
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

        // Boarding leg: settle, so it fires settlement events.
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
     * Size and submit one migration leg: drop oversized inputs (alone above `vtxoMaxAmount`),
     * cap the rest highest-value first via {@link capSettlementBatch}, apply the dust floor, and
     * submit. A throw from `submit` lands in `error`; the caller's other leg still runs.
     *
     * Migration is fee-exempt: every input moves at full value, so the gross total IS the
     * output amount.
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
         * Inputs this leg's submit path would reject, filtered *before* sizing so they neither
         * take batch capacity nor count toward dust. Omitted by the boarding leg: settle
         * validates per-input server-side.
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
            // Attribute the skip to whichever filter emptied the set.
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
     * Classify the wallet's `default`/`delegate` contracts against the fresh signer set, splitting
     * spendable VTXOs into cooperatively-migratable and cutoff-expired sets and building the
     * per-signer report. Current-signer contracts are skipped.
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

            // Swept VTXOs follow the recovery path, not migration, so they stay OUT of the settle
            // sets but are counted on EXPIRED rows (recoverableCount) as funds in flight.
            // Exited coins belong in no bucket: `completeUnroll` is their only remedy.
            const live = vtxos.filter((v) => !v.isUnrolled);
            const recoverable = live.filter((v) => v.isSwept && !isVtxoSpent(v));
            const spendable = live.filter((v) => !isVtxoSpent(v) && !v.isSwept);

            const value = spendable.reduce((sum, v) => sum + v.value, 0);

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
                    const exp = v.expiresAt?.getTime();
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
                    // No batch expiry: the send path rejects it (see canMigrateBySend) and one
                    // such input would fail the whole leg. Still counted in the report above.
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
     * Boarding sibling of {@link classifyDeprecatedSignerContracts}, over the wallet's current and
     * historical boarding addresses. Migration eligibility is gated after discovery by
     * {@link isCooperativelyMigratable} plus a per-row CSV check — never by the fetch. Foreign-ASP
     * rows are excluded because their keys are not in the signer set.
     */
    private async classifyDeprecatedSignerBoarding(info: ArkadeInfo): Promise<{
        reports: DeprecatedSignerReport[];
        migratable: ClassifiedBoarding[];
        expired: ClassifiedBoarding[];
    }> {
        const wallet = this.requireMigrationCapableWallet();
        const signerSet = signerSetFromInfo(info);
        const nowSeconds = Math.floor(Date.now() / 1000);

        // Discovery MUST see EXPIRED-signer coins or they could never be reported; including
        // `active` lets one fetch cover both.
        const allowed = new Set<string>([signerSet.active, ...signerSet.deprecated.keys()]);

        const groups = await wallet.getBoardingUtxosForSigners(allowed);

        // Boarding-output expiry is PER GROUP: a rotation may change the boarding exit delay.
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

            // Counts CSV-expired coins too: still holdings, leaving via the unilateral sweep.
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
                    // Sweep-lifecycle fields are VTXO-only, merged in by mergeSignerReports.
                    recoverableCount: 0,
                    recoverableValue: 0,
                    awaitingSweepCount: 0,
                    awaitingSweepValue: 0,
                });
            }

            for (const coin of confirmed) {
                // Two independent gates: signer cutoff AND this row's own CSV expiry.
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
                // Migratable signer but CSV-expired: leaves via the unilateral sweep instead.
            }
        }

        return {
            reports: Array.from(reportsBySigner.values()),
            migratable,
            expired,
        };
    }

    /** Automatic poll-loop migration pass: backs off exponentially and logs rather than throws. */
    private async runMigrationPass(): Promise<void> {
        const cooldownMs = Math.min(
            VtxoManager.MIGRATION_COOLDOWN_MS * Math.pow(2, this.consecutiveMigrationFailures),
            VtxoManager.MIGRATION_MAX_BACKOFF_MS,
        );
        if (Date.now() - this.lastMigrationTimestamp < cooldownMs) return;

        try {
            const report = await this.migrateCore();
            // Legs never throw out of migrateCore; either leg's error fails the whole pass.
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
     * If the wallet's construction-time signer snapshot is deprecated, re-derive receive/boarding
     * state under the active signer so later outputs commit to the active key. Returns whether it
     * rotated; current and unknown-signer snapshots are left alone. Safe to repeat:
     * `rotateServerSigner` is idempotent and serializes against HD receive rotation.
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
        // The fresh epoch's checkpoint script, so send-path checkpoints use the active signer.
        await wallet.rotateServerSigner(hex.decode(info.signerPubkey), info.checkpointTapscript);
        return true;
    }

    /**
     * Rotation guard for recover / renew / periodic settle: pins the receive snapshot to the
     * active signer before they build their output, but ONLY when this pass carries a
     * deprecated-signer input — so a routine settle on a long-lived pre-rotation instance does
     * not eagerly rotate, so a recovered old-signer VTXO re-mints under the active key. Returns
     * whether a rotation was applied.
     */
    private async rotateForRecoverableInputs(
        inputs: { txid: string; vout: number }[],
        info: ArkadeInfo,
    ): Promise<boolean> {
        if (!isMigrationCapable(this.wallet)) return false;

        // Cheap in-memory gate before the contract scan.
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
     * Whether any input belongs to a contract whose signer is non-`CURRENT` (incl. EXPIRED).
     * Resolved via the ContractManager because the recovery paths' inputs don't expose
     * `contractScript`.
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

    private getSweepWallet(): IWallet & SweepCapableWallet {
        assertSweepCapable(this.wallet);
        return this.wallet;
    }

    private getBoardingTimelock() {
        const wallet = this.getSweepWallet();
        const exitScript = CSVMultisigTapscript.decode(
            hex.decode(wallet.boardingTapscript.exitScript),
        );
        return exitScript.params.timelock;
    }

    private getOnchainProvider() {
        return this.getSweepWallet().onchainProvider;
    }

    private getArkProvider() {
        return this.getSweepWallet().arkProvider;
    }

    /**
     * Unlike {@link getArkProvider}, doesn't require boarding-sweep capability. Undefined when no
     * provider is wired, which callers treat as "no limit".
     */
    private getInfoProvider(): ArkProvider | undefined {
        // Narrow cast, so an incompatible future IWallet.arkProvider is a type error here.
        return (this.wallet as { arkProvider?: ArkProvider }).arkProvider;
    }

    private getNetwork() {
        return this.getSweepWallet().network;
    }

    private async initializeSubscription(): Promise<(() => void) | undefined> {
        if (this.settlementConfig === false) {
            return undefined;
        }

        // Independent of contract-manager SSE setup; the delay lets the wallet finish constructing.
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
                // A watched script's outputs are not ours to renew or delegate.
                if (event.type !== "vtxo_received" || !isContractVtxoEvent(event)) {
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
                                return;
                            }
                            if (e.message.includes("is below dust threshold")) {
                                // Resolves itself as more virtual outputs are received.
                                return;
                            }
                            if (
                                e.message.includes("VTXO_ALREADY_REGISTERED") ||
                                e.message.includes("duplicated input")
                            ) {
                                // In use by a concurrent user operation; retried next cycle.
                                return;
                            }
                            if (e.message.includes("VTXO_ALREADY_SPENT")) {
                                // Stale local cache: targeted, throttled refresh, then skip.
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
     * VTXO_ALREADY_SPENT means the server is ahead of our cache (cross-instance race, snapshot
     * drift, SSE gap); swallowing it guarantees the same error next cycle.
     *
     * The delta sync filters by `created_at`, so a VTXO created before the cursor but spent
     * recently is never reconciled by `refreshVtxos()` — hence `refreshOutpoints` on the stale
     * outpoint. Throttled: the same VTXO can fire repeatedly before the upsert propagates.
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

    /** The outpoint a `VTXO_ALREADY_SPENT` error carries in `metadata.vtxo_outpoint`, if any. */
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
     * Pre-flight: refresh the candidates from the indexer ({@link IContractManager.refreshOutpoints})
     * and re-select, dropping any now known spent. The `created_at`-filtered delta sync can keep a
     * spent VTXO cached forever, and settling it is a guaranteed VTXO_ALREADY_SPENT 400.
     *
     * Best-effort: on failure, returns the original candidates and leaves the post-submit
     * `VTXO_ALREADY_SPENT` recovery to handle whatever slipped through.
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
        try {
            const refreshed = await this.selectExpiringVtxos(thresholdMs, now);
            const candidateKeys = new Set(candidates.map((v) => `${v.txid}:${v.vout}`));
            // Pre-flight must not silently expand the input set with newly surfaced VTXOs.
            return refreshed.filter((v) => candidateKeys.has(`${v.txid}:${v.vout}`));
        } catch (e) {
            console.error("Error re-selecting VTXOs after pre-validate:", e);
            return candidates;
        }
    }

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
     * Starts the poll loop (auto-settle new boarding inputs, sweep expired ones). setTimeout
     * chaining, not setInterval, so a slow poll cannot stack up and each delay can back off.
     */
    private startBoardingUtxoPoll(): void {
        if (this.settlementConfig === false) return;

        this.pollBoardingUtxos();
    }

    private schedulePoll(): void {
        if (this.disposed || this.settlementConfig === false) return;
        const delay = this.getNextPollDelay();
        this.pollTimeoutId = setTimeout(() => this.pollBoardingUtxos(), delay);
    }

    private async pollBoardingUtxos(): Promise<void> {
        if (!isSweepCapable(this.wallet)) return;
        if (this.disposed) return;
        if (this.pollInProgress) return;
        this.pollInProgress = true;

        // Awaited by dispose().
        let resolve: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        this.pollDone = { promise, resolve: resolve! };

        let hadError = false;

        try {
            // Otherwise every tab submits a parallel RegisterIntent for the same boarding input
            // and N-1 collide on the server's duplicated-input check.
            await runWithCrossInstanceLock(BOARDING_POLL_LOCK_NAME, async () => {
                const boardingUtxos = await this.wallet.getBoardingUtxos();

                // Settle, then sweep: sequential to avoid racing for the same inputs.
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

                // runMigrationPass has its own backoff and never throws, so it doesn't stack the
                // poll backoff.
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
     * Auto-settle new, unexpired boarding inputs AND near-expiry VTXOs in a single intent.
     * Skips expired boarding (swept instead) and in-flight boarding (knownBoardingUtxos); omits
     * VTXOs while the event-driven renewal runs, to avoid double-spending.
     */
    private async runPeriodicSettle(boardingUtxos: ExtendedCoin[]): Promise<void> {
        // If expiry can't be determined, bail entirely rather than settle an input sweep also
        // targets.
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

        let expiringVtxos: NormalizedExtendedVirtualCoin[] = [];
        // Fetched here rather than at the top of the method so a boarding-only pass stays offline.
        let now: TimeHeight | undefined;
        if (!this.renewalInProgress) {
            try {
                now = await fetchTimeHeight(this.wallet);
                expiringVtxos = await this.selectExpiringVtxos(undefined, now);
                expiringVtxos = await this.revalidateBeforeSettle(expiringVtxos, undefined, now);
            } catch (e) {
                // Non-fatal: fall back to boarding-only settle.
                console.error("Error fetching expiring VTXOs:", e);
            }
        }

        if (unsettledBoarding.length === 0 && expiringVtxos.length === 0) {
            return;
        }

        const cooldownMs = Math.min(
            VtxoManager.PERIODIC_SETTLE_COOLDOWN_MS *
                Math.pow(2, this.consecutivePeriodicSettleFailures),
            VtxoManager.PERIODIC_SETTLE_MAX_BACKOFF_MS,
        );
        if (Date.now() - this.lastPeriodicSettleTimestamp < cooldownMs) {
            return;
        }

        const dustAmount = getDustAmount(this.wallet);

        const info = await this.getArkProvider().getInfo();
        const { fees, vtxoMaxAmount } = info;
        const estimator = new Estimator(fees.intentFee);

        let totalAmount = 0n;

        const filteredBoarding: ExtendedCoin[] = [];
        for (const u of unsettledBoarding) {
            const inputFee = estimator.evalOnchainInput({
                amount: BigInt(u.value),
            });
            if (inputFee.satoshis >= u.value) {
                continue;
            }
            filteredBoarding.push(u);
            totalAmount += BigInt(u.value) - BigInt(inputFee.satoshis);
        }

        // Inline capSettlementBatch on NET value, over viable VTXOs only, soonest-expiring first.
        // Boarding is uncapped but counted in the running total: if boarding alone exceeds
        // vtxoMaxAmount no VTXO fits and the server rejects the output (a multi-output split,
        // out of scope, would be needed).
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
            if (vtxoMaxAmount >= 0n && totalAmount + net > vtxoMaxAmount) {
                continue;
            }
            filteredVtxos.push(v);
            totalAmount += net;
        }

        if (filteredBoarding.length === 0 && filteredVtxos.length === 0) {
            return;
        }

        // BEFORE getAddress(), and outside the renewalInProgress window below.
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

        // Block event-driven renewal so the two paths can't race on the same VTXO inputs.
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

                for (const u of filteredBoarding) {
                    this.knownBoardingUtxos.add(`${u.txid}:${u.vout}`);
                }
                success = true;
            } catch (e) {
                if (e instanceof Error && e.message.includes("VTXO_ALREADY_SPENT")) {
                    // Stale cache, not a transient failure: refresh and skip without backoff.
                    staleCacheSkip = true;
                    void this.maybeRefreshAfterVtxoSpent(this.extractSpentOutpoint(e));
                } else {
                    throw e;
                }
            }
        } finally {
            this.lastPeriodicSettleTimestamp = Date.now();
            if (includesVtxos) {
                // Bumped on failure too, as in renewVtxos().
                this.lastRenewalTimestamp = Date.now();
                this.renewalInProgress = false;
            }
            if (success) {
                this.consecutivePeriodicSettleFailures = 0;
            } else if (!staleCacheSkip) {
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
