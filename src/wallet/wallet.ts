import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction, Address, OutScript } from "@scure/btc-signer";
import { TransactionInput, TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Bytes, sha256 } from "@scure/btc-signer/utils.js";
import { ArkAddress } from "../script/address";
import { DefaultVtxo } from "../script/default";
import { getNetwork, Network, NetworkName } from "../networks";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "../providers/onchain";
import {
    BatchFinalizationEvent,
    SettlementEvent,
    TreeSigningStartedEvent,
    ArkProvider,
    RestArkProvider,
    BatchStartedEvent,
    SignedIntent,
    TreeNoncesEvent,
} from "../providers/ark";
import { SignerSession } from "../tree/signingSession";
import { buildForfeitTx } from "../forfeit";
import {
    validateConnectorsTxGraph,
    validateVtxoTxGraph,
} from "../tree/validation";
import { Identity, ReadonlyIdentity } from "../identity";
import {
    ArkTransaction,
    Asset,
    Recipient,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    IReadonlyWallet,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    IWallet,
    ReadonlyWalletConfig,
    SendBitcoinParams,
    SettleParams,
    TxType,
    VirtualCoin,
    WalletBalance,
    WalletConfig,
    IAssetManager,
    IReadonlyAssetManager,
} from ".";
import {
    createAssetPacket,
    selectedCoinsToAssetInputs,
    selectCoinsWithAsset,
} from "./asset";
import { getSequence, VtxoScript } from "../script/base";
import { CSVMultisigTapscript, RelativeTimelock } from "../script/tapscript";
import {
    buildOffchainTx,
    hasBoardingTxExpired,
    isValidArkAddress,
} from "../utils/arkTransaction";
import { DEFAULT_RENEWAL_CONFIG } from "./vtxo-manager";
import { ArkNote } from "../arknote";
import { Intent } from "../intent";
import { IndexerProvider, RestIndexerProvider } from "../providers/indexer";
import { TxTree } from "../tree/txTree";
import { ConditionWitness, VtxoTaprootTree } from "../utils/unknownFields";
import { InMemoryStorageAdapter } from "../storage/inMemory";
import {
    WalletRepository,
    WalletRepositoryImpl,
} from "../repositories/walletRepository";
import {
    ContractRepository,
    ContractRepositoryImpl,
} from "../repositories/contractRepository";
import { extendCoin, extendVirtualCoin, validateRecipients } from "./utils";
import { ArkError } from "../providers/errors";
import { Batch } from "./batch";
import { Estimator } from "../arkfee";
import { DelegatorProvider } from "../providers/delegator";
import { buildTransactionHistory } from "../utils/transactionHistory";
import { AssetManager, ReadonlyAssetManager } from "./asset-manager";
import { DelegateVtxo } from "../script/delegate";
import { DelegatorManager, DelegatorManagerImpl } from "./delegator";

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

export class ReadonlyWallet implements IReadonlyWallet {
    private readonly _assetManager: IReadonlyAssetManager;

    get assetManager(): IReadonlyAssetManager {
        return this._assetManager;
    }

    protected constructor(
        readonly identity: ReadonlyIdentity,
        readonly network: Network,
        readonly onchainProvider: OnchainProvider,
        readonly indexerProvider: IndexerProvider,
        readonly arkServerPublicKey: Bytes,
        readonly offchainTapscript: DefaultVtxo.Script | DelegateVtxo.Script,
        readonly boardingTapscript: DefaultVtxo.Script,
        readonly dustAmount: bigint,
        public readonly walletRepository: WalletRepository,
        public readonly contractRepository: ContractRepository,
        readonly delegatorProvider?: DelegatorProvider
    ) {
        this._assetManager = new ReadonlyAssetManager(this.indexerProvider);
    }

