import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { Address, OutScript, SigHash, Transaction } from "@scure/btc-signer";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Bytes, sha256 } from "@scure/btc-signer/utils.js";
import { ArkAddress } from "../script/address";
import { DefaultVtxo } from "../script/default";
import { DEFAULT_ARKADE_SERVER_URL, getNetwork, Network, NetworkName } from "../networks";
import { ESPLORA_URL, EsploraProvider, OnchainProvider } from "../providers/onchain";
import {
    ArkProvider,
    BatchFinalizationEvent,
    BatchStartedEvent,
    RestArkProvider,
    SettlementEvent,
    SignedIntent,
    TreeNoncesEvent,
    TreeSigningStartedEvent,
} from "../providers/ark";
import { SignerSession } from "../tree/signingSession";
import { buildForfeitTx } from "../forfeit";
import { validateConnectorsTxGraph, validateVtxoTxGraph } from "../tree/validation";
import { validateBatchRecipients } from "./validation";
import { Identity, ReadonlyIdentity, isBatchSignable } from "../identity";
import {
    ArkTransaction,
    Asset,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    IAssetManager,
    IReadonlyAssetManager,
    IReadonlyWallet,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    IWallet,
    ReadonlyWalletConfig,
    Recipient,
    SendBitcoinParams,
    SettleParams,
    TxType,
    VirtualCoin,
    WalletBalance,
    WalletConfig,
} from ".";
import { createAssetPacket, selectCoinsWithAsset, selectedCoinsToAssetInputs } from "./asset";
import { VtxoScript } from "../script/base";
import { CSVMultisigTapscript, RelativeTimelock } from "../script/tapscript";
import {
    buildOffchainTx,
    combineTapscriptSigs,
    hasBoardingTxExpired,
    isValidArkAddress,
} from "../utils/arkTransaction";
import {
    byValueDescending,
    DEFAULT_RENEWAL_CONFIG,
    DEFAULT_SETTLEMENT_CONFIG,
    MAX_VTXOS_PER_SETTLEMENT,
    SettlementConfig,
    VtxoManager,
} from "./vtxo-manager";
import { ArkNote } from "../arknote";
import { Intent } from "../intent";
import { IndexerProvider, RestIndexerProvider } from "../providers/indexer";
import { TxTree } from "../tree/txTree";
import { WalletRepository } from "../repositories/walletRepository";
import { ContractRepository } from "../repositories/contractRepository";
import { extendCoin, extendCoinWithTapscript, validateRecipients } from "./utils";
import { ArkError } from "../providers/errors";
import { Batch } from "./batch";
import { Estimator } from "../arkfee";
import { DelegateProvider } from "../providers/delegate";
import { buildTransactionHistory } from "../utils/transactionHistory";
import { AssetManager, ReadonlyAssetManager } from "./asset-manager";
import { Extension } from "../extension";
import { DelegateVtxo } from "../script/delegate";
import { DelegateManagerImpl, findDestinationOutputIndex, IDelegateManager } from "./delegate";
import { IndexedDBContractRepository, IndexedDBWalletRepository } from "../repositories";
import { ContractManager } from "../contracts/contractManager";
import type { CreateContractParams } from "../contracts/contractManager";
import { contractHandlers } from "../contracts/handlers";
import { BoardingContractHandler } from "../contracts/handlers/boarding";
import { timelockToSequence } from "../utils/timelock";
import { clearSyncCursor, updateWalletState } from "../utils/syncCursors";
import { validateVtxosForScript, saveVtxosForContract } from "../contracts/vtxoOwnership";
import { WalletReceiveRotator, signingDescriptorIndex } from "./walletReceiveRotator";
import { HDDescriptorProvider } from "./hdDescriptorProvider";
import { DescriptorProvider } from "../identity/descriptorProvider";
import { deriveDescriptorLeafPubKey } from "../identity/descriptor";
import { WALLET_RECEIVE_SOURCE } from "../contracts/metadata";
import { DiscoveryDeps } from "../contracts/types";
import { InputSignerRouter, InputSigningJob } from "./inputSignerRouter";
import {
    DescriptorSigningProviderMissingError,
    MissingSigningDescriptorError,
} from "./signingErrors";

export const getArkadeServerUrl = ({ arkServerUrl }: { arkServerUrl?: string }) =>
    arkServerUrl || DEFAULT_ARKADE_SERVER_URL;

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

// Built-in ArkProvider implementations (Rest/Expo) expose `serverUrl`,
// but the interface itself does not declare a URL accessor — so this is a
// structural read that returns undefined for custom implementations.
function extractArkProviderUrl(provider: ArkProvider): string | undefined {
    const serverUrl = (provider as { serverUrl?: unknown }).serverUrl;
    return typeof serverUrl === "string" && serverUrl.length > 0 ? serverUrl : undefined;
}

// Historical unilateral exit delay for mainnet (~7 days in seconds).
// Kept so existing wallets can still discover and spend VTXOs sent to the
// legacy address after arkd starts advertising a different delay.
const MAINNET_UNILATERAL_EXIT_DELAY = 605184n;

// Normalize a server signer pubkey to the x-only (32-byte) form script
// encoding requires (CSVMultisigTapscript.encode throws on anything else).
// A 33-byte compressed key drops its parity prefix; a 32-byte key is already
// x-only. Mirrors the setup path's `hex.decode(info.signerPubkey).slice(1)`.
function toXOnlyPubKey(pubkey: Uint8Array): Uint8Array {
    if (pubkey.length === 33) return pubkey.slice(1);
    if (pubkey.length === 32) return pubkey;
    throw new Error(`invalid signer pubkey length: expected 32 or 33, got ${pubkey.length}`);
}

function delayToTimelock(delay: bigint): RelativeTimelock {
    return {
        value: delay,
        type: delay < 512n ? "blocks" : "seconds",
    };
}

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
 * Register a wallet baseline contract (`default` / `boarding`) idempotently.
 *
 * Thin pass-through to {@link ContractManager.createContract}, which is now the
 * single source of truth for the degenerate `default`/`boarding` same-script
 * collision: contracts are keyed by pkScript, so when the two derive a
 * byte-identical script (a misconfigured server whose `boardingExitDelay`
 * coincides with the offchain unilateral-exit delay) only one row can exist for
 * it, and `createContract` resolves the clash FIRST-WINS — it keeps the row
 * already persisted for the shared script instead of throwing (see
 * {@link areCoalescibleContractTypes}). The wallet-layer "default wins +
 * promote" coalescing this helper used to carry has been consolidated into that
 * one place so init and the restore scan share a single rule (see
 * docs/hd-wallets_onchain_rotation_collision_fix.md §5.1, §5.3).
 *
 * @internal Exported for unit tests; not part of the public API surface.
 */
export async function ensureWalletContract(
    manager: ContractManager,
    params: CreateContractParams,
): Promise<void> {
    await manager.createContract(params);
}

/**
 * Resolve the wallet's current boarding tapscript at boot.
 *
 * Mirrors {@link WalletReceiveRotator.resolveBoot} for the boarding domain:
 * when the wallet rotates boarding (plan §6-II) the latest allocated boarding
 * address is persisted as the newest `active` `boarding` contract tagged
 * {@link WALLET_RECEIVE_SOURCE}. On restart this re-derives the boarding
 * tapscript at that contract's pubkey so {@link Wallet.getBoardingAddress}
 * keeps returning the most recently allocated boarding address.
 *
 * Returns the `baseline` boarding tapscript unchanged when no rotated boarding
 * row exists (a fresh wallet, a never-rotated wallet, or — in the degenerate
 * equal-delay case — an index-0 boarding row coalesced onto `default`). The
 * boarding-exit CSV is index-independent, so the resolved tapscript reuses the
 * baseline's options and swaps only the owner pubkey.
 *
 * @internal Exported for unit tests; not part of the public API surface.
 */
