import { collectUtxos } from "../repositories/walletRepository";
import { collectIntents } from "../repositories/intentRepository";
import { collectContracts } from "../repositories/contractRepository";
import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Bytes, equalBytes, sha256 } from "@scure/btc-signer/utils.js";
import { ArkAddress } from "../script/address";
import { DefaultVtxo } from "../script/default";
import {
    DEFAULT_ARKADE_SERVER_URL,
    Network,
    NetworkName,
    networkFromArkadeInfo,
} from "../networks";
import { ESPLORA_URL, EsploraProvider, OnchainProvider } from "../providers/onchain";
import {
    ArkadeInfo,
    ArkProvider,
    BatchFinalizationEvent,
    BatchStartedEvent,
    PendingTx,
    RestArkProvider,
    SettlementEvent,
    SignedIntent,
    TreeNoncesEvent,
    TreeSigningStartedEvent,
} from "../providers/ark";
import { SignerSession } from "../tree/signingSession";
import { buildForfeitTx } from "../forfeit";
import { validateConnectorsTxGraph, validateVtxoTxGraph } from "../tree/validation";
import {
    assertFinalCommitmentMatchesValidated,
    validateBatchRecipients,
    validateBatchRecipientsWithoutTree,
} from "./validation";
import { Identity, ReadonlyIdentity, isBatchSignable } from "../identity";
import {
    canRecoverOnchain,
    canSpendOffchain,
    fetchVtxoCreatedAtByTxid,
    getAllNormalizedVtxos,
    getNormalizedVtxos,
    isVtxoSpent,
    isPastExpiry,
    isVirtualCoin,
    normalizeVtxo,
    requiresForfeit,
    resolveTimeHeight,
    toOffchainInputFeeParams,
    type NormalizedExtendedVirtualCoin,
    type NormalizedVirtualCoin,
    type TimeHeight,
} from "./vtxo";
import {
    ArkTransaction,
    ArkadeBroadcaster,
    ArkadeReader,
    GetArkadeInfoOptions,
    Asset,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    GetSpendableVtxosFilter,
    GetNewAddressesOptions,
    IAssetManager,
    IReadonlyAssetManager,
    IReadonlyWallet,
    isSubdust,
    IWallet,
    NewAddress,
    NewAddressType,
    Outpoint,
    ReadonlyWalletConfig,
    Recipient,
    SendParams,
    SettleParams,
    TxType,
    VirtualCoin,
    WalletBalance,
    WalletConfig,
} from ".";
import { createAssetPacket, selectCoinsWithAsset, selectedCoinsToAssetInputs } from "./asset";
import { toBIP371TapTree, VtxoScript } from "../script/base";
import { CSVMultisigTapscript, RelativeTimelock } from "../script/tapscript";
import { classifyAgainstSignerSet, signerSetFromInfo, toXOnlySignerHex } from "./signerRotation";
import { assertValidBatchExpiry, resolveBatchExpiryPolicy } from "./batchExpiry";
import type { BatchExpiryPolicy } from "./batchExpiry";
import { toTimelock } from "./timelockPolicy";
import { runWalletRestoreHooks } from "./restoreHooks";
import {
    assertValidServerUnrollScript,
    resolveCheckpointExitDelayPolicy,
} from "./checkpointExitDelay";
import type { CheckpointExitDelayPolicy } from "./checkpointExitDelay";
import {
    assertAllowedSighashTypes,
    assertCheckpointsMatchInputs,
    buildOffchainTx,
    hasBoardingTxExpired,
    signAndSubmitOffchainTx,
    submitOffchainTx,
    type OffchainTxSigner,
} from "../utils/arkTransaction";
import { toXOnly } from "../utils/keys";
import { Transaction } from "../utils/transaction";
import {
    byValueDescending,
    DEFAULT_SETTLEMENT_CONFIG,
    MAX_INPUTS_PER_INTENT,
    MAX_VTXOS_PER_SETTLEMENT,
    SettlementConfig,
    VtxoManager,
    selectPendingRecoveryOutpoints,
} from "./vtxo-manager";
import { ArkNote } from "../arknote";
import { ArkadeCash } from "../arkadeCash";
import { Intent } from "../intent";
import { IndexerProvider, RestIndexerProvider } from "../providers/indexer";
import { TxTree } from "../tree/txTree";
import { WalletRepository } from "../repositories/walletRepository";
import { ContractRepository } from "../repositories/contractRepository";
import type { IntentRepository, ArkIntent, ArkIntentState } from "../repositories/intentRepository";
import { isTerminalIntentState } from "../repositories/intentRepository";
import type { VirtualTxRepository } from "../repositories/virtualTxRepository";
import { wrapHandlerWithIntentPersistence } from "./intentPersistenceHandler";
import {
    assertRecipientArkadeAddress,
    extendCoinWithTapscript,
    getDustAmount,
    isSdkPicked,
    validateRecipients,
    type RecipientArkadeAddressContext,
} from "./utils";
import {
    captureExitBranch,
    DEFAULT_EXIT_CAPTURE_MODE,
    DEFAULT_MIN_EXIT_WORTH_SATS,
    ExitCaptureMode,
    pruneExitBranches,
} from "./exit/capture";
import { createExitChainResolver, ExitDataSource } from "./exit/resolver";
import { ArkError, ProviderUnavailableError, type ProviderKind } from "../providers/errors";
import { isRetryableProviderError } from "../providers/availability";
import {
    resolveArkInfo,
    saveValidatedArkInfoSnapshot,
    type ServerInfoSource,
} from "./arkInfoSnapshot";
import { Batch } from "./batch";
import { Estimator } from "../arkfee";
import { DelegateProvider } from "../providers/delegate";
import { buildTransactionHistory } from "../utils/transactionHistory";
import { createDefaultActivityRegistry, buildActivities, type Activity } from "./activity";
import { AssetManager, ReadonlyAssetManager } from "./asset-manager";
import { Extension, type ExtensionPacket } from "../extension";
import { DelegateVtxo } from "../script/delegate";
import { DelegateManagerImpl, findDestinationOutputIndex, IDelegateManager } from "./delegate";
import { IndexedDBContractRepository, IndexedDBWalletRepository } from "../repositories";
import { ContractManager } from "../contracts/contractManager";
import type {
    ContractManagerConfig,
    ContractSyncState,
    CreateContractParams,
} from "../contracts/contractManager";
import { contractHandlers } from "../contracts/handlers";
import { BoardingContractHandler } from "../contracts/handlers/boarding";
import { timelockToSequence } from "../utils/timelock";
import { clearSyncCursor, updateWalletState } from "../utils/syncCursors";
import {
    inVtxoWriteOrder,
    validateVtxosForScript,
    saveVtxosForContract,
    vtxoOutpoint,
} from "../contracts/vtxoOwnership";
import {
    WalletReceiveRotator,
    buildReceiveContract,
    newestWalletReceiveContract,
    signingDescriptorIndex,
    strictSigningDescriptorIndex,
} from "./walletReceiveRotator";
import { HDDescriptorProvider } from "./hdDescriptorProvider";
import { DescriptorProvider } from "../identity/descriptorProvider";
import {
    AddressAllocationCapable,
    HDWalletCapable,
    WalletCannotAllocateAddressError,
    resolveDescriptorSigner,
} from "./hdWalletCapable";
import { deriveDescriptorLeafPubKey, identityDescriptor } from "../identity/descriptor";
import { WALLET_RECEIVE_SOURCE } from "../contracts/metadata";
import {
    CandidateDeps,
    Contract,
    ContractWithVtxos,
    DiscoveryDeps,
    GetContractsFilter,
    isContractVtxoEvent,
} from "../contracts/types";
import {
    gateExclusion,
    gatedContracts,
    gatedFrom,
    isContractGenericallySpendable,
    isGatedVtxo,
    type GatedContracts,
    logExcludedVtxos,
    outpointExclusion,
    type VtxoExclusion,
} from "../contracts/spendability";
import { computeOffchainBalance, toWalletBalance, type BalanceCapabilities } from "./balance";
import { InputSignerRouter, InputSigningJob } from "./inputSignerRouter";
import {
    DescriptorSigningProviderMissingError,
    MissingSigningDescriptorError,
} from "./signingErrors";

// Build per-input jobs for an intent proof. Index 0 of the proof is a
// synthetic BIP-322 toSpend reference whose witnessUtxo.script mirrors
// coin[0]'s pkScript, so we map it to the same source contract as
// coin[0]; coins 0..N-1 then map to proof inputs 1..N.
function intentProofJobs(coins: ReadonlyArray<{ tapTree: Bytes }>): InputSigningJob[] {
    if (coins.length === 0) return [];
    const coinJobs = coins.map((coin, i) => ({
        index: i + 1,
        lookupScript: VtxoScript.decode(coin.tapTree).pkScript,
    }));
    return [{ index: 0, lookupScript: coinJobs[0].lookupScript }, ...coinJobs];
}

// `send` takes either a recipient list or an options object, told apart by
// `recipients` — which no `Recipient` has and every `SendParams` does — rather
// than by "one argument", which both forms produce for a single recipient.
function asSendParams(args: [SendParams] | [Recipient, ...Recipient[]]): SendParams {
    const [first] = args;
    if (args.length === 1 && first && "recipients" in first) {
        const params = first as SendParams;
        if (params.recipients.length === 0) {
            throw new Error("At least one receiver is required");
        }
        return params;
    }
    return { recipients: args as [Recipient, ...Recipient[]] };
}

// Built-in and decorated ArkProvider implementations may expose `serverUrl`.
// The interface does not require it, so custom providers can return undefined.
export function extractArkProviderUrl(provider: ArkProvider): string | undefined {
    const serverUrl = (provider as { serverUrl?: unknown }).serverUrl;
    return typeof serverUrl === "string" && serverUrl.length > 0 ? serverUrl : undefined;
}

/**
 * Default per-side width of the HD look-ahead watch window
 * ({@link WalletConfig.lookAheadWindow}). Matches `restore()`'s default
 * `gapLimit` so both mechanisms describe the same order of reach.
 */
export const DEFAULT_LOOK_AHEAD_WINDOW = 20;

/**
 * A {@link NewAddress} plus the built tapscript (for the deprecated boarding allocator's display
 * swap) and whether an index was actually burned (so no phantom rotation is announced).
 *
 * Discriminated on `type` so the boarding branch narrows to {@link DefaultVtxo.Script};
 * {@link Wallet.mintAddress} must build each flavour in its own branch, since a ternary widens
 * the result and forces an unchecked cast where the displayed boarding script is written.
 *
 * @internal {@link Wallet.getNewAddresses} projects it down to {@link NewAddress}.
 */
type AllocatedAddress = NewAddress & { allocated: boolean } & (
        | { type: "boarding"; tapscript: DefaultVtxo.Script }
        | { type: "default"; tapscript: DefaultVtxo.Script | DelegateVtxo.Script }
    );

/**
 * Cap on HD descriptors getUsedSigningDescriptors() materializes past the watermark (bounds
 * plugin/restore probes; the watermark itself is not moved).
 */
export const MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD = 1_000;

// Historical unilateral exit delay for mainnet (~7 days in seconds).
// Kept so existing wallets can still discover and spend VTXOs sent to the
// legacy address after arkd starts advertising a different delay.
const MAINNET_UNILATERAL_EXIT_DELAY = 605184n;

function dedupeTimelocks(timelocks: RelativeTimelock[]): RelativeTimelock[] {
    const seen = new Set<string>();
    const deduped: RelativeTimelock[] = [];

    for (const timelock of timelocks) {
        const sequence = timelockToSequence(timelock).toString();
        if (seen.has(sequence)) continue;
        seen.add(sequence);
        deduped.push(timelock);
    }

    return deduped;
}

/**
 * Resolve the wallet's current boarding tapscript at boot: the boarding analogue of
 * {@link WalletReceiveRotator.resolveBoot}. Re-derives at the newest active `boarding` contract
 * tagged {@link WALLET_RECEIVE_SOURCE} so {@link Wallet.getBoardingAddress} survives restarts;
 * `baseline` when no rotated row exists. The boarding CSV is index-independent, so only the owner
 * pubkey is swapped.
 *
 * @internal Exported for unit tests; not part of the public API surface.
 */
export async function resolveBoardingBootTapscript(
    contractRepository: ContractRepository,
    serverPubKey: Bytes,
    baseline: DefaultVtxo.Script,
): Promise<DefaultVtxo.Script> {
    const candidates = await collectContracts(contractRepository, {
        type: ["boarding"],
        state: "active",
    });
    const newest = newestWalletReceiveContract(candidates, hex.encode(serverPubKey));
    if (!newest?.params.pubKey) return baseline;
    try {
        const pubKey = hex.decode(newest.params.pubKey);
        return new DefaultVtxo.Script({ ...baseline.options, pubKey });
    } catch (e) {
        // Fall back to the baseline boarding tapscript rather than fail boot,
        // but surface the corrupt row so repo corruption is detectable.
        console.warn("Skipping malformed boarding contract at boot", newest.script, e);
        return baseline;
    }
}

export type IncomingFunds =
    | {
          type: "utxo";
          coins: Coin[];
      }
    | {
          type: "vtxo";
          newVtxos: ExtendedVirtualCoin[];
          spentVtxos: ExtendedVirtualCoin[];
      };

interface HasToReadonly {
    toReadonly(): Promise<ReadonlyIdentity>;
}

function hasToReadonly(identity: unknown): identity is HasToReadonly {
    return (
        typeof identity === "object" &&
        identity !== null &&
        "toReadonly" in identity &&
        typeof (identity as any).toReadonly === "function"
    );
}

export { DescriptorSigningProviderMissingError, MissingSigningDescriptorError };

/**
 * Apply {@link GetVtxosFilter} to a contract snapshot; the single definition shared by `getVtxos`
 * and {@link IReadonlyWallet.getSpendableVtxos}. No chain tip (offline-first), so height-encoded
 * expiry reads as not expired.
 */
export function filterSnapshotVtxos(
    snapshot: readonly ContractWithVtxos[],
    filter: GetVtxosFilter | undefined,
    pendingSpendOutpoints: ReadonlySet<string>,
): NormalizedExtendedVirtualCoin[] {
    const f = filter ?? { withRecoverable: true, withUnrolled: false };
    const now = { timestamp: new Date() };
    return snapshot
        .flatMap((_) => _.vtxos)
        .filter((vtxo) => {
            if (pendingSpendOutpoints.has(`${vtxo.txid}:${vtxo.vout}`)) {
                return false;
            }
            // Location before spend: `withUnrolled` is authoritative for an exited coin, even
            // an unrolled-and-spent one.
            if (vtxo.isUnrolled) {
                return !!f.withUnrolled;
            }
            if (isVtxoSpent(vtxo)) {
                return false;
            }
            if (!f.withRecoverable && canRecoverOnchain(vtxo, now)) {
                return false;
            }
            return true;
        });
}

/**
 * Refresh the swept state of settle inputs already past their batch expiry. The delta sync windows
 * on `created_at`, so it never revisits a coin the operator swept after the cursor passed it, and a
 * stale `isSwept: false` makes {@link requiresForfeit} build a forfeit the operator allocated no
 * connector for. Fails closed: a swept state that cannot be confirmed aborts the settlement, since
 * guessing the obligation fails mid-batch and can get the input's script convicted.
 */
async function refreshSweptStateOfExpiredInputs(
    wallet: Pick<ReadonlyWallet, "getContractManager" | "getVtxos" | "onchainProvider">,
    inputs: ExtendedCoin[],
): Promise<ExtendedCoin[]> {
    const candidates = inputs
        .filter(isVirtualCoin)
        .map(normalizeVtxo)
        .filter((v) => !v.isSwept);
    if (candidates.length === 0) return inputs;

    // Only a height-encoded expiry needs the tip, so time-based networks make no call.
    const now = candidates.some((v) => v.expiresAtHeight !== undefined)
        ? await resolveTimeHeight(wallet.onchainProvider)
        : { timestamp: new Date() };
    // An unknown tip must not exempt a height-expiring coin; a needless refresh is harmless.
    const suspects = candidates.filter(
        (v) =>
            isPastExpiry(v, now) || (v.expiresAtHeight !== undefined && now.height === undefined),
    );
    if (suspects.length === 0) return inputs;

    let sweptNow: Set<string>;
    try {
        const manager = await wallet.getContractManager();
        await manager.refreshOutpoints(suspects.map(({ txid, vout }) => ({ txid, vout })));
        const suspectKeys = new Set(suspects.map((v) => `${v.txid}:${v.vout}`));
        const fresh = await wallet.getVtxos({ withRecoverable: true });
        sweptNow = new Set(
            fresh
                .filter((v) => v.isSwept && suspectKeys.has(`${v.txid}:${v.vout}`))
                .map((v) => `${v.txid}:${v.vout}`),
        );
    } catch (e) {
        const message =
            "could not confirm the swept state of expired settlement inputs; retry the settlement";
        throw isRetryableProviderError(e)
            ? new ProviderUnavailableError(message, { cause: e })
            : new Error(message, { cause: e });
    }

    if (sweptNow.size === 0) return inputs;
    return inputs.map((input) => {
        if (!isVirtualCoin(input) || !sweptNow.has(`${input.txid}:${input.vout}`)) return input;
        return { ...normalizeVtxo(input), isSwept: true };
    });
}

/**
 * Shared by the two places a past-cutoff signer excludes a VTXO: the
 * outpoint-level `pendingRecovery` set and the script-level check
 * {@link ReadonlyWallet.logUngatedInputs} can afford.
 */
const PENDING_RECOVERY_REASON =
    "is past its operator signer's rotation cutoff — the operator will not co-sign it until it recovers";

/**
 * Reported from the raw snapshot, not via the other exclusions: {@link filterSnapshotVtxos}
 * removes unrolled coins first, so an exclusion there could never match.
 */
const UNROLLED_REASON =
    "was unilaterally exited and lives onchain — `Unroll.completeUnroll` is the only spend that reaches it";

/**
 * Structural rather than {@link ContractWithVtxos} so the worker's repository-built snapshot
 * (VTXOs without `contractScript`) classifies without a parallel array.
 */
type PendingRecoverySnapshot = Parameters<typeof selectPendingRecoveryOutpoints>[0];

/** The outpoints in `before` that `after` dropped. */
function omittedOutpoints(
    before: readonly { txid: string; vout: number }[],
    after: readonly { txid: string; vout: number }[],
): Set<string> {
    if (before.length === after.length) return new Set();
    const kept = new Set(after.map((vtxo) => `${vtxo.txid}:${vtxo.vout}`));
    return new Set(
        before.map((vtxo) => `${vtxo.txid}:${vtxo.vout}`).filter((outpoint) => !kept.has(outpoint)),
    );
}

/** `txid:vout` of each coin input, VTXO or boarding; an arknote string has none. */
function coinKeys(inputs: readonly ExtendedCoin[]): string[] {
    return inputs
        .filter((input) => typeof input === "object" && input !== null)
        .map((input) => `${input.txid}:${input.vout}`);
}

/** Drop VTXOs whose outpoint is locked by a non-terminal intent; same array when none is. */
export function excludeLockedOutpoints<T extends { txid: string; vout: number }>(
    vtxos: T[],
    locked: { txid: string; vout: number }[],
): T[] {
    if (locked.length === 0) return vtxos;
    const lockedKeys = new Set(locked.map((o) => `${o.txid}:${o.vout}`));
    return vtxos.filter((v) => !lockedKeys.has(`${v.txid}:${v.vout}`));
}

/**
 * `vtxos` minus outpoints locked by a non-terminal settlement intent. Reads only the intent
 * store, and **fails open** if that read rejects: a broken store must not sink the whole balance,
 * at the cost of a locked VTXO briefly showing as spendable.
 */
export async function spendableVtxosExcludingLocked<T extends { txid: string; vout: number }>(
    vtxos: T[],
    intentRepository?: Pick<IntentRepository, "getLockedVtxoOutpoints">,
): Promise<T[]> {
    if (!intentRepository) return vtxos;
    let locked: Outpoint[];
    try {
        locked = await intentRepository.getLockedVtxoOutpoints();
    } catch (e) {
        console.error("getLockedVtxoOutpoints failed; reporting unfiltered balance", e);
        return vtxos;
    }
    return excludeLockedOutpoints(vtxos, locked);
}

/**
 * Boarding UTXOs grouped by boarding address, with that address's signer. A flat
 * {@link ExtendedCoin} can't carry it: it keeps only the encoded leaves, not the owning script's
 * `serverPubKey` or CSV delay, which deprecated-signer classification needs.
 */
export interface BoardingUtxoGroup {
    /** Tapscript of the boarding address the coins sit on. */
    tapscript: DefaultVtxo.Script;
    /** Server key of that address, normalized x-only hex. */
    serverPubKey: string;
    /** CSV exit timelock decoded from THIS tapscript's exit leaf. */
    csvTimelock: RelativeTimelock;
    coins: ExtendedCoin[];
}

/**
 * Why a VTXO at an arkadeCash address could not be swept by {@link Wallet.claimCash}.
 *
 * - `swept` — the server swept the batch at expiry. Recoverable in principle,
 *   but only through a settlement, which the thin sweep cannot do.
 * - `subdust` — below dust, so it sits at an OP_RETURN script with no spendable
 *   leaf. Unspendable as cash; `createCash` prevents minting these.
 * - `already-spent` — someone else claimed it first.
 * - `exited` — unilaterally exited onchain, so the offchain sweep cannot reach it;
 *   `Unroll.completeUnroll` is the remedy.
 * - `has-assets` — asset-bearing; the BTC-only sweep would burn the assets.
 * - `sweep-failed` — spendable, but its own sweep was rejected.
 */
export type ArkadeCashUnclaimedReason =
    | "swept"
    | "subdust"
    | "already-spent"
    | "exited"
    | "has-assets"
    | "sweep-failed";

const cashReport = (
    vtxo: VirtualCoin,
    reason: ArkadeCashUnclaimedReason,
): ArkadeCashUnclaimedVtxo => ({
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    reason,
});

/** A VTXO {@link Wallet.claimCash} left behind, with the reason why. */
export interface ArkadeCashUnclaimedVtxo {
    txid: string;
    vout: number;
    /** Value in satoshis. */
    value: number;
    reason: ArkadeCashUnclaimedReason;
}

/**
 * Outcome of {@link Wallet.claimCash}: what was swept, and what was not.
 *
 * The shape is open — further buckets may be added alongside `unclaimed` as
 * more of the non-sweepable states become claimable.
 */
export interface ArkadeCashClaimResult {
    /** Satoshis swept to this wallet. */
    swept: number;
    unclaimed: {
        /** Satoshis left behind. */
        amount: number;
        vtxos: ArkadeCashUnclaimedVtxo[];
    };
}

/**
 * Thrown when {@link Wallet.createCash}'s `send` fails after the transaction may already have been
 * submitted. `cash` carries the private key of the funded output: discard it and the sats may be
 * stranded. Persist it; {@link Wallet.claimCash} recovers the funds whether or not the send landed.
 */
export class ArkadeCashCreateError extends Error {
    constructor(
        /** The encoded arkadeCash token controlling the funded output. */
        readonly cash: string,
        /** The original failure from `send`. */
        readonly cause: unknown,
    ) {
        super(
            `Failed to create ArkadeCash: send failed after the note may have been submitted. ` +
                `Recover with claimCash using the token on this error's \`cash\` field.`,
        );
        this.name = "ArkadeCashCreateError";
    }
}

/**
 * Freshness of provider-backed sync (server-info source + indexer-sync health). Balances/VTXOs
 * are always served from the repository regardless.
 */
export type ProviderConnectionState =
    | { mode: "online"; source: "live"; lastOnlineAt: number }
    | {
          mode: "degraded";
          source: "cache" | "repository";
          provider: ProviderKind;
          reason: string;
          lastOnlineAt?: number;
      };

export class ReadonlyWallet implements IReadonlyWallet {
    private _contractManager?: ContractManager;
    private _contractManagerInitializing?: Promise<ContractManager>;
    protected readonly watcherConfig?: ReadonlyWalletConfig["watcherConfig"];

    /** Opt-in intent-lifecycle repository; `undefined` ⇒ intent persistence is a no-op. */
    public intentRepository?: IntentRepository;
    /**
     * **Experimental / inert.** Opt-in virtual-tx repository, exposed so callers can pass it to
     * {@link Unroll.Session.create} as a best-effort raw-tx cache. Normal sync never writes it.
     */
    public virtualTxRepository?: VirtualTxRepository;
    /** Opt-in exit-data capture settings; see {@link StorageConfig.exitDataCapture}. */
    public exitDataCapture?: {
        mode?: ExitCaptureMode;
        minExitWorthSats?: number;
        sources?: ExitDataSource[];
    };
    private readonly _assetManager: IReadonlyAssetManager;
    readonly walletContractTimelocks: RelativeTimelock[];
    // Outpoints committed to an in-flight settle/send, filtered from getVtxos() so concurrent
    // callers can't reselect them. In-memory only: a stale entry only hides a VTXO.
    protected _pendingSpendOutpoints = new Set<string>();
    protected _heldOutpoints = new Set<string>();

    /** Activity resolvers consumed by {@link getActivityHistory}. */
    readonly activity = createDefaultActivityRegistry();

    get assetManager(): IReadonlyAssetManager {
        return this._assetManager;
    }

    /**
     * Active receive tapscript; written only by {@link Wallet.setOffchainTapscriptForRotation}
     * (sole intended caller: {@link WalletReceiveRotator.rotate}).
     */
    protected _offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;

    /**
     * Current boarding tapscript (QR / onboarding target); written only by
     * {@link Wallet.setBoardingTapscriptForRotation}. Static / `auto` wallets never rotate it.
     */
    protected _boardingTapscript: DefaultVtxo.Script;

    /**
     * Active server signer (x-only); written only by
     * {@link Wallet.setArkServerPublicKeyForRotation} when arkd rotates its signer mid-session.
     */
    protected _arkServerPublicKey: Bytes;

    /**
     * Whether the LATEST server-info resolution was live or fell back to the cached snapshot.
     * Updated on every {@link getArkadeInfo} read so recovery (or a fresh fallback) is reflected.
     */
    protected _serverInfoSource: ServerInfoSource = "live";

    /**
     * Epoch-ms of the last live operator contact, or the cached snapshot's `savedAt` when the
     * latest resolution fell back.
     */
    protected _serverInfoLastOnlineAt?: number;

    /** @see {@link _serverInfoSource} */
    get serverInfoSource(): ServerInfoSource {
        return this._serverInfoSource;
    }

