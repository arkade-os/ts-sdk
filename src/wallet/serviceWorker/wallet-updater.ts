import {
    ArkProvider,
    RestArkProvider,
    SettlementEvent,
} from "../../providers/ark";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { WalletRepository, WalletRepositoryImpl } from "../../repositories";
import { IndexedDBStorageAdapter } from "../../storage/indexedDB";
import { Handler, ReadonlyHandler } from "./worker";
import { DEFAULT_DB_NAME } from "./utils";
import { Response } from "./response";
import {
    ArkTransaction,
    ExtendedCoin,
    GetVtxosFilter,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    IWallet,
    SendBitcoinParams,
    SettleParams,
    WalletBalance,
} from "../index";
import { Request } from "./request";
import { ReadonlySingleKey, SingleKey } from "../../identity";
import { ReadonlyWallet, Wallet } from "../wallet";
import { hex } from "@scure/base";
import { extendCoin, extendVirtualCoin } from "../utils";
import { vtxosToTxs } from "../../utils/transactionHistory";
import {
    IUpdater,
    RequestEnvelope,
    ResponseEnvelope,
} from "./ark-serviceworker";
import TransactionHistory = Response.TransactionHistory;
import WalletStatus = Response.WalletStatus;

export type RequestInitWallet = RequestEnvelope & {
    type: "INIT_WALLET";
    payload: {
        key: { privateKey: string } | { publicKey: string };
        arkServerUrl: string;
        arkServerPublicKey?: string;
    };
};
export type ResponseInitWallet = ResponseEnvelope & {
    type: "WALLET_INITIALIZED";
};

export type RequestSettle = RequestEnvelope & {
    type: "SETTLE";
    payload: SettleParams;
};
export type ResponseSettle = ResponseEnvelope & {
    type: "SETTLE_SUCCESS";
    payload: { txid: string };
};

export type RequestSendBitcoin = RequestEnvelope & {
    type: "SEND_BITCOIN";
    payload: SendBitcoinParams;
};
export type ResponseSendBitcoin = ResponseEnvelope & {
    type: "SEND_BITCOIN_SUCCESS";
    payload: { txid: string };
};

export type RequestGetAddress = RequestEnvelope & { type: "GET_ADDRESS" };
export type ResponseGetAddress = ResponseEnvelope & {
    type: "ADDRESS";
    payload: { address: string };
};

export type RequestGetBoardingAddress = RequestEnvelope & {
    type: "GET_BOARDING_ADDRESS";
};
export type ResponseGetBoardingAddress = ResponseEnvelope & {
    type: "BOARDING_ADDRESS";
    payload: { address: string };
};

export type RequestGetBalance = RequestEnvelope & { type: "GET_BALANCE" };
export type ResponseGetBalance = ResponseEnvelope & {
    type: "BALANCE";
    payload: WalletBalance;
};

export type RequestGetVtxos = RequestEnvelope & {
    type: "GET_VTXOS";
    payload: { filter?: GetVtxosFilter };
};
export type ResponseGetVtxos = ResponseEnvelope & {
    type: "VTXOS";
    payload: { vtxos: Awaited<ReturnType<IWallet["getVtxos"]>> };
};

export type RequestGetBoardingUtxos = RequestEnvelope & {
    type: "GET_BOARDING_UTXOS";
};
export type ResponseGetBoardingUtxos = ResponseEnvelope & {
    type: "BOARDING_UTXOS";
    payload: { utxos: ExtendedCoin[] };
};

export type RequestGetTransactionHistory = RequestEnvelope & {
    type: "GET_TRANSACTION_HISTORY";
};
export type ResponseGetTransactionHistory = ResponseEnvelope & {
    type: "TRANSACTION_HISTORY";
    payload: { transactions: ArkTransaction[] };
};

export type RequestGetStatus = RequestEnvelope & { type: "GET_STATUS" };
export type ResponseGetStatus = ResponseEnvelope & {
    type: "WALLET_STATUS";
    payload: {
        walletInitialized: boolean;
        xOnlyPublicKey: Uint8Array | undefined;
    };
};