export async function resolveBoardingBootTapscript(
    contractRepository: ContractRepository,
    serverPubKey: Bytes,
    baseline: DefaultVtxo.Script,
): Promise<DefaultVtxo.Script> {
    const serverPubKeyHex = hex.encode(serverPubKey);
    const candidates = await contractRepository.getContracts({
        type: ["boarding"],
        state: "active",
    });
    const newest = candidates
        .filter(
            (c) =>
                c.params.serverPubKey === serverPubKeyHex &&
                c.metadata?.source === WALLET_RECEIVE_SOURCE,
        )
        .sort((a, b) => {
            if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
            return (
                signingDescriptorIndex(b.metadata?.signingDescriptor) -
                signingDescriptorIndex(a.metadata?.signingDescriptor)
            );
        })[0];
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

/**
 * Type guard interface for identities that support conversion to readonly.
 */
interface HasToReadonly {
    toReadonly(): Promise<ReadonlyIdentity>;
}

/**
 * Type guard function to check if an identity has a toReadonly method.
 */
function hasToReadonly(identity: unknown): identity is HasToReadonly {
    return (
        typeof identity === "object" &&
        identity !== null &&
        "toReadonly" in identity &&
        typeof (identity as any).toReadonly === "function"
    );
}

export { DescriptorSigningProviderMissingError, MissingSigningDescriptorError };

export class ReadonlyWallet implements IReadonlyWallet {
    private _contractManager?: ContractManager;
    private _contractManagerInitializing?: Promise<ContractManager>;
    protected readonly watcherConfig?: ReadonlyWalletConfig["watcherConfig"];
    private readonly _assetManager: IReadonlyAssetManager;
    private _syncVtxosInflight?: Promise<void>;
    readonly walletContractTimelocks: RelativeTimelock[];
    // Outpoints ("txid:vout") committed to an in-flight settle/send. Filtered
    // from getVtxos() so concurrent callers (UI, VtxoManager auto-renewal,
    // another send/settle racing the _txLock) can't reselect coins that are
    // already on their way out. The set is in-memory only: a process crash
    // clears it, and a stale entry only hides a VTXO (never spends one).
    protected _pendingSpendOutpoints = new Set<string>();

    get assetManager(): IReadonlyAssetManager {
        return this._assetManager;
    }

    /**
     * Backing field for the active receive tapscript. Read via the
     * public `offchainTapscript` getter; written only by
     * {@link Wallet.setOffchainTapscriptForRotation}, which
     * {@link WalletReceiveRotator.rotate} is the sole intended caller of.
     */
    protected _offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script;

    /**
     * Backing field for the current boarding tapscript (the QR / onboarding
     * target). Read via the public `boardingTapscript` getter; written only
     * by {@link Wallet.setBoardingTapscriptForRotation}, the sanctioned
     * boarding-rotation write path (analogue of `_offchainTapscript`). It is
     * a *current value*, not a fixed setup constant, because per-derivation
     * boarding rotation (plan §6-II) swaps it when a fresh boarding address
     * is explicitly allocated. Static / `auto` wallets never rotate it, so
     * it stays the index-0 baseline for their lifetime.
     */
    protected _boardingTapscript: DefaultVtxo.Script;

    protected constructor(
        readonly identity: ReadonlyIdentity,
        readonly network: Network,
        readonly onchainProvider: OnchainProvider,
        readonly indexerProvider: IndexerProvider,
        readonly arkServerPublicKey: Bytes,
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        boardingTapscript: DefaultVtxo.Script,
        readonly dustAmount: bigint,
        public readonly walletRepository: WalletRepository,
        public readonly contractRepository: ContractRepository,
        readonly delegateProvider?: DelegateProvider,
        watcherConfig?: ReadonlyWalletConfig["watcherConfig"],
        walletContractTimelocks?: RelativeTimelock[],
    ) {
        // Guard: detect identity/server network mismatch for descriptor-based identities.
        // This duplicates the check in setupWalletConfig() so that subclasses
        // bypassing the factory still get the safety net.
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
     * Currently-active receive tapscript. Read-only from the outside;
     * mutated only via {@link Wallet.setOffchainTapscriptForRotation}
     * by {@link WalletReceiveRotator.rotate}.
     */
    get offchainTapscript(): DefaultVtxo.Script | DelegateVtxo.Script {
        return this._offchainTapscript;
    }

    /**
     * The wallet's current boarding tapscript (the on-chain onboarding
     * target). Read-only from the outside; mutated only via
     * {@link Wallet.setBoardingTapscriptForRotation} when a fresh boarding
     * address is explicitly allocated. Single-valued for static / `auto`
     * wallets.
     */
    get boardingTapscript(): DefaultVtxo.Script {
        return this._boardingTapscript;
    }

    /**
     * Listeners fired after the boarding tapscript rotates to a fresh index
     * (see {@link Wallet.setBoardingTapscriptForRotation}). A live
     * {@link notifyIncomingFunds} onchain watcher registers one so it can
     * re-subscribe to include the newly allocated boarding address within the
     * same session — without it, a deposit to the fresh address wouldn't fire
     * a notification until the watcher's next re-init. Always empty for
     * readonly / static / `auto` wallets, which never rotate boarding.
     */
    private readonly _boardingRotationListeners = new Set<() => void>();

    /**
     * Register a listener invoked synchronously after each boarding rotation.
     * Returns an unsubscribe function. Protected: only internal subscribers
     * (the incoming-funds watcher) participate.
     */
    protected onBoardingRotation(listener: () => void): () => void {
        this._boardingRotationListeners.add(listener);
        return () => {
            this._boardingRotationListeners.delete(listener);
        };
    }

    /**
     * Notify boarding-rotation listeners. Called by the boarding-rotation
     * write path ({@link Wallet.setBoardingTapscriptForRotation}) once the new
     * tapscript is in place. A throwing listener is isolated so it can neither
     * break the rotation nor starve sibling listeners.
     */
    protected notifyBoardingRotation(): void {
        for (const listener of this._boardingRotationListeners) {
            try {
                listener();
            } catch (e) {
                console.warn("Boarding-rotation listener failed", e);
            }
        }
    }

    /**
     * Protected helper to set up shared wallet configuration.
     * Extracts common logic used by both ReadonlyWallet.create() and Wallet.create().
     */
    protected static async setupWalletConfig(config: ReadonlyWalletConfig, pubKey: Uint8Array) {
        const arkadeServerUrl = getArkadeServerUrl(config);

        // Use provided arkProvider instance or create a new one from arkServerUrl
        const arkProvider = config.arkProvider || new RestArkProvider(arkadeServerUrl);

        // Resolve the indexer provider. If a full instance is supplied, use it
        // directly. Otherwise pick a URL with priority:
        //   1. explicit config.indexerUrl
        //   2. URL derived from the injected arkProvider (so a custom
        //      arkProvider does not silently pair with the public default)
        //   3. arkadeServerUrl (only when no custom arkProvider was injected)
        let indexerProvider = config.indexerProvider;
        if (!indexerProvider) {
            let indexerUrl = config.indexerUrl;
            if (!indexerUrl) {
                if (config.arkProvider) {
                    const derived = extractArkProviderUrl(config.arkProvider);
                    if (!derived) {
                        throw new Error(
                            "indexerUrl is required when arkProvider is provided without a discoverable serverUrl",
                        );
                    }
                    indexerUrl = derived;
                } else {
                    indexerUrl = arkadeServerUrl;
                }
            }
            indexerProvider = new RestIndexerProvider(indexerUrl);
        }

        const info = await arkProvider.getInfo();

        const network = getNetwork(info.network as NetworkName);

        // Guard: detect identity/server network mismatch for seed-based identities.
        // A mainnet descriptor (xpub, coin type 0) connected to a testnet server
        // (or vice versa) means wrong derivation path → wrong keys → potential fund loss.
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

        // Extract esploraUrl from provider if not explicitly provided
        const esploraUrl = config.esploraUrl || ESPLORA_URL[info.network as NetworkName];

        // Use provided onchainProvider instance or create a new one
        const onchainProvider = config.onchainProvider || new EsploraProvider(esploraUrl);

        // validate unilateral exit timelock passed in config if any
        if (config.exitTimelock) {
            const { value, type } = config.exitTimelock;
            if ((value < 512n && type !== "blocks") || (value >= 512n && type !== "seconds")) {
                throw new Error("invalid exitTimelock");
            }
        }

        const arkdExitTimelock = delayToTimelock(info.unilateralExitDelay);

        // create unilateral exit timelock
        const exitTimelock: RelativeTimelock = config.exitTimelock ?? arkdExitTimelock;

        const walletContractTimelocks = config.exitTimelock
            ? [exitTimelock]
            : dedupeTimelocks([
                  arkdExitTimelock,
                  ...(info.network === "bitcoin"
                      ? [delayToTimelock(MAINNET_UNILATERAL_EXIT_DELAY)]
                      : []),
              ]);

        // validate boarding timelock passed in config if any
        if (config.boardingTimelock) {
            const { value, type } = config.boardingTimelock;
            if ((value < 512n && type !== "blocks") || (value >= 512n && type !== "seconds")) {
                throw new Error("invalid boardingTimelock");
            }
        }

        // create boarding timelock
        const boardingTimelock: RelativeTimelock = config.boardingTimelock ?? {
            value: info.boardingExitDelay,
            type: info.boardingExitDelay < 512n ? "blocks" : "seconds",
        };

        // Generate tapscripts for offchain and boarding address
        const serverPubKey = hex.decode(info.signerPubkey).slice(1);

        const delegatePubKey = config.delegateProvider
            ? await config.delegateProvider
                  .getDelegateInfo()
                  .then((info) => hex.decode(info.pubkey).slice(1))
            : config.delegatorProvider
              ? await config.delegatorProvider
                    .getDelegateInfo()
                    .then((info) => hex.decode(info.pubkey).slice(1))
              : undefined;

        const offchainOptions = {
            pubKey,
            serverPubKey,
            csvTimelock: exitTimelock,
        };
        const offchainTapscript = !delegatePubKey
            ? new DefaultVtxo.Script(offchainOptions)
            : new DelegateVtxo.Script({ ...offchainOptions, delegatePubKey });
        // Source the boarding script from the registered `boarding` handler so
        // wallet setup derives it through the contract type rather than ad-hoc
        // construction. The handler returns a DefaultVtxo.Script byte-identical
        // to the previous inline construction for equivalent params (the CSV
        // timelock round-trips through the same BIP68 sequence encoding the
        // script bytes already use), so getBoardingAddress() and pkScript are
        // unchanged. Contract-manager initialization persists a matching
        // `boarding` contract from these same params.
        const boardingTapscript = BoardingContractHandler.createScript({
            pubKey: hex.encode(pubKey),
            serverPubKey: hex.encode(serverPubKey),
            csvTimelock: timelockToSequence(boardingTimelock).toString(),
        });

        const walletRepository =
            config.storage?.walletRepository ?? new IndexedDBWalletRepository();

        const contractRepository =
            config.storage?.contractRepository ?? new IndexedDBContractRepository();

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
            delegateProvider: config.delegateProvider || config.delegatorProvider,
            /** @deprecated alias for `delegateProvider` */
            delegatorProvider: config.delegateProvider || config.delegatorProvider,
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

        return new ReadonlyWallet(
            config.identity,
            setup.network,
            setup.onchainProvider,
            setup.indexerProvider,
            setup.serverPubKey,
            setup.offchainTapscript,
            setup.boardingTapscript,
            setup.dustAmount,
            setup.walletRepository,
            setup.contractRepository,
            setup.delegateProvider || setup.delegatorProvider,
            config.watcherConfig,
            setup.walletContractTimelocks,
        );
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
        const [boardingUtxos, vtxos] = await Promise.all([
            this.getBoardingUtxos(),
            this.getVtxos(),
        ]);

        // boarding
        let confirmed = 0;
        let unconfirmed = 0;
        for (const utxo of boardingUtxos) {
            if (utxo.status.confirmed) {
                confirmed += utxo.value;
            } else {
                unconfirmed += utxo.value;
            }
        }

        // offchain
        let settled = 0;
        let preconfirmed = 0;
        let recoverable = 0;
        settled = vtxos
            .filter((coin) => coin.virtualStatus.state === "settled")
            .reduce((sum, coin) => sum + coin.value, 0);
        preconfirmed = vtxos
            .filter((coin) => coin.virtualStatus.state === "preconfirmed")
            .reduce((sum, coin) => sum + coin.value, 0);
        recoverable = vtxos
            .filter((coin) => isSpendable(coin) && coin.virtualStatus.state === "swept")
            .reduce((sum, coin) => sum + coin.value, 0);

        const totalBoarding = confirmed + unconfirmed;
        const totalOffchain = settled + preconfirmed + recoverable;

        // aggregate asset balances from spendable virtual outputs
        const assetBalances = new Map<string, bigint>();
        for (const vtxo of vtxos) {
            if (!isSpendable(vtxo)) continue;
            if (vtxo.assets) {
                for (const a of vtxo.assets) {
                    const current = assetBalances.get(a.assetId) ?? 0n;
                    assetBalances.set(a.assetId, current + a.amount);
                }
            }
        }
        const assets = Array.from(assetBalances.entries()).map(([assetId, amount]) => ({
            assetId,
            amount,
        }));

        return {
            boarding: {
                confirmed,
                unconfirmed,
                total: totalBoarding,
            },
            settled,
            preconfirmed,
            available: settled + preconfirmed,
            recoverable,
            total: totalBoarding + totalOffchain,
            assets,
        };
    }

    /**
     * Return virtual outputs tracked by the wallet.
     *
     * @param filter - Optional flags controlling whether recoverable or unrolled VTXOs are included
     */
    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        const f = filter ?? { withRecoverable: true, withUnrolled: false };
        const contractManager = await this.getContractManager();
        const vtxos = await contractManager.getContractsWithVtxos();

        return vtxos
            .flatMap((_) => _.vtxos)
            .filter((vtxo) => {
                if (this._pendingSpendOutpoints.has(`${vtxo.txid}:${vtxo.vout}`)) {
                    return false;
                }
                if (isSpendable(vtxo)) {
                    if (!f.withRecoverable && (isRecoverable(vtxo) || isExpired(vtxo))) {
                        return false;
                    }
                    return true;
                }
                return !!(f.withUnrolled && vtxo.isUnrolled);
            });
    }

    /**
     * Return wallet transaction history derived from Arkade state and boarding transactions.
     */
    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const contractManager = await this.getContractManager();
        const response = await contractManager.getContractsWithVtxos();
        const allVtxos = response.flatMap((_) => _.vtxos);

        const { boardingTxs, commitmentsToIgnore } = await this.getBoardingTxs();

        const getTxCreatedAt = (txid: string) =>
            this.indexerProvider
                .getVtxos({ outpoints: [{ txid, vout: 0 }] })
                .then((res) => res.vtxos[0]?.createdAt.getTime());

        return buildTransactionHistory(allVtxos, boardingTxs, commitmentsToIgnore, getTxCreatedAt);
    }

    /**
     * Clear the global VTXO sync cursor, forcing a full re-bootstrap on next sync.
     * Useful for recovery after indexer reprocessing or debugging.
     */
    async clearSyncCursor(): Promise<void> {
        await clearSyncCursor(this.walletRepository);
    }
    /**
     * The on-chain (P2TR) addresses of every boarding tapscript this wallet
     * uses — the current address plus any historical rotated boarding
     * addresses. The aggregating boarding readers (history, notifications) fan
     * out over this set so deposits at previous boarding addresses are still
     * surfaced (plan §6-IV); {@link getBoardingAddress} stays single-valued.
     */
    async getBoardingAddresses(): Promise<string[]> {
        const tapscripts = await this.getBoardingTapscripts();
        return tapscripts.map((t) => t.onchainAddress(this.network));
    }

    /**
     * Build a transaction history view across the wallet's boarding addresses
     * (current + historical rotated; plan §6-IV.1).
     */
    async getBoardingTxs(): Promise<{
        boardingTxs: ArkTransaction[];
        commitmentsToIgnore: Set<string>;
    }> {
        const utxos: VirtualCoin[] = [];
        const commitmentsToIgnore = new Set<string>();
        const tapscripts = await this.getBoardingTapscripts();

        const outspendCache = new Map<
            string,
            Awaited<ReturnType<typeof this.onchainProvider.getTxOutspends>>
        >();

        for (const tapscript of tapscripts) {
            const boardingAddress = tapscript.onchainAddress(this.network);
            const scriptHex = hex.encode(tapscript.pkScript);
            const txs = await this.onchainProvider.getTransactions(boardingAddress);

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

                        if (spentStatus?.spent) {
                            commitmentsToIgnore.add(spentStatus.txid);
                        }

                        utxos.push({
                            txid: tx.txid,
                            vout: i,
                            value: Number(vout.value),
                            status: {
                                confirmed: tx.status.confirmed,
                                block_time: tx.status.block_time,
                            },
                            isUnrolled: true,
                            virtualStatus: {
                                state: spentStatus?.spent ? "spent" : "settled",
                                commitmentTxIds: spentStatus?.spent
                                    ? [spentStatus.txid]
                                    : undefined,
                            },
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
                    commitmentTxid: utxo.virtualStatus.commitmentTxIds?.[0] ?? "",
                    arkTxid: "",
                },
                amount: utxo.value,
                type: TxType.TxReceived,
                settled: utxo.virtualStatus.state === "spent",
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
     * The set of boarding tapscripts whose on-chain UTXOs belong to this
     * wallet — the current display tapscript plus every historical boarding
     * address it has used. Under per-derivation rotation (plan §6-II) a wallet
     * can hold unspent boarding UTXOs at several addresses at once, so fund
     * discovery / spending must enumerate them all, not just the current one
     * (plan §6-III.1). Deduplicated by scriptPubKey.
     *
     * Always includes the index-0 baseline (identity x-only key), which covers
     * the degenerate equal-delay case where the index-0 boarding row is
     * coalesced onto a `default` row and so isn't a `boarding`-typed contract.
     */
    protected async getBoardingTapscripts(): Promise<DefaultVtxo.Script[]> {
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
        // Every persisted boarding contract — current + historical rotated.
        // Read the contract repository directly (not via getContractManager)
        // so fund discovery doesn't force contract-manager initialization as a
        // side effect; the boarding rows are persisted by init and the
        // allocator, which run earlier in the wallet lifecycle.
        const serverPubKeyHex = hex.encode(this.boardingTapscript.options.serverPubKey);
        const boardingContracts = await this.contractRepository.getContracts({
            type: ["boarding"],
        });
        for (const c of boardingContracts) {
            // Only this wallet's server. A row left by a previous ASP (e.g. a
            // repo recovered against a different server) would otherwise emit a
            // spurious onchain script — and a wasted getCoins/getTransactions
            // call — on every boarding read. Mirrors the filter in
            // resolveBoardingBootTapscript.
            if (c.params.serverPubKey !== serverPubKeyHex) continue;
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
     * Fetch and cache onchain inputs (UTXOs) received at the wallet's boarding
     * addresses — the current address plus any historical rotated boarding
     * addresses that still hold unspent UTXOs (plan §6-III.1). Each UTXO is
     * annotated with the tapscript of the address it actually sits on, so the
     * spending path forfeits / exits it with the correct per-index leaves.
     */
    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        const tapscripts = await this.getBoardingTapscripts();
        const all: ExtendedCoin[] = [];
        for (const tapscript of tapscripts) {
            const address = tapscript.onchainAddress(this.network);
            const coins = await this.onchainProvider.getCoins(address);
            const utxos = coins.map((utxo) => extendCoinWithTapscript(tapscript, utxo));
            // Save boarding inputs using unified repository, keyed by the
            // address the UTXOs actually sit on.
            await this.walletRepository.saveUtxos(address, utxos);
            all.push(...utxos);
        }
        return all;
    }

    /**
     * Subscribe to onchain and offchain notifications for newly received funds.
     *
     * The onchain watcher tracks the full boarding-address set (current +
     * historical rotated). When boarding rotates *after* subscribing — e.g.
     * rotate-on-board allocates a fresh address via
     * {@link getNewBoardingAddress} — the watcher automatically re-subscribes
     * to widen its set, so a deposit to the new address fires a notification
     * within the same session (no watcher re-init required). The re-subscribe
     * is driven by {@link onBoardingRotation}; static / `auto` / readonly
     * wallets never rotate boarding, so it never fires for them.
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

        // (Re)subscribe the onchain watcher to the CURRENT boarding-address set.
        // Serialized on a single chain so a burst of rotations can't interleave
        // teardown/setup and leak a watcher. Re-reads `getBoardingAddresses()`
        // each time: a rotation appends a new address, so the watcher must
        // widen to include it while keeping the historical ones (plan §6-IV.2).
        let onchainChain: Promise<void> = Promise.resolve();
        const subscribeOnchain = (): Promise<void> => {
            onchainChain = onchainChain
                .then(async () => {
                    if (stopped || !this.onchainProvider) return;

                    const boardingAddresses = await this.getBoardingAddresses();
                    if (boardingAddresses.length === 0) return;
                    const boardingAddressSet = new Set(boardingAddresses);

                    // Subscribe-then-swap: bring the NEW watcher up *before*
                    // retiring the previous one. If `watchAddresses` throws, the
                    // catch leaves `onchainStopFunc` (the old watcher) untouched,
                    // so the subscription degrades to the stale set rather than
                    // to no watcher at all; and there's no blind window where
                    // neither is live (which would let a deposit be seeded as
                    // "already known" history and never reported). The newly
                    // allocated boarding address can't have received funds before
                    // now — it was just derived — so the widened set needs no
                    // separate reconciliation fetch.
                    const previousStop = onchainStopFunc;
                    const stop = await this.onchainProvider.watchAddresses(
                        boardingAddresses,
                        (txs) => {
                            // Emit a coin for EVERY output that pays one of our
                            // boarding addresses. A single tx can pay several
                            // (e.g. the current and a rotated-away boarding
                            // address, now that boarding fans out — plan
                            // §6-IV.2), so map per matching vout rather than
                            // reporting only the first match per tx.
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

                            // and notify via callback
                            eventCallback({
                                type: "utxo",
                                coins,
                            });
                        },
                    );

                    // `stopFunc` may have run while we awaited the subscribe. It
                    // already stopped the previous watcher (then held in
                    // `onchainStopFunc`), so only the fresh one needs tearing
                    // down here — don't touch `previousStop` again.
                    if (stopped) {
                        stop();
                        return;
                    }

                    // New watcher is live: promote it, then atomically retire
                    // the old one. Brief overlap is fine — at worst a duplicate
                    // notification, never a missed deposit.
                    onchainStopFunc = stop;
                    previousStop?.();
                })
                .catch((e) => {
                    console.warn("Failed to (re)subscribe boarding-funds watcher", e);
                });
            return onchainChain;
        };

        // Widen the onchain watcher whenever boarding rotates (rotate-on-board
        // / explicit allocation), so a deposit to the freshly allocated address
        // is watched within this same session. Registered BEFORE the initial
        // subscribe so a rotation that lands during initial setup still queues a
        // re-subscribe on the chain (rather than being dropped, leaving the
        // watcher stuck on the stale set). No-op for wallets that never rotate
        // boarding.
        boardingRotationStopFunc = this.onBoardingRotation(() => {
            void subscribeOnchain();
        });

        await subscribeOnchain();

        if (this.indexerProvider && arkAddress) {
            // Share the ContractWatcher's single subscription instead of
            // opening a second SSE stream.
            const cm = await this.getContractManager();

            // Serialize annotation+notification: parallel `annotateVtxos`
            // awaits could resolve out of order and deliver eventCallback
            // calls in the wrong sequence (e.g. `vtxo_spent` before its
            // matching `vtxo_received`).
            let annotationQueue: Promise<void> = Promise.resolve();

            indexerStopFunc = cm.onContractEvent((event) => {
                if (event.type !== "vtxo_received" && event.type !== "vtxo_spent") {
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
        let { vtxos } = await this.indexerProvider.getVtxos({
            scripts,
        });
        return vtxos
            .filter(
                (vtxo) =>
                    vtxo.virtualStatus.state !== "swept" &&
                    vtxo.virtualStatus.state !== "settled" &&
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
     * Get the ContractManager for managing contracts including the wallet's default address.
     *
     * The ContractManager handles:
     * - The wallet's default receiving address (as a "default" contract)
     * - External contracts (Boltz swaps, HTLCs, etc.)
     * - Multi-contract watching with resilient connections
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
        // Return existing manager if already initialized
        if (this._contractManager) {
            return this._contractManager;
        }

        // If initialization is in progress, wait for it
        if (this._contractManagerInitializing) {
            return this._contractManagerInitializing;
        }

        // Start initialization and store the promise
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
            // Clear the initializing promise after completion
            this._contractManagerInitializing = undefined;
        }
    }

    private async initializeContractManager(): Promise<ContractManager> {
        const manager = await ContractManager.create({
            indexerProvider: this.indexerProvider,
            contractRepository: this.contractRepository,
            walletRepository: this.walletRepository,
            watcherConfig: this.watcherConfig,
        });

        // Register the wallet's baseline always-active contracts: every
        // `walletContractTimelocks` entry × {default, delegate-if-enabled}.
        // This matrix is bound to INDEX 0 — the identity's x-only pubkey
        // — by design: it's the permanent fallback set the wallet wants
        // active forever, independent of any HD rotation. Rotated
        // display contracts (registered separately by
        // {@link WalletReceiveRotator.rotate}) are intentionally
        // single-timelock-single-pubkey at the CURRENT arkd delay, and
        // get the `metadata.source = WALLET_RECEIVE_SOURCE` tag so the
        // next boot can find them. We deliberately do NOT re-register
        // the matrix at a rotated pubkey: doing so would dilute the
        // "index-0 baseline" guarantee and turn every rotation into a
        // multi-timelock matrix expansion on every boot.
        const baselinePubkey = await this.identity.xOnlyPublicKey();
        for (const csvTimelock of this.walletContractTimelocks) {
            const csvTimelockStr = timelockToSequence(csvTimelock).toString();
            const defaultScript = new DefaultVtxo.Script({
                pubKey: baselinePubkey,
                serverPubKey: this.offchainTapscript.options.serverPubKey,
                csvTimelock,
            });
            const defaultScriptHex = hex.encode(defaultScript.pkScript);

            // ensureWalletContract (a thin pass-through to createContract) so a
            // default baseline whose script collides with an already-persisted
            // `boarding` row is tolerated FIRST-WINS at the persistence layer
            // instead of throwing a type mismatch. The default matrix is
            // persisted before the boarding baseline below, so at index 0 the
            // `default` row wins. Degenerate guard only: a sound server keeps
            // the unilateral-exit and boarding-exit delays distinct, so these
            // scripts never actually collide.
            await ensureWalletContract(manager, {
                type: "default",
                params: {
                    pubKey: hex.encode(defaultScript.options.pubKey),
                    serverPubKey: hex.encode(defaultScript.options.serverPubKey),
                    csvTimelock: csvTimelockStr,
                },
                script: defaultScriptHex,
                address: defaultScript.address(this.network.hrp, this.arkServerPublicKey).encode(),
                state: "active",
            });

            if (this.offchainTapscript instanceof DelegateVtxo.Script) {
                const delegateScript = new DelegateVtxo.Script({
                    pubKey: baselinePubkey,
                    serverPubKey: this.offchainTapscript.options.serverPubKey,
                    delegatePubKey: this.offchainTapscript.options.delegatePubKey,
                    csvTimelock,
                });
                const delegateScriptHex = hex.encode(delegateScript.pkScript);

                await manager.createContract({
                    type: "delegate",
                    params: {
                        pubKey: hex.encode(delegateScript.options.pubKey),
                        serverPubKey: hex.encode(delegateScript.options.serverPubKey),
                        delegatePubKey: hex.encode(delegateScript.options.delegatePubKey),
                        csvTimelock: csvTimelockStr,
                    },
                    script: delegateScriptHex,
                    address: delegateScript
                        .address(this.network.hrp, this.arkServerPublicKey)
                        .encode(),
                    state: "active",
                });
            }
        }

        // Boarding contract: the wallet's permanent INDEX-0 baseline boarding
        // script. Bound to the identity's x-only pubkey (`baselinePubkey`) —
        // NOT `this.boardingTapscript`, which is a *current value* that
        // per-derivation rotation (plan §6-II) may have advanced to a higher
        // index. Like the default/delegate matrix above, the baseline boarding
        // row must stay anchored at index 0 so funds landing on the baseline
        // address are always visible/spendable, independent of rotation.
        // Rotated boarding rows are persisted separately (tagged) by the
        // boarding allocator. The boarding-exit CSV is index-independent, so it
        // is read from the current `boardingTapscript.options`.
        //
        // Created `active` so ContractWatcher monitors the boarding Arkade
        // address. getBoardingAddress() does not depend on this contract (it
        // derives from `this.boardingTapscript` directly), keeping the lazy
        // contract-manager lifecycle intact.
        //
        // Create-if-missing via ensureWalletContract (idempotent): contracts
        // are keyed by script. In the degenerate case where boardingExitDelay
        // coincides with a baseline `default` timelock (a misconfigured server;
        // sound servers keep them distinct), the boarding script is
        // byte-identical to that default contract's script, so we cannot — and
        // need not — persist a second row: the shared script is already
        // persisted and watched as the `default` baseline (which was created
        // first, so first-wins keeps it `default`), so funds landing on it stay
        // visible/spendable. Re-running initialization is likewise a no-op once
        // the row exists.
        const boardingCsvTimelock =
            this.boardingTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        const baselineBoarding = new DefaultVtxo.Script({
            pubKey: baselinePubkey,
            serverPubKey: this.boardingTapscript.options.serverPubKey,
            csvTimelock: boardingCsvTimelock,
        });
        await ensureWalletContract(manager, {
            type: "boarding",
            params: {
                pubKey: hex.encode(baselineBoarding.options.pubKey),
                serverPubKey: hex.encode(baselineBoarding.options.serverPubKey),
                csvTimelock: timelockToSequence(boardingCsvTimelock).toString(),
            },
            script: hex.encode(baselineBoarding.pkScript),
            address: baselineBoarding.address(this.network.hrp, this.arkServerPublicKey).encode(),
            state: "active",
        });

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
 * The wallet does not store any data locally and relies on Arkade and onchain
 * providers to fetch onchain and virtual outputs.
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
export class Wallet extends ReadonlyWallet implements IWallet {
    static MIN_FEE_RATE = 1; // sats/vbyte

    override readonly identity: Identity;
    private readonly _delegateManager?: IDelegateManager;
    private _vtxoManager?: VtxoManager;
    private _vtxoManagerInitializing?: Promise<VtxoManager>;

    private _walletAssetManager?: IAssetManager;

    /**
     * HD receive rotator. Owns the {@link DescriptorProvider}, the
     * `vtxo_received` subscription, and the rotate-and-register
     * lifecycle. Absent in `walletMode: 'static'` and for SingleKey
     * wallets under `'auto'`. Wired in via the constructor; the actual
     * subscription is installed lazily on first `getVtxoManager()` so
     * the contract manager is up first.
     */
    private _receiveRotator?: WalletReceiveRotator;
    private _receiveRotatorInstalled = false;

    /**
     * Descriptor-aware signer used by {@link _signerRouter} to sign
     * inputs locked by rotated pubkeys. Same instance the rotator owns;
     * stashed here so the spending paths don't have to reach inside the
     * rotator. Undefined for static / non-HD-capable wallets — those
     * paths only ever take the identity-sign branch.
     */
    private readonly _descriptorProvider?: DescriptorProvider;

    private readonly _signerRouter: InputSignerRouter;

    /**
     * @internal Sole write path for `offchainTapscript` after construction.
     * Called by {@link WalletReceiveRotator.rotate} once the rotated
     * display contract has been persisted. External code must treat
     * `offchainTapscript` as read-only.
     */
    setOffchainTapscriptForRotation(tapscript: DefaultVtxo.Script | DelegateVtxo.Script): void {
        this._offchainTapscript = tapscript;
    }

    /**
     * @internal Sole write path for `boardingTapscript` after construction.
     * Called by {@link Wallet.getNewBoardingAddress} once the rotated
     * boarding contract has been persisted. External code must treat
     * `boardingTapscript` as read-only.
     */
    setBoardingTapscriptForRotation(tapscript: DefaultVtxo.Script): void {
        this._boardingTapscript = tapscript;
        // Let live subscribers (the incoming-funds onchain watcher) widen to
        // the freshly allocated boarding address. Harmless at boot — the
        // boot-time restore runs before any subscription exists.
        this.notifyBoardingRotation();
    }

    /**
     * Allocate and return a *fresh* on-chain boarding address, rotating the
     * wallet's current boarding tapscript to a new HD index.
     *
     * This is the explicit boarding allocator — the analogue of dotnet's
     * `GetNextContract(NextContractPurpose.Boarding)`. Unlike
     * {@link getBoardingAddress} (a stable read of the current display
     * address that never burns an index), each call here:
     *
     * - allocates the next index from the shared HD stream (so boarding and
     *   L2 receive interleave on one monotonic index);
     * - builds the boarding tapscript at that index with the boarding-exit
     *   CSV;
     * - persists an `active` `boarding` contract tagged
     *   {@link WALLET_RECEIVE_SOURCE} (with its `signingDescriptor`) so the
     *   ContractWatcher monitors it, boot can restore it as the current
     *   boarding address, and descriptor-aware signing can recover the
     *   per-index key;
     * - swaps the wallet's current `boardingTapscript`.
     *
     * Gated by `walletMode`: a static / `auto` wallet has no descriptor
     * provider and keeps a single index-0 boarding address for its lifetime,
     * so this returns the existing {@link getBoardingAddress} unchanged
     * (no rotation, no index burned).
     */
    async getNewBoardingAddress(): Promise<string> {
        const provider = this._descriptorProvider;
        if (!provider) {
            // Static / `auto`: single fixed boarding address, no rotation.
            return this.getBoardingAddress();
        }

        const descriptor = await provider.getNextSigningDescriptor();
        const pubKey = deriveDescriptorLeafPubKey(descriptor);
        const newBoarding = new DefaultVtxo.Script({
            ...this._boardingTapscript.options,
            pubKey,
        });
        const csvTimelock = newBoarding.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;

        const manager = await this.getContractManager();
        // Persist BEFORE swapping the visible tapscript: if registration
        // throws, the wallet keeps displaying the previous (registered)
        // boarding address — never an unwatched one (mirrors `rotate()`).
        await manager.createContract({
            type: "boarding",
            params: {
                pubKey: hex.encode(pubKey),
                serverPubKey: hex.encode(newBoarding.options.serverPubKey),
                csvTimelock: timelockToSequence(csvTimelock).toString(),
            },
            script: hex.encode(newBoarding.pkScript),
            address: newBoarding.address(this.network.hrp, this.arkServerPublicKey).encode(),
            state: "active",
            metadata: {
                source: WALLET_RECEIVE_SOURCE,
                signingDescriptor: descriptor,
            },
        });

        this.setBoardingTapscriptForRotation(newBoarding);
        return newBoarding.onchainAddress(this.network);
    }

    /**
     * Async mutex that serializes all operations submitting VTXOs to the Arkade
     * server (`settle`, `send`, `sendBitcoin`). This prevents VtxoManager's
     * background renewal from racing with user-initiated transactions for the
     * same VTXO inputs.
     */
    private _txLock: Promise<void> = Promise.resolve();

    /**
     * In-flight guard for {@link restore}. A second `restore()` while one
     * is running returns the same promise so concurrent callers coalesce
     * into a single scan (spec §3.E). Cleared on settle so a later
     * explicit `restore()` re-runs.
     */
    private _restoreInFlight?: Promise<void>;

    private _addPendingSpends(inputs: readonly ExtendedCoin[]): void {
        for (const input of inputs) {
            if ("virtualStatus" in input) {
                this._pendingSpendOutpoints.add(`${input.txid}:${input.vout}`);
            }
        }
    }

    private _removePendingSpends(inputs: readonly ExtendedCoin[]): void {
        for (const input of inputs) {
            if ("virtualStatus" in input) {
                this._pendingSpendOutpoints.delete(`${input.txid}:${input.vout}`);
            }
        }
    }

    private _withTxLock<T>(fn: () => Promise<T>): Promise<T> {
        let release!: () => void;
        const lock = new Promise<void>((r) => (release = r));
        const prev = this._txLock;
        this._txLock = lock;
        return prev.then(async () => {
            try {
                return await fn();
            } finally {
                release();
            }
        });
    }

    /**
     * Explicitly recover this wallet's contracts and balance on a fresh
     * repo. HD wallets run a gap-limit scan across the index range;
     * static / non-HD wallets restore based on the single default
     * pubkey. Never throws because of identity/mode (a static identity
     * is a valid, narrower restore); throws on operational failure (so a
     * truncated restore is loud, not silent — the gap window may have
     * closed early). Idempotent and safe to call concurrently (calls
     * coalesce into one scan).
     *
     * Ordering is deliberate (spec §3.B / §4): scan → advance the HD
     * watermark → inline VTXO pull → only THEN surface aggregated
     * handler errors, so safely-discovered funds are always recovered
     * even when one discovery handler failed.
     *
     * @param opts.gapLimit - Consecutive-unused-index window. Default
     * 20. A non-positive / non-integer value is a programmer error and
     * throws synchronously (distinct from operational failure).
     *
     * @note Concurrent calls coalesce: if a restore is already in flight,
     * subsequent callers receive the same promise and their `gapLimit` is
     * ignored — the first caller's value governs the running scan.
     */
    async restore(opts?: { gapLimit?: number }): Promise<void> {
        // Coalesce concurrent calls FIRST: the documented contract says a
        // second caller's `gapLimit` is ignored while a restore is running,
        // so validating it ahead of the coalesce check would surface a
        // misleading "invalid gapLimit" error to a caller whose value was
        // never going to be used. Only the caller that actually starts the
        // run gets its gapLimit validated.
        if (this._restoreInFlight) return this._restoreInFlight;
        const gapLimit = opts?.gapLimit ?? 20;
        if (!Number.isInteger(gapLimit) || gapLimit <= 0) {
            throw new Error(
                `restore: gapLimit must be a positive integer (got ${String(opts?.gapLimit)})`,
            );
        }
        this._restoreInFlight = this._runRestore(gapLimit).finally(() => {
            this._restoreInFlight = undefined;
        });
        return this._restoreInFlight;
    }

    private async _runRestore(gapLimit: number): Promise<void> {
        const manager = await this.getContractManager();
        const provider = this._descriptorProvider;
        // Use `instanceof` rather than duck-typing the
        // materializeDescriptorAt / advanceLastIndexUsed surface: a
        // non-HD provider that happens to expose either method name
        // would otherwise be mis-classified as HD and TypeError mid-
        // scan. There is no production extension point for custom HD
        // providers today — if one is added, lift this into an
        // `isHDCapableDescriptorProvider` type guard alongside
        // `isHDCapableIdentity`.
        const hd = provider instanceof HDDescriptorProvider;

        const staticDescriptor = hd
            ? undefined
            : `tr(${hex.encode(await this.identity.xOnlyPublicKey())})`;
        const materialize = (index: number): string =>
            hd ? provider.materializeDescriptorAt(index) : staticDescriptor!;

        const delegatePubKey =
            this.offchainTapscript instanceof DelegateVtxo.Script
                ? this.offchainTapscript.options.delegatePubKey
                : undefined;

        // Source the signer axis from a single fresh server-info snapshot so
        // the current and deprecated signers are mutually consistent (mirrors
        // NArk's recovery-time snapshot). Deriving the current signer from this
        // snapshot rather than `this.offchainTapscript.options.serverPubKey`
        // avoids mixing a stale instance signer with fresh history.
        const arkInfo = await this.arkProvider.getInfo();
        const currentSignerPubKey = toXOnlyPubKey(hex.decode(arkInfo.signerPubkey));
        const deprecatedSignerPubKeys = arkInfo.deprecatedSigners.map((s) =>
            toXOnlyPubKey(hex.decode(s.pubkey)),
        );

        const deps: DiscoveryDeps = {
            indexerProvider: this.indexerProvider,
            onchainProvider: this.onchainProvider,
            network: { hrp: this.network.hrp },
            // Full network for the boarding on-chain (P2TR) probe — the
            // `{ hrp }` shape above lacks the `bech32` data
            // `VtxoScript.onchainAddress` needs (plan §6-I.1).
            onchainNetwork: this.network,
            serverPubKey: currentSignerPubKey,
            deprecatedSignerPubKeys,
            csvTimelocks: this.walletContractTimelocks,
            // Boarding-exit CSV so the boarding handler can build its
            // candidate script (distinct from the unilateral-exit matrix).
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

        if (hd && result.lastIndexUsed >= 0) {
            await provider.advanceLastIndexUsed(result.lastIndexUsed);
        }

        // Inline pull BEFORE surfacing any handler errors so safely
        // discovered funds are always recovered (spec §3.B / §4).
        await manager.refreshVtxos({ includeInactive: true });

        if (result.handlerErrors.length > 0) {
            throw new AggregateError(
                result.handlerErrors.map((e) =>
                    e.error instanceof Error ? e.error : new Error(String(e.error)),
                ),
                `restore: ${result.handlerErrors.length} discovery handler(s) failed; ` +
                    `the gap window may have closed early — retry is safe (idempotent).`,
            );
        }
    }

    /** @deprecated Use settlementConfig instead */
    public readonly renewalConfig: Required<Omit<WalletConfig["renewalConfig"], "enabled">> & {
        enabled: boolean;
        thresholdMs: number;
    };

    public readonly settlementConfig: SettlementConfig | false;

    protected constructor(
        identity: Identity,
        network: Network,
        onchainProvider: OnchainProvider,
        readonly arkProvider: ArkProvider,
        indexerProvider: IndexerProvider,
        arkServerPublicKey: Bytes,
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        boardingTapscript: DefaultVtxo.Script,
        readonly serverUnrollScript: CSVMultisigTapscript.Type,
        readonly forfeitOutputScript: Bytes,
        readonly forfeitPubkey: Bytes,
        dustAmount: bigint,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository,
        /** @deprecated Use settlementConfig */
        renewalConfig?: WalletConfig["renewalConfig"],
        delegateProvider?: DelegateProvider,
        watcherConfig?: WalletConfig["watcherConfig"],
        settlementConfig?: WalletConfig["settlementConfig"],
        walletContractTimelocks?: RelativeTimelock[],
        receiveRotator?: WalletReceiveRotator,
        descriptorProvider?: DescriptorProvider,
    ) {
        super(
            identity,
            network,
            onchainProvider,
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

        // Backwards-compatible: keep renewalConfig populated for any code reading it
        this.renewalConfig = {
            enabled: renewalConfig?.enabled ?? false,
            ...DEFAULT_RENEWAL_CONFIG,
            ...renewalConfig,
        };

        // Normalize: prefer settlementConfig, fall back to renewalConfig, default to enabled
        if (settlementConfig !== undefined) {
            this.settlementConfig = settlementConfig;
        } else if (renewalConfig && this.renewalConfig.enabled) {
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
        this._delegateManager = delegateProvider
            ? new DelegateManagerImpl(delegateProvider, arkProvider, identity)
            : undefined;
        this._receiveRotator = receiveRotator;
        this._descriptorProvider = descriptorProvider;
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
            new VtxoManager(this, this.renewalConfig, this.settlementConfig),
        );

        try {
            const manager = await this._vtxoManagerInitializing;
            // First-time hookup of the HD rotator: subscribe to
            // `vtxo_received` AFTER the contract manager (which is
            // initialised inside the VtxoManager construction path) has
            // registered the wallet's baseline contracts. The flag
            // makes this idempotent across repeated `getVtxoManager`
            // calls — install runs at most once per wallet instance.
            // Cache the manager and flip the install flag only after
            // `install()` resolves; otherwise a failing install would
            // leave the manager cached and silently disable HD
            // rotation for the lifetime of this wallet.
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
        // Drain any in-flight restore before touching the contract/vtxo
        // managers — _runRestore calls manager.refreshVtxos() and
        // manager.scanContracts(), both of which would hit a torn-down
        // manager if we proceeded concurrently. _runRestore never calls
        // dispose(), so awaiting it here is deadlock-free.
        await this._restoreInFlight?.catch(() => undefined);

        // Tear down the rotation subscription + drain in-flight rotations
        // first so no late `vtxo_received` event can queue work on a
        // disposing wallet, and so any in-flight `createContract` call
        // finishes before we dispose the contract manager underneath it.
        // A rotator-disposal failure must not abort the rest of
        // teardown — the contract manager / super still need to run on
        // best-effort, so we capture and rethrow at the end.
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
        const pubkey = await config.identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        const setup = await ReadonlyWallet.setupWalletConfig(config, pubkey);

        // Compute Wallet-specific forfeit and unroll scripts
        // the serverUnrollScript is the one used to create output scripts of the checkpoint transactions
        let serverUnrollScript: CSVMultisigTapscript.Type;
        try {
            const raw = hex.decode(setup.info.checkpointTapscript);
            serverUnrollScript = CSVMultisigTapscript.decode(raw);
        } catch (e) {
            throw new Error("Invalid checkpointTapscript from server");
        }

        // parse the server forfeit address
        // server is expecting funds to be sent to this address
        const forfeitPubkey = hex.decode(setup.info.forfeitPubkey).slice(1);
        const forfeitAddress = Address(setup.network).decode(setup.info.forfeitAddress);
        const forfeitOutputScript = OutScript.encode(forfeitAddress);

        // HD wiring (boot path) — resolved via the descriptor provider.
        // The rotator (when present) is handed to the constructor as
        // the last positional arg and `getVtxoManager()` lazily
        // installs its `vtxo_received` subscription on first call,
        // after the contract manager has registered the wallet's
        // baseline contracts.
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
            config.renewalConfig,
            config.delegateProvider || config.delegatorProvider,
            config.watcherConfig,
            config.settlementConfig,
            setup.walletContractTimelocks,
            boot?.rotator,
            boot?.provider,
        );

        // Boarding boot (plan §6-II.3): when HD/boarding rotation is active (a
        // provider resolved), restore the most recently allocated boarding
        // address from the repo so `getBoardingAddress()` survives restarts.
        // The constructor was handed the index-0 baseline boarding tapscript
        // (so `InputSignerRouter`'s boarding fallback and the init-time
        // baseline boarding row both anchor to index 0); we swap the wallet's
        // *current* boarding tapscript here. Static / `auto` wallets have no
        // provider and keep the baseline.
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
        // Check if the identity has a toReadonly method using type guard
        const readonlyIdentity: ReadonlyIdentity = hasToReadonly(this.identity)
            ? await this.identity.toReadonly()
            : this.identity; // Identity extends ReadonlyIdentity, so this is safe

        return new ReadonlyWallet(
            readonlyIdentity,
            this.network,
            this.onchainProvider,
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
    }

    /** Returns the delegate manager when delegation support is configured. */
    async getDelegateManager(): Promise<IDelegateManager | undefined> {
        return this._delegateManager;
    }

    /** @deprecated alias for @see Wallet.getDelegateManager */
    async getDelegatorManager(): Promise<IDelegateManager | undefined> {
        return this.getDelegateManager();
    }

    /**
     * Send bitcoin to an Arkade address.
     *
     * @deprecated Use `send`.
     * @param params - Send parameters
     */
    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }

        if (!isValidArkAddress(params.address)) {
            throw new Error("Invalid Arkade address " + params.address);
        }

        if (params.selectedVtxos && params.selectedVtxos.length > 0) {
            return this._withTxLock(async () => {
                // Snapshot the active receive tapscript synchronously
                // before any `await` so the change output's pkScript and
                // the change-VTXO metadata written later by
                // `updateDbAfterOffchainTx` are bound to the same
                // tapscript even if `WalletReceiveRotator.rotate` fires
                // during the offchain round-trip.
                const offchainTapscript = this.offchainTapscript;
                const arkAddress = offchainTapscript.address(
                    this.network.hrp,
                    this.arkServerPublicKey,
                );

                const selectedVtxoSum = params
                    .selectedVtxos!.map((v) => v.value)
                    .reduce((a, b) => a + b, 0);
                if (selectedVtxoSum < params.amount) {
                    throw new Error("Selected VTXOs do not cover specified amount");
                }
                const changeAmount = selectedVtxoSum - params.amount;

                const selected = {
                    inputs: params.selectedVtxos!,
                    changeAmount: BigInt(changeAmount),
                };

                const outputAddress = ArkAddress.decode(params.address);
                const outputScript =
                    BigInt(params.amount) < this.dustAmount
                        ? outputAddress.subdustPkScript
                        : outputAddress.pkScript;

                const outputs: TransactionOutput[] = [
                    {
                        script: outputScript,
                        amount: BigInt(params.amount),
                    },
                ];

                // add change output if needed
                if (selected.changeAmount > 0n) {
                    const changeOutputScript =
                        selected.changeAmount < this.dustAmount
                            ? arkAddress.subdustPkScript
                            : arkAddress.pkScript;

                    outputs.push({
                        script: changeOutputScript,
                        amount: BigInt(selected.changeAmount),
                    });
                }

                this._addPendingSpends(selected.inputs);
                try {
                    const { arkTxid, signedCheckpointTxs } = await this.buildAndSubmitOffchainTx(
                        selected.inputs,
                        outputs,
                    );

                    await this.updateDbAfterOffchainTx(
                        selected.inputs,
                        arkTxid,
                        signedCheckpointTxs,
                        params.amount,
                        selected.changeAmount,
                        selected.changeAmount > 0n ? outputs.length - 1 : 0,
                        offchainTapscript,
                    );

                    return arkTxid;
                } finally {
                    this._removePendingSpends(selected.inputs);
                }
            });
        }

        return this.send({
            address: params.address,
            amount: params.amount,
        });
    }

    /**
     * Settle boarding inputs and/or virtual outputs into a finalized mainnet transaction.
     *
     * @param params - Optional settlement inputs and outputs. When omitted, the wallet settles all eligible funds.
     * @param eventCallback - Optional callback invoked for settlement stream events.
     * @returns The finalized Arkade transaction id
     */
    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void,
    ): Promise<string> {
        return this._withTxLock(() => this._settleImpl(params, eventCallback));
    }

    private async _settleImpl(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void,
    ): Promise<string> {
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
        }

        // Resolve the wallet's receive address once and reuse it for every read
        // below. `WalletReceiveRotator.rotate` mutates `this.offchainTapscript`
        // without acquiring `_txLock`, so re-calling `getAddress()` later could
        // observe a rotated script — building the output from one and matching
        // `findDestinationOutputIndex` against the other, which fails with a
        // spurious "no output matches". A single read pins the no-params output
        // below and the asset-routing destination script later to one address.
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
                if (inputFee.value >= utxo.value) {
                    // skip if fees are greater than the boarding input value
                    continue;
                }

                filteredBoardingUtxos.push(utxo);
                amount += utxo.value - inputFee.satoshis;
            }

            const vtxos = await this.getVtxos({ withRecoverable: true });

            // Cap the VTXOs per settlement to stay under the server's
            // intent-size limit (MAX_VTXOS_PER_SETTLEMENT inputs) and its
            // per-output ceiling (vtxoMaxAmount; -1 means no limit). Settle the
            // highest-value VTXOs first so the capped batch carries the most
            // value. Apply the cap to economically viable VTXOs only: skipping
            // uneconomic inputs and continuing past the cap avoids an uneconomic
            // prefix permanently starving valid VTXOs behind it. The boarding
            // inputs above are added uncapped; the amount cap accounts for them
            // via the running total (if boarding alone exceeds vtxoMaxAmount no
            // VTXO fits and the server rejects the over-limit output). Any
            // overflow is settled on the next call.
            const filteredVtxos = [];
            for (const vtxo of byValueDescending(vtxos)) {
                if (filteredVtxos.length >= MAX_VTXOS_PER_SETTLEMENT) {
                    break;
                }
                const inputFee = estimator.evalOffchainInput({
                    amount: BigInt(vtxo.value),
                    type: vtxo.virtualStatus.state === "swept" ? "recoverable" : "vtxo",
                    weight: 0,
                    birth: vtxo.createdAt,
                    expiry: vtxo.virtualStatus.batchExpiry
                        ? new Date(vtxo.virtualStatus.batchExpiry)
                        : undefined,
                });
                if (inputFee.satoshis >= vtxo.value) {
                    // skip if fees are greater than the virtual output value
                    continue;
                }

                const net = vtxo.value - inputFee.satoshis;
                // Skip (don't stop at) a VTXO that would push the output past
                // the ceiling; a smaller VTXO behind it can still fit. Compare
                // against the projected post-fee output (what the server
                // actually receives) rather than the pre-fee subtotal, so a
                // VTXO whose output would fit once the output fee is deducted
                // isn't dropped.
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

            if (output.amount <= this.dustAmount) {
                throw new Error("Output amount is below dust limit");
            }

            params = {
                inputs,
                outputs: [output],
            };
        }

        const onchainOutputIndexes: number[] = [];
        const outputs: TransactionOutput[] = [];
        let hasOffchainOutputs = false;

        for (const [index, output] of params.outputs.entries()) {
            let script: Bytes | undefined;
            try {
                // offchain
                const addr = ArkAddress.decode(output.address);
                script = addr.pkScript;
                hasOffchainOutputs = true;
            } catch {
                // onchain
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

        const topics = [
            ...signingPublicKeys,
            ...params.inputs.map((input) => `${input.txid}:${input.vout}`),
        ];

        const abortController = new AbortController();
        let stream: AsyncIterableIterator<SettlementEvent> | undefined;

        // Optimistically hide these inputs from concurrent getVtxos() callers
        // while the settlement is in flight. Set before safeRegisterIntent so
        // there's no window between intent registration and coin-visibility.
        this._addPendingSpends(params.inputs);

        try {
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

            const intentId = await this.safeRegisterIntent(intent, params.inputs);

            const handler = this.createBatchHandler(intentId, params.inputs, recipients, session);

            const commitmentTxid = await Batch.join(primedStream, handler, {
                abortController,
                skipVtxoTreeSigning: !hasOffchainOutputs,
                eventCallback: eventCallback
                    ? (event) => Promise.resolve(eventCallback(event))
                    : undefined,
            });

            await this.updateDbAfterSettle(params.inputs, commitmentTxid);

            // Boarding rotation (rotate-on-board): if this settle swept any
            // boarding (on-chain) UTXO into Arkade, advance the boarding
            // address to a fresh HD index so the next deposit lands on a new
            // address. This is the boarding analogue of the L2 receive
            // rotation that runs on `vtxo_received` — boarding has no on-chain
            // receival event (ContractWatcher watches only the L2 indexer), so
            // the board itself is the trigger. Best-effort: it never fails an
            // already-committed settle.
            await this.maybeRotateBoardingAfterBoard(params.inputs);

            return commitmentTxid;
        } catch (error) {
            // delete the intent to not be stuck in the queue. If deletion fails
            // the intent stays on the server and the next settle will hit
            // "duplicated input" in safeRegisterIntent — surface the failure
            // rather than silently swallowing it.
            const inputIds = params.inputs.map((i) => `${i.txid}:${i.vout}`).join(",");
            await this.arkProvider.deleteIntent(deleteIntent).catch((e) => {
                console.warn(
                    `Failed to delete intent after settle failure for inputs [${inputIds}]; intent may linger on server and cause 'duplicated input' on next settle`,
                    e,
                );
            });
            throw error;
        } finally {
            // Clear state first so a synchronous handler firing from abort()
            // never observes a stale pending-spend set.
            this._removePendingSpends(params.inputs);
            // close the stream — abort() fires the in-body handler if the
            // generator has started iterating; return() also releases the
            // eager resource if the body is still suspended or never ran
            // (e.g. safeRegisterIntent threw before Batch.join was called).
            abortController.abort();
            await stream?.return?.().catch(() => {});
        }
    }

    /**
     * Rotate the boarding address after a board (rotate-on-board trigger).
     *
     * Mirrors {@link WalletReceiveRotator}'s L2 rotation, but driven by a
     * board instead of a `vtxo_received` event: when a settle consumes at
     * least one boarding (on-chain) UTXO, the current boarding address has
     * served its purpose, so we allocate a fresh one via
     * {@link getNewBoardingAddress}. A settle that consumed only VTXOs (a
     * renewal / offboard) is not a board and leaves the boarding address
     * untouched.
     *
     * Boarding inputs are the non-VTXO coins (no `virtualStatus`), the same
     * discriminator {@link handleSettlementFinalizationEvent} uses; the
     * `typeof` guard skips arknote string inputs before the `in` test.
     *
     * No-ops for static / `auto` wallets (no descriptor provider — boarding
     * stays on its fixed index-0 address). Best-effort and non-fatal: the
     * settle has already committed and its txid must be returned, so a
     * rotation failure is logged and swallowed rather than thrown. Funds at
     * the retired boarding address remain discoverable — the old `boarding`
     * contract stays active and {@link getBoardingUtxos} fans out over the
     * full historical boarding set.
     */
    private async maybeRotateBoardingAfterBoard(inputs: SettleParams["inputs"]): Promise<void> {
        if (!this._descriptorProvider) return;
        const consumedBoarding = inputs.some(
            (input) => typeof input !== "string" && !("virtualStatus" in input),
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
        connectorsGraph?: TxTree,
    ) {
        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        const isVtxo = (input: ExtendedCoin): input is ExtendedVirtualCoin =>
            "virtualStatus" in input;

        let settlementPsbt = Transaction.fromPSBT(base64.decode(event.commitmentTx));
        let hasBoardingUtxos = false;

        let connectorIndex = 0;

        const connectorsLeaves = connectorsGraph?.leaves() || [];

        for (const input of inputs) {
            // boarding input, we need to sign the settlement tx
            if (!isVtxo(input)) {
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
                    hasBoardingUtxos = true;
                    break;
                }

                continue;
            }

            if (isRecoverable(input) || isSubdust(input, this.dustAmount)) {
                // recoverable or subdust coin, we don't need to create a forfeit tx
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
        return {
            onBatchStarted: async (event: BatchStartedEvent): Promise<{ skip: boolean }> => {
                const utf8IntentId = new TextEncoder().encode(intentId);
                const intentIdHash = sha256(utf8IntentId);
                const intentIdHashStr = hex.encode(intentIdHash);

                let skip = true;

                // check if our intent ID hash matches any in the event
                for (const idHash of event.intentIdHashes) {
                    if (idHash === intentIdHashStr) {
                        if (!this.arkProvider) {
                            throw new Error("Arkade provider not configured");
                        }
                        await this.arkProvider.confirmRegistration(intentId);
                        skip = false;
                    }
                }

                if (skip) {
                    return { skip };
                }

                const sweepTapscript = CSVMultisigTapscript.encode({
                    timelock: {
                        value: event.batchExpiry,
                        type: event.batchExpiry >= 512n ? "seconds" : "blocks",
                    },
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

                const xOnlyPublicKeys = event.cosignersPublicKeys.map((k) => k.slice(2));
                const signerPublicKey = await session.getPublicKey();
                const xonlySignerPublicKey = signerPublicKey.subarray(1);

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
                    connectorTree,
                );
            },
        };
    }

    /**
     * Build {@link InputSigningJob}s for a tx whose signable inputs can be
     * resolved from their own `witnessUtxo.script`. Inputs without a
     * `witnessUtxo` are silently omitted, mirroring the wallet's
     * historical silent-skip behaviour for cosigner/connector inputs.
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
     * @internal Sign an on-chain boarding exit / sweep transaction, routing
     * each input to the correct key by its `witnessUtxo.script`: the identity
     * for index-0 / static boarding, the per-index descriptor for a rotated
     * boarding UTXO (plan §6-III.3). Used by
     * {@link VtxoManager.sweepExpiredBoardingUtxos}; without it, the
     * unilateral exit of a rotated boarding UTXO would be signed with the
     * wrong (index-0) key and rejected.
     */
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
                // Clear any queued intent spending these exact inputs. The
                // previous implementation signed a proof over getVtxos() only,
                // which misses boarding UTXOs — the most common trigger for
                // "duplicated input" on the auto-settle path. Signing the
                // caller's own inputs keeps the proof surgical and correct
                // regardless of whether the stuck input is a VTXO or boarding.
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

        const MAX_INPUTS_PER_INTENT = 20;

        if (!vtxos || vtxos.length === 0) {
            // Batch all scripts into a single indexer call
            const scriptMap = await this.getScriptMap();
            const allExtended: ExtendedVirtualCoin[] = [];

            const allScripts = [...scriptMap.keys()];
            const { vtxos: fetchedVtxos } = await this.indexerProvider.getVtxos({
                scripts: allScripts,
            });

            for (const vtxo of fetchedVtxos) {
                const vtxoScript = scriptMap.get(vtxo.script);
                if (!vtxoScript) continue;

                if (
                    vtxo.virtualStatus.state === "swept" ||
                    vtxo.virtualStatus.state === "settled"
                ) {
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
                        const checkpointTxs = pendingTx.signedCheckpointTxs.map((c) =>
                            Transaction.fromPSBT(base64.decode(c)),
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
                            // Recovery batch: these checkpoints already carry
                            // the server's tapScriptSig. signMultiple adds the
                            // user's share and, per the BatchSignableIdentity
                            // contract, preserves the pre-existing server sig,
                            // so the transactions it returns hold both. We use
                            // those returned txs directly — no separate merge
                            // step, unlike the send path which signs unsigned
                            // checkpoints and merges via combineTapscriptSigs.
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
     * Send BTC and/or assets to one or more recipients.
     *
     * @param args - Recipients with their addresses, BTC amounts, and assets
     * @returns Promise resolving to the Arkade transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.send({
     *     address: 'ark1q...',
     *     amount: 1000, // (optional, default to dust) btc amount to send to the output
     *     assets: [{ assetId: 'abc123...', amount: 50n }] // (optional) list of assets to send
     * });
     * ```
     */
    async send(...args: [Recipient, ...Recipient[]]): Promise<string> {
        return this._withTxLock(() => this._sendImpl(...args));
    }

    private async _sendImpl(...args: [Recipient, ...Recipient[]]): Promise<string> {
        if (args.length === 0) {
            throw new Error("At least one receiver is required");
        }

        // Snapshot the active receive tapscript synchronously before any
        // `await`. `WalletReceiveRotator.rotate` mutates
        // `this.offchainTapscript` without acquiring `_txLock`, so any
        // yield between here and `updateDbAfterOffchainTx` opens a window
        // where the change-output pkScript (built from `outputAddress`
        // below) and the change-VTXO metadata (built from the snapshot
        // inside `updateDbAfterOffchainTx`) could come from different
        // tapscripts. Threading the snapshot pins both reads.
        const offchainTapscript = this.offchainTapscript;
        const outputAddress = offchainTapscript.address(this.network.hrp, this.arkServerPublicKey);
        const address = outputAddress.encode();

        // validate recipients and populate undefined amount with dust amount
        const recipients = validateRecipients(args, Number(this.dustAmount));

        const virtualCoins = await this.getVtxos({
            withRecoverable: false,
        });

        // keep track of asset changes
        const assetChanges = new Map<string, bigint>();

        let selectedCoins: ExtendedVirtualCoin[] = [];
        let btcAmountToSelect = 0;

        for (const recipient of recipients) {
            btcAmountToSelect += Math.max(recipient.amount, Number(this.dustAmount));
        }

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

                const availableCoins = virtualCoins.filter(
                    (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout),
                );

                const { selected, totalAssetAmount } = selectCoinsWithAsset(
                    availableCoins,
                    receiverAsset.assetId,
                    amountToSelect,
                );

                for (const coin of selected) {
                    selectedCoins.push(coin);
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
                (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout),
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
        }

        let totalBtcSelected = selectedCoins.reduce((sum, c) => sum + c.value, 0);

        // build tx outputs
        const outputs = recipients.map((recipient) => ({
            script: recipient.script,
            amount: BigInt(recipient.amount),
        }));

        const totalBtcOutput = outputs.reduce((sum, o) => sum + Number(o.amount), 0);
        let changeAmount = totalBtcSelected - totalBtcOutput;

        // enforce minimum change amount when there are asset changes
        if (assetChanges.size > 0 && changeAmount < Number(this.dustAmount)) {
            const availableCoins = virtualCoins.filter(
                (c) => !selectedCoins.find((sc) => sc.txid === c.txid && sc.vout === c.vout),
            );
            const { inputs: extraCoins } = selectVirtualCoins(
                availableCoins,
                Number(this.dustAmount) - changeAmount,
            );

            for (const coin of extraCoins) {
                if (coin.assets) {
                    for (const asset of coin.assets) {
                        const existing = assetChanges.get(asset.assetId) ?? 0n;
                        assetChanges.set(asset.assetId, existing + asset.amount);
                    }
                }
            }

            selectedCoins = [...selectedCoins, ...extraCoins];
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
        if (hasAssets) {
            const assetPacket = createAssetPacket(assetInputs, recipients, changeReceiver);
            outputs.push(Extension.create([assetPacket]).txOut());
        }

        const sentAmount = recipients.reduce((sum, r) => sum + r.amount, 0);

        // Optimistically hide selected coins from concurrent getVtxos() while
        // the offchain tx is in flight.
        this._addPendingSpends(selectedCoins);
        try {
            const { arkTxid, signedCheckpointTxs } = await this.buildAndSubmitOffchainTx(
                selectedCoins,
                outputs,
            );

            await this.updateDbAfterOffchainTx(
                selectedCoins,
                arkTxid,
                signedCheckpointTxs,
                sentAmount,
                BigInt(changeAmount),
                changeReceiver ? changeIndex : 0,
                offchainTapscript,
                changeReceiver?.assets,
            );

            return arkTxid;
        } finally {
            this._removePendingSpends(selectedCoins);
        }
    }

    /**
     * Build an offchain transaction from the given inputs and outputs,
     * sign it, submit to the Arkade provider, and finalize.
     * @returns The Arkade transaction id and server-signed checkpoint PSBTs (for bookkeeping)
     */
    async buildAndSubmitOffchainTx(
        inputs: ExtendedVirtualCoin[],
        outputs: TransactionOutput[],
    ): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }> {
        const offchainTx = buildOffchainTx(
            inputs.map((input) => {
                return {
                    ...input,
                    tapLeafScript: input.forfeitTapLeafScript,
                };
            }),
            outputs,
            this.serverUnrollScript,
        );

        // arkTx inputs spend checkpoint outputs, so each input's
        // `witnessUtxo.script` is the checkpoint pkScript — not the
        // source VTXO contract's pkScript. Build the routing jobs from
        // the source VTXO scripts (positionally aligned to `inputs[i]`)
        // so the router can resolve each input's owning contract.
        const arkTxJobs = inputs.map((input, index) => ({
            index,
            lookupScript: VtxoScript.decode(input.tapTree).pkScript,
        }));
        const checkpointJobs = offchainTx.checkpoints.map((c) =>
            this.inputSigningJobsFromWitnessUtxos(c),
        );

        // Batch path: when every signable input across arkTx + checkpoints
        // resolves to the baseline identity key, a `BatchSignableIdentity`
        // can sign all N+1 PSBTs in a single wallet popup. Stash the
        // user-signed checkpoints, submit the unsigned ones to the server
        // for its share, then merge server + user tapscript sigs.
        let signedVirtualTx: Transaction;
        let userSignedCheckpoints: Transaction[] | undefined;
        const identity = this.identity;
        const batchEligible =
            isBatchSignable(identity) &&
            (await this._signerRouter.canBatch(arkTxJobs, ...checkpointJobs));

        if (batchEligible) {
            // Clone so a misbehaving provider can't mutate the originals
            // before submitTx. The contract on `signMultiple` is "one
            // result per request, in input order" — validated below.
            const requests = [
                {
                    tx: offchainTx.arkTx.clone(),
                    inputIndexes: arkTxJobs.map((j) => j.index),
                },
                ...offchainTx.checkpoints.map((c, i) => ({
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
            signedVirtualTx = firstSignedTx;
            userSignedCheckpoints = signedCheckpoints;
        } else {
            signedVirtualTx = await this._signerRouter.sign(offchainTx.arkTx, arkTxJobs);
        }

        // Mark pending before submitting — if we crash between submit and
        // finalize, the next init will recover via finalizePendingTxs.
        await this.setPendingTxFlag(true);

        const { arkTxid, signedCheckpointTxs } = await this.arkProvider.submitTx(
            base64.encode(signedVirtualTx.toPSBT()),
            offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
        );

        let finalCheckpoints: string[];
        if (userSignedCheckpoints) {
            // The server must return exactly one checkpoint per user-signed
            // checkpoint: the merge below pairs them by index, so a short
            // response would silently drop the tail (→ incomplete finalizeTx)
            // and a long one would throw a cryptic undefined access. Guard
            // explicitly, mirroring the signMultiple length check above.
            if (signedCheckpointTxs.length !== userSignedCheckpoints.length) {
                throw new Error(
                    `submitTx returned ${signedCheckpointTxs.length} checkpoints, expected ${userSignedCheckpoints.length}`,
                );
            }
            // Merge stashed user sigs onto the server-signed checkpoints.
            finalCheckpoints = signedCheckpointTxs.map((c, i) => {
                const serverSigned = Transaction.fromPSBT(base64.decode(c));
                combineTapscriptSigs(userSignedCheckpoints![i], serverSigned);
                return base64.encode(serverSigned.toPSBT());
            });
        } else {
            finalCheckpoints = await Promise.all(
                signedCheckpointTxs.map(async (c) => {
                    const tx = Transaction.fromPSBT(base64.decode(c));
                    const signedCheckpoint = await this._signerRouter.sign(
                        tx,
                        this.inputSigningJobsFromWitnessUtxos(tx),
                    );
                    return base64.encode(signedCheckpoint.toPSBT());
                }),
            );
        }

        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

        try {
            await this.setPendingTxFlag(false);
        } catch (error) {
            console.error("Failed to clear pending tx flag:", error);
        }

        return { arkTxid, signedCheckpointTxs };
    }

    // mark virtual outputs as spent, save change outputs if any.
    // `offchainTapscript` is the snapshot the caller captured under
    // `_txLock` before any `await`; deriving both the change-VTXO
    // metadata and `primaryAddress` from it here guarantees the local
    // record matches the pkScript the server saw on the inbound
    // transaction, even if `WalletReceiveRotator.rotate` swaps
    // `this.offchainTapscript` mid-flight.
    private async updateDbAfterOffchainTx(
        inputs: VirtualCoin[],
        arkTxid: string,
        signedCheckpointTxs: string[],
        sentAmount: number,
        changeAmount: bigint,
        changeVout: number,
        offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        changeAssets?: Asset[],
    ): Promise<void> {
        const primaryAddress = offchainTapscript
            .address(this.network.hrp, this.arkServerPublicKey)
            .encode();

        try {
            const spentVtxos: ExtendedVirtualCoin[] = [];
            const commitmentTxIds = new Set<string>();
            let batchExpiry: number = Number.MAX_SAFE_INTEGER;

            if (inputs.length !== signedCheckpointTxs.length) {
                console.warn(
                    `updateDbAfterOffchainTx: inputs length (${inputs.length}) differs from signedCheckpointTxs length (${signedCheckpointTxs.length})`,
                );
            }

            const safeLength = Math.min(inputs.length, signedCheckpointTxs.length);
            const cm = await this.getContractManager();
            const annotatedInputs = await cm.annotateVtxos(inputs);
            for (const [inputIndex, vtxo] of annotatedInputs.entries()) {
                if (inputIndex < safeLength && signedCheckpointTxs[inputIndex]) {
                    const checkpoint = Transaction.fromPSBT(
                        base64.decode(signedCheckpointTxs[inputIndex]),
                    );

                    spentVtxos.push({
                        ...vtxo,
                        virtualStatus: {
                            ...vtxo.virtualStatus,
                            state: "spent",
                        },
                        spentBy: checkpoint.id,
                        arkTxId: arkTxid,
                        isSpent: true,
                    });
                } else {
                    spentVtxos.push({
                        ...vtxo,
                        virtualStatus: {
                            ...vtxo.virtualStatus,
                            state: "spent",
                        },
                        arkTxId: arkTxid,
                        isSpent: true,
                    });
                }

                if (vtxo.virtualStatus.commitmentTxIds) {
                    for (const id of vtxo.virtualStatus.commitmentTxIds) {
                        commitmentTxIds.add(id);
                    }
                }
                if (vtxo.virtualStatus.batchExpiry) {
                    batchExpiry = Math.min(batchExpiry, vtxo.virtualStatus.batchExpiry);
                }
            }

            const createdAt = Date.now();

            // Only save a change virtual output for preconfirmed coins (those with a batchExpiry).
            // Inputs without a batchExpiry are already settled/unrolled and don't need tracking.
            let changeVtxo: ExtendedVirtualCoin | undefined;
            if (changeAmount > 0n && batchExpiry !== Number.MAX_SAFE_INTEGER) {
                changeVtxo = {
                    txid: arkTxid,
                    vout: changeVout,
                    createdAt: new Date(createdAt),
                    forfeitTapLeafScript: offchainTapscript.forfeit(),
                    intentTapLeafScript: offchainTapscript.forfeit(),
                    isUnrolled: false,
                    isSpent: false,
                    tapTree: offchainTapscript.encode(),
                    value: Number(changeAmount),
                    virtualStatus: {
                        state: "preconfirmed",
                        commitmentTxIds: Array.from(commitmentTxIds),
                        batchExpiry,
                    },
                    status: {
                        confirmed: false,
                    },
                    assets: changeAssets,
                    script: hex.encode(offchainTapscript.pkScript),
                };
            }

            // Route spent rows to their owning contract bucket. The wallet's
            // primary contract is registered with the manager at boot, so
            // `addrByScript` already includes it; in a multi-contract spend
            // each input may belong to a different contract.
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
                // User-initiated send path: a wrong-script row here means the
                // wallet is about to record ownership against the wrong
                // contract — fail loudly rather than persist inconsistent state.
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
            // Boarding inputs to remove, grouped by the address they actually
            // sit on. Under per-derivation rotation a settled boarding UTXO may
            // have been received at a *previous* boarding address, so the
            // cleanup must delete from the bucket the UTXO lives in — not just
            // the current `getBoardingAddress()` bucket (plan §6-III.4).
            const boardingRemovalsByAddress = new Map<string, Set<string>>();

            const isVtxo = (input: ExtendedCoin): input is ExtendedVirtualCoin =>
                "virtualStatus" in input;

            const vtxoInputs = inputs.filter(isVtxo);
            const cm = await this.getContractManager();
            const annotatedVtxos = await cm.annotateVtxos(vtxoInputs);
            const annotatedByKey = new Map(annotatedVtxos.map((v) => [`${v.txid}:${v.vout}`, v]));
            for (const input of inputs) {
                if (isVtxo(input)) {
                    // virtual output = mark it settled
                    const vtxo = annotatedByKey.get(`${input.txid}:${input.vout}`)!;
                    if (vtxo.arkTxId) {
                        inputArkTxIds.add(vtxo.arkTxId);
                    }
                    spentVtxos.push({
                        ...vtxo,
                        virtualStatus: {
                            ...vtxo.virtualStatus,
                            state: "settled",
                        },
                        settledBy: commitmentTxid,
                        isSpent: true,
                    });
                } else {
                    // boarding input = remove it from the bucket of the
                    // address it actually sits on. The source boarding address
                    // is recoverable from the input's tapTree (its leaves
                    // determine the tweaked key → on-chain P2TR), so a UTXO
                    // received at a rotated-away boarding address is cleaned up
                    // in its own bucket rather than the current one. Fall back
                    // to the current boarding address if the tapTree can't be
                    // decoded (defensive — real inputs always carry it).
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
                // Route settled rows to their owning contract bucket. In a
                // multi-contract settle the inputs may belong to several
                // contracts; the wallet's primary contract is registered with
                // the manager at boot, so its address is in `addrByScript`
                // alongside the rest.
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
                    // User-initiated settle path: refuse to record a settle
                    // against the wrong script.
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

            for (const [address, toRemove] of boardingRemovalsByAddress) {
                const currentUtxos = await this.walletRepository.getUtxos(address);
                const filtered = currentUtxos.filter((u) => !toRemove.has(`${u.txid}:${u.vout}`));
                // Clear and re-save the filtered list for this address bucket.
                await this.walletRepository.deleteUtxos(address);
                if (filtered.length > 0) {
                    await this.walletRepository.saveUtxos(address, filtered);
                }
            }
        } catch (e) {
            console.warn("error updating repository after settle", e);
            throw e;
        }
    }
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
    // Sort virtual outputs by expiry (ascending) and amount (descending)
    const sortedCoins = [...coins].sort((a, b) => {
        // First sort by expiry if available
        const expiryA = a.virtualStatus.batchExpiry || Number.MAX_SAFE_INTEGER;
        const expiryB = b.virtualStatus.batchExpiry || Number.MAX_SAFE_INTEGER;
        if (expiryA !== expiryB) {
            return expiryA - expiryB; // Earlier expiry first
        }

        // Then sort by amount
        return b.value - a.value; // Larger amount first
    });

    const selectedCoins: ExtendedVirtualCoin[] = [];
    let selectedAmount = 0;

    // Select coins until we have enough
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

    // Check if we have enough
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
 * Wait for incoming funds to the wallet
 * @param wallet - The wallet to wait for incoming funds
 * @returns A promise that resolves the next new coins received by the wallet's address
 */
export async function waitForIncomingFunds(wallet: Wallet): Promise<IncomingFunds> {
    let stopFunc: (() => void) | undefined;
    let settled = false;

    return new Promise<IncomingFunds>((resolve) => {
        wallet
            .notifyIncomingFunds((funds: IncomingFunds) => {
                // `notifyIncomingFunds` also fires for purely outgoing activity:
                // a `vtxo_spent` event carries `newVtxos: []`, and an onchain tx
                // that only spends from the boarding address yields empty
                // `coins`. Those hold no incoming funds, so skip them and keep
                // waiting — otherwise this one-shot helper can resolve on the
                // spent half of a self-send before the matching `vtxo_received`
                // arrives, returning an empty result.
                const hasFunds =
                    funds.type === "utxo" ? funds.coins.length > 0 : funds.newVtxos.length > 0;
                if (settled || !hasFunds) return;

                settled = true;
                resolve(funds);
                stopFunc?.();
            })
            .then((stop) => {
                stopFunc = stop;
                // The callback may have already resolved before the subscription
                // handle was available; tear it down now so we don't leak it.
                if (settled) stop();
            });
    });
}