    /**
     * Composed provider-connection freshness: degraded on `arkade` (`cache`) when the latest
     * server-info resolution fell back, else degraded on `indexer` (`repository`) when an
     * initialized contract manager has, else online. Never forces a `ContractManager` to
     * construct, so it is safe for readonly callers.
     */
    getProviderConnectionState(): ProviderConnectionState {
        if (this._serverInfoSource === "cache") {
            return {
                mode: "degraded",
                source: "cache",
                provider: "arkade",
                reason: "constructed from cached server-info; operator was unreachable at boot",
                lastOnlineAt: this._serverInfoLastOnlineAt,
            };
        }
        const sync = this._contractManager?.getSyncState();
        if (sync?.mode === "degraded") {
            return {
                mode: "degraded",
                source: "repository",
                provider: "indexer",
                reason: sync.reason,
                lastOnlineAt: sync.lastSyncedAt ?? this._serverInfoLastOnlineAt,
            };
        }
        return {
            mode: "online",
            source: "live",
            lastOnlineAt: sync?.lastSyncedAt ?? this._serverInfoLastOnlineAt ?? 0,
        };
    }

    /**
     * The contract manager's sync health **without initializing it** (`online` if none exists),
     * so unlike {@link getContractManager} it never triggers a remote sync.
     */
    getContractSyncState(): ContractSyncState {
        return this._contractManager?.getSyncState() ?? { mode: "online" };
    }

    protected constructor(
        readonly identity: ReadonlyIdentity,
        readonly network: Network,
        readonly onchainProvider: OnchainProvider,
        /** Narrowed so a readonly wallet can't grow a `submitTx` use; `Wallet` re-widens it. */
        protected readonly arkProvider: Pick<ArkProvider, "getInfo">,
        readonly indexerProvider: IndexerProvider,
        arkServerPublicKey: Bytes,
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        boardingTapscript: DefaultVtxo.Script,
        readonly dustAmount: bigint,
        public readonly walletRepository: WalletRepository,
        public readonly contractRepository: ContractRepository,
        readonly delegateProvider?: DelegateProvider,
        watcherConfig?: ReadonlyWalletConfig["watcherConfig"],
        walletContractTimelocks?: RelativeTimelock[],
    ) {
        // Duplicates setupWalletConfig()'s network-mismatch check for callers bypassing create().
        if ("descriptor" in identity) {
            const descriptor = identity.descriptor as string;
            const identityIsMainnet = !descriptor.includes("tpub");
            const serverIsMainnet = network.bech32 === "bc";
            if (identityIsMainnet !== serverIsMainnet) {
                throw new Error(
                    `Network mismatch: identity uses ${identityIsMainnet ? "mainnet" : "testnet"} derivation ` +
                        `but wallet network is ${serverIsMainnet ? "mainnet" : "testnet"}. ` +
                        `Create identity with { isMainnet: ${serverIsMainnet} } to match.`,
                );
            }
        }
        this._offchainTapscript = offchainTapscript;
        this._boardingTapscript = boardingTapscript;
        this._arkServerPublicKey = arkServerPublicKey;
        this.watcherConfig = watcherConfig;
        this._assetManager = new ReadonlyAssetManager(this.indexerProvider);
        // Defensive for direct-construction callers; setupWalletConfig already
        // passes a deduped list through the public create() factories.
        this.walletContractTimelocks =
            walletContractTimelocks && walletContractTimelocks.length > 0
                ? dedupeTimelocks(walletContractTimelocks)
                : [this.offchainTapscript.options.csvTimelock];
    }

    /**
     * x-only hex → cutoff of the operator's deprecated signers, cached for OFFLINE read/watch.
     * Boarding watch/history fan out over {current} ∪ this set so deposits at addresses minted
     * under a rotated signer stay watched. Deliberately NOT used by the spend path:
     * {@link getBoardingUtxos} stays current-signer-only (a deprecated-signer input in a plain
     * settle() is rejected; recovery goes through the migration API).
     */
    protected _deprecatedSigners: Map<string, bigint> = new Map();

    /**
     * Refresh the cached deprecated-signer set from server info; feeds
     * {@link pendingRecoveryOutpoints}. Lenient: a malformed entry is skipped, never fatal.
     */
    refreshDeprecatedSigners(info: {
        deprecatedSigners?: readonly { pubkey?: string; cutoffDate?: bigint }[];
    }): void {
        const next = new Map<string, bigint>();
        for (const s of info.deprecatedSigners ?? []) {
            if (!s.pubkey) continue;
            try {
                // `0n` is arkd's sentinel for "no cutoff advertised" (→ DUE_NOW); a positive
                // cutoff that has already passed is EXPIRED.
                next.set(toXOnlySignerHex(s.pubkey), s.cutoffDate ?? 0n);
            } catch (e) {
                console.warn("Skipping malformed deprecated signer pubkey", s.pubkey, e);
            }
        }
        this._deprecatedSigners = next;
    }

    /** Boarding WATCH/HISTORY signer set: current ∪ deprecated (spend stays current-only). */
    protected watchedBoardingSigners(): Set<string> {
        return new Set([
            toXOnlySignerHex(hex.encode(this.boardingTapscript.options.serverPubKey)),
            ...this._deprecatedSigners.keys(),
        ]);
    }

    /**
     * `serverPubKey` defaults to the live key; spend paths that snapshot it
     * against mid-flight rotation pass their snapshot, so the check reads from
     * one rotation epoch.
     */
    protected recipientAddressContext(
        serverPubKey: Bytes = this._arkServerPublicKey,
    ): RecipientArkadeAddressContext {
        return {
            hrp: this.network.hrp,
            signerSet: {
                active: toXOnlySignerHex(hex.encode(serverPubKey)),
                deprecated: this._deprecatedSigners,
            },
        };
    }

    /** Currently-active receive tapscript; changes only on receive rotation. */
    get offchainTapscript(): DefaultVtxo.Script | DelegateVtxo.Script {
        return this._offchainTapscript;
    }

    /** Current active server signer (x-only, 32 bytes); changes only on server-signer rotation. */
    get arkServerPublicKey(): Bytes {
        return this._arkServerPublicKey;
    }

    /**
     * Server info for the connected Arkade server: live wins, a retryable failure falls back to
     * the boot snapshot, a terminal one propagates. Live because `signerPubkey`,
     * `checkpointTapscript` and `fees` move on rotation, and a covenant built against a
     * superseded signer is unspendable.
     *
     * @remarks Reading does NOT re-pin the wallet ({@link arkServerPublicKey}, {@link dustAmount},
     * tapscripts), so inside a rotation window this can report epoch N+1 while the wallet spends
     * on N; the provider's `onServerInfoChanged` closes the window. Pass `{ requireLive: true }`
     * before binding the answer into a covenant to fail closed instead of getting the snapshot.
     *
     * @returns The Arkade server's info
     * @see ArkadeInfo
     */
    async getArkadeInfo(opts?: GetArkadeInfoOptions): Promise<ArkadeInfo> {
        const { info, source, lastOnlineAt } = await resolveArkInfo(
            this.arkProvider,
            this.walletRepository,
            opts,
        );
        // Track the LATEST resolution, which also makes fail-closed expressible: read, then check.
        this._serverInfoSource = source;
        if (source === "live") {
            this._serverInfoLastOnlineAt = Date.now();
        } else if (lastOnlineAt !== undefined) {
            this._serverInfoLastOnlineAt = lastOnlineAt;
        }
        return info;
    }

    /**
     * Chain reads against this wallet's server for scripts it does not own, bound to the wallet's
     * own (possibly Expo/injected) `indexerProvider`. `getVtxos` normalizes via
     * {@link getNormalizedVtxos}. A bound object, not the provider, so an `IReadonlyWallet`
     * holder gets these two reads and nothing else.
     */
    async getArkadeReader(): Promise<ArkadeReader> {
        const indexer = this.indexerProvider;
        return {
            getVtxos: (opts) => getNormalizedVtxos(indexer, opts),
            getVirtualTxs: (txids, opts) => indexer.getVirtualTxs(txids, opts),
        };
    }

    /**
     * Current boarding tapscript (on-chain onboarding target); changes only when a fresh boarding
     * address is explicitly allocated.
     */
    get boardingTapscript(): DefaultVtxo.Script {
        return this._boardingTapscript;
    }

    /**
     * Fired after boarding rotation so a live {@link notifyIncomingFunds} watcher re-subscribes
     * to the fresh address in-session instead of missing deposits until its next re-init.
     */
    private readonly _boardingRotationListeners = new Set<() => void>();

    /** Register a listener invoked synchronously after each boarding rotation. */
    protected onBoardingRotation(listener: () => void): () => void {
        this._boardingRotationListeners.add(listener);
        return () => {
            this._boardingRotationListeners.delete(listener);
        };
    }

    /** A throwing listener is isolated: it can't break the rotation or starve siblings. */
    protected notifyBoardingRotation(): void {
        for (const listener of this._boardingRotationListeners) {
            try {
                listener();
            } catch (e) {
                console.warn("Boarding-rotation listener failed", e);
            }
        }
    }

    /** Shared setup for ReadonlyWallet.create() and Wallet.create(). */
    protected static async setupWalletConfig(config: ReadonlyWalletConfig, pubKey: Uint8Array) {
        const arkProvider = config.arkProvider || new RestArkProvider();
        let indexerProvider = config.indexerProvider;
        if (!indexerProvider) {
            const derived = extractArkProviderUrl(arkProvider);
            // Refuse to pair a caller's own ark provider with the public default: the wallet would
            // read its VTXOs from a server that has never seen them, and report phantom coins and
            // missed receipts rather than an error.
            if (!derived && config.arkProvider) {
                throw new Error(
                    "indexerProvider is required when arkProvider is provided without a discoverable serverUrl",
                );
            }
            indexerProvider = new RestIndexerProvider(derived ?? DEFAULT_ARKADE_SERVER_URL);
        }

        // Repositories BEFORE the first server-info fetch, so boot can fall back to the cached
        // snapshot when the operator is unreachable.
        const walletRepository =
            config.storage?.walletRepository ?? new IndexedDBWalletRepository();

        const contractRepository =
            config.storage?.contractRepository ?? new IndexedDBContractRepository();

        // The cache is NOT written here but after construction validates the response
        // (saveValidatedArkInfoSnapshot in create()), so a bad live response can't poison it.
        const {
            info,
            source: serverInfoSource,
            lastOnlineAt: serverInfoLastOnlineAt,
        } = await resolveArkInfo(arkProvider, walletRepository);

        const network = networkFromArkadeInfo(info);

        // Identity/server network mismatch means wrong derivation path → wrong keys → fund loss.
        if ("descriptor" in config.identity) {
            const descriptor = config.identity.descriptor as string;
            const identityIsMainnet = !descriptor.includes("tpub");
            const serverIsMainnet = info.network === "bitcoin";
            if (identityIsMainnet && !serverIsMainnet) {
                throw new Error(
                    `Network mismatch: identity uses mainnet derivation (coin type 0) ` +
                        `but the Arkade server is on ${info.network}. ` +
                        `Create identity with { isMainnet: false } to use testnet derivation.`,
                );
            }
            if (!identityIsMainnet && serverIsMainnet) {
                throw new Error(
                    `Network mismatch: identity uses testnet derivation (coin type 1) ` +
                        `but the Arkade server is on mainnet. ` +
                        `Create identity with { isMainnet: true } or omit isMainnet (defaults to mainnet).`,
                );
            }
        }

        const onchainProvider =
            config.onchainProvider || new EsploraProvider(ESPLORA_URL[info.network as NetworkName]);

        if (config.exitTimelock) {
            const { value, type } = config.exitTimelock;
            if ((value < 512n && type !== "blocks") || (value >= 512n && type !== "seconds")) {
                throw new Error("invalid exitTimelock");
            }
        }

        const arkdExitTimelock = toTimelock(info.unilateralExitDelay);

        const exitTimelock: RelativeTimelock = config.exitTimelock ?? arkdExitTimelock;

        const walletContractTimelocks = config.exitTimelock
            ? [exitTimelock]
            : dedupeTimelocks([
                  arkdExitTimelock,
                  ...(info.network === "bitcoin"
                      ? [toTimelock(MAINNET_UNILATERAL_EXIT_DELAY)]
                      : []),
              ]);

        if (config.boardingTimelock) {
            const { value, type } = config.boardingTimelock;
            if ((value < 512n && type !== "blocks") || (value >= 512n && type !== "seconds")) {
                throw new Error("invalid boardingTimelock");
            }
        }

        const boardingTimelock: RelativeTimelock =
            config.boardingTimelock ?? toTimelock(info.boardingExitDelay);

        const serverPubKey = toXOnly(hex.decode(info.signerPubkey), "ark signer key");

        const delegatePubKey = config.delegateProvider
            ? await config.delegateProvider
                  .getDelegateInfo()
                  .then((info) => toXOnly(hex.decode(info.pubkey), "delegate key"))
                  .catch(() => undefined)
            : undefined;

        const offchainOptions = {
            pubKey,
            serverPubKey,
            csvTimelock: exitTimelock,
        };
        const offchainTapscript = !delegatePubKey
            ? new DefaultVtxo.Script(offchainOptions)
            : new DelegateVtxo.Script({ ...offchainOptions, delegatePubKey });
        // Via the `boarding` handler so this matches the `boarding` contract the contract manager
        // later persists from the same params.
        const boardingTapscript = BoardingContractHandler.createScript({
            pubKey: hex.encode(pubKey),
            serverPubKey: hex.encode(serverPubKey),
            csvTimelock: timelockToSequence(boardingTimelock).toString(),
        });

        return {
            arkProvider,
            indexerProvider,
            onchainProvider,
            network,
            networkName: info.network as NetworkName,
            serverPubKey,
            offchainTapscript,
            boardingTapscript,
            dustAmount: info.dust,
            walletRepository,
            contractRepository,
            info,
            serverInfoSource,
            serverInfoLastOnlineAt,
            delegateProvider: config.delegateProvider,
            walletContractTimelocks,
        };
    }

    /**
     * Create a readonly wallet for querying balances, addresses, and history.
     *
     * @param config - Readonly wallet configuration
     * @returns A readonly wallet instance
     */
    static async create(config: ReadonlyWalletConfig): Promise<ReadonlyWallet> {
        const pubkey = await config.identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        const setup = await ReadonlyWallet.setupWalletConfig(config, pubkey);

        const wallet = new ReadonlyWallet(
            config.identity,
            setup.network,
            setup.onchainProvider,
            setup.arkProvider,
            setup.indexerProvider,
            setup.serverPubKey,
            setup.offchainTapscript,
            setup.boardingTapscript,
            setup.dustAmount,
            setup.walletRepository,
            setup.contractRepository,
            setup.delegateProvider,
            config.watcherConfig,
            setup.walletContractTimelocks,
        );
        wallet.intentRepository = config.storage?.intentRepository;
        wallet.virtualTxRepository = config.storage?.virtualTxRepository;
        wallet.exitDataCapture = config.storage?.exitDataCapture;
        wallet._serverInfoSource = setup.serverInfoSource;
        // Construction validated the live response (network, signer, address
        // params); only now is it safe to refresh the cached snapshot.
        if (setup.serverInfoSource === "live") {
            const now = Date.now();
            await saveValidatedArkInfoSnapshot(setup.walletRepository, setup.info, now);
            wallet._serverInfoLastOnlineAt = now;
        } else {
            wallet._serverInfoLastOnlineAt = setup.serverInfoLastOnlineAt;
        }
        wallet.refreshDeprecatedSigners(setup.info);
        return wallet;
    }

    get arkAddress(): ArkAddress {
        return this.offchainTapscript.address(this.network.hrp, this.arkServerPublicKey);
    }

    /**
     * Get the pkScript hex for the wallet's primary offchain address.
     * For the full wallet-owned script set registered in ContractManager, use getWalletScripts().
     */
    get defaultContractScript(): string {
        return hex.encode(this.offchainTapscript.pkScript);
    }

    /** Returns the wallet's Arkade address. */
    async getAddress(): Promise<string> {
        return this.arkAddress.encode();
    }

    /** Returns the onchain boarding address used to move funds into Arkade. */
    async getBoardingAddress(): Promise<string> {
        return this.boardingTapscript.onchainAddress(this.network);
    }

    /**
     * Return the wallet's combined onchain and offchain balances.
     */
    async getBalance(): Promise<WalletBalance> {
        const [boardingUtxos, snapshot] = await Promise.all([
            this.getBoardingUtxos(),
            // The bucketer drops every spent coin and the gate reads contracts only.
            this.contractSnapshot(undefined, { unspentOnly: true }),
        ]);
        // Explicit, not the default filter: the default drops unrolled coins,
        // and `computeOffchainBalance` cannot report a bucket it never sees.
        const vtxos = filterSnapshotVtxos(
            snapshot,
            { withRecoverable: true, withUnrolled: true },
            this._pendingSpendOutpoints,
        );

        // `settled`/`preconfirmed`/`total` and the `assets` rollup count every VTXO
        // the wallet owns, including escrowed and intent-locked ones; `available`
        // and `availableAssets` count only what generic spending would pick, so
        // nothing reported as available can be refused by `send`.
        const offchain = computeOffchainBalance(
            vtxos,
            await this.balanceCapabilities(snapshot, vtxos),
        );

        return toWalletBalance(boardingUtxos, offchain);
    }

    /**
     * Return virtual outputs tracked by the wallet, including escrowed, locked and
     * awaiting-recovery funds. Coin selection must use {@link getSpendableVtxos}: feeding this
     * into `settle({ inputs })` or `send({ selectedVtxos })` bypasses the generic-spending gate.
     *
     * @param filter - Optional flags controlling whether recoverable or unrolled VTXOs are included
     */
    async getVtxos(filter?: GetVtxosFilter): Promise<NormalizedExtendedVirtualCoin[]> {
        return filterSnapshotVtxos(
            // Only an unrolled coin is returned spent, so no other read needs spent rows.
            await this.contractSnapshot(undefined, { unspentOnly: !filter?.withUnrolled }),
            filter,
            this._pendingSpendOutpoints,
        );
    }

    /** @inheritdoc */
    async getSpendableVtxos(
        filter?: GetSpendableVtxosFilter,
    ): Promise<NormalizedExtendedVirtualCoin[]> {
        const snapshot = await this.contractSnapshot(filter, {
            unspentOnly: !filter?.withUnrolled,
        });
        const vtxos = filterSnapshotVtxos(snapshot, filter, this._pendingSpendOutpoints);
        const { gated, pendingRecovery } = this.spendabilityView(snapshot);
        const selectable = vtxos.filter(
            (vtxo) =>
                !isGatedVtxo(vtxo, gated) &&
                !pendingRecovery.has(`${vtxo.txid}:${vtxo.vout}`) &&
                !this._heldOutpoints.has(`${vtxo.txid}:${vtxo.vout}`),
        );
        const unlocked = await spendableVtxosExcludingLocked(selectable, this.intentRepository);
        logExcludedVtxos("getSpendableVtxos", vtxos, [
            gateExclusion(gated),
            outpointExclusion(pendingRecovery, PENDING_RECOVERY_REASON),
            outpointExclusion(this._heldOutpoints, "is held by reserveVtxos"),
            outpointExclusion(
                omittedOutpoints(selectable, unlocked),
                "is locked by an in-flight settlement intent",
            ),
        ]);
        // Separate call: widening the set above to the raw snapshot would report every
        // terminally-spent coin under a gated contract as gated. A completed unroll stays out.
        if (!filter?.withUnrolled) {
            logExcludedVtxos(
                "getSpendableVtxos",
                snapshot
                    .flatMap((contract) => contract.vtxos)
                    .filter((vtxo) => vtxo.isUnrolled && !isVtxoSpent(vtxo)),
                [() => UNROLLED_REASON],
            );
        }
        return unlocked;
    }

    /**
     * Debug-log any explicit input generic selection would have excluded. Explicit-input APIs stay
     * ungated on purpose (naming an outpoint *is* the intent, and is how an escrowed deposit is
     * recovered), so this only makes the crossing visible — notably
     * `settle({ inputs: await wallet.getVtxos() })`. Never throws. Public for worker and plugins.
     */
    async logUngatedInputs(
        source: string,
        inputs: readonly { txid: string; vout: number; script?: string }[],
    ): Promise<void> {
        try {
            // Pure repository reads so this can't slow or fail a spend (hence not
            // `spendabilityView`, whose snapshot syncs).
            const manager = await this.getContractManager();
            const contracts = await manager.getContracts();
            const locked = await this.lockedOutpoints();
            logExcludedVtxos(source, inputs, [
                gateExclusion(gatedContracts(contracts)),
                this.expiredSignerExclusion(contracts),
                outpointExclusion(locked, "is locked by an in-flight settlement intent"),
            ]);
        } catch {
            // diagnostics only
        }
    }

    /**
     * Past-cutoff-signer contracts as a script-level exclusion: the `pendingRecovery` answer for a
     * caller-supplied input without a synced snapshot (a swept outpoint is unspendable anyway).
     */
    private expiredSignerExclusion(contracts: readonly Contract[]): VtxoExclusion {
        if (this._deprecatedSigners.size === 0) return () => undefined;
        const signerSet = {
            active: toXOnlySignerHex(hex.encode(this.offchainTapscript.options.serverPubKey)),
            deprecated: this._deprecatedSigners,
        };
        const expired = new Set(
            contracts
                .filter((contract) => {
                    const serverPubKey = contract.params.serverPubKey;
                    if (typeof serverPubKey !== "string") return false;
                    try {
                        return (
                            classifyAgainstSignerSet(serverPubKey, signerSet).status === "EXPIRED"
                        );
                    } catch {
                        // One malformed row must not suppress every other input's diagnostics.
                        return false;
                    }
                })
                .map((contract) => contract.script),
        );
        return (vtxo) =>
            vtxo.script !== undefined && expired.has(vtxo.script)
                ? PENDING_RECOVERY_REASON
                : undefined;
    }

    /** The intent store's lock set. Fails open, like every other read of it. */
    private async lockedOutpoints(): Promise<Set<string>> {
        if (!this.intentRepository) return new Set();
        try {
            const locked = await this.intentRepository.getLockedVtxoOutpoints();
            return new Set(locked.map((o) => `${o.txid}:${o.vout}`));
        } catch {
            return new Set();
        }
    }

    /**
     * One contract+VTXO read (which may sync against the indexer). Callers needing several views
     * derive them all from one snapshot so they answer about the same instant.
     */
    protected async contractSnapshot(
        filter?: GetSpendableVtxosFilter,
        options?: { unspentOnly?: boolean },
    ): Promise<ContractWithVtxos[]> {
        const contractManager = await this.getContractManager();
        const scope: GetContractsFilter | undefined = filter?.watchedOnly
            ? { watch: ["watched", "awaiting-funds"] }
            : undefined;
        let query = scope;
        if (filter?.genericallySpendableOnly) {
            const scripts = (await contractManager.getContracts(scope))
                .filter(isContractGenericallySpendable)
                .map((contract) => contract.script);
            if (scripts.length === 0) {
                if (filter.requireSynced) {
                    throw new Error("No generically spendable contracts to sync");
                }
                return [];
            }
            query = { ...scope, script: scripts };
        }
        return contractManager.getContractsWithVtxos(query, undefined, {
            maxSyncAgeMs: filter?.maxSyncAgeMs,
            unspentOnly: options?.unspentOnly,
            requireSynced: filter?.requireSynced,
        });
    }

    /**
     * The two exclusion sets the gate is made of, derived from one snapshot so
     * {@link getSpendableVtxos} and the balance answer about the same instant.
     */
    private spendabilityView(snapshot: readonly ContractWithVtxos[]): {
        gated: GatedContracts;
        pendingRecovery: ReadonlySet<string>;
    } {
        return {
            gated: gatedFrom(snapshot),
            pendingRecovery: this.selectPendingRecovery(snapshot),
        };
    }

    /** The capability probes {@link computeOffchainBalance} needs, over one snapshot. */
    private async balanceCapabilities(
        snapshot: readonly ContractWithVtxos[],
        vtxos: readonly NormalizedExtendedVirtualCoin[],
    ): Promise<BalanceCapabilities> {
        const { gated, pendingRecovery } = this.spendabilityView(snapshot);
        // Offline-first and fails open — see {@link spendableVtxosExcludingLocked}.
        const unlocked = new Set(
            (await spendableVtxosExcludingLocked([...vtxos], this.intentRepository)).map(
                (vtxo) => `${vtxo.txid}:${vtxo.vout}`,
            ),
        );
        return {
            now: { timestamp: new Date() },
            isPendingRecovery: (vtxo) => pendingRecovery.has(`${vtxo.txid}:${vtxo.vout}`),
            isGenericallySpendable: (vtxo) => !isGatedVtxo(vtxo, gated),
            isUnlocked: (vtxo) => unlocked.has(`${vtxo.txid}:${vtxo.vout}`),
            isReserved: (vtxo) => this._heldOutpoints.has(`${vtxo.txid}:${vtxo.vout}`),
            dustCarrier: getDustAmount(this),
        };
    }

    /**
     * Outpoints of not-yet-swept VTXOs whose deprecated signer is past its cutoff (EXPIRED) —
     * unspendable until they recover; excluded by {@link getBalance} and {@link getSpendableVtxos}.
     * Takes a fresh (syncing) snapshot; callers that hold one or must not sync use
     * {@link pendingRecoveryOutpointsIn}.
     */
    async pendingRecoveryOutpoints(): Promise<Set<string>> {
        if (this._deprecatedSigners.size === 0) return new Set();
        return this.selectPendingRecovery(await this.contractSnapshot());
    }

    /** {@link pendingRecoveryOutpoints} over a caller-held snapshot; no I/O of its own. */
    pendingRecoveryOutpointsIn(snapshot: PendingRecoverySnapshot): Set<string> {
        return this.selectPendingRecovery(snapshot);
    }

    private selectPendingRecovery(snapshot: PendingRecoverySnapshot): Set<string> {
        if (this._deprecatedSigners.size === 0) return new Set();
        return selectPendingRecoveryOutpoints(snapshot, {
            active: toXOnlySignerHex(hex.encode(this.offchainTapscript.options.serverPubKey)),
            deprecated: this._deprecatedSigners,
        });
    }

    /**
     * Return wallet transaction history derived from Arkade state and boarding transactions.
     */
    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const [snapshot, { boardingTxs, commitmentsToIgnore }] = await Promise.all([
            this.contractSnapshot(),
            this.getBoardingTxs(),
        ]);
        const allVtxos = snapshot.flatMap((_) => _.vtxos);

        // Best-effort: a retryable indexer failure yields a partial map, not a
        // failed read; terminal failures still propagate.
        const resolveTxCreatedAt = (txids: string[]) =>
            fetchVtxoCreatedAtByTxid(this.indexerProvider, txids);

