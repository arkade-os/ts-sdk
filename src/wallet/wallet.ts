import { base64, hex } from "@scure/base";
import * as bip68 from "bip68";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction, Address, OutScript } from "@scure/btc-signer";
import { TransactionInput, TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Bytes, sha256 } from "@scure/btc-signer/utils.js";
import { vtxosToTxs } from "../utils/transactionHistory";
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
    PendingTx,
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
} from ".";
import { TapLeafScript, VtxoScript } from "../script/base";
import {
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    RelativeTimelock,
} from "../script/tapscript";
import { buildOffchainTx, hasBoardingTxExpired } from "../utils/arkTransaction";
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
import { extendCoin, extendVirtualCoin } from "./utils";
import { ArkError } from "../providers/errors";
import { Batch } from "./batch";

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
    protected constructor(
        readonly identity: ReadonlyIdentity,
        readonly network: Network,
        readonly onchainProvider: OnchainProvider,
        readonly indexerProvider: IndexerProvider,
        readonly arkServerPublicKey: Bytes,
        readonly offchainTapscript: DefaultVtxo.Script,
        readonly boardingTapscript: DefaultVtxo.Script,
        readonly dustAmount: bigint,
        public readonly walletRepository: WalletRepository,
        public readonly contractRepository: ContractRepository
    ) {}

    /**
     * Protected helper to set up shared wallet configuration.
     * Extracts common logic used by both ReadonlyWallet.create() and Wallet.create().
     */
    protected static async setupWalletConfig(
        config: ReadonlyWalletConfig,
        pubkey: Uint8Array
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
        const bareVtxoTapscript = new DefaultVtxo.Script({
            pubKey: pubkey,
            serverPubKey,
            csvTimelock: exitTimelock,
        });
        const boardingTapscript = new DefaultVtxo.Script({
            pubKey: pubkey,
            serverPubKey,
            csvTimelock: boardingTimelock,
        });

        // Save tapscripts
        const offchainTapscript = bareVtxoTapscript;

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
            setup.contractRepository
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

        const spendableVtxos = [];
        const spentVtxos = [];

        for (const vtxo of response.vtxos) {
            if (isSpendable(vtxo)) {
                spendableVtxos.push(vtxo);
            } else {
                spentVtxos.push(vtxo);
            }
        }

        // convert VTXOs to offchain transactions
        const offchainTxs = vtxosToTxs(
            spendableVtxos,
            spentVtxos,
            commitmentsToIgnore
        );

        const txs = [...boardingTxs, ...offchainTxs];

        // sort transactions by creation time in descending order (newest first)
        txs.sort(
            // place createdAt = 0 (unconfirmed txs) first, then descending
            (a, b) => {
                if (a.createdAt === 0) return -1;
                if (b.createdAt === 0) return 1;
                return b.createdAt - a.createdAt;
            }
        );

        return txs;
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
        offchainTapscript: DefaultVtxo.Script,
        boardingTapscript: DefaultVtxo.Script,
        readonly serverUnrollScript: CSVMultisigTapscript.Type,
        readonly forfeitOutputScript: Bytes,
        readonly forfeitPubkey: Bytes,
        dustAmount: bigint,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository,
        renewalConfig?: WalletConfig["renewalConfig"]
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
            contractRepository
        );
        this.identity = identity;
        this.renewalConfig = {
            enabled: renewalConfig?.enabled ?? false,
            ...DEFAULT_RENEWAL_CONFIG,
            ...renewalConfig,
        };
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
            config.renewalConfig
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

        const selectedLeaf = this.offchainTapscript.forfeit();
        if (!selectedLeaf) {
            throw new Error("Selected leaf not found");
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

        const tapTree = this.offchainTapscript.encode();
        const offchainTx = buildOffchainTx(
            selected.inputs.map((input) => ({
                ...input,
                tapLeafScript: selectedLeaf,
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

        // sign the checkpoints
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c));
                const signedCheckpoint = await this.identity.sign(tx);
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );

        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

        try {
            // mark VTXOs as spent and optionally add the change VTXO
            const spentVtxos: ExtendedVirtualCoin[] = [];
            const commitmentTxIds = new Set<string>();
            let batchExpiry: number = Number.MAX_SAFE_INTEGER;

            for (const [inputIndex, input] of selected.inputs.entries()) {
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
                    for (const commitmentTxId of vtxo.virtualStatus
                        .commitmentTxIds) {
                        commitmentTxIds.add(commitmentTxId);
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

            if (
                selected.changeAmount > 0n &&
                batchExpiry !== Number.MAX_SAFE_INTEGER
            ) {
                const changeVtxo: ExtendedVirtualCoin = {
                    txid: arkTxid,
                    vout: outputs.length - 1,
                    createdAt: new Date(createdAt),
                    forfeitTapLeafScript: this.offchainTapscript.forfeit(),
                    intentTapLeafScript: this.offchainTapscript.forfeit(),
                    isUnrolled: false,
                    isSpent: false,
                    tapTree: this.offchainTapscript.encode(),
                    value: Number(selected.changeAmount),
                    virtualStatus: {
                        state: "preconfirmed",
                        commitmentTxIds: Array.from(commitmentTxIds),
                        batchExpiry,
                    },
                    status: {
                        confirmed: false,
                    },
                };

                await this.walletRepository.saveVtxos(addr, [changeVtxo]);
            }

            await this.walletRepository.saveVtxos(addr, spentVtxos);
            await this.walletRepository.saveTransactions(addr, [
                {
                    key: {
                        boardingTxid: "",
                        commitmentTxid: "",
                        arkTxid: arkTxid,
                    },
                    amount: params.amount,
                    type: TxType.TxSent,
                    settled: false,
                    createdAt: Date.now(),
                },
            ]);
        } catch (e) {
            console.warn("error saving offchain tx to repository", e);
        } finally {
            return arkTxid;
        }
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
            let amount = 0;

            const exitScript = CSVMultisigTapscript.decode(
                hex.decode(this.boardingTapscript.exitScript)
            );

            const boardingTimelock = exitScript.params.timelock;

            const boardingUtxos = (await this.getBoardingUtxos()).filter(
                (utxo) => !hasBoardingTxExpired(utxo, boardingTimelock)
            );

            amount += boardingUtxos.reduce(
                (sum, input) => sum + input.value,
                0
            );

            const vtxos = await this.getVtxos({ withRecoverable: true });
            amount += vtxos.reduce((sum, input) => sum + input.value, 0);

            const inputs = [...boardingUtxos, ...vtxos];

            if (inputs.length === 0) {
                throw new Error("No inputs found");
            }

            params = {
                inputs,
                outputs: [
                    {
                        address: await this.getAddress(),
                        amount: BigInt(amount),
                    },
                ],
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

            return await Batch.join(stream, handler, {
                abortController,
                skipVtxoTreeSigning: !hasOffchainOutputs,
                eventCallback: eventCallback
                    ? (event) => Promise.resolve(eventCallback(event))
                    : undefined,
            });
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
        cosignerPubKeys: string[]
    ): Promise<SignedIntent<Intent.RegisterMessage>> {
        const inputs = this.prepareIntentProofInputs(coins);

        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: onchainOutputsIndexes,
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: cosignerPubKeys,
        };

        const proof = Intent.create(message, inputs, outputs);
        const signedProof = await this.identity.sign(proof);

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    async makeDeleteIntentSignature(
        coins: ExtendedCoin[]
    ): Promise<SignedIntent<Intent.DeleteMessage>> {
        const inputs = this.prepareIntentProofInputs(coins);

        const message: Intent.DeleteMessage = {
            type: "delete",
            expire_at: 0,
        };

        const proof = Intent.create(message, inputs, []);
        const signedProof = await this.identity.sign(proof);

        return {
            proof: base64.encode(signedProof.toPSBT()),
            message,
        };
    }

    async makeGetPendingTxIntentSignature(
        vtxos: ExtendedVirtualCoin[]
    ): Promise<SignedIntent<Intent.GetPendingTxMessage>> {
        const inputs = this.prepareIntentProofInputs(vtxos);

        const message: Intent.GetPendingTxMessage = {
            type: "get-pending-tx",
            expire_at: 0,
        };

        const proof = Intent.create(message, inputs, []);
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

    private prepareIntentProofInputs(
        coins: ExtendedCoin[]
    ): TransactionInput[] {
        const inputs: TransactionInput[] = [];

        for (const input of coins) {
            const vtxoScript = VtxoScript.decode(input.tapTree);
            const sequence = getSequence(input.intentTapLeafScript);

            const unknown = [VtxoTaprootTree.encode(input.tapTree)];
            if (input.extraWitness) {
                unknown.push(ConditionWitness.encode(input.extraWitness));
            }

            inputs.push({
                txid: hex.decode(input.txid),
                index: input.vout,
                witnessUtxo: {
                    amount: BigInt(input.value),
                    script: vtxoScript.pkScript,
                },
                sequence,
                tapLeafScript: [input.intentTapLeafScript],
                unknown,
            });
        }

        return inputs;
    }
}

export function getSequence(tapLeafScript: TapLeafScript): number | undefined {
    let sequence: number | undefined = undefined;

    try {
        const scriptWithLeafVersion = tapLeafScript[1];
        const script = scriptWithLeafVersion.subarray(
            0,
            scriptWithLeafVersion.length - 1
        );
        try {
            const params = CSVMultisigTapscript.decode(script).params;
            sequence = bip68.encode(
                params.timelock.type === "blocks"
                    ? { blocks: Number(params.timelock.value) }
                    : { seconds: Number(params.timelock.value) }
            );
        } catch {
            const params = CLTVMultisigTapscript.decode(script).params;
            sequence = Number(params.absoluteTimelock);
        }
    } catch {}

    return sequence;
}

function isValidArkAddress(address: string): boolean {
    try {
        ArkAddress.decode(address);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Select virtual coins to reach a target amount, prioritizing those closer to expiry
 * @param coins List of virtual coins to select from
 * @param targetAmount Target amount to reach in satoshis
 * @returns Selected coins and change amount
 */
function selectVirtualCoins(
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