export type RequestClear = RequestEnvelope & { type: "CLEAR" };
export type ResponseClear = ResponseEnvelope & {
    type: "CLEAR_SUCCESS";
    payload: { cleared: boolean };
};

export type RequestReloadWallet = RequestEnvelope & { type: "RELOAD_WALLET" };
export type ResponseReloadWallet = ResponseEnvelope & {
    type: "RELOAD_SUCCESS";
    payload: { reloaded: boolean };
};

export type ResponseSettleEvent = ResponseEnvelope & {
    broadcast: true;
    type: "SETTLE_EVENT";
    payload: SettlementEvent;
};
export type ResponseUtxoUpdate = ResponseEnvelope & {
    broadcast: true;
    type: "UTXO_UPDATE";
    payload: { coins: ExtendedCoin[] };
};
export type ResponseVtxoUpdate = ResponseEnvelope & {
    broadcast: true;
    type: "VTXO_UPDATE";
    payload: { newVtxos: ExtendedCoin[]; spentVtxos: ExtendedCoin[] };
};

// WalletUpdater
export type WalletUpdaterRequest =
    | RequestInitWallet
    | RequestSettle
    | RequestSendBitcoin
    | RequestGetAddress
    | RequestGetBoardingAddress
    | RequestGetBalance
    | RequestGetVtxos
    | RequestGetBoardingUtxos
    | RequestGetTransactionHistory
    | RequestGetStatus
    | RequestClear
    | RequestReloadWallet;

export type WalletUpdaterResponse =
    | ResponseInitWallet
    | ResponseSettle
    | ResponseSettleEvent
    | ResponseSendBitcoin
    | ResponseGetAddress
    | ResponseGetBoardingAddress
    | ResponseGetBalance
    | ResponseGetVtxos
    | ResponseGetBoardingUtxos
    | ResponseGetTransactionHistory
    | ResponseGetStatus
    | ResponseClear
    | ResponseReloadWallet
    | ResponseUtxoUpdate
    | ResponseVtxoUpdate;