        // Gate from the same snapshot; see `buildTransactionHistory`'s `gatedScripts` for why.
        return buildTransactionHistory(
            allVtxos,
            boardingTxs,
            commitmentsToIgnore,
            resolveTxCreatedAt,
            gatedFrom(snapshot),
        );
    }

    /**
     * Wallet history grouped by registered activity resolvers. With no resolver match,
     * rows bucket by transaction key so send/change pairs stay together.
     */
    async getActivityHistory(): Promise<Activity[]> {
        return buildActivities(await this.getTransactionHistory(), this.activity.all());
    }

    /**
     * Clear the global VTXO sync cursor, forcing a full re-bootstrap on next sync.
     * Useful for recovery after indexer reprocessing or debugging.
     */
    async clearSyncCursor(): Promise<void> {
        await clearSyncCursor(this.walletRepository);
    }

    /**
     * Wipe all locally persisted wallet data (VTXOs, UTXOs, history, sync
     * cursor, contracts). Create a fresh wallet instance afterward.
     */
    async clear(): Promise<void> {
        try {
            await this.dispose();
        } finally {
            await Promise.all([this.walletRepository.clear(), this.contractRepository.clear()]);
        }
    }
    /**
     * On-chain (P2TR) addresses of every boarding tapscript this wallet uses, current plus
     * historical rotated, so deposits at old addresses still surface; {@link getBoardingAddress}
     * stays single-valued.
     */
    async getBoardingAddresses(): Promise<string[]> {
        const tapscripts = await this.getBoardingTapscripts(this.watchedBoardingSigners());
        return tapscripts.map((t) => t.onchainAddress(this.network));
    }

    /** Transaction history across the wallet's boarding addresses (current + historical). */
    async getBoardingTxs(): Promise<{
        boardingTxs: ArkTransaction[];
        commitmentsToIgnore: Set<string>;
    }> {
        const utxos: NormalizedVirtualCoin[] = [];
        const commitmentsToIgnore = new Set<string>();
        const tapscripts = await this.getBoardingTapscripts(this.watchedBoardingSigners());

        const outspendCache = new Map<
            string,
            Awaited<ReturnType<typeof this.onchainProvider.getTxOutspends>>
        >();

        for (const tapscript of tapscripts) {
            const boardingAddress = tapscript.onchainAddress(this.network);
            const scriptHex = hex.encode(tapscript.pkScript);
            const txs = await this.onchainProvider.getTransactions(boardingAddress);

            // Fallback spender (commitment) txid from this address history's vins: some Esplora
            // deployments (e.g. mempool.arkade.sh) return `/outspends` `{spent:true}` WITHOUT the
            // txid, which would double-count the resulting VTXO as a phantom receive.
            const commitmentByOutpoint = new Map<string, string>();
            for (const tx of txs) {
                for (const input of tx.vin ?? []) {
                    commitmentByOutpoint.set(`${input.txid}:${input.vout}`, tx.txid);
                }
            }

            for (const tx of txs) {
                for (let i = 0; i < tx.vout.length; i++) {
                    const vout = tx.vout[i];
                    if (vout.scriptpubkey_address === boardingAddress) {
                        let spentStatuses = outspendCache.get(tx.txid);
                        if (!spentStatuses) {
                            spentStatuses = await this.onchainProvider.getTxOutspends(tx.txid);
                            outspendCache.set(tx.txid, spentStatuses);
                        }
                        const spentStatus = spentStatuses[i];

                        // `||` (not `??`) so the electrum provider's `txid: ""` sentinel for
                        // unspent outputs falls through to the vin lookup.
                        const commitmentTxid =
                            spentStatus?.txid || commitmentByOutpoint.get(`${tx.txid}:${i}`);
                        const spent = Boolean(spentStatus?.spent) || commitmentTxid !== undefined;

                        if (spent && commitmentTxid) {
                            commitmentsToIgnore.add(commitmentTxid);
                        }

                        const boardingFacts = {
                            isSpent: spent,
                            isSwept: false,
                            isPreconfirmed: false,
                            commitmentTxIds: spent && commitmentTxid ? [commitmentTxid] : [],
                        };
                        utxos.push({
                            txid: tx.txid,
                            vout: i,
                            value: Number(vout.value),
                            status: {
                                confirmed: tx.status.confirmed,
                                block_time: tx.status.block_time,
                            },
                            isUnrolled: true,
                            ...boardingFacts,
                            spentBy: "",
                            createdAt: tx.status.confirmed
                                ? new Date(tx.status.block_time * 1000)
                                : new Date(0),
                            script: scriptHex,
                        });
                    }
                }
            }
        }

        const unconfirmedTxs: ArkTransaction[] = [];
        const confirmedTxs: ArkTransaction[] = [];

        for (const utxo of utxos) {
            const tx: ArkTransaction = {
                key: {
                    boardingTxid: utxo.txid,
                    commitmentTxid: utxo.commitmentTxIds[0] ?? "",
                    arkTxid: "",
                },
                amount: utxo.value,
                type: TxType.TxReceived,
                settled: utxo.isSpent,
                createdAt: utxo.status.block_time
                    ? new Date(utxo.status.block_time * 1000).getTime()
                    : 0,
            };

            if (!utxo.status.block_time) {
                unconfirmedTxs.push(tx);
            } else {
                confirmedTxs.push(tx);
            }
        }

        return {
            boardingTxs: [...unconfirmedTxs, ...confirmedTxs],
            commitmentsToIgnore,
        };
    }

    /**
     * Every boarding tapscript whose UTXOs belong to this wallet (rotation spreads them over
     * several addresses), deduplicated by scriptPubKey. Always includes the index-0 baseline,
     * which covers the equal-delay case where that row coalesced onto `default`.
     *
     * @param allowedSigners - x-only server keys whose persisted boarding rows are included;
     *   defaults to the current signer (the foreign-ASP guard). Migration widens it to old signers.
     *   The baseline and current display tapscript are included regardless.
     */
    protected async getBoardingTapscripts(
        allowedSigners?: Set<string>,
    ): Promise<DefaultVtxo.Script[]> {
        const byScript = new Map<string, DefaultVtxo.Script>();
        const add = (s: DefaultVtxo.Script) => byScript.set(hex.encode(s.pkScript), s);

        const boardingCsv =
            this.boardingTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        // Index-0 baseline boarding (identity x-only key) — always in scope.
        add(
            new DefaultVtxo.Script({
                pubKey: await this.identity.xOnlyPublicKey(),
                serverPubKey: this.boardingTapscript.options.serverPubKey,
                csvTimelock: boardingCsv,
            }),
        );
        // Current display boarding tapscript (may be a rotated index).
        add(this.boardingTapscript);
        // Every persisted boarding contract, read from the repository directly so fund discovery
        // doesn't force contract-manager initialization.
        const serverPubKeyHex = hex.encode(this.boardingTapscript.options.serverPubKey);
        const allowed = allowedSigners ?? new Set([toXOnlySignerHex(serverPubKeyHex)]);
        const boardingContracts = await collectContracts(this.contractRepository, {
            type: ["boarding"],
        });
        for (const c of boardingContracts) {
            // Only allowed servers, else a previous ASP's row emits a spurious script and wasted
            // provider calls on every read. Both sides x-only so a compressed key can't drop a row.
            if (!allowed.has(toXOnlySignerHex(c.params.serverPubKey))) continue;
            try {
                add(BoardingContractHandler.createScript(c.params));
            } catch (e) {
                // Skip a malformed row rather than abort fund discovery, but
                // surface it so repo corruption is detectable.
                console.warn("Skipping malformed boarding contract", c.script, e);
            }
        }
        return [...byScript.values()];
    }

    /**
     * Fetch and cache boarding UTXOs for the given signer set, grouped per address (see
     * {@link BoardingUtxoGroup} for why). No `getInfo()`: the only network calls are the
     * per-address `getCoins`.
     *
     * @param allowedSigners - x-only-hex server keys whose boarding addresses to
     *   fetch (passed through to {@link getBoardingTapscripts}).
     */
    async getBoardingUtxosForSigners(allowedSigners: Set<string>): Promise<BoardingUtxoGroup[]> {
        const tapscripts = await this.getBoardingTapscripts(allowedSigners);
        const addresses = tapscripts.map((tapscript) => tapscript.onchainAddress(this.network));
        const groups: BoardingUtxoGroup[] = await Promise.all(
            tapscripts.map(async (tapscript, i) => {
                const coins = await this.onchainProvider.getCoins(addresses[i]);
                const utxos = coins.map((utxo) => extendCoinWithTapscript(tapscript, utxo));
                return {
                    tapscript,
                    // x-only regardless of how the tapscript's key was stored.
                    serverPubKey: toXOnlySignerHex(hex.encode(tapscript.options.serverPubKey)),
                    // Per-row CSV delay decoded from THIS tapscript's exit leaf —
                    // not the wallet's current boarding timelock, which a signer
                    // rotation may have changed.
                    csvTimelock: CSVMultisigTapscript.decode(hex.decode(tapscript.exitScript))
                        .params.timelock,
                    coins: utxos,
                };
            }),
        );
        // Saved only once every fetch has succeeded, so a failure leaves no write in flight.
        for (const [i, group] of groups.entries()) {
            await this.walletRepository.saveUtxos(addresses[i], group.coins);
        }
        return groups;
    }

    /**
     * Fetch and cache boarding UTXOs at current and historical boarding addresses, each annotated
     * with its own address's tapscript so spends use the right per-index leaves. Current-signer
     * only: old-signer inputs would make a plain `settle()` the server must reject, so their
     * recovery goes through the deprecated-signer migration API.
     */
    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        const currentOnly = new Set([
            toXOnlySignerHex(hex.encode(this.boardingTapscript.options.serverPubKey)),
        ]);
        const groups = await this.getBoardingUtxosForSigners(currentOnly);
        return groups
            .flatMap((g) => g.coins)
            .filter((coin) => !this._pendingSpendOutpoints.has(`${coin.txid}:${coin.vout}`));
    }

    /**
     * Subscribe to onchain and offchain notifications for newly received funds.
     *
     * The onchain watcher tracks every boarding address (current + historical) and re-subscribes
     * automatically when boarding rotates after subscribing, so deposits to a fresh address fire
     * within the same session.
     *
     * @param eventCallback - Callback invoked when matching funds are detected
     * @returns A function that stops the subscriptions
     */
    async notifyIncomingFunds(eventCallback: (coins: IncomingFunds) => void): Promise<() => void> {
        const arkAddress = await this.getAddress();

        let onchainStopFunc: (() => void) | undefined;
        let indexerStopFunc: (() => void) | undefined;
        let boardingRotationStopFunc: (() => void) | undefined;
        let stopped = false;

        // (Re)subscribe to the CURRENT boarding-address set, serialized on one chain so a burst of
        // rotations can't interleave teardown/setup and leak a watcher.
        let onchainChain: Promise<void> = Promise.resolve();
        const subscribeOnchain = (): Promise<void> => {
            onchainChain = onchainChain
                .then(async () => {
                    if (stopped || !this.onchainProvider) return;

                    const boardingAddresses = await this.getBoardingAddresses();
                    if (boardingAddresses.length === 0) return;
                    const boardingAddressSet = new Set(boardingAddresses);

                    // Subscribe-then-swap: a throw leaves the old watcher live (stale set, not
                    // none), and there's no blind window where a deposit could be seeded as
                    // "already known" and never reported. A just-derived address can't have
                    // prior funds, so no reconciliation fetch is needed.
                    const previousStop = onchainStopFunc;
                    const stop = await this.onchainProvider.watchAddresses(
                        boardingAddresses,
                        (txs) => {
                            // Per matching vout, not first match per tx: one tx can pay
                            // several of our boarding addresses.
                            const coins: Coin[] = txs.flatMap((tx) => {
                                const { txid, status } = tx;
                                const matched: Coin[] = [];
                                tx.vout.forEach((v: any, vout: number) => {
                                    if (boardingAddressSet.has(v.scriptpubkey_address)) {
                                        matched.push({
                                            txid,
                                            vout,
                                            value: Number(v.value),
                                            status,
                                        });
                                    }
                                });
                                return matched;
                            });

                            eventCallback({
                                type: "utxo",
                                coins,
                            });
                        },
                    );

                    // `stopFunc` ran during the await and already stopped the previous watcher;
                    // only the fresh one needs tearing down.
                    if (stopped) {
                        stop();
                        return;
                    }

                    // Brief overlap is fine: at worst a duplicate notification, never a miss.
                    onchainStopFunc = stop;
                    previousStop?.();
                })
                .catch((e) => {
                    console.warn("Failed to (re)subscribe boarding-funds watcher", e);
                });
            return onchainChain;
        };

        // Registered BEFORE the initial subscribe so a rotation landing during setup still queues
        // a re-subscribe instead of leaving the watcher on the stale set.
        boardingRotationStopFunc = this.onBoardingRotation(() => {
            void subscribeOnchain();
        });

        await subscribeOnchain();

        if (this.indexerProvider && arkAddress) {
            // Share the ContractWatcher's single subscription instead of
            // opening a second SSE stream.
            const cm = await this.getContractManager();

            // Serialized: parallel `annotateVtxos` could deliver e.g. `vtxo_spent` before its
            // matching `vtxo_received`.
            let annotationQueue: Promise<void> = Promise.resolve();

            indexerStopFunc = cm.onContractEvent((event) => {
                if (!isContractVtxoEvent(event)) {
                    return;
                }
                if (event.contract.type !== "default" && event.contract.type !== "delegate") {
                    return;
                }

                // `event.vtxos` carries placeholder tapscript fields from
                // the watcher; `annotateVtxos` fills them in.
                annotationQueue = annotationQueue.then(async () => {
                    try {
                        const annotated = await cm.annotateVtxos(event.vtxos);
                        eventCallback({
                            type: "vtxo",
                            newVtxos: event.type === "vtxo_received" ? annotated : [],
                            spentVtxos: event.type === "vtxo_spent" ? annotated : [],
                        });
                    } catch (error) {
                        console.warn(
                            "Dropping subscription update after annotation failed; next sync will reconcile:",
                            error,
                        );
                    }
                });
            });
        }

        const stopFunc = () => {
            // Flag first so any in-flight (re)subscribe on `onchainChain` tears
            // its fresh watcher down instead of leaking it.
            stopped = true;
            boardingRotationStopFunc?.();
            onchainStopFunc?.();
            onchainStopFunc = undefined;
            indexerStopFunc?.();
        };

        return stopFunc;
    }

    /** Fetch Arkade transaction ids that are still pending final settlement. */
    async fetchPendingTxs(): Promise<string[]> {
        // get non-swept virtual outputs, rely on the indexer only in case DB doesn't have the right state
        const scripts = await this.getWalletScripts();
        const vtxos = await getAllNormalizedVtxos(this.indexerProvider, scripts);
        return vtxos
            .filter(
                (vtxo) =>
                    (vtxo.isSpent || (vtxo.isPreconfirmed && !vtxo.isSwept)) &&
                    vtxo.arkTxId !== undefined,
            )
            .map((_) => _.arkTxId!);
    }

    // ========================================================================
    // Multi-script support (default + delegate addresses)
    // ========================================================================

    /**
     * Get all pkScript hex strings for the wallet's own addresses
     * (both delegate and non-delegate, current and historical).
     */
    async getWalletScripts(): Promise<string[]> {
        const manager = await this.getContractManager();
        const contracts = await manager.getContracts({
            type: ["default", "delegate"],
        });
        return contracts.map((c) => c.script);
    }

    /**
     * Build a map of scriptHex → VtxoScript for all wallet contracts,
     * so virtual outputs can be extended with the correct tapscript per contract.
     */
    async getScriptMap(): Promise<Map<string, DefaultVtxo.Script | DelegateVtxo.Script>> {
        const map = new Map<string, DefaultVtxo.Script | DelegateVtxo.Script>();

        const manager = await this.getContractManager();
        const contracts = await manager.getContracts({
            type: ["default", "delegate"],
        });
        for (const contract of contracts) {
            if (map.has(contract.script)) continue;
            const handler = contractHandlers.get(contract.type);
            if (handler) {
                const script = handler.createScript(contract.params) as
                    | DefaultVtxo.Script
                    | DelegateVtxo.Script;
                map.set(contract.script, script);
            }
        }

        return map;
    }

    // ========================================================================
    // Contract Management
    // ========================================================================

    /**
     * Get the ContractManager, which manages the wallet's own receive contracts and external ones
     * (Boltz swaps, HTLCs, …) with resilient multi-contract watching.
     *
     * @example
     * ```typescript
     * const manager = await wallet.getContractManager();
     *
     * // Create a contract for a Boltz swap
     * const contract = await manager.createContract({
     *   label: "Boltz Swap",
     *   type: "vhtlc",
     *   params: { ... },
     *   script: swapScript,
     *   address: swapAddress,
     * });
     *
     * // Start watching for events (includes wallet's default address)
     * const stop = await manager.onContractEvent((event) => {
     *   console.log(`${event.type} on ${event.contractScript}`);
     * });
     * ```
     */
    async getContractManager(): Promise<ContractManager> {
        if (this._contractManager) {
            return this._contractManager;
        }

        if (this._contractManagerInitializing) {
            return this._contractManagerInitializing;
        }

        this._contractManagerInitializing = this.initializeContractManager();

        try {
            const manager = await this._contractManagerInitializing;
            this._contractManager = manager;
            return manager;
        } catch (error) {
            // Clear the initializing promise so subsequent calls can retry
            this._contractManagerInitializing = undefined;
            throw error;
        } finally {
            this._contractManagerInitializing = undefined;
        }
    }

    /**
     * HD look-ahead configuration for the contract manager. Readonly wallets
     * have no descriptor provider, hence no watermark to look ahead of.
     * @see Wallet.lookAheadConfig
     */
    protected lookAheadConfig(): ContractManagerConfig["lookAhead"] {
        return undefined;
    }

    private async initializeContractManager(): Promise<ContractManager> {
        // When a virtualTxRepository is configured, capture each received VTXO's
        // unilateral-exit branch and prune it on spend (both best-effort).
        const virtualTxRepository = this.virtualTxRepository;
        let onVtxosPersisted: ContractManagerConfig["onVtxosPersisted"];
        let onVtxosSpent: ContractManagerConfig["onVtxosSpent"];
        if (virtualTxRepository) {
            const capture = this.exitDataCapture;
            const resolver = createExitChainResolver({
                indexer: this.indexerProvider,
                repository: virtualTxRepository,
                extraSources: capture?.sources,
            });
            onVtxosPersisted = async (_contract, vtxos) => {
                for (const v of vtxos) {
                    if (v.isSpent) continue;
                    await captureExitBranch({
                        resolver,
                        repository: virtualTxRepository,
                        vtxo: { txid: v.txid, vout: v.vout },
                        value: v.value,
                        mode: capture?.mode ?? DEFAULT_EXIT_CAPTURE_MODE,
                        minExitWorthSats: capture?.minExitWorthSats ?? DEFAULT_MIN_EXIT_WORTH_SATS,
                    }).catch(() => {
                        // capture is best-effort
                    });
                }
            };
            onVtxosSpent = (vtxos) => pruneExitBranches(virtualTxRepository, vtxos);
        }
        const manager = await ContractManager.create({
            indexerProvider: this.indexerProvider,
            contractRepository: this.contractRepository,
            walletRepository: this.walletRepository,
            intentRepository: this.intentRepository,
            onVtxosPersisted,
            onVtxosSpent,
            watcherConfig: this.watcherConfig,
            lookAhead: this.lookAheadConfig(),
            // Without it every height-typed CLTV reads as unsatisfied, and seconds-typed timelocks
            // would be judged against the host clock. @see ContractManagerConfig.chainTip
            chainTip: async () => {
                const { height, time } = await this.onchainProvider.getChainTip();
                return { height, time };
            },
        });

        // Baseline always-active contracts: `walletContractTimelocks` × {default, delegate}, bound
        // to INDEX 0 (identity x-only key) as the permanent fallback set. Rotated display
        // contracts are single-timelock at the current delay and tagged WALLET_RECEIVE_SOURCE;
        // the matrix is deliberately NOT re-registered at rotated keys (it would expand per boot).
        const baselinePubkey = await this.identity.xOnlyPublicKey();
        // The matrix also fans the SERVER-signer axis (current + every deprecated signer), so funds
        // on a rotated-signer contract are watched from boot, not only after restore(). Deduped
        // by scriptHex.
        const delegatePubKey =
            this.offchainTapscript instanceof DelegateVtxo.Script
                ? this.offchainTapscript.options.delegatePubKey
                : undefined;
        const baselineSigners = [
            this.offchainTapscript.options.serverPubKey,
            ...[...this._deprecatedSigners.keys()].map((h) => hex.decode(h)),
        ];
        const seenBaselineScripts = new Set<string>();
        for (const serverPubKey of baselineSigners) {
            for (const csvTimelock of this.walletContractTimelocks) {
                const csvTimelockStr = timelockToSequence(csvTimelock).toString();
                const defaultScript = new DefaultVtxo.Script({
                    pubKey: baselinePubkey,
                    serverPubKey,
                    csvTimelock,
                });
                const defaultScriptHex = hex.encode(defaultScript.pkScript);

                if (!seenBaselineScripts.has(defaultScriptHex)) {
                    seenBaselineScripts.add(defaultScriptHex);
                    // Persisted before the boarding baseline below, so in the degenerate
                    // equal-delay collision the index-0 row stays `default` (first-wins).
                    await manager.createContract({
                        type: "default",
                        params: {
                            pubKey: hex.encode(defaultScript.options.pubKey),
                            serverPubKey: hex.encode(serverPubKey),
                            csvTimelock: csvTimelockStr,
                        },
                        script: defaultScriptHex,
                        address: defaultScript.address(this.network.hrp, serverPubKey).encode(),
                        state: "active",
                    });
                }

                if (delegatePubKey) {
                    const delegateScript = new DelegateVtxo.Script({
                        pubKey: baselinePubkey,
                        serverPubKey,
                        delegatePubKey,
                        csvTimelock,
                    });
                    const delegateScriptHex = hex.encode(delegateScript.pkScript);

                    if (seenBaselineScripts.has(delegateScriptHex)) continue;
                    seenBaselineScripts.add(delegateScriptHex);
                    await manager.createContract({
                        type: "delegate",
                        params: {
                            pubKey: hex.encode(delegateScript.options.pubKey),
                            serverPubKey: hex.encode(serverPubKey),
                            delegatePubKey: hex.encode(delegateScript.options.delegatePubKey),
                            csvTimelock: csvTimelockStr,
                        },
                        script: delegateScriptHex,
                        address: delegateScript.address(this.network.hrp, serverPubKey).encode(),
                        state: "active",
                    });
                }
            }
        }

        // Baseline boarding rows, anchored at INDEX 0 (`baselinePubkey`, NOT the possibly-rotated
        // `boardingTapscript`) so baseline deposits stay visible regardless of rotation; the CSV
        // is index-independent. Same signer axis as above; only the signer fans, since the
        // boarding CSV is server-wide. Idempotent (keyed by script); a script colliding with a
        // default/delegate one (degenerate equal delays) stays that type via the shared set.
        const boardingCsvTimelock =
            this.boardingTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        for (const serverPubKey of baselineSigners) {
            const baselineBoarding = new DefaultVtxo.Script({
                pubKey: baselinePubkey,
                serverPubKey,
                csvTimelock: boardingCsvTimelock,
            });
            const boardingScriptHex = hex.encode(baselineBoarding.pkScript);
            if (seenBaselineScripts.has(boardingScriptHex)) continue;
            seenBaselineScripts.add(boardingScriptHex);
            await manager.createContract({
                type: "boarding",
                params: {
                    pubKey: hex.encode(baselineBoarding.options.pubKey),
                    serverPubKey: hex.encode(serverPubKey),
                    csvTimelock: timelockToSequence(boardingCsvTimelock).toString(),
                },
                script: boardingScriptHex,
                address: baselineBoarding.address(this.network.hrp, serverPubKey).encode(),
                state: "active",
            });
        }

        return manager;
    }

    /** Dispose wallet-owned managers and release background resources. */
    async dispose(): Promise<void> {
        const manager =
            this._contractManager ??
            (this._contractManagerInitializing
                ? await this._contractManagerInitializing.catch(() => undefined)
                : undefined);

        manager?.dispose();
        this._contractManager = undefined;
        this._contractManagerInitializing = undefined;
    }

    /** Async-dispose hook that forwards to `dispose()`. */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}

/**
 * Main wallet implementation for Bitcoin transactions with Arkade protocol support.
 *
 * @example
 * ```typescript
 * // Create a wallet with providers
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
 *   onchainProvider: new EsploraProvider()
 * });
 *
 * // Use custom providers and/or URLs (e.g., for Expo/React Native)
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new ExpoArkProvider('https://arkade.computer'),
 *   indexerProvider: new ExpoIndexerProvider('https://arkade.computer'),
 *   onchainProvider: new EsploraProvider('https://mempool.space/api')
 * });
 *
 * // Get addresses
 * const arkAddress = await wallet.getAddress();
 * const boardingAddress = await wallet.getBoardingAddress();
 *
 * // Send bitcoin
 * const txid = await wallet.send({
 *   address: 'ark1q...',
 *   amount: 50000,
 * });
 * ```
 */