    /**
     * Protected helper to set up shared wallet configuration.
     * Extracts common logic used by both ReadonlyWallet.create() and Wallet.create().
     */
    protected static async setupWalletConfig(
        config: ReadonlyWalletConfig,
        pubKey: Uint8Array
    ) {
        // Use provided arkProvider instance or create a new one from arkServerUrl
        const arkProvider =
            config.arkProvider ||
            (() => {
                if (!config.arkServerUrl) {
                    throw new Error(
                        "Either arkProvider or arkServerUrl must be provided"
                    );
                }
                return new RestArkProvider(config.arkServerUrl);
            })();

        // Extract arkServerUrl from provider if not explicitly provided
        const arkServerUrl =
            config.arkServerUrl || (arkProvider as RestArkProvider).serverUrl;

        if (!arkServerUrl) {
            throw new Error("Could not determine arkServerUrl from provider");
        }

        // Use provided indexerProvider instance or create a new one
        // indexerUrl defaults to arkServerUrl if not provided
        const indexerUrl = config.indexerUrl || arkServerUrl;
        const indexerProvider =
            config.indexerProvider || new RestIndexerProvider(indexerUrl);

        const info = await arkProvider.getInfo();

        const network = getNetwork(info.network as NetworkName);

        // Extract esploraUrl from provider if not explicitly provided
        const esploraUrl =
            config.esploraUrl || ESPLORA_URL[info.network as NetworkName];

        // Use provided onchainProvider instance or create a new one
        const onchainProvider =
            config.onchainProvider || new EsploraProvider(esploraUrl);

        // validate unilateral exit timelock passed in config if any
        if (config.exitTimelock) {
            const { value, type } = config.exitTimelock;
            if (
                (value < 512n && type !== "blocks") ||
                (value >= 512n && type !== "seconds")
            ) {
                throw new Error("invalid exitTimelock");
            }
        }

        // create unilateral exit timelock
        const exitTimelock: RelativeTimelock = config.exitTimelock ?? {
            value: info.unilateralExitDelay,
            type: info.unilateralExitDelay < 512n ? "blocks" : "seconds",
        };

        // validate boarding timelock passed in config if any
        if (config.boardingTimelock) {
            const { value, type } = config.boardingTimelock;
            if (
                (value < 512n && type !== "blocks") ||
                (value >= 512n && type !== "seconds")
            ) {
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

        const delegatePubKey = config.delegatorProvider
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
        const boardingTapscript = new DefaultVtxo.Script({
            ...offchainOptions,
            csvTimelock: boardingTimelock,
        });

        // Set up storage and repositories
        const storage = config.storage || new InMemoryStorageAdapter();
        const walletRepository = new WalletRepositoryImpl(storage);
        const contractRepository = new ContractRepositoryImpl(storage);

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
            delegatorProvider: config.delegatorProvider,
        };
    }

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
            setup.delegatorProvider
        );
    }

    get arkAddress(): ArkAddress {
        return this.offchainTapscript.address(
            this.network.hrp,
            this.arkServerPublicKey
        );
    }

    async getAddress(): Promise<string> {
        return this.arkAddress.encode();
    }

    async getBoardingAddress(): Promise<string> {
        return this.boardingTapscript.onchainAddress(this.network);
    }

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
            .filter(
                (coin) =>
                    isSpendable(coin) && coin.virtualStatus.state === "swept"
            )
            .reduce((sum, coin) => sum + coin.value, 0);

        const totalBoarding = confirmed + unconfirmed;
        const totalOffchain = settled + preconfirmed + recoverable;

        // aggregate asset balances from spendable vtxos
        const assetBalances = new Map<string, number>();
        for (const vtxo of vtxos) {
            if (!isSpendable(vtxo)) continue;
            if (vtxo.assets) {
                for (const a of vtxo.assets) {
                    const current = assetBalances.get(a.assetId) ?? 0;
                    assetBalances.set(a.assetId, current + a.amount);
                }
            }
        }
        const assets = Array.from(assetBalances.entries()).map(
            ([assetId, amount]) => ({
                assetId,
                amount,
            })
        );

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

    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        const address = await this.getAddress();

        // Try to get from cache first first (optional fast path)
        // const cachedVtxos = await this.walletRepository.getVtxos(address);
        // if (cachedVtxos.length) return cachedVtxos;

        // For now, always fetch fresh data from provider and update cache
        // In future, we can add cache invalidation logic based on timestamps
        const vtxos = await this.getVirtualCoins(filter);
        const extendedVtxos = vtxos.map((vtxo) =>
            extendVirtualCoin(this, vtxo)
        );

        // Update cache with fresh data
        await this.walletRepository.saveVtxos(address, extendedVtxos);

        return extendedVtxos;
    }

    protected async getVirtualCoins(
        filter: GetVtxosFilter = { withRecoverable: true, withUnrolled: false }
    ): Promise<VirtualCoin[]> {
        const scripts = [hex.encode(this.offchainTapscript.pkScript)];
        const response = await this.indexerProvider.getVtxos({ scripts });
        const allVtxos = response.vtxos;

        let vtxos: VirtualCoin[] = allVtxos.filter(isSpendable);

        // all recoverable vtxos are spendable by definition
        if (!filter.withRecoverable) {
            vtxos = vtxos.filter(
                (vtxo) => !isRecoverable(vtxo) && !isExpired(vtxo)
            );
        }

        if (filter.withUnrolled) {
            const spentVtxos = allVtxos.filter((vtxo) => !isSpendable(vtxo));
            vtxos.push(...spentVtxos.filter((vtxo) => vtxo.isUnrolled));
        }

        return vtxos;
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const response = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(this.offchainTapscript.pkScript)],
        });

        const { boardingTxs, commitmentsToIgnore } =
            await this.getBoardingTxs();

        const getTxCreatedAt = (txid: string) =>
            this.indexerProvider
                .getVtxos({ outpoints: [{ txid, vout: 0 }] })
                .then((res) => res.vtxos[0]?.createdAt.getTime() || 0);

        return buildTransactionHistory(
            response.vtxos,
            boardingTxs,
            commitmentsToIgnore,
            getTxCreatedAt
        );
    }

    async getBoardingTxs(): Promise<{
        boardingTxs: ArkTransaction[];
        commitmentsToIgnore: Set<string>;
    }> {
        const utxos: VirtualCoin[] = [];
        const commitmentsToIgnore = new Set<string>();
        const boardingAddress = await this.getBoardingAddress();
        const txs = await this.onchainProvider.getTransactions(boardingAddress);

        for (const tx of txs) {
            for (let i = 0; i < tx.vout.length; i++) {
                const vout = tx.vout[i];
                if (vout.scriptpubkey_address === boardingAddress) {
                    const spentStatuses =
                        await this.onchainProvider.getTxOutspends(tx.txid);
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
                    });
                }
            }
        }

        const unconfirmedTxs: ArkTransaction[] = [];
        const confirmedTxs: ArkTransaction[] = [];

        for (const utxo of utxos) {
            const tx: ArkTransaction = {
                key: {
                    boardingTxid: utxo.txid,
                    commitmentTxid: "",
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

    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        const boardingAddress = await this.getBoardingAddress();
        const boardingUtxos =
            await this.onchainProvider.getCoins(boardingAddress);

        const utxos = boardingUtxos.map((utxo) => {
            return extendCoin(this, utxo);
        });

        // Save boardingUtxos using unified repository
        await this.walletRepository.saveUtxos(boardingAddress, utxos);

        return utxos;
    }

    async notifyIncomingFunds(
        eventCallback: (coins: IncomingFunds) => void
    ): Promise<() => void> {
        const arkAddress = await this.getAddress();
        const boardingAddress = await this.getBoardingAddress();

        let onchainStopFunc: () => void;
        let indexerStopFunc: () => void;

        if (this.onchainProvider && boardingAddress) {
            const findVoutOnTx = (tx: any) => {
                return tx.vout.findIndex(
                    (v: any) => v.scriptpubkey_address === boardingAddress
                );
            };
            onchainStopFunc = await this.onchainProvider.watchAddresses(
                [boardingAddress],
                (txs) => {
                    // find all utxos belonging to our boarding address
                    const coins: Coin[] = txs
                        // filter txs where address is in output
                        .filter((tx) => findVoutOnTx(tx) !== -1)
                        // return utxo as Coin
                        .map((tx) => {
                            const { txid, status } = tx;
                            const vout = findVoutOnTx(tx);
                            const value = Number(tx.vout[vout].value);
                            return { txid, vout, value, status };
                        });

                    // and notify via callback
                    eventCallback({
                        type: "utxo",
                        coins,
                    });
                }
            );
        }

        if (this.indexerProvider && arkAddress) {
            const offchainScript = this.offchainTapscript;

            const subscriptionId =
                await this.indexerProvider.subscribeForScripts([
                    hex.encode(offchainScript.pkScript),
                ]);

            const abortController = new AbortController();
            const subscription = this.indexerProvider.getSubscription(
                subscriptionId,
                abortController.signal
            );

            indexerStopFunc = async () => {
                abortController.abort();
                await this.indexerProvider?.unsubscribeForScripts(
                    subscriptionId
                );
            };

            // Handle subscription updates asynchronously without blocking
            (async () => {
                try {
                    for await (const update of subscription) {
                        if (
                            update.newVtxos?.length > 0 ||
                            update.spentVtxos?.length > 0
                        ) {
                            eventCallback({
                                type: "vtxo",
                                newVtxos: update.newVtxos.map((vtxo) =>
                                    extendVirtualCoin(this, vtxo)
                                ),
                                spentVtxos: update.spentVtxos.map((vtxo) =>
                                    extendVirtualCoin(this, vtxo)
                                ),
                            });
                        }
                    }
                } catch (error) {
                    console.error("Subscription error:", error);
                }
            })();
        }

        const stopFunc = () => {
            onchainStopFunc?.();
            indexerStopFunc?.();
        };

        return stopFunc;
    }

    async fetchPendingTxs(): Promise<string[]> {
        // get non-swept VTXOs, rely on the indexer only in case DB doesn't have the right state
        const scripts = [hex.encode(this.offchainTapscript.pkScript)];
        let { vtxos } = await this.indexerProvider.getVtxos({
            scripts,
        });
        return vtxos
            .filter(
                (vtxo) =>
                    vtxo.virtualStatus.state !== "swept" &&
                    vtxo.virtualStatus.state !== "settled" &&
                    vtxo.arkTxId !== undefined
            )
            .map((_) => _.arkTxId!);
    }
}

/**
 * Main wallet implementation for Bitcoin transactions with Ark protocol support.
 * The wallet does not store any data locally and relies on Ark and onchain
 * providers to fetch UTXOs and VTXOs.
 *
 * @example
 * ```typescript
 * // Create a wallet with URL configuration
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('your_private_key'),
 *   arkServerUrl: 'https://ark.example.com',
 *   esploraUrl: 'https://mempool.space/api'
 * });
 *
 * // Or with custom provider instances (e.g., for Expo/React Native)
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('your_private_key'),
 *   arkProvider: new ExpoArkProvider('https://ark.example.com'),
 *   indexerProvider: new ExpoIndexerProvider('https://ark.example.com'),
 *   esploraUrl: 'https://mempool.space/api'
 * });
 *
 * // Get addresses
 * const arkAddress = await wallet.getAddress();
 * const boardingAddress = await wallet.getBoardingAddress();
 *
 * // Send bitcoin
 * const txid = await wallet.sendBitcoin({
 *   address: 'tb1...',
 *   amount: 50000
 * });
 * ```
 */
export class Wallet extends ReadonlyWallet implements IWallet {
    static MIN_FEE_RATE = 1; // sats/vbyte

    override readonly identity: Identity;
    readonly delegatorManager?: DelegatorManager;

    private _walletAssetManager?: IAssetManager;

    public readonly renewalConfig: Required<
        Omit<WalletConfig["renewalConfig"], "enabled">
    > & { enabled: boolean; thresholdMs: number };

    protected constructor(
        identity: Identity,
        network: Network,
        readonly networkName: NetworkName,
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
        renewalConfig?: WalletConfig["renewalConfig"],
        delegatorProvider?: DelegatorProvider
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
            delegatorProvider
        );
        this.identity = identity;
        this.renewalConfig = {
            enabled: renewalConfig?.enabled ?? false,
            ...DEFAULT_RENEWAL_CONFIG,
            ...renewalConfig,
        };
        this.delegatorManager = delegatorProvider
            ? new DelegatorManagerImpl(delegatorProvider, arkProvider, identity)
            : undefined;
    }

    override get assetManager(): IAssetManager {
        this._walletAssetManager ??= new AssetManager(this);
        return this._walletAssetManager;
    }

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
        const forfeitAddress = Address(setup.network).decode(
            setup.info.forfeitAddress
        );
        const forfeitOutputScript = OutScript.encode(forfeitAddress);

        return new Wallet(
            config.identity,
            setup.network,
            setup.networkName,
            setup.onchainProvider,
            setup.arkProvider,
            setup.indexerProvider,
            setup.serverPubKey,
            setup.offchainTapscript,
            setup.boardingTapscript,
            serverUnrollScript,
            forfeitOutputScript,
            forfeitPubkey,
            setup.dustAmount,
            setup.walletRepository,
            setup.contractRepository,
            config.renewalConfig,
            config.delegatorProvider
        );
    }

    /**
     * Convert this wallet to a readonly wallet.
     *
     * @returns A readonly wallet with the same configuration but readonly identity
     * @example
     * ```typescript
     * const wallet = await Wallet.create({ identity: SingleKey.fromHex('...'), ... });
     * const readonlyWallet = await wallet.toReadonly();
     *
     * // Can query balance and addresses
     * const balance = await readonlyWallet.getBalance();
     * const address = await readonlyWallet.getAddress();
     *
     * // But cannot send transactions (type error)
     * // readonlyWallet.sendBitcoin(...); // TypeScript error
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
            this.contractRepository
        );
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }

        if (!isValidArkAddress(params.address)) {
            throw new Error("Invalid Ark address " + params.address);
        }

        // recoverable and subdust coins can't be spent in offchain tx
        const virtualCoins = await this.getVirtualCoins({
            withRecoverable: false,
        });

        let selected;
        if (params.selectedVtxos) {
            const selectedVtxoSum = params.selectedVtxos
                .map((v) => v.value)
                .reduce((a, b) => a + b, 0);
            if (selectedVtxoSum < params.amount) {
                throw new Error("Selected VTXOs do not cover specified amount");
            }
            const changeAmount = selectedVtxoSum - params.amount;

            selected = {
                inputs: params.selectedVtxos,
                changeAmount: BigInt(changeAmount),
            };
        } else {
            selected = selectVirtualCoins(virtualCoins, params.amount);
        }

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
                    ? this.arkAddress.subdustPkScript
                    : this.arkAddress.pkScript;

            outputs.push({
                script: changeOutputScript,
                amount: BigInt(selected.changeAmount),
            });
        }

        const { arkTxid, signedCheckpointTxs } =
            await this.buildAndSubmitOffchainTx(selected.inputs, outputs);

        await this.updateDbAfterOffchainTx(
            selected.inputs,
            arkTxid,
            signedCheckpointTxs,
            params.amount,
            selected.changeAmount,
            selected.changeAmount > 0n ? outputs.length - 1 : 0
        );

        return arkTxid;
    }

    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
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

        // if no params are provided, use all non expired boarding utxos and offchain vtxos as inputs
        // and send all to the offchain address
        if (!params) {
            const { fees } = await this.arkProvider.getInfo();
            const estimator = new Estimator(fees.intentFee);

            let amount = 0;

            const exitScript = CSVMultisigTapscript.decode(
                hex.decode(this.boardingTapscript.exitScript)
            );

            const boardingTimelock = exitScript.params.timelock;

            const boardingUtxos = (await this.getBoardingUtxos()).filter(
                (utxo) => !hasBoardingTxExpired(utxo, boardingTimelock)
            );

            const filteredBoardingUtxos = [];
            for (const utxo of boardingUtxos) {
                const inputFee = estimator.evalOnchainInput({
                    amount: BigInt(utxo.value),
                });
                if (inputFee.value >= utxo.value) {
                    // skip if fees are greater than the utxo value
                    continue;
                }

                filteredBoardingUtxos.push(utxo);
                amount += utxo.value - inputFee.satoshis;
            }

            const vtxos = await this.getVtxos({ withRecoverable: true });

            const filteredVtxos = [];
            for (const vtxo of vtxos) {
                const inputFee = estimator.evalOffchainInput({
                    amount: BigInt(vtxo.value),
                    type:
                        vtxo.virtualStatus.state === "swept"
                            ? "recoverable"
                            : "vtxo",
                    weight: 0,
                    birth: vtxo.createdAt,
                    expiry: vtxo.virtualStatus.batchExpiry
                        ? new Date(vtxo.virtualStatus.batchExpiry * 1000)
                        : new Date(),
                });
                if (inputFee.value >= vtxo.value) {
                    // skip if fees are greater than the vtxo value
                    continue;
                }

                filteredVtxos.push(vtxo);
                amount += vtxo.value - inputFee.satoshis;
            }

            const inputs = [...filteredBoardingUtxos, ...filteredVtxos];
            if (inputs.length === 0) {
                throw new Error("No inputs found");
            }

            const output = {
                address: await this.getAddress(),
                amount: BigInt(amount),
            };

            const outputFee = estimator.evalOffchainOutput({
                amount: output.amount,
                script: hex.encode(ArkAddress.decode(output.address).pkScript),
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
                const assets = (params.inputs[i] as unknown as VirtualCoin)
                    .assets;
                if (assets && assets.length > 0) {
                    assetInputs.set(i + 1, assets);
                }
            }
        }

        if (assetInputs.size > 0) {
            // collect all input assets and assign them to the first offchain output
            const allAssets = new Map<string, bigint>();
            for (const [, assets] of assetInputs) {
                for (const asset of assets) {
                    const existing = allAssets.get(asset.assetId) ?? 0n;
                    allAssets.set(
                        asset.assetId,
                        existing + BigInt(asset.amount)
                    );
                }
            }

            const assetList: Asset[] = [];
            for (const [assetId, amount] of allAssets) {
                assetList.push({ assetId, amount: Number(amount) });
            }

            // TODO change this logic to allow mutiple outputs ?
            const firstOffchainIndex = params.outputs.findIndex(
                (_, i) => !onchainOutputIndexes.includes(i)
            );
            if (firstOffchainIndex === -1) {
                throw new Error(
                    "Cannot settle assets without an offchain output"
                );
            }

            const receivers: Recipient[] = params.outputs.map((output, i) => ({
                address: output.address,
                amount: Number(output.amount),
                assets: i === firstOffchainIndex ? assetList : undefined,
            }));

            const assetPacket = createAssetPacket(
                assetInputs,
                receivers,
                undefined
            );
            outputs.push(assetPacket.txOut());
        }

        // session holds the state of the musig2 signing process of the vtxo tree
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
                signingPublicKeys
            ),
            this.makeDeleteIntentSignature(params.inputs),
        ]);

        const intentId = await this.safeRegisterIntent(intent);

        const topics = [
            ...signingPublicKeys,
            ...params.inputs.map((input) => `${input.txid}:${input.vout}`),
        ];

        const handler = this.createBatchHandler(
            intentId,
            params.inputs,
            session
        );

        const abortController = new AbortController();

        try {
            const stream = this.arkProvider.getEventStream(
                abortController.signal,
                topics
            );

            const commitmentTxid = await Batch.join(stream, handler, {
                abortController,
                skipVtxoTreeSigning: !hasOffchainOutputs,
                eventCallback: eventCallback
                    ? (event) => Promise.resolve(eventCallback(event))
                    : undefined,
            });

            await this.updateDbAfterSettle(params.inputs, commitmentTxid);

            return commitmentTxid;
        } catch (error) {
            // delete the intent to not be stuck in the queue
            await this.arkProvider.deleteIntent(deleteIntent).catch(() => {});
            throw error;
        } finally {
            // close the stream
            abortController.abort();
        }
    }

    private async handleSettlementFinalizationEvent(
        event: BatchFinalizationEvent,
        inputs: SettleParams["inputs"],
        forfeitOutputScript: Bytes,
        connectorsGraph?: TxTree
    ) {
        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        const vtxos = await this.getVirtualCoins();
        let settlementPsbt = Transaction.fromPSBT(
            base64.decode(event.commitmentTx)
        );
        let hasBoardingUtxos = false;

        let connectorIndex = 0;

        const connectorsLeaves = connectorsGraph?.leaves() || [];

        for (const input of inputs) {
            // check if the input is an offchain "virtual" coin
            const vtxo = vtxos.find(
                (vtxo) => vtxo.txid === input.txid && vtxo.vout === input.vout
            );

            // boarding utxo, we need to sign the settlement tx
            if (!vtxo) {
                for (let i = 0; i < settlementPsbt.inputsLength; i++) {
                    const settlementInput = settlementPsbt.getInput(i);

                    if (
                        !settlementInput.txid ||
                        settlementInput.index === undefined
                    ) {
                        throw new Error(
                            "The server returned incomplete data. No settlement input found in the PSBT"
                        );
                    }
                    const inputTxId = hex.encode(settlementInput.txid);
                    if (inputTxId !== input.txid) continue;
                    if (settlementInput.index !== input.vout) continue;
                    // input found in the settlement tx, sign it
                    settlementPsbt.updateInput(i, {
                        tapLeafScript: [input.forfeitTapLeafScript],
                    });
                    settlementPsbt = await this.identity.sign(settlementPsbt, [
                        i,
                    ]);
                    hasBoardingUtxos = true;
                    break;
                }

                continue;
            }

            if (isRecoverable(vtxo) || isSubdust(vtxo, this.dustAmount)) {
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
                            amount: BigInt(vtxo.value),
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
                forfeitOutputScript
            );

            // do not sign the connector input
            forfeitTx = await this.identity.sign(forfeitTx, [0]);

            signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }

        if (signedForfeits.length > 0 || hasBoardingUtxos) {
            await this.arkProvider.submitSignedForfeitTxs(
                signedForfeits,
                hasBoardingUtxos
                    ? base64.encode(settlementPsbt.toPSBT())
                    : undefined
            );
        }
    }

    /**
     * @implements Batch.Handler interface.
     * @param intentId - The intent ID.
     * @param inputs - The inputs of the intent.
     * @param session - The musig2 signing session, if not provided, the signing will be skipped.
     */
    createBatchHandler(
        intentId: string,
        inputs: ExtendedCoin[],
        session?: SignerSession
    ): Batch.Handler {
        let sweepTapTreeRoot: Uint8Array | undefined;
        return {
            onBatchStarted: async (
                event: BatchStartedEvent
            ): Promise<{ skip: boolean }> => {
                const utf8IntentId = new TextEncoder().encode(intentId);
                const intentIdHash = sha256(utf8IntentId);
                const intentIdHashStr = hex.encode(intentIdHash);

                let skip = true;

                // check if our intent ID hash matches any in the event
                for (const idHash of event.intentIdHashes) {
                    if (idHash === intentIdHashStr) {
                        if (!this.arkProvider) {
                            throw new Error("Ark provider not configured");
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
                vtxoTree: TxTree
            ): Promise<{ skip: boolean }> => {
                if (!session) {
                    return { skip: true };
                }
                if (!sweepTapTreeRoot) {
                    throw new Error("Sweep tap tree root not set");
                }

                const xOnlyPublicKeys = event.cosignersPublicKeys.map((k) =>
                    k.slice(2)
                );
                const signerPublicKey = await session.getPublicKey();
                const xonlySignerPublicKey = signerPublicKey.subarray(1);

                if (
                    !xOnlyPublicKeys.includes(hex.encode(xonlySignerPublicKey))
                ) {
                    // not a cosigner, skip the signing
                    return { skip: true };
                }

                // validate the unsigned vtxo tree
                const commitmentTx = Transaction.fromPSBT(
                    base64.decode(event.unsignedCommitmentTx)
                );
                validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot);

                // TODO check if our registered outputs are in the vtxo tree

                const sharedOutput = commitmentTx.getOutput(0);
                if (!sharedOutput?.amount) {
                    throw new Error("Shared output not found");
                }

                await session.init(
                    vtxoTree,
                    sweepTapTreeRoot,
                    sharedOutput.amount
                );

                const pubkey = hex.encode(await session.getPublicKey());
                const nonces = await session.getNonces();

                await this.arkProvider.submitTreeNonces(
                    event.id,
                    pubkey,
                    nonces
                );

                return { skip: false };
            },
            onTreeNonces: async (
                event: TreeNoncesEvent
            ): Promise<{ fullySigned: boolean }> => {
                if (!session) {
                    return { fullySigned: true }; // Signing complete (no signing needed)
                }

                const { hasAllNonces } = await session.aggregatedNonces(
                    event.txid,
                    event.nonces
                );

                // wait to receive and aggregate all nonces before sending signatures
                if (!hasAllNonces) return { fullySigned: false };

                const signatures = await session.sign();
                const pubkey = hex.encode(await session.getPublicKey());

                await this.arkProvider.submitTreeSignatures(
                    event.id,
                    pubkey,
                    signatures
                );
                return { fullySigned: true };
            },
            onBatchFinalization: async (
                event: BatchFinalizationEvent,
                _?: TxTree,
                connectorTree?: TxTree
            ): Promise<void> => {
                if (!this.forfeitOutputScript) {
                    throw new Error("Forfeit output script not set");
                }

                if (connectorTree) {
                    validateConnectorsTxGraph(
                        event.commitmentTx,
                        connectorTree
                    );
                }

                await this.handleSettlementFinalizationEvent(
                    event,
                    inputs,
                    this.forfeitOutputScript,
                    connectorTree
                );
            },
        };
    }

    async safeRegisterIntent(
        intent: SignedIntent<Intent.RegisterMessage>
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
                // delete all intents spending one of the wallet coins
                const allSpendableCoins = await this.getVtxos({
                    withRecoverable: true,
                });
                const deleteIntent =
                    await this.makeDeleteIntentSignature(allSpendableCoins);
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
        validAt?: number
    ): Promise<SignedIntent<Intent.RegisterMessage>> {
        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: onchainOutputsIndexes,
            valid_at: validAt ? Math.floor(validAt) : 0,
            expire_at: 0,
            cosigners_public_keys: cosignerPubKeys,
        };

        const proof = Intent.create(message, coins, outputs);
        const signedProof = await this.identity.sign(proof);

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    async makeDeleteIntentSignature(
        coins: ExtendedCoin[]
    ): Promise<SignedIntent<Intent.DeleteMessage>> {
        const message: Intent.DeleteMessage = {
            type: "delete",
            expire_at: 0,
        };

        const proof = Intent.create(message, coins, []);
        const signedProof = await this.identity.sign(proof);

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    async makeGetPendingTxIntentSignature(
        coins: ExtendedVirtualCoin[]
    ): Promise<SignedIntent<Intent.GetPendingTxMessage>> {
        const message: Intent.GetPendingTxMessage = {
            type: "get-pending-tx",
            expire_at: 0,
        };

        const proof = Intent.create(message, coins, []);
        const signedProof = await this.identity.sign(proof);

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    /**
     * Finalizes pending transactions by retrieving them from the server and finalizing each one.
     * @param vtxos - Optional list of VTXOs to use instead of retrieving them from the server
     * @returns Array of transaction IDs that were finalized
     */
    async finalizePendingTxs(
        vtxos?: ExtendedVirtualCoin[]
    ): Promise<{ finalized: string[]; pending: string[] }> {
        const MAX_INPUTS_PER_INTENT = 20;

        if (!vtxos || vtxos.length === 0) {
            // get non-swept VTXOs, rely on the indexer only in case DB doesn't have the right state
            const scripts = [hex.encode(this.offchainTapscript.pkScript)];
            let { vtxos: fetchedVtxos } = await this.indexerProvider.getVtxos({
                scripts,
            });
            fetchedVtxos = fetchedVtxos.filter(
                (vtxo) =>
                    vtxo.virtualStatus.state !== "swept" &&
                    vtxo.virtualStatus.state !== "settled"
            );

            if (fetchedVtxos.length === 0) {
                return { finalized: [], pending: [] };
            }

            vtxos = fetchedVtxos.map((v) => extendVirtualCoin(this, v));
        }
        const finalized: string[] = [];
        const pending: string[] = [];

        for (let i = 0; i < vtxos.length; i += MAX_INPUTS_PER_INTENT) {
            const batch = vtxos.slice(i, i + MAX_INPUTS_PER_INTENT);
            const intent = await this.makeGetPendingTxIntentSignature(batch);
            const pendingTxs = await this.arkProvider.getPendingTxs(intent);

            // finalize each transaction by signing the checkpoints
            for (const pendingTx of pendingTxs) {
                pending.push(pendingTx.arkTxid);
                try {
                    // sign the checkpoints
                    const finalCheckpoints = await Promise.all(
                        pendingTx.signedCheckpointTxs.map(async (c) => {
                            const tx = Transaction.fromPSBT(base64.decode(c));
                            const signedCheckpoint =
                                await this.identity.sign(tx);
                            return base64.encode(signedCheckpoint.toPSBT());
                        })
                    );

                    await this.arkProvider.finalizeTx(
                        pendingTx.arkTxid,
                        finalCheckpoints
                    );
                    finalized.push(pendingTx.arkTxid);
                } catch (error) {
                    console.error(
                        `Failed to finalize transaction ${pendingTx.arkTxid}:`,
                        error
                    );
                    // continue with other transactions even if one fails
                }
            }
        }

        return { finalized, pending };
    }

    /**
     * Send BTC and/or assets to one or more recipients.
     *
     * @param recipients - Array of recipients with their addresses, BTC amounts, and assets
     * @returns Promise resolving to the ark transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.send({
     *     address: 'ark1...',
     *     amount: 1000, // (optional, default to dust) btc amount to send to the output
     *     assets: [{ assetId: 'abc123...', amount: 50 }] // (optional) list of assets to send
     * });
     * ```
     */
    async send(...args: Recipient[]): Promise<string> {
        if (args.length === 0) {
            throw new Error("At least one receiver is required");
        }

        // validate recipients and populate undefined amount with dust amount
        const recipients = validateRecipients(args, Number(this.dustAmount));

        const address = await this.getAddress();
        const outputAddress = ArkAddress.decode(address);

        const virtualCoins = await this.getVirtualCoins({
            withRecoverable: false,
        });

        // keep track of asset changes
        const assetChanges = new Map<string, bigint>();

        let selectedCoins: VirtualCoin[] = [];
        let btcAmountToSelect = 0;

        for (const recipient of recipients) {
            btcAmountToSelect += Math.max(
                recipient.amount,
                Number(this.dustAmount)
            );
        }

        // select assets
        for (const recipient of recipients) {
            if (!recipient.assets) {
                continue;
            }
            for (const receiverAsset of recipient.assets) {
                let amountToSelect = BigInt(receiverAsset.amount);

                // check if existing change covers the needed amount
                const existingChange =
                    assetChanges.get(receiverAsset.assetId) ?? 0n;
                if (existingChange >= amountToSelect) {
                    assetChanges.set(
                        receiverAsset.assetId,
                        existingChange - amountToSelect
                    );
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
                    (c) =>
                        !selectedCoins.find(
                            (sc) => sc.txid === c.txid && sc.vout === c.vout
                        )
                );

                const { selected, totalAssetAmount } = selectCoinsWithAsset(
                    availableCoins,
                    receiverAsset.assetId,
                    amountToSelect
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
                            assetChanges.set(
                                a.assetId,
                                existing + BigInt(a.amount)
                            );
                        }
                    }
                }

                const assetChangeAmount = totalAssetAmount - amountToSelect;
                if (assetChangeAmount > 0n) {
                    const existing =
                        assetChanges.get(receiverAsset.assetId) ?? 0n;
                    assetChanges.set(
                        receiverAsset.assetId,
                        existing + assetChangeAmount
                    );
                }
            }
        }

        // select remaining btc
        if (btcAmountToSelect > 0) {
            const availableCoins = virtualCoins.filter(
                (c) =>
                    !selectedCoins.find(
                        (sc) => sc.txid === c.txid && sc.vout === c.vout
                    )
            );
            const { inputs: btcCoins } = selectVirtualCoins(
                availableCoins,
                btcAmountToSelect
            );

            // some coins may contain assets, add them to asset changes
            for (const coin of btcCoins) {
                if (coin.assets) {
                    for (const asset of coin.assets) {
                        const existing = assetChanges.get(asset.assetId) ?? 0n;
                        assetChanges.set(
                            asset.assetId,
                            existing + BigInt(asset.amount)
                        );
                    }
                }
            }

            selectedCoins = [...selectedCoins, ...btcCoins];
        }

        let totalBtcSelected = selectedCoins.reduce(
            (sum, c) => sum + c.value,
            0
        );

        // build tx outputs
        const outputs = recipients.map((recipient) => ({
            script: recipient.script,
            amount: BigInt(recipient.amount),
        }));

        const totalBtcOutput = outputs.reduce(
            (sum, o) => sum + Number(o.amount),
            0
        );
        let changeAmount = totalBtcSelected - totalBtcOutput;

        // enforce minimum change amount when there are asset changes
        if (assetChanges.size > 0 && changeAmount < Number(this.dustAmount)) {
            const availableCoins = virtualCoins.filter(
                (c) =>
                    !selectedCoins.find(
                        (sc) => sc.txid === c.txid && sc.vout === c.vout
                    )
            );
            const { inputs: extraCoins } = selectVirtualCoins(
                availableCoins,
                Number(this.dustAmount) - changeAmount
            );

            for (const coin of extraCoins) {
                if (coin.assets) {
                    for (const asset of coin.assets) {
                        const existing = assetChanges.get(asset.assetId) ?? 0n;
                        assetChanges.set(
                            asset.assetId,
                            existing + BigInt(asset.amount)
                        );
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
                    changeAssets.push({ assetId, amount: Number(amount) });
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
            assetInputs.size > 0 ||
            recipients.some((r) => r.assets && r.assets.length > 0);
        if (hasAssets) {
            const assetPacket = createAssetPacket(
                assetInputs,
                recipients,
                changeReceiver
            );
            outputs.push(assetPacket.txOut());
        }

        const sentAmount = recipients.reduce((sum, r) => sum + r.amount, 0);

        const { arkTxid, signedCheckpointTxs } =
            await this.buildAndSubmitOffchainTx(selectedCoins, outputs);

        await this.updateDbAfterOffchainTx(
            selectedCoins,
            arkTxid,
            signedCheckpointTxs,
            sentAmount,
            BigInt(changeAmount),
            changeReceiver ? changeIndex : 0,
            changeReceiver?.assets
        );

        return arkTxid;
    }

    /**
     * Build an offchain transaction from the given inputs and outputs,
     * sign it, submit to the ark provider, and finalize.
     * @returns The ark transaction id and server-signed checkpoint PSBTs (for bookkeeping)
     */
    async buildAndSubmitOffchainTx(
        inputs: VirtualCoin[],
        outputs: TransactionOutput[]
    ): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }> {
        const tapLeafScript = this.offchainTapscript.forfeit();
        if (!tapLeafScript) {
            throw new Error("Selected leaf not found");
        }
        const tapTree = this.offchainTapscript.encode();
        const offchainTx = buildOffchainTx(
            inputs.map((input) => ({
                ...input,
                tapLeafScript,
                tapTree,
            })),
            outputs,
            this.serverUnrollScript
        );
        const signedVirtualTx = await this.identity.sign(offchainTx.arkTx);
        const { arkTxid, signedCheckpointTxs } =
            await this.arkProvider.submitTx(
                base64.encode(signedVirtualTx.toPSBT()),
                offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
            );
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c));
                const signedCheckpoint = await this.identity.sign(tx);
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );
        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
        return { arkTxid, signedCheckpointTxs };
    }

    // mark vtxo spent and save change vtxo if any
    private async updateDbAfterOffchainTx(
        inputs: VirtualCoin[],
        arkTxid: string,
        signedCheckpointTxs: string[],
        sentAmount: number,
        changeAmount: bigint,
        changeVout: number,
        changeAssets?: Asset[]
    ): Promise<void> {
        try {
            const spentVtxos: ExtendedVirtualCoin[] = [];
            const commitmentTxIds = new Set<string>();
            let batchExpiry: number = Number.MAX_SAFE_INTEGER;

            for (const [inputIndex, input] of inputs.entries()) {
                const vtxo = extendVirtualCoin(this, input);

                const checkpointB64 = signedCheckpointTxs[inputIndex];
                const checkpoint = Transaction.fromPSBT(
                    base64.decode(checkpointB64)
                );

                spentVtxos.push({
                    ...vtxo,
                    virtualStatus: { ...vtxo.virtualStatus, state: "spent" },
                    spentBy: checkpoint.id,
                    arkTxId: arkTxid,
                    isSpent: true,
                });

                if (vtxo.virtualStatus.commitmentTxIds) {
                    for (const id of vtxo.virtualStatus.commitmentTxIds) {
                        commitmentTxIds.add(id);
                    }
                }
                if (vtxo.virtualStatus.batchExpiry) {
                    batchExpiry = Math.min(
                        batchExpiry,
                        vtxo.virtualStatus.batchExpiry
                    );
                }
            }

            const createdAt = Date.now();
            const addr = this.arkAddress.encode();

            // Only save a change VTXO for preconfirmed coins (those with a batchExpiry).
            // Inputs without a batchExpiry are already settled/unrolled and don't need tracking.
            let changeVtxo: ExtendedVirtualCoin | undefined;
            if (changeAmount > 0n && batchExpiry !== Number.MAX_SAFE_INTEGER) {
                changeVtxo = {
                    txid: arkTxid,
                    vout: changeVout,
                    createdAt: new Date(createdAt),
                    forfeitTapLeafScript: this.offchainTapscript.forfeit(),
                    intentTapLeafScript: this.offchainTapscript.forfeit(),
                    isUnrolled: false,
                    isSpent: false,
                    tapTree: this.offchainTapscript.encode(),
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
                };
            }

            await this.walletRepository.saveVtxos(
                addr,
                changeVtxo ? [...spentVtxos, changeVtxo] : spentVtxos
            );

            await this.walletRepository.saveTransactions(addr, [
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
        }
    }

    // mark vtxo spent & settled, remove boarding utxo
    private async updateDbAfterSettle(
        inputs: ExtendedCoin[],
        commitmentTxid: string
    ): Promise<void> {
        try {
            const addr = this.arkAddress.encode();
            const boardingAddress = await this.getBoardingAddress();

            const spentVtxos: ExtendedVirtualCoin[] = [];
            const inputArkTxIds = new Set<string>();
            const boardingUtxoToRemove = new Set<string>();

            const isVtxo = (
                input: ExtendedCoin
            ): input is ExtendedVirtualCoin => "virtualStatus" in input;

            for (const input of inputs) {
                if (isVtxo(input)) {
                    // vtxo = mark it settled
                    const vtxo = extendVirtualCoin(this, input);
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
                    // boarding utxo = remove it
                    boardingUtxoToRemove.add(`${input.txid}:${input.vout}`);
                }
            }

            if (spentVtxos.length > 0) {
                await this.walletRepository.saveVtxos(addr, spentVtxos);
            }

            for (const utxoId of boardingUtxoToRemove) {
                await this.walletRepository.removeUtxo(boardingAddress, utxoId);
            }
        } catch (e) {
            console.warn("error updating repository after settle", e);
        }
    }
}

/**
 * Select virtual coins to reach a target amount, prioritizing those closer to expiry
 * @param coins List of virtual coins to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected coins and change amount
 */
export function selectVirtualCoins(
    coins: VirtualCoin[],
    targetAmount: number
): {
    inputs: VirtualCoin[];
    changeAmount: bigint;
} {
    // Sort VTXOs by expiry (ascending) and amount (descending)
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

    const selectedCoins: VirtualCoin[] = [];
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
export async function waitForIncomingFunds(
    wallet: Wallet
): Promise<IncomingFunds> {
    let stopFunc: (() => void) | undefined;

    const promise = new Promise<IncomingFunds>((resolve) => {
        wallet
            .notifyIncomingFunds((coins: IncomingFunds) => {
                resolve(coins);
                if (stopFunc) stopFunc();
            })
            .then((stop) => {
                stopFunc = stop;
            });
    });

    return promise;
}