export class WalletUpdater
    implements IUpdater<WalletUpdaterRequest, WalletUpdaterResponse>
{
    static messagePrefix = "WalletUpdater";
    readonly messagePrefix = WalletUpdater.messagePrefix;

    private handler: ReadonlyHandler | undefined;
    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private incomingFundsSubscription: (() => void) | undefined;
    private walletRepository: WalletRepository;
    private storage: IndexedDBStorageAdapter;
    private onNextTick: (() => WalletUpdaterResponse | null)[] = [];

    constructor(
        readonly dbName: string = DEFAULT_DB_NAME,
        readonly dbVersion: number = 1
    ) {
        this.storage = new IndexedDBStorageAdapter(dbName, dbVersion);
        this.walletRepository = new WalletRepositoryImpl(this.storage);
    }

    // lifecycle methods
    async start() {
        // TODO: load config from storage/db
    }

    async stop() {
        // optional cleanup and persistence
    }

    async tick(_now: number) {
        const results = await Promise.allSettled(
            this.onNextTick.map((fn) => fn())
        );
        this.onNextTick = [];
        return results
            .map((result) => {
                if (result.status === "fulfilled") {
                    return result.value;
                } else {
                    console.error(
                        `[${WalletUpdater.messagePrefix}] tick failed`,
                        result.reason
                    );
                    // TODO: how to deliver errors down the stream? a broadcast?
                    return null;
                }
            })
            .filter((response) => response !== null);
    }

    private scheduleForNextTick(callback: () => WalletUpdaterResponse | null) {
        this.onNextTick.push(callback);
    }

    private prefixed(
        res: Partial<WalletUpdaterResponse>
    ): WalletUpdaterResponse {
        return {
            ...res,
            prefix: this.messagePrefix,
        } as WalletUpdaterResponse;
    }

    async handleMessage(
        message: WalletUpdaterRequest
    ): Promise<WalletUpdaterResponse> {
        const id = message.id;
        // console.log(`[${this.messagePrefix}] handleMessage`, message);
        if (message.type === "INIT_WALLET") {
            await this.handleInitWallet(message);
            return this.prefixed({
                id,
                type: "WALLET_INITIALIZED",
            });
        }
        if (!this.handler) {
            return this.prefixed({
                id,
                error: new Error("Wallet handler not initialized"),
            });
        }
        try {
            switch (message.type) {
                case "SETTLE": {
                    const response = await this.handleSettle(message);
                    return this.prefixed({
                        id,
                        ...response,
                    });
                }

                case "SEND_BITCOIN": {
                    const response = await this.handleSendBitcoin(message);
                    return this.prefixed({
                        id,
                        ...response,
                    });
                }
                case "GET_ADDRESS": {
                    const address = await this.handler.getAddress();
                    return this.prefixed({
                        id,
                        type: "ADDRESS",
                        payload: { address },
                    });
                }
                case "GET_BOARDING_ADDRESS": {
                    const address = await this.handler.getBoardingAddress();
                    return this.prefixed({
                        id,
                        type: "BOARDING_ADDRESS",
                        payload: { address },
                    });
                }
                case "GET_BALANCE": {
                    const balance = await this.handleGetBalance();
                    return this.prefixed({
                        id,
                        type: "BALANCE",
                        payload: balance,
                    });
                }
                case "GET_VTXOS": {
                    const vtxos = await this.handleGetVtxos(message);
                    return {
                        prefix: this.messagePrefix,
                        id,
                        type: "VTXOS",
                        payload: { vtxos },
                    };
                }
                case "GET_BOARDING_UTXOS": {
                    const utxos = await this.getAllBoardingUtxos();
                    return this.prefixed({
                        id,
                        type: "BOARDING_UTXOS",
                        payload: { utxos },
                    });
                }
                case "GET_TRANSACTION_HISTORY": {
                    const transactions = await this.getTransactionHistory();
                    return this.prefixed({
                        id,
                        type: "TRANSACTION_HISTORY",
                        payload: { transactions },
                    });
                }
                case "GET_STATUS": {
                    const pubKey = await this.handler.identity.xOnlyPublicKey();
                    return this.prefixed({
                        id,
                        type: "WALLET_STATUS",
                        payload: {
                            walletInitialized: true,
                            xOnlyPublicKey: pubKey,
                        },
                    });
                }
                case "CLEAR": {
                    await this.clear();
                    return this.prefixed({
                        id,
                        type: "CLEAR_SUCCESS",
                        payload: { cleared: true },
                    });
                }
                case "RELOAD_WALLET": {
                    await this.onWalletInitialized();
                    return this.prefixed({
                        id,
                        type: "RELOAD_SUCCESS",
                        payload: { reloaded: true },
                    });
                }
                default:
                    console.error("Unknown message type", message);
                    throw new Error("Unknown message");
            }
        } catch (error: unknown) {
            return this.prefixed({ id, error: error as Error });
        }
    }

    // Wallet methods
    private async handleInitWallet({ payload }: RequestInitWallet) {
        const { arkServerPublicKey, arkServerUrl } = payload;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);

        if (
            "privateKey" in payload.key &&
            typeof payload.key.privateKey === "string"
        ) {
            const {
                key: { privateKey },
            } = payload;
            const identity = SingleKey.fromHex(privateKey);
            const wallet = await Wallet.create({
                identity,
                arkServerUrl,
                arkServerPublicKey,
                storage: this.storage, // Use unified storage for wallet too
            });
            this.handler = new Handler(wallet);
        } else if (
            "publicKey" in payload.key &&
            typeof payload.key.publicKey === "string"
        ) {
            const {
                key: { publicKey },
            } = payload;
            const identity = ReadonlySingleKey.fromPublicKey(
                hex.decode(publicKey)
            );
            const wallet = await ReadonlyWallet.create({
                identity,
                arkServerUrl,
                arkServerPublicKey,
                storage: this.storage, // Use unified storage for wallet too
            });
            this.handler = new ReadonlyHandler(wallet);
        } else {
            throw new Error("Missing privateKey or publicKey in key object");
        }

        // TODO: check if can be blocking
        await this.onWalletInitialized();
    }

    private async handleGetBalance() {
        const [boardingUtxos, spendableVtxos, sweptVtxos] = await Promise.all([
            this.getAllBoardingUtxos(),
            this.getSpendableVtxos(),
            this.getSweptVtxos(),
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
        for (const vtxo of spendableVtxos) {
            if (vtxo.virtualStatus.state === "settled") {
                settled += vtxo.value;
            } else if (vtxo.virtualStatus.state === "preconfirmed") {
                preconfirmed += vtxo.value;
            }
        }
        for (const vtxo of sweptVtxos) {
            if (isSpendable(vtxo)) {
                recoverable += vtxo.value;
            }
        }

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
    private async getAllBoardingUtxos(): Promise<ExtendedCoin[]> {
        if (!this.handler) return [];
        const address = await this.handler.getBoardingAddress();

        return await this.walletRepository.getUtxos(address);
    }
    /**
     * Get spendable vtxos for the current wallet address
     */
    private async getSpendableVtxos() {
        if (!this.handler) return [];
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);
        return allVtxos.filter(isSpendable);
    }

    /**
     * Get swept vtxos for the current wallet address
     */
    private async getSweptVtxos() {
        if (!this.handler) return [];
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);
        return allVtxos.filter((vtxo) => vtxo.virtualStatus.state === "swept");
    }

    private async onWalletInitialized() {
        if (
            !this.handler ||
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.handler.offchainTapscript ||
            !this.handler.boardingTapscript
        ) {
            return;
        }

        // Get public key script and set the initial vtxos state
        const script = hex.encode(this.handler.offchainTapscript.pkScript);
        const response = await this.indexerProvider.getVtxos({
            scripts: [script],
        });
        const vtxos = response.vtxos.map((vtxo) =>
            extendVirtualCoin(this.handler!, vtxo)
        );

        try {
            // recover pending transactions if possible
            const { pending, finalized } =
                await this.handler.handleReload(vtxos);
            console.info(
                `Recovered ${finalized.length}/${pending.length} pending transactions: ${finalized.join(", ")}`
            );
        } catch (error: unknown) {
            console.error("Error recovering pending transactions:", error);
        }

        // Get wallet address and save vtxos using unified repository
        const address = await this.handler.getAddress();
        await this.walletRepository.saveVtxos(address, vtxos);

        // Fetch boarding utxos and save using unified repository
        const boardingAddress = await this.handler.getBoardingAddress();
        const coins =
            await this.handler.onchainProvider.getCoins(boardingAddress);
        await this.walletRepository.saveUtxos(
            boardingAddress,
            coins.map((utxo) => extendCoin(this.handler!, utxo))
        );

        // Get transaction history to cache boarding txs
        const txs = await this.getTransactionHistory();
        if (txs) await this.walletRepository.saveTransactions(address, txs);

        // unsubscribe previous subscription if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // subscribe for incoming funds and notify all clients when new funds arrive
        this.incomingFundsSubscription = await this.handler.notifyIncomingFunds(
            async (funds) => {
                console.log("incomng funds: ", funds);
                if (funds.type === "vtxo") {
                    const newVtxos =
                        funds.newVtxos.length > 0
                            ? funds.newVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.handler!, vtxo)
                              )
                            : [];
                    const spentVtxos =
                        funds.spentVtxos.length > 0
                            ? funds.spentVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.handler!, vtxo)
                              )
                            : [];

                    if ([...newVtxos, ...spentVtxos].length === 0) return;

                    // save vtxos using unified repository
                    await this.walletRepository.saveVtxos(address, [
                        ...newVtxos,
                        ...spentVtxos,
                    ]);

                    // notify all clients about the vtxo update
                    this.scheduleForNextTick(() =>
                        this.prefixed({
                            type: "VTXO_UPDATE",
                            broadcast: true,
                            payload: { newVtxos, spentVtxos },
                        })
                    );
                }
                if (funds.type === "utxo") {
                    const utxos = funds.coins.map((utxo) =>
                        extendCoin(this.handler!, utxo)
                    );

                    const boardingAddress =
                        await this.handler?.getBoardingAddress()!;

                    // save utxos using unified repository
                    await this.walletRepository.clearUtxos(boardingAddress);
                    await this.walletRepository.saveUtxos(
                        boardingAddress,
                        utxos
                    );

                    // notify all clients about the utxo update
                    this.scheduleForNextTick(() =>
                        this.prefixed({
                            type: "UTXO_UPDATE",
                            broadcast: true,
                            payload: { coins: utxos },
                        })
                    );
                }
            }
        );
    }

    private async getTransactionHistory(): Promise<ArkTransaction[]> {
        if (!this.handler) return [];

        let txs: ArkTransaction[] = [];

        try {
            const { boardingTxs, commitmentsToIgnore: roundsToIgnore } =
                await this.handler.getBoardingTxs();

            const { spendable, spent } = await this.getAllVtxos();

            // convert VTXOs to offchain transactions
            const offchainTxs = vtxosToTxs(spendable, spent, roundsToIgnore);

            txs = [...boardingTxs, ...offchainTxs];

            // sort transactions by creation time in descending order (newest first)
            txs.sort(
                // place createdAt = 0 (unconfirmed txs) first, then descending
                (a, b) => {
                    if (a.createdAt === 0) return -1;
                    if (b.createdAt === 0) return 1;
                    return b.createdAt - a.createdAt;
                }
            );
        } catch (error: unknown) {
            console.error("Error getting transaction history:", error);
        }
        return txs;
    }

    private async getAllVtxos() {
        if (!this.handler) return { spendable: [], spent: [] };
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);

        return {
            spendable: allVtxos.filter(isSpendable),
            spent: allVtxos.filter((vtxo) => !isSpendable(vtxo)),
        };
    }

    private async handleSettle(message: RequestSettle) {
        if (!this.handler) {
            throw new Error("Wallet handler not initialized");
        }
        const txid = await this.handler.handleSettle(message.payload, (e) => {
            this.scheduleForNextTick(() =>
                this.prefixed({
                    id: message.id,
                    type: "SETTLE_EVENT",
                    payload: e,
                })
            );
        });

        if (!txid) {
            throw new Error("Settlement failed");
        }
        return { type: "SETTLE_SUCCESS", payload: { txid } } as ResponseSettle;
    }

    private async handleSendBitcoin(message: RequestSendBitcoin) {
        if (!this.handler) {
            throw new Error("Wallet handler not initialized");
        }
        const txid = await this.handler.handleSendBitcoin(message.payload);
        if (!txid) {
            throw new Error("Send bitcoin failed");
        }
        return {
            type: "SEND_BITCOIN_SUCCESS",
            payload: { txid },
        } as ResponseSendBitcoin;
    }

    private async handleGetVtxos(message: RequestGetVtxos) {
        if (!this.handler) {
            throw new Error("Wallet handler not initialized");
        }
        const vtxos = await this.getSpendableVtxos();
        const dustAmount = this.handler.dustAmount;
        const includeRecoverable =
            message.payload.filter?.withRecoverable ?? false;
        const filteredVtxos = includeRecoverable
            ? vtxos
            : vtxos.filter((v) => {
                  if (dustAmount != null && isSubdust(v, dustAmount)) {
                      return false;
                  }
                  if (isRecoverable(v)) {
                      return false;
                  }
                  if (isExpired(v)) {
                      return false;
                  }
                  return true;
              });

        return filteredVtxos;
    }

    private async clear() {
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // Clear storage - this replaces vtxoRepository.close()
        await this.storage.clear();

        // Reset in-memory caches by recreating the repository
        this.walletRepository = new WalletRepositoryImpl(this.storage);

        this.handler = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
    }
}