export class Wallet
    extends ReadonlyWallet
    implements IWallet, HDWalletCapable, AddressAllocationCapable
{
    static MIN_FEE_RATE = 1; // sats/vbyte

    override readonly identity: Identity;
    private readonly _delegateManager?: IDelegateManager;
    private _vtxoManager?: VtxoManager;
    private _vtxoManagerInitializing?: Promise<VtxoManager>;

    private _walletAssetManager?: IAssetManager;

    /**
     * HD receive rotator; absent for `static` and SingleKey-under-`auto` wallets. Its subscription
     * installs lazily on first `getVtxoManager()` so the contract manager is up first.
     */
    private _receiveRotator?: WalletReceiveRotator;

    /** Unsubscribe for `onServerInfoChanged` (mid-session signer rotation). */
    private _serverInfoUnsub?: () => void;

    /**
     * Tail of the serialized {@link handleServerInfoChanged} chain; {@link dispose} awaits it so an
     * in-flight rotation settles before the contract manager is torn down.
     */
    private _serverInfoInFlight: Promise<void> = Promise.resolve();

    /**
     * React to a mid-session server-info change (`DIGEST_MISMATCH`): refresh deprecated signers
     * first so boarding watch widens immediately, then rotate via {@link rotateServerSigner} only
     * if the active signer changed. Old-signer rows stay active. Never throws into the emit loop.
     */
    private async handleServerInfoChanged(info: {
        signerPubkey: string;
        checkpointTapscript: string;
        // without cutoffDate a past-cutoff signer reads as DUE_NOW
        deprecatedSigners?: readonly { pubkey?: string; cutoffDate?: bigint }[];
    }): Promise<void> {
        this.refreshDeprecatedSigners(info);
        try {
            const newActive = toXOnlySignerHex(info.signerPubkey);
            const current = toXOnlySignerHex(hex.encode(this.arkServerPublicKey));
            if (newActive !== current) {
                // Thread the new epoch's checkpoint script through; a bad value throws and is
                // caught below, leaving the wallet on its previous consistent epoch.
                await this.rotateServerSigner(
                    hex.decode(info.signerPubkey),
                    info.checkpointTapscript,
                );
            }
        } catch (e) {
            console.warn("server-signer rotation on info change failed", e);
        }
    }

    /**
     * Await an `onServerInfoChanged` handler still applying a rotation. {@link rotateServerSigner}
     * persists the new signer's rows *before* committing the tapscripts, so a path that refreshes
     * server info then reads signer-derived state must drain first or it reads torn state and
     * races the handler. Resolves once idle; handler rejections are swallowed (already logged).
     *
     * @internal Invoked by {@link dispose} and the {@link VtxoManager} migration
     * pass; not part of the stable public API.
     */
    async settleServerInfoChanges(): Promise<void> {
        await this._serverInfoInFlight?.catch(() => undefined);
    }

    private _receiveRotatorInstalled = false;

    /**
     * Descriptor-aware signer for inputs locked by rotated pubkeys (the rotator's instance).
     * Undefined for static / non-HD wallets, which only sign with the identity.
     */
    private readonly _descriptorProvider?: DescriptorProvider;

    /** Per-side width of the HD look-ahead band. @see WalletConfig.lookAheadWindow */
    private readonly _lookAheadWindow: number;

    /**
     * Watch a band of receive scripts around the HD watermark so payments to an externally-issued
     * address land without a `restore()`. HD only. `candidateDeps` is read at refill time, so a
     * band rebuilt after {@link rotateServerSigner} fans the new signer set.
     */
    protected override lookAheadConfig(): ContractManagerConfig["lookAhead"] {
        const provider = this._descriptorProvider;
        if (!(provider instanceof HDDescriptorProvider)) return undefined;
        return {
            size: this._lookAheadWindow,
            currentWatermark: async () => (await provider.getLastIndexUsed()) ?? -1,
            allocate: () => provider.getNextSigningDescriptor(),
            advanceWatermark: (index) => provider.advanceLastIndexUsed(index),
            materialize: (index) => provider.materializeDescriptorAt(index),
            candidateDeps: () => this.receiveCandidateDeps(),
        };
    }

    /**
     * Every axis an externally issued receive script could use: an issuer sharing the seed (NArk,
     * a merchant backend) picks its own contract type. From cached state (no `getInfo`) to stay
     * synchronous and offline-safe.
     */
    private receiveCandidateDeps(): CandidateDeps {
        return {
            network: { hrp: this.network.hrp },
            serverPubKey: this.offchainTapscript.options.serverPubKey,
            deprecatedSignerPubKeys: [...this._deprecatedSigners.keys()].map((h) => hex.decode(h)),
            csvTimelocks: this.walletContractTimelocks,
            delegatePubKey:
                this.offchainTapscript instanceof DelegateVtxo.Script
                    ? this.offchainTapscript.options.delegatePubKey
                    : undefined,
        };
    }

    private readonly _signerRouter: InputSignerRouter;

    /**
     * @internal Sole write path for `offchainTapscript`; called by
     * {@link WalletReceiveRotator.rotate} after the rotated contract is persisted.
     */
    setOffchainTapscriptForRotation(tapscript: DefaultVtxo.Script | DelegateVtxo.Script): void {
        this._offchainTapscript = tapscript;
    }

    /**
     * @internal Sole write path for `boardingTapscript`; called by
     * {@link Wallet.getNewBoardingAddress} after the rotated contract is persisted.
     */
    setBoardingTapscriptForRotation(tapscript: DefaultVtxo.Script): void {
        this._boardingTapscript = tapscript;
        // Harmless at boot: the boot-time restore runs before any subscription exists.
        this.notifyBoardingRotation();
    }

    /**
     * @internal Sole write path for `arkServerPublicKey`; called by
     * {@link Wallet.rotateServerSigner} after the rotated rows are persisted.
     */
    setArkServerPublicKeyForRotation(serverPubKey: Bytes): void {
        this._arkServerPublicKey = serverPubKey;
    }

    /**
     * Checkpoint output script from the server's `checkpointTapscript`; pinned at construction,
     * re-sourced only via {@link setServerUnrollScriptForRotation}.
     */
    protected _serverUnrollScript: CSVMultisigTapscript.Type;

    get serverUnrollScript(): CSVMultisigTapscript.Type {
        return this._serverUnrollScript;
    }

    /**
     * @internal Sole write path for `serverUnrollScript`; called by
     * {@link Wallet._doRotateServerSigner} with the rotating `ArkadeInfo`'s checkpoint script.
     */
    setServerUnrollScriptForRotation(script: CSVMultisigTapscript.Type): void {
        this._serverUnrollScript = script;
    }

    /**
     * Serializes {@link rotateServerSigner} for static / non-HD wallets so two callers can't both
     * swap the tapscripts; HD wallets use {@link WalletReceiveRotator.runExclusive} instead.
     */
    private _serverRotationChain: Promise<void> = Promise.resolve();

    /**
     * Allocate a *fresh* on-chain boarding address at the next index of the shared HD stream and
     * make it the displayed one (NArk: `GetNextContract(NextContractPurpose.Boarding)`).
     * Persists an `active` `boarding` contract tagged {@link WALLET_RECEIVE_SOURCE} so it is
     * watched, restored at boot and signable per index.
     *
     * A static / `auto` wallet returns {@link getBoardingAddress} unchanged (no index burned). A
     * custom {@link DescriptorProvider} wallet burns an index per call, including via
     * {@link maybeRotateBoardingAfterBoard} on every settle consuming a boarding UTXO; retired
     * addresses stay reachable through {@link getBoardingUtxos}.
     *
     * @deprecated Use {@link getNewAddresses} — it mints any combination of
     * address types at one shared index, and reports the contract row behind
     * each. Note the difference in display behaviour: this method *swaps* the
     * advertised boarding address, where `getNewAddresses` mints side
     * addresses and leaves {@link getBoardingAddress} alone. To keep this
     * method's behaviour, keep calling this method.
     */
    async getNewBoardingAddress(): Promise<string> {
        // Persisted before the swap, so a throw leaves the previous (watched) address displayed.
        const [minted] = await this.allocateAddresses(["boarding"], false, true);
        if (!minted?.allocated) return this.getBoardingAddress();
        if (minted.type === "boarding") this.setBoardingTapscriptForRotation(minted.tapscript);
        return minted.address;
    }

    /**
     * Allocate a *fresh* address of each requested type, all at **one** new HD index. The way to
     * issue a second address before the first is paid ({@link getAddress} only advances on
     * receipt). Each is persisted `active` with its `signingDescriptor`, so it is watched,
     * counted, and signable via {@link signerForDescriptor}; the look-ahead band slides.
     *
     * Rows are deliberately **untagged**: boot adopts the newest {@link WALLET_RECEIVE_SOURCE} row
     * as the display address, and a side address must not become what the wallet advertises.
     * {@link getAddress} and {@link getBoardingAddress} are unchanged.
     *
     * A wallet with no HD stream (`static` / `auto`) returns its persisted display rows, or with
     * `forceNew` throws {@link WalletCannotAllocateAddressError} rather than return a stale one.
     *
     * @example
     * ```typescript
     * const [invoice] = await wallet.getNewAddresses({ forceNew: true });
     * // hand `invoice.address` to Alice, keep the descriptor with the invoice
     * const signer = await wallet.signerForDescriptor(invoice.signingDescriptor);
     * ```
     */
    async getNewAddresses(opts?: GetNewAddressesOptions): Promise<NewAddress[]> {
        const minted = await this.allocateAddresses(
            opts?.types ?? ["default"],
            opts?.forceNew ?? false,
            false,
        );
        return minted.map(({ address, signingDescriptor, contract }) => ({
            address,
            signingDescriptor,
            contract,
        }));
    }

    /**
     * Shared core of {@link getNewAddresses} and {@link getNewBoardingAddress}.
     *
     * @param tagSource - Tag rows {@link WALLET_RECEIVE_SOURCE} so boot adopts them as the display
     * address; only the deprecated boarding allocator passes `true`.
     */
    private async allocateAddresses(
        types: readonly NewAddressType[],
        forceNew: boolean,
        tagSource: boolean,
    ): Promise<AllocatedAddress[]> {
        // Before allocating: an empty request would burn an index no contract row explains.
        if (types.length === 0) {
            throw new Error("getNewAddresses: `types` must name at least one address type");
        }

        const manager = await this.getContractManager();
        const provider = this._descriptorProvider;
        // One allocation for every requested type. The built-in HD provider goes through the
        // contract manager (cross-context serialization + look-ahead band); a custom provider is
        // asked directly, since the manager has no `allocate` hook for it and would answer
        // `undefined` ("declined").
        const descriptor = !provider
            ? undefined
            : provider instanceof HDDescriptorProvider
              ? await manager.getNextSigningDescriptor()
              : await provider.getNextSigningDescriptor();

        if (!descriptor) {
            if (forceNew) {
                throw new WalletCannotAllocateAddressError(
                    provider
                        ? "the descriptor provider declined to allocate an index"
                        : "this wallet has no HD stream (walletMode 'static' / 'auto')",
                );
            }
            // `createContract` is first-wins on script, so this returns the existing rows.
            return this.currentAddresses(manager, types);
        }

        const allocated: AllocatedAddress[] = [];
        try {
            for (const type of types) {
                allocated.push(await this.mintAddress(manager, type, descriptor, tagSource, true));
            }
        } finally {
            // In `finally`: the watermark moved before the first contract was written, so a
            // partial failure must still slide the band. Best-effort: the allocation is committed,
            // so a failed slide must not replace the caller's error or fail the call.
            try {
                await manager.refillLookAhead();
            } catch (e) {
                console.warn("look-ahead refill after address allocation failed", e);
            }
        }
        return allocated;
    }

    /**
     * The wallet's existing display addresses as persisted rows, each minted from the descriptor
     * that owns its display script ({@link displayDescriptor}) so it signs for `address`.
     */
    private async currentAddresses(
        manager: ContractManager,
        types: readonly NewAddressType[],
    ): Promise<AllocatedAddress[]> {
        const out: AllocatedAddress[] = [];
        for (const type of types) {
            const descriptor = await this.displayDescriptor(manager, type);
            out.push(await this.mintAddress(manager, type, descriptor, false, false));
        }
        return out;
    }

    /**
     * The descriptor owning the current display script for `type`, from its persisted row. Not
     * derived from the identity: on a rotated wallet that would pair the address with a signer
     * holding the wrong key. Falls back to the identity's `tr(pubkey)` when no row carries one
     * (static / `auto`; index-0 baselines have no `signingDescriptor`).
     */
    private async displayDescriptor(
        manager: ContractManager,
        type: NewAddressType,
    ): Promise<string> {
        const display = type === "boarding" ? this._boardingTapscript : this.offchainTapscript;
        const [row] = await manager.getContracts({ script: hex.encode(display.pkScript) });
        const persisted = row?.metadata?.signingDescriptor;
        if (typeof persisted === "string") return persisted;
        return identityDescriptor(this.identity);
    }

    /**
     * Build, persist and shape one address of `type` owned by `descriptor`. The descriptor is the
     * sole source of the owner key in both branches, so `address` and `signingDescriptor` can't
     * drift apart.
     */
    private async mintAddress(
        manager: ContractManager,
        type: NewAddressType,
        descriptor: string,
        tagSource: boolean,
        allocated: boolean,
    ): Promise<AllocatedAddress> {
        // Persist before returning: an address the caller hands out but the
        // watcher never saw is one whose payment silently never lands.
        if (type === "boarding") {
            const built = this.buildBoardingContract(
                deriveDescriptorLeafPubKey(descriptor),
                descriptor,
                tagSource,
            );
            const contract = await manager.createContract(built.params);
            return {
                type,
                tapscript: built.tapscript,
                // A boarding row persists the *ark* encoding; re-derive the onchain form.
                address: built.tapscript.onchainAddress(this.network),
                signingDescriptor: descriptor,
                contract,
                allocated,
            };
        }
        const built = buildReceiveContract(
            this.offchainTapscript,
            descriptor,
            this.network.hrp,
            tagSource,
        );
        const contract = await manager.createContract(built.params);
        return {
            type,
            tapscript: built.tapscript,
            // Read back so a coalesced (first-wins) row reports what was actually persisted.
            address: contract.address,
            signingDescriptor: descriptor,
            contract,
            allocated,
        };
    }

    /**
     * Boarding contract owned by `pubKey`, keeping the current tapscript's other options
     * (offchain analogue: {@link buildReceiveContract}).
     */
    private buildBoardingContract(
        pubKey: Bytes,
        descriptor: string,
        tagSource: boolean,
    ): { tapscript: DefaultVtxo.Script; params: CreateContractParams } {
        const tapscript = new DefaultVtxo.Script({
            ...this._boardingTapscript.options,
            pubKey,
        });
        const csvTimelock = tapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        return {
            tapscript,
            params: {
                type: "boarding",
                params: {
                    pubKey: hex.encode(pubKey),
                    serverPubKey: hex.encode(tapscript.options.serverPubKey),
                    csvTimelock: timelockToSequence(csvTimelock).toString(),
                },
                script: hex.encode(tapscript.pkScript),
                address: tapscript.address(this.network.hrp, this.arkServerPublicKey).encode(),
                state: "active",
                metadata: {
                    ...(tagSource && { source: WALLET_RECEIVE_SOURCE }),
                    signingDescriptor: descriptor,
                },
            },
        };
    }

    /**
     * @see HDWalletCapable.getCurrentSigningDescriptor
     */
    async getCurrentSigningDescriptor(): Promise<string | undefined> {
        const provider = this._descriptorProvider;
        if (!(provider instanceof HDDescriptorProvider)) return undefined;
        return provider.getCurrentSigningDescriptor();
    }

    /**
     * @see HDAllocationCapable.getNextSigningDescriptor
     *
     * Every `Wallet` answers, so consumers never branch on wallet shape: HD allocates through the
     * contract manager; otherwise the identity key as `tr(pubkey)`, the same every call.
     */
    async getNextSigningDescriptor(): Promise<string | undefined> {
        if (this._descriptorProvider instanceof HDDescriptorProvider) {
            return (await this.getContractManager()).getNextSigningDescriptor();
        }
        return identityDescriptor(this.identity);
    }

    /**
     * @see HDAllocationCapable.advanceSigningDescriptorWatermark
     */
    async advanceSigningDescriptorWatermark(descriptor: string): Promise<void> {
        const provider = this._descriptorProvider;
        // Nothing to move without an index stream, so nothing to validate.
        if (!(provider instanceof HDDescriptorProvider)) return;
        if (!provider.isOurs(descriptor)) {
            throw new Error(`descriptor is not derivable from this wallet: ${descriptor}`);
        }
        // Strict: `signingDescriptorIndex` answers 0 (a legitimate index) for unparseable input.
        const index = strictSigningDescriptorIndex(descriptor);
        if (index === undefined) {
            throw new Error(`descriptor has no trailing child index: ${descriptor}`);
        }
        await (await this.getContractManager()).advanceSigningDescriptorWatermark(index);
    }

    /**
     * @see HDWalletCapable.getUsedSigningDescriptors
     *
     * Union of the watermark band (covers indices allocated for unpersisted things, e.g. swaps)
     * and descriptors persisted on contracts (covers rows a restore scan wrote).
     */
    async getUsedSigningDescriptors(opts?: { lookAhead?: number }): Promise<string[]> {
        const provider = this._descriptorProvider;
        const descriptors = new Set<string>();
        if (provider instanceof HDDescriptorProvider) {
            const lastIndexUsed = await provider.getLastIndexUsed();
            const requestedLookAhead = opts?.lookAhead ?? 0;
            if (!Number.isFinite(requestedLookAhead)) {
                throw new Error(
                    `lookAhead must be a finite number (got ${String(requestedLookAhead)})`,
                );
            }
            const lookAhead = Math.min(
                MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD,
                Math.max(0, Math.trunc(requestedLookAhead)),
            );
            // Probing past the watermark must not move it: an index nothing
            // has claimed yet stays available to the next allocation.
            for (let i = 0; i <= (lastIndexUsed ?? -1) + lookAhead; i++) {
                descriptors.add(provider.materializeDescriptorAt(i));
            }
        }
        for (const contract of await collectContracts(this.contractRepository)) {
            const descriptor = contract.metadata?.signingDescriptor;
            if (typeof descriptor === "string" && descriptor.length > 0) {
                descriptors.add(descriptor);
            }
        }
        return [...descriptors].sort(
            (a, b) => signingDescriptorIndex(a) - signingDescriptorIndex(b),
        );
    }

    /**
     * @see HDWalletCapable.signerForDescriptor
     *
     * Fail-loud: a descriptor this wallet can't sign for throws {@link ForeignDescriptorError}
     * rather than substituting the baseline identity, which would sign with the wrong key.
     */
    async signerForDescriptor(descriptor: string): Promise<Identity> {
        return resolveDescriptorSigner(descriptor, this.identity, this._descriptorProvider);
    }

    /**
     * Mid-session server-signer rotation. A wallet built before arkd rotated keeps deriving
     * old-signer receive addresses, and a migration output to one yields a VTXO the server must
     * reject, so receive state is re-derived under the new signer first.
     *
     * Same write-path as {@link WalletReceiveRotator.rotate} with the server key swapped: build the
     * new tapscripts, register their rows (carrying signing metadata so a descriptor-backed
     * pubkey still signs), and only then commit visible state. Old-signer rows stay `active` for
     * the migration pass to drain. Idempotent; serialized against HD receive rotation.
     *
     * @internal Invoked by the {@link VtxoManager} migration pass; not part of
     * the stable public API.
     */
    async rotateServerSigner(newServerPubKey: Bytes, checkpointTapscript: string): Promise<void> {
        const xonly = toXOnly(newServerPubKey, "ark signer key");

        // Validate the server-controlled checkpoint script FIRST (the provider defaults it to ""
        // when omitted), as `Wallet.create` does, so a bad rotation is side-effect-free and the
        // wallet stays on its previous consistent epoch. The forfeit pubkey doesn't rotate, so the
        // policy pins it to the boot value rather than trusting this response.
        const newServerUnrollScript = assertValidServerUnrollScript(
            checkpointTapscript,
            resolveCheckpointExitDelayPolicy(this.network, this.checkpointExitDelayPolicy),
        );

        // Fast path only; the authoritative re-check is inside `_doRotateServerSigner`.
        if (equalBytes(xonly, this.arkServerPublicKey)) return;

        if (this._receiveRotator) {
            // Ride the rotator's chain so a concurrent receive rotation can't
            // interleave with the server-key swap.
            await this._receiveRotator.runExclusive(() =>
                this._doRotateServerSigner(xonly, newServerUnrollScript),
            );
            return;
        }

        const run = this._serverRotationChain
            .catch(() => undefined)
            .then(() => this._doRotateServerSigner(xonly, newServerUnrollScript));
        this._serverRotationChain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async _doRotateServerSigner(
        xonly: Bytes,
        newServerUnrollScript: CSVMultisigTapscript.Type,
    ): Promise<void> {
        // Re-check under the serialization barrier: a prior queued rotation may
        // have already applied this signer.
        if (equalBytes(xonly, this.arkServerPublicKey)) return;

        const manager = await this.getContractManager();

        // Carry the current rows' signing metadata so a descriptor-backed owner keeps signing.
        const [currentOffchainRow] = await manager.getContracts({
            script: this.defaultContractScript,
        });
        const currentBoardingScript = hex.encode(this._boardingTapscript.pkScript);
        const [currentBoardingRow] = await manager.getContracts({
            script: currentBoardingScript,
        });

        // Build the new tapscripts locally, preserving every option but the
        // server key (mirrors `rebuildTapscript`, swapping serverPubKey).
        const newOffchain =
            this.offchainTapscript instanceof DelegateVtxo.Script
                ? new DelegateVtxo.Script({
                      ...this.offchainTapscript.options,
                      serverPubKey: xonly,
                  })
                : new DefaultVtxo.Script({
                      ...this.offchainTapscript.options,
                      serverPubKey: xonly,
                  });
        const newBoarding = new DefaultVtxo.Script({
            ...this._boardingTapscript.options,
            serverPubKey: xonly,
        });

        // Register BEFORE swapping visible state, so a throw never displays an unwatched address.
        const offchainCsv = timelockToSequence(newOffchain.options.csvTimelock).toString();
        const newOffchainScript = hex.encode(newOffchain.pkScript);
        const newOffchainAddress = newOffchain.address(this.network.hrp, xonly).encode();
        if (newOffchain instanceof DelegateVtxo.Script) {
            await manager.createContract({
                type: "delegate",
                params: {
                    pubKey: hex.encode(newOffchain.options.pubKey),
                    serverPubKey: hex.encode(xonly),
                    delegatePubKey: hex.encode(newOffchain.options.delegatePubKey),
                    csvTimelock: offchainCsv,
                },
                script: newOffchainScript,
                address: newOffchainAddress,
                state: "active",
                metadata: currentOffchainRow?.metadata,
            });
        } else {
            await manager.createContract({
                type: "default",
                params: {
                    pubKey: hex.encode(newOffchain.options.pubKey),
                    serverPubKey: hex.encode(xonly),
                    csvTimelock: offchainCsv,
                },
                script: newOffchainScript,
                address: newOffchainAddress,
                state: "active",
                metadata: currentOffchainRow?.metadata,
            });
        }

        const boardingCsv = newBoarding.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        await manager.createContract({
            type: "boarding",
            params: {
                pubKey: hex.encode(newBoarding.options.pubKey),
                serverPubKey: hex.encode(xonly),
                csvTimelock: timelockToSequence(boardingCsv).toString(),
            },
            script: hex.encode(newBoarding.pkScript),
            address: newBoarding.address(this.network.hrp, xonly).encode(),
            state: "active",
            metadata: currentBoardingRow?.metadata,
        });

        this.setOffchainTapscriptForRotation(newOffchain);
        this.setBoardingTapscriptForRotation(newBoarding);
        this.setArkServerPublicKeyForRotation(xonly);
        // Decoded up front in `rotateServerSigner`, so this commit cannot fail mid-rotation.
        this.setServerUnrollScriptForRotation(newServerUnrollScript);

        // The old band embedded the previous server key; speculative old-signer entries drop out
        // (persisted ones stay watched). Best-effort: the rotation has already committed.
        try {
            await manager.refillLookAhead();
        } catch (e) {
            console.warn("look-ahead refill after server-signer rotation failed", e);
        }
    }

    /**
     * Serializes `settle`/`send` so VtxoManager's background renewal can't race user
     * transactions for the same inputs; with `concurrentSpending`, only until inputs are reserved.
     */
    private _txLock: Promise<void> = Promise.resolve();

    /** Coalesces concurrent {@link restore} calls into one scan; cleared on settle. */
    private _restoreInFlight?: Promise<void>;

    private _addPendingSpends(inputs: readonly ExtendedCoin[]): void {
        for (const input of inputs) {
            if (isVirtualCoin(input)) {
                this._pendingSpendOutpoints.add(`${input.txid}:${input.vout}`);
            }
        }
    }

    private _removePendingSpends(inputs: readonly ExtendedCoin[]): void {
        for (const input of inputs) {
            if (isVirtualCoin(input)) {
                this._pendingSpendOutpoints.delete(`${input.txid}:${input.vout}`);
            }
        }
    }

    /**
     * Hold VTXOs so no SDK-chosen spend picks them; the holder still spends them by naming them.
     * All-or-nothing: throws {@link VtxoReservedError} if any is held or already being spent.
     * In-memory, for this `Wallet` instance only.
     */
    reserveVtxos(outpoints: readonly Outpoint[]): VtxoReservation {
        const keys = outpoints.map((o) => `${o.txid}:${o.vout}`);
        const inFlight = keys.filter(
            (k) => this._pendingSpendOutpoints.has(k) || this._claimedOutpoints.has(k),
        );
        if (inFlight.length > 0) throw new VtxoReservedError(inFlight, "in-flight");
        const held = keys.filter((k) => this._heldOutpoints.has(k));
        if (held.length > 0) throw new VtxoReservedError(held, "held");
        for (const k of keys) this._heldOutpoints.add(k);
        let released = false;
        return {
            outpoints: [...outpoints],
            release: () => {
                if (released) return;
                released = true;
                for (const k of keys) this._heldOutpoints.delete(k);
            },
        };
    }

    /**
     * @internal For `AssetManager`: with `concurrentSpending`, runs `fn` under the wallet lock and
     * reserves what it submits, releasing the lock once reserved. Otherwise runs `fn` unlocked,
     * exactly as before.
     */
    withSpendLock<T>(fn: (submit: OffchainSubmit) => Promise<T>): Promise<T> {
        if (!this._concurrentSpending) {
            return fn(async (inputs, outputs) => {
                this._assertNotHeld(inputs);
                const keys = coinKeys(inputs);
                for (const key of keys) this._claimedOutpoints.add(key);
                try {
                    return await this.buildAndSubmitOffchainTx(inputs, outputs);
                } finally {
                    for (const key of keys) this._claimedOutpoints.delete(key);
                }
            });
        }
        return this._withTxLock((release) =>
            fn(async (inputs, outputs) => {
                this._assertNotHeld(inputs);
                this._assertNotInFlight(inputs);
                this._addPendingSpends(inputs);
                release();
                try {
                    return await this.buildAndSubmitOffchainTx(inputs, outputs);
                } finally {
                    this._removePendingSpends(inputs);
                }
            }),
        );
    }

    private _withTxLock<T>(fn: (release: () => void) => Promise<T>): Promise<T> {
        let release!: () => void;
        const lock = new Promise<void>((r) => (release = r));
        const prev = this._txLock;
        this._txLock = lock;
        return prev.then(async () => {
            try {
                return await fn(release);
            } finally {
                release();
            }
        });
    }

    private _assertNotInFlight(inputs: readonly ExtendedCoin[]): void {
        const clashing = coinKeys(inputs).filter((key) => this._pendingSpendOutpoints.has(key));
        if (clashing.length > 0) throw new VtxoReservedError(clashing, "in-flight");
    }

    private _assertNotHeld(inputs: readonly ExtendedCoin[]): void {
        const held = coinKeys(inputs.filter(isVirtualCoin)).filter((key) =>
            this._heldOutpoints.has(key),
        );
        if (held.length > 0) throw new VtxoReservedError(held, "held");
    }

    /**
     * Explicitly recover this wallet's contracts and balance on a fresh repo: a gap-limit scan
     * for HD wallets, the single default pubkey otherwise. Throws on operational failure (a
     * truncated restore is loud), never because of identity/mode. Idempotent.
     *
     * Ordering: scan → advance the HD watermark → inline VTXO pull → only THEN surface handler
     * errors, so safely-discovered funds are recovered even when one handler failed.
     *
     * @param opts.gapLimit - Consecutive-unused-index window. Default 20. A non-positive /
     * non-integer value throws synchronously.
     *
     * @note Concurrent calls coalesce onto the running scan; their `gapLimit` is ignored.
     */
    async restore(opts?: { gapLimit?: number }): Promise<void> {
        // Coalesce FIRST so an ignored `gapLimit` never surfaces a misleading validation error.
        if (this._restoreInFlight) return this._restoreInFlight;
        const gapLimit = opts?.gapLimit ?? 20;
        if (!Number.isInteger(gapLimit) || gapLimit <= 0) {
            throw new Error(
                `restore: gapLimit must be a positive integer (got ${String(opts?.gapLimit)})`,
            );
        }
        this._restoreInFlight = (async () => {
            await this._runRestore(gapLimit);
            await runWalletRestoreHooks(this);
        })().finally(() => {
            this._restoreInFlight = undefined;
        });
        return this._restoreInFlight;
    }

    private async _runRestore(gapLimit: number): Promise<void> {
        const manager = await this.getContractManager();
        const provider = this._descriptorProvider;
        // `instanceof`, not duck-typing: a non-HD provider exposing a same-named method would be
        // mis-classified and TypeError mid-scan. Lift into a type guard if custom HD providers
        // are ever supported.
        const hd = provider instanceof HDDescriptorProvider;

        const staticDescriptor = hd ? undefined : await identityDescriptor(this.identity);
        const materialize = (index: number): string =>
            hd ? provider.materializeDescriptorAt(index) : staticDescriptor!;

        const delegatePubKey =
            this.offchainTapscript instanceof DelegateVtxo.Script
                ? this.offchainTapscript.options.delegatePubKey
                : undefined;

        // Current and deprecated signers from one fresh snapshot so they're mutually consistent
        // (NArk parity), rather than mixing a stale instance signer with fresh history.
        const arkInfo = await this.arkProvider.getInfo();
        const currentSignerPubKey = toXOnly(hex.decode(arkInfo.signerPubkey), "ark signer key");
        const deprecatedSignerPubKeys = arkInfo.deprecatedSigners.map((s) =>
            toXOnly(hex.decode(s.pubkey), "deprecated signer key"),
        );

        const deps: DiscoveryDeps = {
            indexerProvider: this.indexerProvider,
            onchainProvider: this.onchainProvider,
            network: { hrp: this.network.hrp },
            // The boarding P2TR probe needs `bech32`, which `{ hrp }` lacks.
            onchainNetwork: this.network,
            serverPubKey: currentSignerPubKey,
            deprecatedSignerPubKeys,
            csvTimelocks: this.walletContractTimelocks,
            // Boarding-exit CSV, distinct from the unilateral-exit matrix.
            boardingTimelock:
                this.boardingTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK,
            delegatePubKey,
        };

        const result = await manager.scanContracts({
            gapLimit,
            hd,
            materialize,
            deps,
        });

        // Advanced even on a truncated scan: a caller that swallows the error
        // below would otherwise be handed an already-funded index as a fresh
        // receive address. See `ScanResult.highestConfirmedUsedIndex`.
        if (hd && result.highestConfirmedUsedIndex >= 0) {
            await manager.advanceSigningDescriptorWatermark(result.highestConfirmedUsedIndex);
        }

        // Leave the wallet watching ahead of the watermark the scan just moved.
        await manager.refillLookAhead();

        // Inline pull BEFORE surfacing handler errors. `after: 0` is load-bearing: otherwise the
        // pull inherits the global cursor (already advanced by the boot reconcile) and recovers
        // only the last OVERLAP_MS of the newly discovered contracts' history.
        await manager.refreshVtxos({ includeInactive: true, after: 0 });

        const causes = result.handlerErrors.map((e) =>
            e.error instanceof Error ? e.error : new Error(String(e.error)),
        );

        if (result.truncatedAt !== undefined) {
            throw new AggregateError(
                causes,
                `restore: scan truncated at index ${result.truncatedAt}; indices >= ` +
                    `${result.truncatedAt} are unverified (${result.handlerErrors.length} ` +
                    `discovery handler failure(s)). Retry is safe (idempotent).`,
            );
        }

        // Unreachable via `ContractManager`, which always pairs errors with
        // `truncatedAt`; kept so a third-party `IContractManager` that doesn't
        // still fails loudly.
        if (result.handlerErrors.length > 0) {
            throw new AggregateError(
                causes,
                `restore: ${result.handlerErrors.length} discovery handler(s) failed; ` +
                    `the gap window may have closed early — retry is safe (idempotent).`,
            );
        }
    }

    public readonly settlementConfig: SettlementConfig | false;

    private _concurrentSpending = false;
    // Inputs an asset operation without concurrentSpending is submitting: refused by
    // reserveVtxos, but not hidden from reads the way the pending set hides them.
    private readonly _claimedOutpoints = new Set<string>();
    private _submitsAwaitingFinalize = 0;

    /** @see WalletConfig.concurrentSpending */
    get concurrentSpending(): boolean {
        return this._concurrentSpending;
    }

    /** Public here; `ReadonlyWallet` keeps it protected so a readonly view can't submit. */
    declare readonly arkProvider: ArkProvider;

    /**
     * Broadcast access bound to this wallet's server, so a plugin needs only the wallet. Not on
     * {@link ReadonlyWallet}: a readonly wallet or `toReadonly()` view must not be able to submit.
     */
    async getArkadeBroadcaster(): Promise<ArkadeBroadcaster> {
        const ark = this.arkProvider;
        return {
            submitTx: (signedArkTx, checkpointTxs) => ark.submitTx(signedArkTx, checkpointTxs),
            finalizeTx: (arkTxid, finalCheckpointTxs) =>
                ark.finalizeTx(arkTxid, finalCheckpointTxs),
        };
    }

    protected constructor(
        identity: Identity,
        network: Network,
        onchainProvider: OnchainProvider,
        arkProvider: ArkProvider,
        indexerProvider: IndexerProvider,
        arkServerPublicKey: Bytes,
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        boardingTapscript: DefaultVtxo.Script,
        serverUnrollScript: CSVMultisigTapscript.Type,
        readonly forfeitOutputScript: Bytes,
        readonly forfeitPubkey: Bytes,
        dustAmount: bigint,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository,
        delegateProvider?: DelegateProvider,
        watcherConfig?: WalletConfig["watcherConfig"],
        settlementConfig?: WalletConfig["settlementConfig"],
        walletContractTimelocks?: RelativeTimelock[],
        receiveRotator?: WalletReceiveRotator,
        descriptorProvider?: DescriptorProvider,
        lookAheadWindow?: number,
        /** Overrides for the `batchExpiry` bounds; defaults derive from `network`. */
        protected readonly batchExpiryPolicy?: Partial<BatchExpiryPolicy>,
        /** Overrides for the checkpoint exit delay bounds; defaults derive from `network`. */
        protected readonly checkpointExitDelayPolicy?: Partial<CheckpointExitDelayPolicy>,
    ) {
        super(
            identity,
            network,
            onchainProvider,
            arkProvider,
            indexerProvider,
            arkServerPublicKey,
            offchainTapscript,
            boardingTapscript,
            dustAmount,
            walletRepository,
            contractRepository,
            delegateProvider,
            watcherConfig,
            walletContractTimelocks,
        );
        this.identity = identity;

        this.settlementConfig =
            settlementConfig !== undefined ? settlementConfig : { ...DEFAULT_SETTLEMENT_CONFIG };
        this._delegateManager = delegateProvider
            ? new DelegateManagerImpl(delegateProvider, arkProvider, identity)
            : undefined;
        this._serverUnrollScript = serverUnrollScript;
        this._receiveRotator = receiveRotator;
        this._descriptorProvider = descriptorProvider;
        this._lookAheadWindow = lookAheadWindow ?? DEFAULT_LOOK_AHEAD_WINDOW;
        this._signerRouter = new InputSignerRouter({
            identity,
            contractRepository,
            descriptorProvider,
            boardingPkScript: boardingTapscript.pkScript,
        });
    }

    override get assetManager(): IAssetManager {
        this._walletAssetManager ??= new AssetManager(this);
        return this._walletAssetManager;
    }

    async getVtxoManager(): Promise<VtxoManager> {
        if (this._vtxoManager) {
            return this._vtxoManager;
        }

        if (this._vtxoManagerInitializing) {
            return this._vtxoManagerInitializing;
        }

        this._vtxoManagerInitializing = Promise.resolve(
            new VtxoManager(this, this.settlementConfig),
        );

        try {
            const manager = await this._vtxoManagerInitializing;
            // Install the HD rotator once, AFTER baseline contracts are registered. Cache the
            // manager and flip the flag only after `install()` resolves, or a failing install
            // would silently disable HD rotation for this wallet's lifetime.
            if (this._receiveRotator && !this._receiveRotatorInstalled) {
                try {
                    await this._receiveRotator.install(this);
                } catch (installErr) {
                    await manager.dispose();
                    throw installErr;
                }
                this._receiveRotatorInstalled = true;
            }
            this._vtxoManager = manager;
            return manager;
        } finally {
            this._vtxoManagerInitializing = undefined;
        }
    }

    override async dispose(): Promise<void> {
        // Drain an in-flight restore so it can't hit torn-down managers (deadlock-free:
        // _runRestore never calls dispose()).
        await this._restoreInFlight?.catch(() => undefined);

        this._serverInfoUnsub?.();
        this._serverInfoUnsub = undefined;
        await this.settleServerInfoChanges();

        // Rotator first, so no late `vtxo_received` queues work and in-flight `createContract`
        // finishes before the contract manager goes. Its failure is rethrown at the end so the
        // rest of teardown still runs.
        let rotatorError: unknown;
        try {
            await this._receiveRotator?.dispose();
        } catch (error) {
            rotatorError = error;
        }

        const manager =
            this._vtxoManager ??
            (this._vtxoManagerInitializing
                ? await this._vtxoManagerInitializing.catch(() => undefined)
                : undefined);
        try {
            if (manager) {
                await manager.dispose();
            }
        } catch {
            // best-effort teardown; ensure super.dispose() still runs
        } finally {
            this._vtxoManager = undefined;
            this._vtxoManagerInitializing = undefined;
            await super.dispose();
        }

        if (rotatorError) {
            throw rotatorError;
        }
    }

    /**
     * Create a full wallet and initialize its background managers.
     *
     * @param config - Wallet configuration
     * @returns A wallet ready to query balances and send transactions
     * @example
     * ```typescript
     * const wallet = await Wallet.create({
     *   identity,
     *   arkProvider: new RestArkProvider(),
     * });
     * ```
     */
    static async create(config: WalletConfig): Promise<Wallet> {
        // Programmer error, not an operational one — surface it before any I/O.
        if (
            config.lookAheadWindow !== undefined &&
            (!Number.isInteger(config.lookAheadWindow) || config.lookAheadWindow <= 0)
        ) {
            throw new Error(
                `lookAheadWindow must be a positive integer (got ${String(config.lookAheadWindow)})`,
            );
        }
        const pubkey = await config.identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        const setup = await ReadonlyWallet.setupWalletConfig(config, pubkey);

        // The server expects forfeited funds at this address.
        const forfeitPubkey = toXOnly(hex.decode(setup.info.forfeitPubkey), "forfeit key");
        const forfeitAddress = Address(setup.network).decode(setup.info.forfeitAddress);
        const forfeitOutputScript = OutScript.encode(forfeitAddress);

        // Checkpoint output script. No prior pin at first contact (TOFU, like
        // `arkServerPublicKey`): the forfeitPubkey check only catches malformed responses; the
        // exit-delay floor is the real defense against a malicious operator.
        const checkpointExitDelayOverrides: Partial<CheckpointExitDelayPolicy> = {
            advertisedForfeitPubkey: forfeitPubkey,
            ...(config.minCheckpointExitDelaySeconds !== undefined
                ? { minSeconds: config.minCheckpointExitDelaySeconds }
                : {}),
        };
        const serverUnrollScript = assertValidServerUnrollScript(
            setup.info.checkpointTapscript,
            resolveCheckpointExitDelayPolicy(setup.network, checkpointExitDelayOverrides),
        );

        // HD boot wiring; `getVtxoManager()` installs the rotator lazily.
        const boot = await WalletReceiveRotator.resolveBoot(config, setup);

        const wallet = new Wallet(
            config.identity,
            setup.network,
            setup.onchainProvider,
            setup.arkProvider,
            setup.indexerProvider,
            setup.serverPubKey,
            boot?.offchainTapscript ?? setup.offchainTapscript,
            setup.boardingTapscript,
            serverUnrollScript,
            forfeitOutputScript,
            forfeitPubkey,
            setup.dustAmount,
            setup.walletRepository,
            setup.contractRepository,
            config.delegateProvider,
            config.watcherConfig,
            config.settlementConfig,
            setup.walletContractTimelocks,
            boot?.rotator,
            boot?.provider,
            config.lookAheadWindow,
            // Pinned at setup rather than refetched per round.
            {
                advertisedVtxoTreeExpiry: setup.info.vtxoTreeExpiry,
                ...(config.minBatchExpirySeconds !== undefined
                    ? { minSeconds: config.minBatchExpirySeconds }
                    : {}),
            },
            checkpointExitDelayOverrides,
        );
        wallet._serverInfoSource = setup.serverInfoSource;
        // Construction validated the response, so it is now safe to refresh the cached snapshot.
        if (setup.serverInfoSource === "live") {
            const now = Date.now();
            await saveValidatedArkInfoSnapshot(setup.walletRepository, setup.info, now);
            wallet._serverInfoLastOnlineAt = now;
        } else {
            wallet._serverInfoLastOnlineAt = setup.serverInfoLastOnlineAt;
        }
        wallet.refreshDeprecatedSigners(setup.info);
        // Re-derive signer-dependent state when the provider refetches info on DIGEST_MISMATCH.
        // Duck-typed: only RestArkProvider implements it.
        {
            const ap = setup.arkProvider as Partial<{
                onServerInfoChanged(
                    cb: (info: {
                        signerPubkey: string;
                        checkpointTapscript: string;
                        deprecatedSigners?: readonly { pubkey?: string; cutoffDate?: bigint }[];
                    }) => void,
                ): () => void;
            }>;
            if (typeof ap.onServerInfoChanged === "function") {
                wallet._serverInfoUnsub = ap.onServerInfoChanged((info) => {
                    wallet._serverInfoInFlight = wallet._serverInfoInFlight
                        .then(() => wallet.handleServerInfoChanged(info))
                        .catch(() => undefined);
                });
            }
        }

        // Restore the latest boarding address. Swapped here, after construction, because the
        // signer router's boarding fallback and the baseline boarding row must anchor to index 0.
        if (boot?.provider) {
            const resolvedBoarding = await resolveBoardingBootTapscript(
                setup.contractRepository,
                setup.serverPubKey,
                setup.boardingTapscript,
            );
            if (resolvedBoarding !== setup.boardingTapscript) {
                wallet.setBoardingTapscriptForRotation(resolvedBoarding);
            }
        }

        wallet.intentRepository = config.storage?.intentRepository;
        wallet.virtualTxRepository = config.storage?.virtualTxRepository;
        wallet.exitDataCapture = config.storage?.exitDataCapture;
        wallet._concurrentSpending = config.concurrentSpending === true;

        await wallet.getVtxoManager();
        return wallet;
    }

    /**
     * Convert this wallet to a readonly wallet.
     *
     * @returns A readonly wallet with the same configuration but readonly identity
     * @example
     * ```typescript
     * const wallet = await Wallet.create({ identity: MnemonicIdentity.fromMnemonic('abandon abandon...'), ... });
     * const readonlyWallet = await wallet.toReadonly();
     *
     * // Can query balance and addresses
     * const balance = await readonlyWallet.getBalance();
     * const address = await readonlyWallet.getAddress();
     *
     * // But cannot send transactions (type error)
     * // readonlyWallet.send(...); // TypeScript error
     * ```
     */
    async toReadonly(): Promise<ReadonlyWallet> {
        const readonlyIdentity: ReadonlyIdentity = hasToReadonly(this.identity)
            ? await this.identity.toReadonly()
            : this.identity; // Identity extends ReadonlyIdentity, so this is safe

        const readonly = new ReadonlyWallet(
            readonlyIdentity,
            this.network,
            this.onchainProvider,
            this.arkProvider,
            this.indexerProvider,
            this.arkServerPublicKey,
            this.offchainTapscript,
            this.boardingTapscript,
            this.dustAmount,
            this.walletRepository,
            this.contractRepository,
            this.delegateProvider,
            this.watcherConfig,
            this.walletContractTimelocks,
        );
        // Carry the cached deprecated-signer set (with cutoffs) so the clone's
        // boarding watch path and spendability split match the source wallet's.
        (readonly as unknown as { _deprecatedSigners: Map<string, bigint> })._deprecatedSigners =
            new Map(this._deprecatedSigners);
        return readonly;
    }

    /** Returns the delegate manager when delegation support is configured. */
    async getDelegateManager(): Promise<IDelegateManager | undefined> {
        return this._delegateManager;
    }

    /**
     * Settle boarding inputs and/or virtual outputs into a finalized mainnet transaction.
     *
     * `params.inputs` is **ungated** (how an escrowed deposit is recovered by hand), so
     * `settle({ inputs: await wallet.getVtxos() })` bypasses the gate; pass
     * {@link getSpendableVtxos} to settle "whatever is spendable".
     *
     * @param params - Optional settlement inputs and outputs. When omitted, the wallet settles all eligible funds.
     * @param eventCallback - Optional callback invoked for settlement stream events.
     * @returns The finalized Arkade transaction id
     */
    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void,
    ): Promise<string> {
        return this._withTxLock((release) =>
            this._settleImpl(params, eventCallback, this._concurrentSpending ? release : undefined),
        );
    }

    private async _settleImpl(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void,
        onReserved?: () => void,
    ): Promise<string> {
        const picked = params === undefined || isSdkPicked(params);
        if (params?.inputs) {
            for (const input of params.inputs) {
                // validate arknotes inputs
                if (typeof input === "string") {
                    try {
                        ArkNote.fromString(input);
                    } catch (e) {
                        throw new Error(`Invalid arknote "${input}"`);
                    }
                }
            }
            void this.logUngatedInputs("settle({ inputs })", params.inputs as ExtendedCoin[]);
        }

        // Read once: `WalletReceiveRotator.rotate` mutates `offchainTapscript` without `_txLock`,
        // and a second read could mismatch `findDestinationOutputIndex` ("no output matches").
        const offchainAddress = await this.getAddress();
        const offchainPkScript = ArkAddress.decode(offchainAddress).pkScript;
        const offchainOutputScript = hex.encode(offchainPkScript);

        // if no params are provided, use all non-expired boarding inputs and offchain virtual outputs as inputs
        // and send all to the offchain address
        if (!params) {
            const { fees, vtxoMaxAmount } = await this.arkProvider.getInfo();
            const estimator = new Estimator(fees.intentFee);

            let amount = 0;

            const exitScript = CSVMultisigTapscript.decode(
                hex.decode(this.boardingTapscript.exitScript),
            );

            const boardingTimelock = exitScript.params.timelock;

            // For block-based timelocks, fetch the chain tip height
            let chainTipHeight: number | undefined;
            if (boardingTimelock.type === "blocks") {
                const tip = await this.onchainProvider.getChainTip();
                chainTipHeight = tip.height;
            }

            const boardingUtxos = (await this.getBoardingUtxos()).filter(
                (utxo) =>
                    utxo.status.confirmed &&
                    !hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight),
            );

            const filteredBoardingUtxos = [];
            for (const utxo of boardingUtxos) {
                const inputFee = estimator.evalOnchainInput({
                    amount: BigInt(utxo.value),
                });
                if (inputFee.satoshis >= utxo.value) {
                    // skip if fees are greater than the boarding input value
                    continue;
                }

                filteredBoardingUtxos.push(utxo);
                amount += utxo.value - inputFee.satoshis;
            }

            const vtxos = await this.getSpendableVtxos({
                withRecoverable: true,
                genericallySpendableOnly: true,
            });

            // Cap to the server's intent-size limit (MAX_VTXOS_PER_SETTLEMENT) and per-output
            // ceiling (vtxoMaxAmount; -1 = none), highest value first, counting only economic
            // VTXOs so an uneconomic prefix can't starve the rest. Boarding inputs are uncapped
            // but count toward the amount. Overflow settles on the next call.
            const filteredVtxos = [];
            for (const vtxo of byValueDescending(vtxos)) {
                if (filteredVtxos.length >= MAX_VTXOS_PER_SETTLEMENT) {
                    break;
                }
                const inputFee = estimator.evalOffchainInput(toOffchainInputFeeParams(vtxo));
                if (inputFee.satoshis >= vtxo.value) {
                    // skip if fees are greater than the virtual output value
                    continue;
                }

                const net = vtxo.value - inputFee.satoshis;
                // Skip, don't stop: a smaller VTXO can still fit. Compared post output fee,
                // which is what the server actually receives.
                if (vtxoMaxAmount >= 0n) {
                    const projectedAmount = BigInt(amount + net);
                    const projectedOutputFee = estimator.evalOffchainOutput({
                        amount: projectedAmount,
                        script: offchainOutputScript,
                    });
                    if (projectedAmount - BigInt(projectedOutputFee.satoshis) > vtxoMaxAmount) {
                        continue;
                    }
                }

                filteredVtxos.push(vtxo);
                amount += net;
            }

            const inputs = [...filteredBoardingUtxos, ...filteredVtxos];
            if (inputs.length === 0) {
                throw new Error("No inputs found");
            }

            const output = {
                address: offchainAddress,
                amount: BigInt(amount),
            };

            const outputFee = estimator.evalOffchainOutput({
                amount: output.amount,
                script: offchainOutputScript,
            });

            output.amount -= BigInt(outputFee.satoshis);

            if (isSubdust(output.amount, this.dustAmount)) {
                throw new Error("Output amount is below dust limit");
            }

            params = {
                inputs,
                outputs: [output],
            };
        }

        params = {
            ...params,
            inputs: await refreshSweptStateOfExpiredInputs(this, params.inputs),
        };
        if (onReserved) this._assertNotInFlight(params.inputs);

        const onchainOutputIndexes: number[] = [];
        const outputs: TransactionOutput[] = [];
        let hasOffchainOutputs = false;

        let recipientContext: RecipientArkadeAddressContext | undefined;
        for (const [index, output] of params.outputs.entries()) {
            let script: Bytes | undefined;

            // decode only: a binding failure must surface as its own error,
            // not fall through to the onchain branch
            let arkAddress: ArkAddress | undefined;
            try {
                arkAddress = ArkAddress.decode(output.address);
            } catch {
                arkAddress = undefined;
            }

            if (arkAddress) {
                recipientContext ??= this.recipientAddressContext();
                assertRecipientArkadeAddress(output.address, arkAddress, recipientContext);
                script = arkAddress.pkScript;
                hasOffchainOutputs = true;
            } else {
                const addr = Address(this.network).decode(output.address);
                script = OutScript.encode(addr);
                onchainOutputIndexes.push(index);
            }

            outputs.push({
                amount: output.amount,
                script,
            });
        }

        // if some of the inputs hold assets, build the asset packet and append as output
        // in the intent proof tx, there is a "fake" input at index 0
        // so the real coin indices are offset by +1
        const assetInputs = new Map<number, Asset[]>();
        for (let i = 0; i < params.inputs.length; i++) {
            if ("assets" in params.inputs[i]) {
                const assets = (params.inputs[i] as unknown as VirtualCoin).assets;
                if (assets && assets.length > 0) {
                    assetInputs.set(i + 1, assets);
                }
            }
        }

        let outputAssets: Asset[] | undefined;

        const assetOutputIndex = findDestinationOutputIndex(outputs, offchainPkScript);

        if (assetInputs.size > 0) {
            if (assetOutputIndex === -1) {
                throw new Error("Cannot assign assets: no output matches the destination address");
            }
            // collect all input assets and assign them to the destination output
            const allAssets = new Map<string, bigint>();
            for (const [, assets] of assetInputs) {
                for (const asset of assets) {
                    const existing = allAssets.get(asset.assetId) ?? 0n;
                    allAssets.set(asset.assetId, existing + asset.amount);
                }
            }

            outputAssets = [];
            for (const [assetId, amount] of allAssets) {
                outputAssets.push({ assetId, amount });
            }
        }

        const recipients: Recipient[] = params.outputs.map((output, i) => ({
            address: output.address,
            amount: Number(output.amount),
            assets: i === assetOutputIndex ? outputAssets : undefined,
        }));

        if (outputAssets && outputAssets.length > 0) {
            const assetPacket = createAssetPacket(assetInputs, recipients);
            outputs.push(Extension.create([assetPacket]).txOut());
        }

        // session holds the state of the musig2 signing process of the virtual output tree
        let session: SignerSession | undefined;
        const signingPublicKeys: string[] = [];
        if (hasOffchainOutputs) {
            session = this.identity.signerSession();
            signingPublicKeys.push(hex.encode(await session.getPublicKey()));
        }

        const [intent, deleteIntent] = await Promise.all([
            this.makeRegisterIntentSignature(
                params.inputs,
                outputs,
                onchainOutputIndexes,
                signingPublicKeys,
            ),
            this.makeDeleteIntentSignature(params.inputs),
        ]);

        // Client-side intent key: the intent proof's txid (NArk parity).
        // Falls back to a deterministic outpoint digest if the special
        // intent PSBT can't be decoded — keeps persistence resilient.
        let intentTxId: string;
        try {
            intentTxId = Transaction.fromPSBT(base64.decode(intent.proof)).id;
        } catch {
            intentTxId = params.inputs
                .map((i) => `${i.txid}:${i.vout}`)
                .sort()
                .join("|");
        }
        await this.persistIntentSnapshot(
            intentTxId,
            "waiting_to_submit",
            intent,
            deleteIntent,
            params.inputs,
        );

        const topics = [
            ...signingPublicKeys,
            ...params.inputs.map((input) => `${input.txid}:${input.vout}`),
        ];

        const abortController = new AbortController();
        let stream: AsyncIterableIterator<SettlementEvent> | undefined;
        // Set just before registering: a failure earlier has no server intent to delete.
        let registering = false;
        // Set once Batch.join returns: the batch is committed on-chain and no
        // local cleanup failure may cancel it. Authoritative in memory even if
        // the hook's terminal repo write failed, which repo state can't tell us.
        let committedTxid: string | undefined;

        // Last check before anything leaves the wallet: `updateDbAfterSettle` re-annotates these
        // inputs only after the batch finalized. After the cheap local validation, before the
        // intent; arknotes and boarding inputs carry no vtxo script.
        const settleInputVtxos = params.inputs.filter(isVirtualCoin);
        const contractManager = await this.getContractManager();
        await contractManager.assertAnnotatable(settleInputVtxos);
        // Immature timelocks otherwise register fine and are refused server-side, unhelpfully.
        // Only certain handlers answer, so a no-op for ordinary coins.
        await contractManager.assertSpendableNow?.(settleInputVtxos, async () =>
            hex.encode(await this.identity.xOnlyPublicKey()),
        );

        const boardingKeys = onReserved
            ? coinKeys(params.inputs.filter((i) => !isVirtualCoin(i)))
            : [];
        try {
            // After the last await, so a hold placed during signing is caught; before the inputs
            // go pending, so the holder can spend them while this settle unwinds.
            if (picked) this._assertNotHeld(params.inputs);
            // Hide the inputs from concurrent getVtxos() callers before the intent registers.
            this._addPendingSpends(params.inputs);
            for (const key of boardingKeys) this._pendingSpendOutpoints.add(key);
            onReserved?.();
            stream = this.arkProvider.getEventStream(abortController.signal, topics);

            // Prime the iterator so the provider opens the SSE subscription
            // before safeRegisterIntent can trigger server-side batch events.
            const firstNext = stream.next();
            // If settle exits before Batch.join consumes the primed result,
            // keep the orphaned promise from surfacing as an unhandled rejection.
            void firstNext.catch(() => {});
            const primedStream = (async function* () {
                const first = await firstNext;
                if (!first.done) {
                    yield first.value;
                }
                yield* stream;
            })();

            registering = true;
            const intentId = await this.safeRegisterIntent(intent, params.inputs);

            await this.persistIntentSnapshot(
                intentTxId,
                "waiting_for_batch",
                intent,
                deleteIntent,
                params.inputs,
                { intentId },
            );

            // SDK-owned intent persistence runs from the awaited batch hooks;
            // the caller's eventCallback stays purely observational.
            const handler = wrapHandlerWithIntentPersistence(
                this.createBatchHandler(intentId, params.inputs, recipients, session),
                { intentRepository: this.intentRepository, intentTxId },
            );

            const commitmentTxid = await Batch.join(primedStream, handler, {
                abortController,
                skipVtxoTreeSigning: !hasOffchainOutputs,
                // async so a synchronous throw becomes a rejection Batch.join
                // swallows, keeping the observational callback off the stream path.
                eventCallback:
                    eventCallback &&
                    (async (event) => {
                        await eventCallback(event);
                    }),
            });
            committedTxid = commitmentTxid;

            await this.updateDbAfterSettle(params.inputs, commitmentTxid);

            await this.maybeRotateBoardingAfterBoard(params.inputs);

            return commitmentTxid;
        } catch (error) {
            if (committedTxid !== undefined) {
                // Committed, then a local step threw: the settlement stands, never cancel it.
                // Re-persist success in case the hook's write failed (no-op if it landed).
                await this.persistIntentSnapshot(
                    intentTxId,
                    "batch_succeeded",
                    intent,
                    deleteIntent,
                    params.inputs,
                    { commitmentTransactionId: committedTxid },
                );
                throw error;
            }
            // Pre-commit failure: release the server intent so the next settle
            // doesn't hit "duplicated input", and record the cancellation.
            const inputIds = params.inputs.map((i) => `${i.txid}:${i.vout}`).join(",");
            if (registering) {
                await this.arkProvider.deleteIntent(deleteIntent).catch((e) => {
                    console.warn(
                        `Failed to delete intent after settle failure for inputs [${inputIds}]; intent may linger on server and cause 'duplicated input' on next settle`,
                        e,
                    );
                });
            }
            await this.persistIntentSnapshot(
                intentTxId,
                "cancelled",
                intent,
                deleteIntent,
                params.inputs,
                {
                    cancellationReason: error instanceof Error ? error.message : String(error),
                },
            );
            throw error;
        } finally {
            // Clear first so a synchronous handler firing from abort() never sees stale state.
            this._removePendingSpends(params.inputs);
            for (const key of boardingKeys) this._pendingSpendOutpoints.delete(key);
            // abort() covers a started generator; return() also releases one that never ran.
            abortController.abort();
            await stream?.return?.().catch(() => {});
        }
    }

    /**
     * Rotate-on-board: the boarding analogue of {@link WalletReceiveRotator}'s L2 rotation.
     * Boarding has no on-chain receive event (the watcher sees only the L2 indexer), so a settle
     * consuming a boarding UTXO (a non-VTXO, non-arknote input) is the trigger. No-op without a
     * descriptor provider. Best-effort: the settle has committed, so failures are only logged.
     */
    private async maybeRotateBoardingAfterBoard(inputs: SettleParams["inputs"]): Promise<void> {
        if (!this._descriptorProvider) return;
        const consumedBoarding = inputs.some(
            (input) => typeof input !== "string" && !isVirtualCoin(input),
        );
        if (!consumedBoarding) return;
        try {
            await this.getNewBoardingAddress();
        } catch (e) {
            console.warn("Failed to rotate boarding address after board", e);
        }
    }

    private async handleSettlementFinalizationEvent(
        event: BatchFinalizationEvent,
        inputs: SettleParams["inputs"],
        forfeitOutputScript: Bytes,
        expectedRecipients: Recipient[],
        connectorsGraph?: TxTree,
        validatedCommitmentTxid?: string,
    ) {
        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        let settlementPsbt = Transaction.fromPSBT(base64.decode(event.commitmentTx));
        assertFinalCommitmentMatchesValidated(
            settlementPsbt,
            validatedCommitmentTxid,
            "settlement finalization",
        );

        // No validated txid ⇒ tree signing never ran (onchain-only settle), so check recipients
        // here, before any signature (boarding or forfeit) is handed over.
        if (!validatedCommitmentTxid && expectedRecipients.length > 0) {
            validateBatchRecipientsWithoutTree(settlementPsbt, expectedRecipients, this.network);
        }
        let hasBoardingUtxos = false;

        let connectorIndex = 0;

        const connectorsLeaves = connectorsGraph?.leaves() || [];

        for (const input of inputs) {
            // boarding input, we need to sign the settlement tx
            if (!isVirtualCoin(input)) {
                let matched = false;
                for (let i = 0; i < settlementPsbt.inputsLength; i++) {
                    const settlementInput = settlementPsbt.getInput(i);

                    if (!settlementInput.txid || settlementInput.index === undefined) {
                        throw new Error(
                            "The server returned incomplete data. No settlement input found in the PSBT",
                        );
                    }
                    const inputTxId = hex.encode(settlementInput.txid);
                    if (inputTxId !== input.txid) continue;
                    if (settlementInput.index !== input.vout) continue;
                    // input found in the settlement tx, sign it
                    settlementPsbt.updateInput(i, {
                        tapLeafScript: [input.forfeitTapLeafScript],
                    });
                    const script = settlementPsbt.getInput(i).witnessUtxo?.script;
                    if (!script) {
                        throw new Error(
                            "The server returned incomplete data. Settlement input is missing witnessUtxo.script",
                        );
                    }
                    settlementPsbt = await this._signerRouter.sign(settlementPsbt, [
                        { index: i, lookupScript: script },
                    ]);
                    // The signer router silently skips inputs it can't resolve,
                    // which would leave this boarding input unsigned and cause
                    // arkd to reject it as "not a wallet script". Fail early.
                    if (!settlementPsbt.getInput(i).tapScriptSig?.length) {
                        throw new Error(await this.unsignableBoardingInputError(input, script));
                    }
                    hasBoardingUtxos = true;
                    matched = true;
                    break;
                }

                // Else the forfeits settle and this input is left behind. Arknotes spend no
                // commitment input, so they're exempt.
                if (!matched && !(input instanceof ArkNote)) {
                    throw new Error(
                        `boarding input ${input.txid}:${input.vout} is not an input of the commitment tx`,
                    );
                }

                continue;
            }

            if (!requiresForfeit(input) || isSubdust({ value: input.value }, this.dustAmount)) {
                // swept, unrolled or subdust coin, we don't need to create a forfeit tx
                continue;
            }

            if (connectorsLeaves.length === 0) {
                throw new Error("connectors not received");
            }

            if (connectorIndex >= connectorsLeaves.length) {
                throw new Error("not enough connectors received");
            }

            const connectorLeaf = connectorsLeaves[connectorIndex];
            const connectorTxId = connectorLeaf.id;
            const connectorOutput = connectorLeaf.getOutput(0);
            if (!connectorOutput) {
                throw new Error("connector output not found");
            }

            const connectorAmount = connectorOutput.amount;
            const connectorPkScript = connectorOutput.script;

            if (!connectorAmount || !connectorPkScript) {
                throw new Error("invalid connector output");
            }

            connectorIndex++;

            let forfeitTx = buildForfeitTx(
                [
                    {
                        txid: input.txid,
                        index: input.vout,
                        witnessUtxo: {
                            amount: BigInt(input.value),
                            script: VtxoScript.decode(input.tapTree).pkScript,
                        },
                        sighashType: SigHash.DEFAULT,
                        tapLeafScript: [input.forfeitTapLeafScript],
                    },
                    {
                        txid: connectorTxId,
                        index: 0,
                        witnessUtxo: {
                            amount: connectorAmount,
                            script: connectorPkScript,
                        },
                    },
                ],
                forfeitOutputScript,
            );

            // do not sign the connector input
            forfeitTx = await this._signerRouter.sign(forfeitTx, [
                {
                    index: 0,
                    lookupScript: VtxoScript.decode(input.tapTree).pkScript,
                },
            ]);

            signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }

        if (signedForfeits.length > 0 || hasBoardingUtxos) {
            await this.arkProvider.submitSignedForfeitTxs(
                signedForfeits,
                hasBoardingUtxos ? base64.encode(settlementPsbt.toPSBT()) : undefined,
            );
        }
    }

    // Best-effort: every enrichment is guarded so a secondary failure can't
    // mask the original signing error.
    private async unsignableBoardingInputError(
        input: { txid: string; vout: number },
        script: Bytes,
    ): Promise<string> {
        const scriptHex = hex.encode(script);
        let unresolvedAddress = "<undecodable>";
        try {
            unresolvedAddress = Address(this.network).encode(OutScript.decode(script));
        } catch {}
        let recognized = "<unavailable>";
        try {
            const current = await this.getBoardingAddress();
            const all = await this.getBoardingAddresses();
            recognized = `current=${current}; all=[${all.join(", ")}]`;
        } catch {}
        return (
            `failed to sign boarding input ${input.txid}:${input.vout}: ` +
            `signer did not recognize script ${scriptHex} (${unresolvedAddress}); ` +
            `would have reached arkd unsigned and been rejected as "not a wallet script". ` +
            `Recognized boarding addresses: ${recognized}. ` +
            `Likely a rotated boarding address with a missing contract row.`
        );
    }

    /**
     * Create a batch event handler for settlement flows.
     *
     * @param intentId - The intent ID.
     * @param inputs - Inputs used by the intent.
     * @param expectedRecipients - Expected recipients to validate in the virtual output tree.
     * @param session - Optional musig2 signing session. When omitted, signing steps are skipped.
     */
    createBatchHandler(
        intentId: string,
        inputs: ExtendedCoin[],
        expectedRecipients: Recipient[],
        session?: SignerSession,
    ): Batch.Handler {
        let sweepTapTreeRoot: Uint8Array | undefined;
        // Assigned only after the tree it commits to has been validated, so it
        // always names a commitment tx this handler has checked.
        let validatedCommitmentTxid: string | undefined;
        return {
            onBatchStarted: async (event: BatchStartedEvent): Promise<{ skip: boolean }> => {
                const utf8IntentId = new TextEncoder().encode(intentId);
                const intentIdHash = sha256(utf8IntentId);
                const intentIdHashStr = hex.encode(intentIdHash);

                // check if our intent ID hash matches any in the event
                const skip = !event.intentIdHashes.includes(intentIdHashStr);

                if (skip) {
                    return { skip };
                }

                if (!this.arkProvider) {
                    throw new Error("Arkade provider not configured");
                }

                // Bound the expiry before confirming, so a rejected round is
                // never confirmed to the operator.
                const timelock = assertValidBatchExpiry(
                    event.batchExpiry,
                    resolveBatchExpiryPolicy(this.network, this.batchExpiryPolicy),
                );

                await this.arkProvider.confirmRegistration(intentId);

                const sweepTapscript = CSVMultisigTapscript.encode({
                    timelock,
                    pubkeys: [this.forfeitPubkey],
                }).script;

                sweepTapTreeRoot = tapLeafHash(sweepTapscript);

                return { skip: false };
            },
            onTreeSigningStarted: async (
                event: TreeSigningStartedEvent,
                vtxoTree: TxTree,
            ): Promise<{ skip: boolean }> => {
                if (!session) {
                    return { skip: true };
                }
                if (!sweepTapTreeRoot) {
                    throw new Error("Sweep tap tree root not set");
                }

                const xOnlyPublicKeys = event.cosignersPublicKeys.map((k) =>
                    hex.encode(toXOnly(hex.decode(k), "cosigner key")),
                );
                const signerPublicKey = await session.getPublicKey();
                const xonlySignerPublicKey = toXOnly(signerPublicKey, "signer key");

                if (!xOnlyPublicKeys.includes(hex.encode(xonlySignerPublicKey))) {
                    // not a cosigner, skip the signing
                    return { skip: true };
                }

                // validate the unsigned virtual output tree
                const commitmentTx = Transaction.fromPSBT(
                    base64.decode(event.unsignedCommitmentTx),
                );
                validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot);

                // validate that all expected receivers are in the virtual output tree with correct amounts and assets
                if (expectedRecipients && expectedRecipients.length > 0) {
                    validateBatchRecipients(
                        commitmentTx,
                        vtxoTree.leaves(),
                        expectedRecipients,
                        this.network,
                    );
                }

                const sharedOutput = commitmentTx.getOutput(0);
                if (!sharedOutput?.amount) {
                    throw new Error("Shared output not found");
                }

                validatedCommitmentTxid = commitmentTx.id;

                await session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);

                const pubkey = hex.encode(await session.getPublicKey());
                const nonces = await session.getNonces();

                await this.arkProvider.submitTreeNonces(event.id, pubkey, nonces);

                return { skip: false };
            },
            onTreeNonces: async (event: TreeNoncesEvent): Promise<{ fullySigned: boolean }> => {
                if (!session) {
                    return { fullySigned: true }; // Signing complete (no signing needed)
                }

                const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces);

                // wait to receive and aggregate all nonces before sending signatures
                if (!hasAllNonces) return { fullySigned: false };

                const signatures = await session.sign();
                const pubkey = hex.encode(await session.getPublicKey());

                await this.arkProvider.submitTreeSignatures(event.id, pubkey, signatures);
                return { fullySigned: true };
            },
            onBatchFinalization: async (
                event: BatchFinalizationEvent,
                _?: TxTree,
                connectorTree?: TxTree,
            ): Promise<void> => {
                if (!this.forfeitOutputScript) {
                    throw new Error("Forfeit output script not set");
                }

                if (connectorTree) {
                    validateConnectorsTxGraph(event.commitmentTx, connectorTree);
                }

                await this.handleSettlementFinalizationEvent(
                    event,
                    inputs,
                    this.forfeitOutputScript,
                    expectedRecipients,
                    connectorTree,
                    validatedCommitmentTxid,
                );
            },
        };
    }

    /**
     * Signing jobs keyed by each input's own `witnessUtxo.script`; inputs without one
     * (cosigner/connector) are silently omitted.
     */
    private inputSigningJobsFromWitnessUtxos(
        tx: Transaction,
        indexes?: number[],
    ): InputSigningJob[] {
        const candidateIndexes = indexes ?? Array.from({ length: tx.inputsLength }, (_, i) => i);
        const jobs: InputSigningJob[] = [];
        for (const index of candidateIndexes) {
            const script = tx.getInput(index).witnessUtxo?.script;
            if (script) jobs.push({ index, lookupScript: script });
        }
        return jobs;
    }

    /**
     * Best-effort upsert into {@link intentRepository}; never throws into the settle path.
     * Preserves fields the event reducer already wrote.
     */
    private async persistIntentSnapshot(
        intentTxId: string,
        state: ArkIntentState,
        intent: SignedIntent<Intent.RegisterMessage>,
        deleteIntent: SignedIntent<Intent.DeleteMessage>,
        inputs: ExtendedCoin[],
        patch?: Partial<ArkIntent>,
    ): Promise<void> {
        const repo = this.intentRepository;
        if (!repo) return;
        try {
            const now = Date.now();
            const existing = (await collectIntents(repo, { intentTxIds: [intentTxId] }))[0];
            // Terminal is sticky: a later step throwing into settle()'s catch passes "cancelled",
            // which must not clobber a `batch_succeeded` whose money already moved.
            if (existing && isTerminalIntentState(existing.state)) {
                return;
            }
            await repo.saveIntent({
                ...(existing ?? {}),
                intentTxId,
                registerProof: intent.proof,
                registerProofMessage: Intent.encodeMessage(intent.message),
                deleteProof: deleteIntent.proof,
                deleteProofMessage: Intent.encodeMessage(deleteIntent.message),
                intentVtxos: inputs.map((i) => ({
                    txid: i.txid,
                    vout: i.vout,
                })),
                partialForfeits: existing?.partialForfeits ?? [],
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                state,
                ...patch,
            });
        } catch (e) {
            console.error(`Failed to persist intent ${intentTxId} (state=${state})`, e);
        }
    }

    async signInputsByWitnessScript(tx: Transaction): Promise<Transaction> {
        const signed = await this._signerRouter.sign(
            tx,
            this.inputSigningJobsFromWitnessUtxos(tx),
            {
                onUnknownScript: "sign",
            },
        );
        return signed as Transaction;
    }

    async signOnchainBoardingTx(tx: Transaction): Promise<Transaction> {
        const signed = await this._signerRouter.sign(tx, this.inputSigningJobsFromWitnessUtxos(tx));
        return signed as Transaction;
    }

    async safeRegisterIntent(
        intent: SignedIntent<Intent.RegisterMessage>,
        inputs: ExtendedCoin[],
    ): Promise<string> {
        try {
            return await this.arkProvider.registerIntent(intent);
        } catch (error) {
            // catch the "already registered by another intent" error
            if (
                error instanceof ArkError &&
                error.code === 0 &&
                error.message.includes("duplicated input")
            ) {
                // Delete over the caller's own inputs, not getVtxos(): boarding UTXOs are the
                // most common "duplicated input" trigger and getVtxos() misses them.
                const deleteIntent = await this.makeDeleteIntentSignature(inputs);
                await this.arkProvider.deleteIntent(deleteIntent);

                // try again
                return this.arkProvider.registerIntent(intent);
            }

            throw error;
        }
    }

    async makeRegisterIntentSignature(
        coins: ExtendedCoin[],
        outputs: TransactionOutput[],
        onchainOutputsIndexes: number[],
        cosignerPubKeys: string[],
        validAt?: number,
    ): Promise<SignedIntent<Intent.RegisterMessage>> {
        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: onchainOutputsIndexes,
            valid_at: validAt ? Math.floor(validAt) : 0,
            expire_at: 0,
            cosigners_public_keys: cosignerPubKeys,
        };

        const proof = Intent.create(message, coins, outputs);
        const signedProof = await this._signerRouter.sign(proof, intentProofJobs(coins));

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    async makeDeleteIntentSignature(
        coins: ExtendedCoin[],
    ): Promise<SignedIntent<Intent.DeleteMessage>> {
        const message: Intent.DeleteMessage = {
            type: "delete",
            expire_at: 0,
        };

        const proof = Intent.create(message, coins, []);
        const signedProof = await this._signerRouter.sign(proof, intentProofJobs(coins));

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    async makeGetPendingTxIntentSignature(
        coins: ExtendedVirtualCoin[],
    ): Promise<SignedIntent<Intent.GetPendingTxMessage>> {
        const message: Intent.GetPendingTxMessage = {
            type: "get-pending-tx",
            expire_at: 0,
        };

        const proof = Intent.create(message, coins, []);
        const signedProof = await this._signerRouter.sign(proof, intentProofJobs(coins));

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    /**
     * Finalizes pending transactions by retrieving them from the server and finalizing each one.
     * Skips the server check entirely when no send was interrupted (no pending tx flag set).
     * @param vtxos - Optional list of virtual outputs to use instead of retrieving them from the server
     * @returns Array of transaction IDs that were finalized
     */
    async finalizePendingTxs(
        vtxos?: ExtendedVirtualCoin[],
    ): Promise<{ finalized: string[]; pending: string[] }> {
        const hasPending = await this.hasPendingTxFlag();
        if (!hasPending) {
            return { finalized: [], pending: [] };
        }

        if (!vtxos || vtxos.length === 0) {
            const scriptMap = await this.getScriptMap();
            const allExtended: ExtendedVirtualCoin[] = [];

            const fetchedVtxos = await getAllNormalizedVtxos(this.indexerProvider, [
                ...scriptMap.keys(),
            ]);

            for (const vtxo of fetchedVtxos) {
                const vtxoScript = scriptMap.get(vtxo.script);
                if (!vtxoScript) continue;

                if (!vtxo.isSpent && !(vtxo.isPreconfirmed && !vtxo.isSwept)) {
                    continue;
                }

                allExtended.push({
                    ...vtxo,
                    forfeitTapLeafScript: vtxoScript.forfeit(),
                    intentTapLeafScript: vtxoScript.forfeit(),
                    tapTree: vtxoScript.encode(),
                });
            }

            if (allExtended.length === 0) {
                return { finalized: [], pending: [] };
            }

            vtxos = allExtended;
        }
        const batches: ExtendedVirtualCoin[][] = [];
        for (let i = 0; i < vtxos.length; i += MAX_INPUTS_PER_INTENT) {
            batches.push(vtxos.slice(i, i + MAX_INPUTS_PER_INTENT));
        }

        const unrollCandidates = this.checkpointUnrollCandidates(await this.arkProvider.getInfo());
        // Checked against every VTXO of this run, not the chunk that produced
        // the proof: a pending tx spends whatever the interrupted send did, and
        // its inputs can straddle two chunks.
        const checkpointInputs = vtxos.map((vtxo) => ({
            ...vtxo,
            tapLeafScript: vtxo.forfeitTapLeafScript,
        }));

        // Track seen arkTxids so parallel batches don't finalize the same tx twice
        const seen = new Set<string>();

        const results = await Promise.all(
            batches.map(async (batch) => {
                const batchFinalized: string[] = [];
                const batchPending: string[] = [];

                const intent = await this.makeGetPendingTxIntentSignature(batch);
                const pendingTxs = await this.arkProvider.getPendingTxs(intent);

                for (const pendingTx of pendingTxs) {
                    if (seen.has(pendingTx.arkTxid)) continue;
                    seen.add(pendingTx.arkTxid);

                    batchPending.push(pendingTx.arkTxid);
                    try {
                        const checkpointTxs = pendingTx.signedCheckpointTxs.map((c) => {
                            const tx = Transaction.fromPSBT(base64.decode(c));
                            assertAllowedSighashTypes(tx);
                            return tx;
                        });
                        // Registered by an earlier process, so checkpoints are rebuilt, not
                        // recalled; a mismatch stays pending for the next init.
                        assertCheckpointsMatchInputs(
                            checkpointTxs,
                            checkpointInputs,
                            unrollCandidates,
                            `pending tx ${pendingTx.arkTxid}`,
                        );
                        const checkpointJobs = checkpointTxs.map((tx) =>
                            this.inputSigningJobsFromWitnessUtxos(tx),
                        );
                        const identity = this.identity;
                        const batchEligible =
                            isBatchSignable(identity) &&
                            (await this._signerRouter.canBatch(...checkpointJobs));

                        let finalCheckpoints: string[];
                        if (batchEligible) {
                            // These already carry the server's sig, which signMultiple preserves
                            // (BatchSignableIdentity contract), so no merge step unlike the send
                            // path's combineTapscriptSigs.
                            const requests = checkpointTxs.map((tx, i) => ({
                                tx,
                                inputIndexes: checkpointJobs[i].map((j) => j.index),
                            }));
                            const signed = await identity.signMultiple(requests);
                            if (signed.length !== requests.length) {
                                throw new Error(
                                    `signMultiple returned ${signed.length} transactions, expected ${requests.length}`,
                                );
                            }
                            finalCheckpoints = signed.map((tx) => base64.encode(tx.toPSBT()));
                        } else {
                            finalCheckpoints = await Promise.all(
                                checkpointTxs.map(async (tx, i) => {
                                    const signedCheckpoint = await this._signerRouter.sign(
                                        tx,
                                        checkpointJobs[i],
                                    );
                                    return base64.encode(signedCheckpoint.toPSBT());
                                }),
                            );
                        }

                        await this.arkProvider.finalizeTx(pendingTx.arkTxid, finalCheckpoints);
                        batchFinalized.push(pendingTx.arkTxid);
                    } catch (error) {
                        console.error(
                            `Failed to finalize transaction ${pendingTx.arkTxid}:`,
                            error,
                        );
                    }
                }

                return {
                    finalized: batchFinalized,
                    pending: batchPending,
                };
            }),
        );

        const finalized: string[] = [];
        const pending: string[] = [];
        for (const result of results) {
            finalized.push(...result.finalized);
            pending.push(...result.pending);
        }

        // Only clear the flag if every discovered pending tx was finalized;
        // if any failed, keep it so recovery retries on next startup.
        if (finalized.length === pending.length) {
            await this.setPendingTxFlag(false);
        }

        return { finalized, pending };
    }

    /**
     * Server unroll scripts a pending checkpoint may have been built under: configured, current,
     * and one per deprecated signer — else a pre-rotation tx would stay pending forever.
     */
    private checkpointUnrollCandidates(info: ArkadeInfo): CSVMultisigTapscript.Type[] {
        const current = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
        const candidates = [this._serverUnrollScript, current];
        for (const deprecated of signerSetFromInfo(info).deprecated.keys()) {
            candidates.push(
                CSVMultisigTapscript.encode({
                    ...current.params,
                    pubkeys: [hex.decode(deprecated)],
                }),
            );
        }

        const seen = new Set<string>();
        return candidates.filter((candidate) => {
            const script = hex.encode(candidate.script);
            if (seen.has(script)) return false;
            seen.add(script);
            return true;
        });
    }

    private async hasPendingTxFlag(): Promise<boolean> {
        const state = await this.walletRepository.getWalletState();
        return state?.settings?.hasPendingTx === true;
    }

    private async setPendingTxFlag(value: boolean): Promise<void> {
        await updateWalletState(this.walletRepository, (state) => ({
            ...state,
            settings: { ...state.settings, hasPendingTx: value },
        }));
    }

    /**
     * Create an ArkadeCash bearer instrument: sends `amount` to a DefaultVtxo controlled by a fresh
     * key and returns the encoded token, claimable via `claimCash()` without sharing an address.
     *
     * Short-lived: it carries a private key, so hand it over and claim it promptly. Unclaimed past
     * its batch expiry it is swept, and `claimCash` can only report it.
     *
     * @param amount - Whole sats at or above dust (below dust mints an unspendable OP_RETURN).
     * @returns The encoded arkadeCash string (e.g., "arkadecash1...")
     */
    async createCash(amount: number): Promise<string> {
        // A bare `amount < dust` guard would let NaN, Infinity and fractional
        // amounts through (all compare false), and `send` itself defaults every
        // falsy amount to a dust send rather than rejecting it.
        if (!Number.isSafeInteger(amount) || amount < Number(this.dustAmount)) {
            throw new Error(
                `Invalid ArkadeCash amount ${amount}: must be a whole number of sats >= dust (${this.dustAmount})`,
            );
        }

        // Derive HRP: ark→arkadecash, tark→tarkadecash
        const cashHrp = this.network.hrp.replace(/ark$/, "arkadecash");

        const cash = ArkadeCash.generate(
            this.arkServerPublicKey,
            this.offchainTapscript.options.csvTimelock,
            cashHrp,
        );
        const address = cash.address(this.network.hrp).encode();
        const cashStr = cash.toString();

        try {
            await this.send({ address, amount });
        } catch (error) {
            // The note may already be funded; see ArkadeCashCreateError.
            throw new ArkadeCashCreateError(cashStr, error);
        }

        return cashStr;
    }

    /**
     * Claim an ArkadeCash bearer instrument: sweep each spendable VTXO to this wallet in its own
     * offchain tx signed with the token's key, and report the rest in `unclaimed` with a
     * per-VTXO reason. Nothing is persisted (no contract imported, key not stored).
     *
     * The token is the recovery handle: re-running `claimCash` completes an interrupted claim by
     * draining pending arkadeCash txs before sweeping.
     *
     * @param cashStr - The encoded arkadeCash string (e.g., "arkadecash1...")
     * @returns The swept total and the report of what was left behind. The
     * shape is open: further buckets may be added alongside `unclaimed`.
     */
    async claimCash(cashStr: string): Promise<ArkadeCashClaimResult> {
        const cash = ArkadeCash.fromString(cashStr);
        const cashScript = cash.vtxoScript;
        const cashPkScript = hex.encode(cashScript.pkScript);

        // Unfiltered: the server's state filters are mutually exclusive and would hide states
        // reported here. P2TR only: the indexer rejects OP_RETURN query scripts and reports
        // subdust under the P2TR key, so subdust is told apart by value.
        const scripts = [cashPkScript];
        let vtxos = await this.fetchAllVtxos(scripts);

        if (vtxos.length === 0) {
            throw new Error("No VTXOs found for this arkadeCash");
        }

        const myPkScript = ArkAddress.decode(await this.getAddress()).pkScript;
        let { spendable, unclaimed } = this.classifyCashVtxos(vtxos);
        let swept = 0;

        // Drain a previously registered but unfinalized sweep, keyed to the cash key so
        // finalizePendingTxs can't reach it. Not gated on `spendable`: a registered sweep marks
        // its input `already-spent`. Subdust is excluded (the proof's P2TR pkScript would be a lie
        // for an OP_RETURN outpoint and sink the whole proof), as are exited outputs (onchain).
        const drainable = vtxos.filter(
            (vtxo) => !isSubdust(vtxo, this.dustAmount) && !vtxo.isUnrolled,
        );
        if (drainable.length > 0) {
            let drained = { count: 0, swept: 0, claimed: new Set<string>() };
            try {
                drained = await this.finalizePendingCashTxs(
                    cash,
                    drainable,
                    cashScript,
                    myPkScript,
                );
            } catch (error) {
                // Must not sink a claim that can still sweep; held VTXOs fail and are reported.
                console.error("Failed to drain pending arkadeCash txs:", error);
            }
            if (drained.count > 0) {
                // Re-read, or we'd re-sweep an outpoint the drain just spent.
                vtxos = await this.fetchAllVtxos(scripts);
                ({ spendable, unclaimed } = this.classifyCashVtxos(vtxos));

                // Drained-to-us outpoints now read as spent but were claimed by this call;
                // ones a drained tx paid to someone else stay reported.
                swept += drained.swept;
                unclaimed = unclaimed.filter(
                    (vtxo) => !drained.claimed.has(`${vtxo.txid}:${vtxo.vout}`),
                );
            }
        }

        if (spendable.length > 0) {
            const info = await this.arkProvider.getInfo();
            const serverUnrollScript = assertValidServerUnrollScript(
                info.checkpointTapscript,
                resolveCheckpointExitDelayPolicy(this.network, this.checkpointExitDelayPolicy),
            );

            // One tx per VTXO: a rejected input dents only its own sweep, and each output stays
            // within the server's per-output ceiling.
            for (const vtxo of spendable) {
                try {
                    await signAndSubmitOffchainTx({
                        identity: cash.identity,
                        provider: this.arkProvider,
                        inputs: [
                            {
                                txid: vtxo.txid,
                                vout: vtxo.vout,
                                value: vtxo.value,
                                tapLeafScript: cashScript.forfeit(),
                                tapTree: cashScript.encode(),
                            },
                        ],
                        outputs: [{ script: myPkScript, amount: BigInt(vtxo.value) }],
                        serverUnrollScript,
                    });
                    swept += vtxo.value;
                } catch (error) {
                    console.error(
                        `Failed to sweep arkadeCash VTXO ${vtxo.txid}:${vtxo.vout}:`,
                        error,
                    );
                    unclaimed.push(cashReport(vtxo, "sweep-failed"));
                }
            }
        }

        return {
            swept,
            unclaimed: {
                amount: unclaimed.reduce((total, vtxo) => total + vtxo.value, 0),
                vtxos: unclaimed,
            },
        };
    }

    /**
     * Split the VTXOs at an arkadeCash address into the ones the thin sweep can
     * move and the ones it can only report.
     */
    private classifyCashVtxos(vtxos: NormalizedVirtualCoin[]): {
        spendable: NormalizedVirtualCoin[];
        unclaimed: ArkadeCashUnclaimedVtxo[];
    } {
        const spendable: NormalizedVirtualCoin[] = [];
        const unclaimed: ArkadeCashUnclaimedVtxo[] = [];

        for (const vtxo of vtxos) {
            if (isVtxoSpent(vtxo)) {
                unclaimed.push(cashReport(vtxo, "already-spent"));
            } else if (vtxo.isUnrolled) {
                // Before the dust/swept checks: no offchain spend reaches it whatever its state.
                unclaimed.push(cashReport(vtxo, "exited"));
            } else if (isSubdust(vtxo, this.dustAmount)) {
                // The indexer flags subdust swept, so it must be checked before the swept case,
                // which would otherwise claim it is recoverable.
                unclaimed.push(cashReport(vtxo, "subdust"));
            } else if (vtxo.isSwept) {
                // Bare `isSwept` on purpose: about sweptness, not past-expiry coins.
                unclaimed.push(cashReport(vtxo, "swept"));
            } else if (vtxo.assets && vtxo.assets.length > 0) {
                unclaimed.push(cashReport(vtxo, "has-assets"));
            } else {
                spendable.push(vtxo);
            }
        }

        return { spendable, unclaimed };
    }

    /** Read every page of an unfiltered VTXO query for the given scripts. */
    private async fetchAllVtxos(scripts: string[]): Promise<NormalizedVirtualCoin[]> {
        const pageSize = 100;
        const all: NormalizedVirtualCoin[] = [];
        const seen = new Set<string>();

        for (let pageIndex = 0; ; pageIndex++) {
            const { vtxos, page } = await getNormalizedVtxos(this.indexerProvider, {
                scripts,
                pageIndex,
                pageSize,
            });
            for (const vtxo of vtxos) {
                const outpoint = `${vtxo.txid}:${vtxo.vout}`;
                if (seen.has(outpoint)) continue;
                seen.add(outpoint);
                all.push(vtxo);
            }
            if (!page || vtxos.length < pageSize) return all;
        }
    }

    /**
     * Complete sweeps a previous `claimCash` registered but never finalized: a thin
     * {@link finalizePendingTxs} signed with the arkadeCash key. A drained tx pays whoever
     * registered it, so finalizing is still right, but only value paid to `myPkScript` counts.
     *
     * @param vtxos - VTXOs at the cash contract's own pkScript, spent included; any other
     * outpoint (subdust above all) would invalidate the proof.
     * @returns Txs finalized, sats paid to this wallet, and the outpoints consumed to pay it.
     */
    private async finalizePendingCashTxs(
        cash: ArkadeCash,
        vtxos: VirtualCoin[],
        cashScript: DefaultVtxo.Script,
        myPkScript: Bytes,
    ): Promise<{ count: number; swept: number; claimed: Set<string> }> {
        const result = { count: 0, swept: 0, claimed: new Set<string>() };

        const inputs = vtxos.map((vtxo) => ({
            ...vtxo,
            forfeitTapLeafScript: cashScript.forfeit(),
            intentTapLeafScript: cashScript.forfeit(),
            tapTree: cashScript.encode(),
        }));
        if (inputs.length === 0) return result;

        const identity = cash.identity;

        // Chunked to the server's MAX_INPUTS_PER_INTENT; deduped by arkTxid since a tx can
        // surface under two chunks.
        const seenTxids = new Set<string>();
        const pendingTxs: PendingTx[] = [];
        for (let i = 0; i < inputs.length; i += MAX_INPUTS_PER_INTENT) {
            const batch = inputs.slice(i, i + MAX_INPUTS_PER_INTENT);
            const message: Intent.GetPendingTxMessage = { type: "get-pending-tx", expire_at: 0 };
            const proof = Intent.create(message, batch, []);
            // All inputs incl. index 0 (BIP-322 toSpend, mirroring input 1) are cash inputs;
            // explicit indexes surface a failure instead of shipping a half-signed proof.
            const signedProof = await identity.sign(
                proof,
                Array.from({ length: batch.length + 1 }, (_, j) => j),
            );
            const batchPending = await this.arkProvider.getPendingTxs({
                proof: base64.encode(signedProof.toPSBT()),
                message,
            });
            for (const pendingTx of batchPending) {
                if (seenTxids.has(pendingTx.arkTxid)) continue;
                seenTxids.add(pendingTx.arkTxid);
                pendingTxs.push(pendingTx);
            }
        }

        if (pendingTxs.length === 0) return result;

        const myPkScriptHex = hex.encode(myPkScript);
        const unrollCandidates = this.checkpointUnrollCandidates(await this.arkProvider.getInfo());

        for (const pendingTx of pendingTxs) {
            try {
                // These checkpoints already carry the server's signature; the
                // arkadeCash key adds its own share in place.
                const checkpointTxs = pendingTx.signedCheckpointTxs.map((checkpoint) => {
                    const tx = Transaction.fromPSBT(base64.decode(checkpoint));
                    assertAllowedSighashTypes(tx);
                    return tx;
                });
                assertCheckpointsMatchInputs(
                    checkpointTxs,
                    inputs.map((input) => ({
                        ...input,
                        tapLeafScript: input.forfeitTapLeafScript,
                    })),
                    unrollCandidates,
                    `pending arkadeCash tx ${pendingTx.arkTxid}`,
                );
                const finalCheckpoints = await Promise.all(
                    checkpointTxs.map(async (checkpoint) =>
                        base64.encode((await identity.sign(checkpoint)).toPSBT()),
                    ),
                );
                await this.arkProvider.finalizeTx(pendingTx.arkTxid, finalCheckpoints);
                result.count++;

                const paidToMe = this.arkTxAmountPaidTo(pendingTx.finalArkTx, myPkScriptHex);
                if (paidToMe === 0) continue;

                // The ark tx spends the checkpoints; the cash VTXOs are the checkpoints' inputs.
                result.swept += paidToMe;
                for (const checkpoint of checkpointTxs) {
                    for (let i = 0; i < checkpoint.inputsLength; i++) {
                        const input = checkpoint.getInput(i);
                        if (!input.txid) continue;
                        result.claimed.add(`${hex.encode(input.txid)}:${input.index}`);
                    }
                }
            } catch (error) {
                console.error(
                    `Failed to finalize pending arkadeCash tx ${pendingTx.arkTxid}:`,
                    error,
                );
            }
        }

        return result;
    }

    /** Sum the outputs of an ark tx PSBT that pay the given scriptPubKey. */
    private arkTxAmountPaidTo(arkTxPsbt: string, pkScriptHex: string): number {
        const arkTx = Transaction.fromPSBT(base64.decode(arkTxPsbt));
        let total = 0;
        for (let i = 0; i < arkTx.outputsLength; i++) {
            const output = arkTx.getOutput(i);
            if (!output.script || output.amount === undefined) continue;
            if (hex.encode(output.script) === pkScriptHex) total += Number(output.amount);
        }
        return total;
    }

    /**
     * Send BTC and/or assets to one or more recipients, passed either as
     * variadic `Recipient`s or as a single `SendParams` object — the latter
     * also carries the virtual outputs to spend.
     *
     * @param args - Recipients, or a `SendParams` object
     * @returns Promise resolving to the Arkade transaction ID
     * @see SendParams
     *
     * @example
     * ```typescript
     * const txid = await wallet.send({
     *     address: 'ark1q...',
     *     amount: 1000, // (optional, default to dust) btc amount to send to the output
     *     assets: [{ assetId: 'abc123...', amount: 50n }] // (optional) list of assets to send
     * });
     *
     * // choosing the inputs as well as the outputs
     * const txid = await wallet.send({
     *     recipients: [{ address: 'ark1q...', amount: 1000 }],
     *     selectedVtxos: mine, // spent as given, nothing added
     * });
     * ```
     */
    async send(...args: [SendParams] | [Recipient, ...Recipient[]]): Promise<string> {
        const params = asSendParams(args);
        return this._withTxLock((release) =>
            this._sendImpl(params, this._concurrentSpending ? release : undefined),
        );
    }

    private async _sendImpl(
        { recipients: args, selectedVtxos }: SendParams,
        onReserved?: () => void,
    ): Promise<string> {
        if (args.length === 0) {
            // The variadic tuple type rules out `send()`; only a JS caller gets here.
            throw new Error("At least one receiver is required");
        }
        if (selectedVtxos && selectedVtxos.length === 0) {
            // Distinct from `undefined`, which means "choose for me": a caller that
            // meant to name inputs and named none is not asking the wallet to pick.
            throw new Error("send({ selectedVtxos }): no inputs");
        }
        if (selectedVtxos) {
            // Naming inputs skips the generic-spending gate, as on `settle({ inputs })`.
            void this.logUngatedInputs("send({ selectedVtxos })", selectedVtxos);
        }

        // Snapshot synchronously before any `await`: receive rotation and `rotateServerSigner`
        // swap the tapscript, server key and unroll script without `_txLock`, so the change
        // output, its VTXO metadata and the checkpoints must all derive from one epoch.
        const offchainTapscript = this.offchainTapscript;
        const serverPubKey = this.arkServerPublicKey;
        const serverUnrollScript = this.serverUnrollScript;
        const outputAddress = offchainTapscript.address(this.network.hrp, serverPubKey);
        const address = outputAddress.encode();

        // validate recipients and populate undefined amount with dust amount
        const recipients = validateRecipients(
            args,
            Number(this.dustAmount),
            this.recipientAddressContext(serverPubKey),
        );

        // Empty when the caller named inputs: that path never reaches for a coin it wasn't given.
        // Otherwise the accessor excludes escrowed, past-cutoff-signer and intent-locked coins.
        let virtualCoins: NormalizedExtendedVirtualCoin[] = [];
        if (!selectedVtxos) {
            virtualCoins = await this.getSpendableVtxos({
                withRecoverable: false,
                genericallySpendableOnly: true,
            });
        }

        // keep track of asset changes
        const assetChanges = new Map<string, bigint>();

        let selectedCoins: ExtendedVirtualCoin[] = selectedVtxos ? [...selectedVtxos] : [];
        let btcAmountToSelect = 0;

        for (const recipient of recipients) {
            btcAmountToSelect += Math.max(recipient.amount, Number(this.dustAmount));
        }

        if (selectedVtxos) {
            // Every asset on a named input must leave on an output: fold them all in, then draw
            // the recipients' amounts back off.
            for (const coin of selectedCoins) {
                for (const asset of coin.assets ?? []) {
                    const existing = assetChanges.get(asset.assetId) ?? 0n;
                    assetChanges.set(asset.assetId, existing + asset.amount);
                }
            }
            for (const recipient of recipients) {
                for (const asset of recipient.assets) {
                    const remaining = (assetChanges.get(asset.assetId) ?? 0n) - asset.amount;
                    if (remaining < 0n) {
                        throw new Error(
                            `send({ selectedVtxos }): inputs are short ${-remaining} of asset ${asset.assetId}`,
                        );
                    }
                    if (remaining === 0n) {
                        assetChanges.delete(asset.assetId);
                    } else {
                        assetChanges.set(asset.assetId, remaining);
                    }
                }
            }
        } else {
            // Index asset candidates once. A wallet with many VTXOs and several
            // asset recipients must not scan the full inventory for each asset
            // or linearly search every already-selected input on each pass.
            const coinsByAsset = new Map<string, NormalizedExtendedVirtualCoin[]>();
            for (const coin of virtualCoins) {
                for (const assetId of new Set(coin.assets?.map((asset) => asset.assetId))) {
                    const coins = coinsByAsset.get(assetId) ?? [];
                    coins.push(coin);
                    coinsByAsset.set(assetId, coins);
                }
            }
            const selectedOutpoints = new Set<string>();
            // select assets
            for (const recipient of recipients) {
                if (!recipient.assets) {
                    continue;
                }
                for (const receiverAsset of recipient.assets) {
                    let amountToSelect = receiverAsset.amount;

                    // check if existing change covers the needed amount
                    const existingChange = assetChanges.get(receiverAsset.assetId) ?? 0n;
                    if (existingChange >= amountToSelect) {
                        assetChanges.set(receiverAsset.assetId, existingChange - amountToSelect);
                        if (assetChanges.get(receiverAsset.assetId) === 0n) {
                            assetChanges.delete(receiverAsset.assetId);
                        }
                        continue;
                    }
                    if (existingChange > 0n) {
                        amountToSelect -= existingChange;
                        assetChanges.delete(receiverAsset.assetId);
                    }

                    const availableCoins = (coinsByAsset.get(receiverAsset.assetId) ?? []).filter(
                        (coin) => !selectedOutpoints.has(vtxoOutpoint(coin)),
                    );

                    const { selected, totalAssetAmount } = selectCoinsWithAsset(
                        availableCoins,
                        receiverAsset.assetId,
                        amountToSelect,
                    );

                    for (const coin of selected) {
                        selectedCoins.push(coin);
                        selectedOutpoints.add(vtxoOutpoint(coin));
                        // asset coins contain btc, subtract from total amount to select
                        btcAmountToSelect -= coin.value;
                        // coin may contain other assets, add them to asset changes
                        if (coin.assets) {
                            for (const a of coin.assets) {
                                if (a.assetId === receiverAsset.assetId) {
                                    continue;
                                }
                                const existing = assetChanges.get(a.assetId) ?? 0n;
                                assetChanges.set(a.assetId, existing + a.amount);
                            }
                        }
                    }

                    const assetChangeAmount = totalAssetAmount - amountToSelect;
                    if (assetChangeAmount > 0n) {
                        const existing = assetChanges.get(receiverAsset.assetId) ?? 0n;
                        assetChanges.set(receiverAsset.assetId, existing + assetChangeAmount);
                    }
                }
            }

            // select remaining btc
            if (btcAmountToSelect > 0) {
                const availableCoins = virtualCoins.filter(
                    (coin) => !selectedOutpoints.has(vtxoOutpoint(coin)),
                );
                const { inputs: btcCoins } = selectVirtualCoins(availableCoins, btcAmountToSelect);

                // some coins may contain assets, add them to asset changes
                for (const coin of btcCoins) {
                    if (coin.assets) {
                        for (const asset of coin.assets) {
                            const existing = assetChanges.get(asset.assetId) ?? 0n;
                            assetChanges.set(asset.assetId, existing + asset.amount);
                        }
                    }
                }

                selectedCoins = [...selectedCoins, ...btcCoins];
                for (const coin of btcCoins) selectedOutpoints.add(vtxoOutpoint(coin));
            }
        }

        let totalBtcSelected = selectedCoins.reduce((sum, c) => sum + c.value, 0);

        // build tx outputs
        const outputs: TransactionOutput[] = recipients.map((recipient) => ({
            script: recipient.script,
            amount: BigInt(recipient.amount),
            // Already checked against the recipient address in `validateRecipients`.
            ...(recipient.tapTree ? { tapTree: toBIP371TapTree(recipient.tapTree) } : {}),
        }));

        const totalBtcOutput = outputs.reduce((sum, o) => sum + Number(o.amount), 0);
        let changeAmount = totalBtcSelected - totalBtcOutput;

        if (changeAmount < 0) {
            // Only reachable with caller-selected inputs: generic selection either
            // covers the outputs or throws while it is still selecting.
            throw new Error(
                `send({ selectedVtxos }): inputs total ${totalBtcSelected} sats, outputs need ${totalBtcOutput}`,
            );
        }

        if (selectedVtxos && assetChanges.size > 0 && changeAmount < Number(this.dustAmount)) {
            // Asset change needs a change output at or above dust, and this path
            // may not reach for a coin the caller did not name.
            throw new Error(
                `send({ selectedVtxos }): ${changeAmount} sats of change cannot carry ` +
                    `${assetChanges.size} asset change(s), needs ${this.dustAmount}`,
            );
        }

        const vtxoMinAmount =
            changeAmount > 0 || assetChanges.size > 0
                ? ((await this.arkProvider.getInfo()).vtxoMinAmount ?? 0n)
                : 0n;
        if (selectedVtxos && changeAmount > 0 && BigInt(changeAmount) < vtxoMinAmount) {
            throw new Error(
                `send({ selectedVtxos }): ${changeAmount} sats of change is below ` +
                    `the operator minimum of ${vtxoMinAmount} sats`,
            );
        }

        const selectedOutpoints = new Set(selectedCoins.map(vtxoOutpoint));
        // A positive change output must meet the operator's VTXO minimum.
        // Asset change also needs at least dust to carry the asset packet.
        // Adding a BTC coin can introduce assets, so recheck after each selection.
        while (
            !selectedVtxos &&
            ((changeAmount > 0 && BigInt(changeAmount) < vtxoMinAmount) ||
                (assetChanges.size > 0 && BigInt(changeAmount) < this.dustAmount))
        ) {
            const minimumChange =
                assetChanges.size > 0 && this.dustAmount > vtxoMinAmount
                    ? this.dustAmount
                    : vtxoMinAmount;
            const availableCoins = virtualCoins.filter(
                (coin) => !selectedOutpoints.has(vtxoOutpoint(coin)),
            );
            let extraCoins: ExtendedVirtualCoin[];
            try {
                ({ inputs: extraCoins } = selectVirtualCoins(
                    availableCoins,
                    Number(minimumChange) - changeAmount,
                ));
            } catch (error) {
                if (!(error instanceof Error) || error.message !== "Insufficient funds") {
                    throw error;
                }
                // If the balance cannot produce valid change, an exact BTC-only
                // subset can still pay without a change output.
                if (recipients.every((r) => r.assets.length === 0)) {
                    const plainCoins = virtualCoins.filter((coin) => !coin.assets?.length);
                    const exact = plainCoins.find((coin) => coin.value === totalBtcOutput);
                    let exactCoins = exact ? [exact] : undefined;
                    if (!exactCoins) {
                        const byAmount = new Map<number, NormalizedExtendedVirtualCoin>();
                        for (const coin of plainCoins) {
                            const partner = byAmount.get(totalBtcOutput - coin.value);
                            if (partner) {
                                exactCoins = [partner, coin];
                                break;
                            }
                            byAmount.set(coin.value, coin);
                        }
                    }
                    if (exactCoins) {
                        selectedCoins = exactCoins;
                        assetChanges.clear();
                        totalBtcSelected = totalBtcOutput;
                        changeAmount = 0;
                        break;
                    }
                }
                throw new Error(`Cannot form minimum change amount of ${minimumChange} sats`);
            }

            for (const coin of extraCoins) {
                if (coin.assets) {
                    for (const asset of coin.assets) {
                        const existing = assetChanges.get(asset.assetId) ?? 0n;
                        assetChanges.set(asset.assetId, existing + asset.amount);
                    }
                }
            }

            selectedCoins = [...selectedCoins, ...extraCoins];
            for (const coin of extraCoins) selectedOutpoints.add(vtxoOutpoint(coin));
            totalBtcSelected += extraCoins.reduce((sum, c) => sum + c.value, 0);
            changeAmount = totalBtcSelected - totalBtcOutput;
        }

        // build change receiver with BTC change and all asset changes
        let changeReceiver: Recipient | undefined;
        let changeIndex = 0;
        if (changeAmount > 0) {
            const changeAssets: Asset[] = [];
            for (const [assetId, amount] of assetChanges) {
                if (amount > 0n) {
                    changeAssets.push({ assetId, amount });
                }
            }

            changeIndex = outputs.length;
            outputs.push({
                script:
                    BigInt(changeAmount) < this.dustAmount
                        ? outputAddress.subdustPkScript
                        : outputAddress.pkScript,
                amount: BigInt(changeAmount),
            });

            changeReceiver = {
                address: address,
                amount: changeAmount,
                assets: changeAssets.length > 0 ? changeAssets : undefined,
            };
        }

        // create asset packet only if there are assets involved
        const assetInputs = selectedCoinsToAssetInputs(selectedCoins);
        const hasAssets =
            assetInputs.size > 0 || recipients.some((r) => r.assets && r.assets.length > 0);

        // collect custom extension packets from recipients
        const customExtPackets: ExtensionPacket[] = [];
        for (const r of args) {
            if (r.extensions) {
                for (const ext of r.extensions) {
                    customExtPackets.push({
                        type: () => ext.type,
                        serialize: () => ext.payload,
                    });
                }
            }
        }

        const allExtPackets: ExtensionPacket[] = [];
        if (hasAssets) {
            allExtPackets.push(createAssetPacket(assetInputs, recipients, changeReceiver));
        }
        allExtPackets.push(...customExtPackets);

        if (allExtPackets.length > 0) {
            outputs.push(Extension.create(allExtPackets).txOut());
        }

        const sentAmount = recipients.reduce((sum, r) => sum + r.amount, 0);

        return this._submitOffchainSpend(
            selectedCoins,
            outputs,
            {
                sentAmount,
                changeAmount: BigInt(changeAmount),
                changeVout: changeReceiver ? changeIndex : 0,
                offchainTapscript,
                serverPubKey,
                serverUnrollScript,
                changeAssets: changeReceiver?.assets,
            },
            onReserved,
            !selectedVtxos,
        );
    }

    /**
     * Shared submit/persist tail of `send` and {@link sendSelectedVtxosToSelf}; callers own coin
     * selection, outputs and the synchronous epoch snapshot.
     */
    private async _submitOffchainSpend(
        inputs: ExtendedVirtualCoin[],
        outputs: TransactionOutput[],
        persist: {
            sentAmount: number;
            changeAmount: bigint;
            changeVout: number;
            offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;
            serverPubKey: Bytes;
            serverUnrollScript: CSVMultisigTapscript.Type;
            changeAssets?: Asset[];
            recordSentHistory?: boolean;
        },
        onReserved?: () => void,
        picked = false,
    ): Promise<string> {
        if (picked) this._assertNotHeld(inputs);
        if (onReserved) this._assertNotInFlight(inputs);
        this._addPendingSpends(inputs);
        onReserved?.();
        try {
            const { arkTxid, signedCheckpointTxs } = await this.buildAndSubmitOffchainTx(
                inputs,
                outputs,
                persist.serverUnrollScript,
            );

            await this.updateDbAfterOffchainTx(
                inputs,
                arkTxid,
                signedCheckpointTxs,
                persist.sentAmount,
                persist.changeAmount,
                persist.changeVout,
                persist.offchainTapscript,
                persist.serverPubKey,
                persist.changeAssets,
                persist.recordSentHistory ?? true,
            );

            return arkTxid;
        } finally {
            this._removePendingSpends(inputs);
        }
    }

    /**
     * @internal Migration primitive for {@link VtxoManager}: spend the wallet's own
     * deprecated-signer VTXOs into one full-value output on the *active* signer, via the Ark send
     * path (not `settle`) so arkd builds checkpoints against the active epoch. No boarding inputs.
     * The caller must already be on the active signer and have sized the batch. Preserves all
     * input assets; records no `TxSent` history.
     */
    async sendSelectedVtxosToSelf(
        inputs: ExtendedVirtualCoin[],
        now?: TimeHeight,
    ): Promise<string> {
        if (inputs.length === 0) {
            throw new Error("sendSelectedVtxosToSelf: no inputs");
        }
        return this._withTxLock(async (release) => {
            // Snapshot the signer epoch synchronously before any `await` (see `_sendImpl`).
            const offchainTapscript = this.offchainTapscript;
            const serverPubKey = this.arkServerPublicKey;
            const serverUnrollScript = this.serverUnrollScript;
            const arkAddress = offchainTapscript.address(this.network.hrp, serverPubKey);

            // May be legacy-shaped (status object only), which would read `undefined` for every
            // canonical fact and wrongly fail the expiry check below.
            const normalizedInputs = inputs.map(normalizeVtxo);

            // Only spendable, batch-expiry-bearing VTXOs migrate cooperatively: recoverable ones
            // take the recovery settle path, and the DB update persists the output only when an
            // input expiry exists. `now` lets a multi-VTXO pass agree with its own gate.
            const at = now ?? (await resolveTimeHeight(this.onchainProvider));
            for (const input of normalizedInputs) {
                if (!canSpendOffchain(input, at)) {
                    throw new Error(
                        `sendSelectedVtxosToSelf: input ${input.txid}:${input.vout} is not cooperatively spendable`,
                    );
                }
                if (input.expiresAt === undefined && input.expiresAtHeight === undefined) {
                    throw new Error(
                        `sendSelectedVtxosToSelf: input ${input.txid}:${input.vout} has no batch expiry`,
                    );
                }
            }

            const total = normalizedInputs.reduce((sum, c) => sum + BigInt(c.value), 0n);

            const outputs: TransactionOutput[] = [
                {
                    script:
                        total < this.dustAmount ? arkAddress.subdustPkScript : arkAddress.pkScript,
                    amount: total,
                },
            ];

            // Every input asset routes to the single self output (index 0).
            const assetInputs = selectedCoinsToAssetInputs(normalizedInputs);
            let selfAssets: Asset[] | undefined;
            if (assetInputs.size > 0) {
                const totals = new Map<string, bigint>();
                for (const [, assets] of assetInputs) {
                    for (const a of assets) {
                        totals.set(a.assetId, (totals.get(a.assetId) ?? 0n) + a.amount);
                    }
                }
                selfAssets = [...totals].map(([assetId, amount]) => ({ assetId, amount }));
                const selfReceiver: Recipient = {
                    address: arkAddress.encode(),
                    amount: Number(total),
                    assets: selfAssets,
                };
                const packet = createAssetPacket(assetInputs, [], selfReceiver);
                outputs.push(Extension.create([packet]).txOut());
            }

            return this._submitOffchainSpend(
                normalizedInputs,
                outputs,
                {
                    sentAmount: 0,
                    changeAmount: total,
                    changeVout: 0,
                    offchainTapscript,
                    serverPubKey,
                    changeAssets: selfAssets,
                    recordSentHistory: false,
                    serverUnrollScript,
                },
                this._concurrentSpending ? release : undefined,
            );
        });
    }

    /**
     * Build an offchain transaction from the given inputs and outputs,
     * sign it, submit to the Arkade provider, and finalize.
     *
     * Signs whatever it is handed, ungated — see {@link settle} for the trade.
     *
     * @returns The Arkade transaction id and server-signed checkpoint PSBTs (for bookkeeping)
     */
    async buildAndSubmitOffchainTx(
        inputs: ExtendedVirtualCoin[],
        outputs: TransactionOutput[],
        serverUnrollScript: CSVMultisigTapscript.Type = this.serverUnrollScript,
    ): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }> {
        void this.logUngatedInputs("buildAndSubmitOffchainTx", inputs);
        // Before anything is signed or submitted: the tx would build fine from
        // the tapscripts stored on each coin, and only `updateDbAfterOffchainTx`
        // would fail — after the broadcast. @see IContractManager.assertAnnotatable
        await (await this.getContractManager()).assertAnnotatable(inputs);
        const offchainTx = buildOffchainTx(
            inputs.map((input) => {
                return {
                    ...input,
                    tapLeafScript: input.forfeitTapLeafScript,
                };
            }),
            outputs,
            serverUnrollScript,
        );

        // arkTx inputs spend checkpoint outputs, so their `witnessUtxo.script` is the checkpoint
        // pkScript; route by the source VTXO scripts instead (positionally aligned to `inputs`).
        const arkTxJobs = inputs.map((input, index) => ({
            index,
            lookupScript: VtxoScript.decode(input.tapTree).pkScript,
        }));
        const identity = this.identity;
        const signer: OffchainTxSigner = {
            signArkTx: async (arkTx, checkpoints) => {
                const checkpointJobs = checkpoints.map((c) =>
                    this.inputSigningJobsFromWitnessUtxos(c),
                );

                // All inputs on the baseline key ⇒ sign all N+1 PSBTs in one popup; the user-signed
                // checkpoints are returned for `submitOffchainTx` to merge onto the server's.
                const batchEligible =
                    isBatchSignable(identity) &&
                    (await this._signerRouter.canBatch(arkTxJobs, ...checkpointJobs));

                if (batchEligible) {
                    // Clone so a misbehaving provider can't mutate the originals before submitTx.
                    const requests = [
                        {
                            tx: arkTx.clone(),
                            inputIndexes: arkTxJobs.map((j) => j.index),
                        },
                        ...checkpoints.map((c, i) => ({
                            tx: c.clone(),
                            inputIndexes: checkpointJobs[i].map((j) => j.index),
                        })),
                    ];
                    const signed = await identity.signMultiple(requests);
                    if (signed.length !== requests.length) {
                        throw new Error(
                            `signMultiple returned ${signed.length} transactions, expected ${requests.length}`,
                        );
                    }
                    const [firstSignedTx, ...signedCheckpoints] = signed;
                    return { arkTx: firstSignedTx, userSignedCheckpoints: signedCheckpoints };
                }

                return { arkTx: await this._signerRouter.sign(arkTx, arkTxJobs) };
            },
            signCheckpoint: (checkpoint) =>
                this._signerRouter.sign(
                    checkpoint,
                    this.inputSigningJobsFromWitnessUtxos(checkpoint),
                ),
        };

        let awaitingFinalize = false;
        try {
            return await submitOffchainTx(
                this.arkProvider,
                offchainTx,
                signer,
                {
                    // Mark pending before submitting — if we crash between submit and
                    // finalize, the next init recovers via finalizePendingTxs.
                    beforeSubmit: async () => {
                        this._submitsAwaitingFinalize++;
                        awaitingFinalize = true;
                        await this.setPendingTxFlag(true);
                    },
                    afterFinalize: async () => {
                        this._submitsAwaitingFinalize--;
                        awaitingFinalize = false;
                        // An overlapping submit still needs the flag if this process dies.
                        if (this._submitsAwaitingFinalize > 0) return;
                        try {
                            await this.setPendingTxFlag(false);
                        } catch (error) {
                            console.error("Failed to clear pending tx flag:", error);
                        }
                    },
                },
                {
                    // Deprecated keys too: a vtxo built before a rotation is still
                    // spent under the signer its leaf names.
                    verifyServerSignatures: {
                        serverPubkey: this._arkServerPublicKey,
                        deprecatedServerPubkeys: [...this._deprecatedSigners.keys()].map((h) =>
                            hex.decode(h),
                        ),
                    },
                },
            );
        } finally {
            if (awaitingFinalize) this._submitsAwaitingFinalize--;
        }
    }

    // Mark inputs spent and save change. `offchainTapscript`/`serverPubKey` are the caller's epoch
    // snapshot, so the record matches what the server saw even if a rotation lands mid-flight.
    private async updateDbAfterOffchainTx(
        inputs: VirtualCoin[],
        arkTxid: string,
        signedCheckpointTxs: string[],
        sentAmount: number,
        changeAmount: bigint,
        changeVout: number,
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        serverPubKey: Bytes,
        changeAssets?: Asset[],
        // False for self-transfer migrations: a `TxSent` row would show a phantom outflow.
        recordSentHistory: boolean = true,
    ): Promise<void> {
        const primaryAddress = offchainTapscript.address(this.network.hrp, serverPubKey).encode();

        try {
            const spentVtxos: ExtendedVirtualCoin[] = [];
            const commitmentTxIds = new Set<string>();
            let batchExpiry: number = Number.MAX_SAFE_INTEGER;

            if (inputs.length !== signedCheckpointTxs.length) {
                console.warn(
                    `updateDbAfterOffchainTx: inputs length (${inputs.length}) differs from signedCheckpointTxs length (${signedCheckpointTxs.length})`,
                );
            }

            // Keyed by spent outpoint, never position: `submitTx` may return checkpoints in any
            // order, and positional pairing would attribute each VTXO to another's checkpoint.
            const checkpointIdByOutpoint = new Map<string, string>();
            for (const encoded of signedCheckpointTxs) {
                const checkpoint = Transaction.fromPSBT(base64.decode(encoded));
                for (let i = 0; i < checkpoint.inputsLength; i++) {
                    const input = checkpoint.getInput(i);
                    if (!input.txid) continue;
                    checkpointIdByOutpoint.set(
                        `${hex.encode(input.txid)}:${input.index}`,
                        checkpoint.id,
                    );
                }
            }

            const cm = await this.getContractManager();
            const annotatedInputs = await cm.annotateVtxos(inputs);
            for (const vtxo of annotatedInputs) {
                const spentFacts = { ...vtxo, isSpent: true };
                const spentBy = checkpointIdByOutpoint.get(`${vtxo.txid}:${vtxo.vout}`);
                spentVtxos.push({
                    ...spentFacts,
                    ...(spentBy ? { spentBy } : {}),
                    arkTxId: arkTxid,
                });

                for (const id of vtxo.commitmentTxIds) {
                    commitmentTxIds.add(id);
                }
                const vtxoExpiry = vtxo.expiresAt?.getTime();
                if (vtxoExpiry) {
                    batchExpiry = Math.min(batchExpiry, vtxoExpiry);
                }
            }

            const createdAt = Date.now();

            // Only save a change virtual output for preconfirmed coins (those with a batchExpiry).
            // Inputs without a batchExpiry are already settled/unrolled and don't need tracking.
            let changeVtxo: NormalizedExtendedVirtualCoin | undefined;
            if (changeAmount > 0n && batchExpiry !== Number.MAX_SAFE_INTEGER) {
                const changeFacts = {
                    isSpent: false,
                    isSwept: false,
                    isPreconfirmed: true,
                    commitmentTxIds: Array.from(commitmentTxIds),
                    expiresAt: new Date(batchExpiry),
                };
                changeVtxo = {
                    txid: arkTxid,
                    vout: changeVout,
                    createdAt: new Date(createdAt),
                    forfeitTapLeafScript: offchainTapscript.forfeit(),
                    intentTapLeafScript: offchainTapscript.forfeit(),
                    isUnrolled: false,
                    tapTree: offchainTapscript.encode(),
                    value: Number(changeAmount),
                    ...changeFacts,
                    spentBy: "",
                    status: {
                        confirmed: false,
                    },
                    assets: changeAssets,
                    script: hex.encode(offchainTapscript.pkScript),
                };
            }

            // Route spent rows to their owning contract bucket (inputs may span contracts).
            const contracts = await cm.getContracts();
            const addrByScript = new Map(contracts.map((c) => [c.script, c.address]));

            const spentByScript = new Map<string, ExtendedVirtualCoin[]>();
            for (const v of spentVtxos) {
                if (!v.script) {
                    throw new Error(
                        `Wallet.updateDbAfterOffchainTx: spent VTXO ${v.txid}:${v.vout} has no script`,
                    );
                }
                const arr = spentByScript.get(v.script) ?? [];
                arr.push(v);
                spentByScript.set(v.script, arr);
            }

            for (const [script, vtxos] of spentByScript) {
                // Fail loudly rather than record ownership against the wrong contract.
                validateVtxosForScript(vtxos, script, "Wallet.updateDbAfterOffchainTx");
                const targetAddr = addrByScript.get(script);
                if (!targetAddr) {
                    throw new Error(
                        `Wallet.updateDbAfterOffchainTx: no contract owns script ${script}`,
                    );
                }
                await saveVtxosForContract(
                    this.walletRepository,
                    { script, address: targetAddr },
                    vtxos,
                );
            }

            // Change is always primary-script by construction.
            if (changeVtxo) {
                await saveVtxosForContract(
                    this.walletRepository,
                    { script: changeVtxo.script!, address: primaryAddress },
                    [changeVtxo],
                );
            }

            if (recordSentHistory) {
                await this.walletRepository.saveTransactions(primaryAddress, [
                    {
                        key: {
                            boardingTxid: "",
                            commitmentTxid: "",
                            arkTxid: arkTxid,
                        },
                        amount: sentAmount,
                        type: TxType.TxSent,
                        settled: false,
                        createdAt,
                    },
                ]);
            }
        } catch (e) {
            console.warn("error saving offchain tx to repository", e);
            throw e;
        }
    }

    // mark virtual outputs as spent/settled, remove boarding inputs
    private async updateDbAfterSettle(
        inputs: ExtendedCoin[],
        commitmentTxid: string,
    ): Promise<void> {
        try {
            const spentVtxos: ExtendedVirtualCoin[] = [];
            const inputArkTxIds = new Set<string>();
            // Grouped by the address each UTXO sits on, which after rotation may not be the
            // current boarding address.
            const boardingRemovalsByAddress = new Map<string, Set<string>>();

            const vtxoInputs = inputs.filter(isVirtualCoin);
            const cm = await this.getContractManager();
            const annotatedVtxos = await cm.annotateVtxos(vtxoInputs);
            const annotatedByKey = new Map(annotatedVtxos.map((v) => [`${v.txid}:${v.vout}`, v]));
            for (const input of inputs) {
                if (isVirtualCoin(input)) {
                    // virtual output = mark it settled
                    const outpoint = `${input.txid}:${input.vout}`;
                    const vtxo = annotatedByKey.get(outpoint);
                    if (!vtxo) {
                        // A gap means the settled row would be silently lost.
                        throw new Error(`missing annotation for virtual coin ${outpoint}`);
                    }
                    if (vtxo.arkTxId) {
                        inputArkTxIds.add(vtxo.arkTxId);
                    }
                    const settledFacts = { ...vtxo, isSpent: true };
                    spentVtxos.push({
                        ...settledFacts,
                        settledBy: commitmentTxid,
                    });
                } else {
                    // Boarding input: its source address is recoverable from its tapTree; fall back
                    // to the current one if undecodable (defensive).
                    let sourceAddress: string;
                    try {
                        sourceAddress = VtxoScript.decode(input.tapTree).onchainAddress(
                            this.network,
                        );
                    } catch {
                        sourceAddress = this.boardingTapscript.onchainAddress(this.network);
                    }
                    let set = boardingRemovalsByAddress.get(sourceAddress);
                    if (!set) {
                        set = new Set();
                        boardingRemovalsByAddress.set(sourceAddress, set);
                    }
                    set.add(`${input.txid}:${input.vout}`);
                }
            }

            if (spentVtxos.length > 0) {
                // Route settled rows to their owning contract bucket.
                const contracts = await cm.getContracts();
                const addrByScript = new Map(contracts.map((c) => [c.script, c.address]));

                const byScript = new Map<string, ExtendedVirtualCoin[]>();
                for (const v of spentVtxos) {
                    if (!v.script) {
                        throw new Error(
                            `Wallet.updateDbAfterSettle: spent VTXO ${v.txid}:${v.vout} has no script`,
                        );
                    }
                    const arr = byScript.get(v.script) ?? [];
                    arr.push(v);
                    byScript.set(v.script, arr);
                }

                for (const [script, vtxos] of byScript) {
                    validateVtxosForScript(vtxos, script, "Wallet.updateDbAfterSettle");
                    const targetAddr = addrByScript.get(script);
                    if (!targetAddr) {
                        throw new Error(
                            `Wallet.updateDbAfterSettle: no contract owns script ${script}`,
                        );
                    }
                    await saveVtxosForContract(
                        this.walletRepository,
                        { script, address: targetAddr },
                        vtxos,
                    );
                }
            }

            if (boardingRemovalsByAddress.size > 0) {
                await inVtxoWriteOrder(this.walletRepository, async () => {
                    for (const [address, toRemove] of boardingRemovalsByAddress) {
                        const currentUtxos = await collectUtxos(this.walletRepository, address);
                        const filtered = currentUtxos.filter(
                            (u) => !toRemove.has(`${u.txid}:${u.vout}`),
                        );
                        // Clear and re-save the filtered list for this address bucket.
                        await this.walletRepository.deleteUtxos(address);
                        if (filtered.length > 0) {
                            await this.walletRepository.saveUtxos(address, filtered);
                        }
                    }
                });
            }
        } catch (e) {
            console.warn("error updating repository after settle", e);
            throw e;
        }
    }
}

/** Earliest expiry first, then largest value: the order {@link selectVirtualCoins} spends in. */
export function bySelectionOrder(
    a: NormalizedExtendedVirtualCoin,
    b: NormalizedExtendedVirtualCoin,
): number {
    const expiryA = a.expiresAt?.getTime() || Number.MAX_SAFE_INTEGER;
    const expiryB = b.expiresAt?.getTime() || Number.MAX_SAFE_INTEGER;
    if (expiryA !== expiryB) {
        return expiryA - expiryB; // Earlier expiry first
    }

    return b.value - a.value; // Larger amount first
}

/**
 * Select virtual outputs to reach a target amount, prioritizing those closer to expiry
 * @param coins List of virtual outputs to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected virtual outputs and change amount
 */
export function selectVirtualCoins(
    coins: ExtendedVirtualCoin[],
    targetAmount: number,
): {
    inputs: ExtendedVirtualCoin[];
    changeAmount: bigint;
} {
    // Normalized once up front rather than per comparison, which would be O(n log n)
    // normalizations.
    const sortedCoins = coins.map(normalizeVtxo).sort(bySelectionOrder);

    const selectedCoins: ExtendedVirtualCoin[] = [];
    let selectedAmount = 0;

    for (const coin of sortedCoins) {
        selectedCoins.push(coin);
        selectedAmount += coin.value;

        if (selectedAmount >= targetAmount) {
            break;
        }
    }

    if (selectedAmount === targetAmount) {
        return { inputs: selectedCoins, changeAmount: 0n };
    }

    if (selectedAmount < targetAmount) {
        throw new Error("Insufficient funds");
    }

    const changeAmount = BigInt(selectedAmount - targetAmount);

    return {
        inputs: selectedCoins,
        changeAmount,
    };
}

/**
 * Raised when a wait is cancelled through its `AbortSignal` or `timeoutMs`. `name` is
 * `"AbortError"`, so DOM and SDK aborts can be handled identically.
 */
export class AbortError extends Error {
    constructor(message = "Operation aborted") {
        super(message);
        this.name = "AbortError";
    }
}

/**
 * A VTXO named for a spend or a hold is held, or already being spent by another operation.
 * Match on `name`, not `instanceof`: only the name survives the service-worker boundary.
 */
export class VtxoReservedError extends Error {
    readonly name = "VtxoReservedError";

    constructor(
        readonly outpoints: readonly string[],
        readonly holder: "in-flight" | "held",
    ) {
        super(
            `${outpoints.join(", ")} ${holder === "held" ? "held by reserveVtxos" : "already being spent by another operation"}`,
        );
    }
}

/** A hold placed by {@link Wallet.reserveVtxos}. */
export interface VtxoReservation {
    readonly outpoints: readonly Outpoint[];
    /** Idempotent. */
    release(): void;
}

/** @internal Submits an Arkade transaction for {@link Wallet.withSpendLock}'s caller. */
export type OffchainSubmit = (
    inputs: ExtendedVirtualCoin[],
    outputs: TransactionOutput[],
) => Promise<{ arkTxid: string; signedCheckpointTxs: string[] }>;

/** Options for {@link waitForIncomingFunds}. */
export interface WaitForIncomingFundsOptions {
    /**
     * Cancels the wait. On abort the underlying subscription is stopped and
     * the returned promise rejects — with the signal's `reason` when the
     * caller supplied an `Error`, otherwise an {@link AbortError}.
     */
    signal?: AbortSignal;

    /**
     * Cancels the wait after this many milliseconds, rejecting with an
     * {@link AbortError}. Equivalent to passing an `AbortSignal.timeout`
     * signal, without requiring that API on the target platform.
     */
    timeoutMs?: number;
}

/**
 * Surface an abort reason like `fetch`: a caller's `Error` as-is, else an {@link AbortError}
 * (not every target runtime exposes the platform `DOMException` as an `Error`).
 */
function abortReason(signal: AbortSignal): unknown {
    const { reason } = signal as AbortSignal & { reason?: unknown };
    if (reason instanceof Error) return reason;
    return new AbortError(typeof reason === "string" ? reason : undefined);
}

/**
 * Wait for incoming funds to the wallet.
 *
 * Keeps live network watchers open until it settles. **Cancel it if you won't await it to
 * completion** (`signal` / `timeoutMs`): a `Promise.race` against a timer abandons the loser
 * without stopping its watchers, and in a loop stacks subscriptions until the process exits.
 *
 * @param wallet - The wallet to wait for incoming funds
 * @param options - Cancellation options; see {@link WaitForIncomingFundsOptions}
 * @returns A promise that resolves the next new coins received by the wallet's address
 * @throws {AbortError} If cancelled via `signal` or `timeoutMs`
 * @example
 * ```typescript
 * // Wake early on a deposit, but give up after 30s and release the watchers.
 * try {
 *   const funds = await waitForIncomingFunds(wallet, { timeoutMs: 30_000 })
 * } catch (e) {
 *   if ((e as Error).name !== "AbortError") throw e
 * }
 * ```
 */
export async function waitForIncomingFunds(
    wallet: Wallet,
    options?: WaitForIncomingFundsOptions,
): Promise<IncomingFunds> {
    const { signal, timeoutMs } = options ?? {};

    if (signal?.aborted) throw abortReason(signal);

    let stopFunc: (() => void) | undefined;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    return new Promise<IncomingFunds>((resolve, reject) => {
        // One teardown path for every exit, so nothing outlives the promise.
        const settle = (deliver: () => void) => {
            if (settled) return;
            settled = true;

            if (timeoutId !== undefined) clearTimeout(timeoutId);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
            stopFunc?.();

            deliver();
        };

        const cancel = (reason: unknown) => settle(() => reject(reason));

        if (signal) {
            onAbort = () => cancel(abortReason(signal));
            // No `{ once: true }`: `settle` already removes it on every exit.
            signal.addEventListener("abort", onAbort);
        }

        if (timeoutMs !== undefined) {
            timeoutId = setTimeout(
                () => cancel(new AbortError(`waitForIncomingFunds timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
        }

        wallet
            .notifyIncomingFunds((funds: IncomingFunds) => {
                // Skip purely outgoing events (empty `newVtxos` / `coins`), or a self-send's spent
                // half could resolve this before its `vtxo_received` arrives.
                const hasFunds =
                    funds.type === "utxo" ? funds.coins.length > 0 : funds.newVtxos.length > 0;
                if (settled || !hasFunds) return;

                settle(() => resolve(funds));
            })
            .then((stop) => {
                stopFunc = stop;
                // May have settled before the handle arrived; don't leak it.
                if (settled) stop();
            })
            .catch((error) => {
                // Else a caller whose providers are down hangs forever on an unhandled rejection.
                cancel(error);
            });
    });
}
