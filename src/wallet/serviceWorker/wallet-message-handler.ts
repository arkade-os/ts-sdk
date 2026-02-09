import { ArkProvider, SettlementEvent } from "../../providers/ark";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { WalletRepository } from "../../repositories";
import type {
    Contract,
    ContractEvent,
    ContractWithVtxos,
    GetContractsFilter,
    PathSelection,
} from "../../contracts";
import type {
    CreateContractParams,
    GetAllSpendingPathsOptions,
    GetSpendablePathsOptions,
} from "../../contracts/contractManager";
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
import { ReadonlyWallet, Wallet } from "../wallet";
import { extendCoin, extendVirtualCoin } from "../utils";
import {
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,
} from "../../worker/messageBus";
import { Transaction } from "../../utils/transaction";

export const DEFAULT_MESSAGE_TAG = "WALLET_UPDATER";

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
    payload: { params?: SettleParams };
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

export type RequestSignTransaction = RequestEnvelope & {
    type: "SIGN_TRANSACTION";
    payload: { tx: Transaction; inputIndexes?: number[] };
};
export type ResponseSignTransaction = ResponseEnvelope & {
    type: "SIGN_TRANSACTION";
    payload: { tx: Transaction };
};

export type RequestReloadWallet = RequestEnvelope & { type: "RELOAD_WALLET" };
export type ResponseReloadWallet = ResponseEnvelope & {
    type: "RELOAD_SUCCESS";
    payload: { reloaded: boolean };
};

export type RequestCreateContract = RequestEnvelope & {
    type: "CREATE_CONTRACT";
    payload: CreateContractParams;
};
export type ResponseCreateContract = ResponseEnvelope & {
    type: "CONTRACT_CREATED";
    payload: { contract: Contract };
};

export type RequestGetContracts = RequestEnvelope & {
    type: "GET_CONTRACTS";
    payload: { filter?: GetContractsFilter };
};
export type ResponseGetContracts = ResponseEnvelope & {
    type: "CONTRACTS";
    payload: { contracts: Contract[] };
};

export type RequestGetContractsWithVtxos = RequestEnvelope & {
    type: "GET_CONTRACTS_WITH_VTXOS";
    payload: { filter?: GetContractsFilter };
};
export type ResponseGetContractsWithVtxos = ResponseEnvelope & {
    type: "CONTRACTS_WITH_VTXOS";
    payload: { contracts: ContractWithVtxos[] };
};

export type RequestUpdateContract = RequestEnvelope & {
    type: "UPDATE_CONTRACT";
    payload: {
        script: string;
        updates: Partial<Omit<Contract, "id" | "createdAt">>;
    };
};
export type ResponseUpdateContract = ResponseEnvelope & {
    type: "CONTRACT_UPDATED";
    payload: { contract: Contract };
};

export type RequestDeleteContract = RequestEnvelope & {
    type: "DELETE_CONTRACT";
    payload: { script: string };
};
export type ResponseDeleteContract = ResponseEnvelope & {
    type: "CONTRACT_DELETED";
    payload: { deleted: boolean };
};

export type RequestGetSpendablePaths = RequestEnvelope & {
    type: "GET_SPENDABLE_PATHS";
    payload: { options: GetSpendablePathsOptions };
};
export type ResponseGetSpendablePaths = ResponseEnvelope & {
    type: "SPENDABLE_PATHS";
    payload: { paths: PathSelection[] };
};

export type RequestIsContractManagerWatching = RequestEnvelope & {
    type: "IS_CONTRACT_MANAGER_WATCHING";
};
export type ResponseIsContractManagerWatching = ResponseEnvelope & {
    type: "CONTRACT_WATCHING";
    payload: { isWatching: boolean };
};

export type RequestGetAllSpendingPaths = RequestEnvelope & {
    type: "GET_ALL_SPENDING_PATHS";
    payload: { options: GetAllSpendingPathsOptions };
};
export type ResponseGetAllSpendingPaths = ResponseEnvelope & {
    type: "ALL_SPENDING_PATHS";
    payload: { paths: PathSelection[] };
};

// broadcast messages
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
export type ResponseContractEvent = ResponseEnvelope & {
    tag: string;
    broadcast: true;
    type: "CONTRACT_EVENT";
    payload: { event: ContractEvent };
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
    | RequestReloadWallet
    | RequestSignTransaction
    | RequestCreateContract
    | RequestGetContracts
    | RequestGetContractsWithVtxos
    | RequestUpdateContract
    | RequestDeleteContract
    | RequestGetSpendablePaths
    | RequestGetAllSpendingPaths
    | RequestIsContractManagerWatching;

export type WalletUpdaterResponse = ResponseEnvelope &
    (
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
        | ResponseVtxoUpdate
        | ResponseSignTransaction
        | ResponseCreateContract
        | ResponseGetContracts
        | ResponseGetContractsWithVtxos
        | ResponseUpdateContract
        | ResponseDeleteContract
        | ResponseGetSpendablePaths
        | ResponseGetAllSpendingPaths
        | ResponseIsContractManagerWatching
        | ResponseContractEvent
    );

export class WalletMessageHandler
    implements MessageHandler<WalletUpdaterRequest, WalletUpdaterResponse>
{
    readonly messageTag: string;

    private wallet: Wallet | undefined;
    private readonlyWallet: ReadonlyWallet | undefined;

    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private walletRepository: WalletRepository | undefined;

    private incomingFundsSubscription: (() => void) | undefined;
    private contractEventsSubscription: (() => void) | undefined;
    private onNextTick: (() => WalletUpdaterResponse | null)[] = [];

    /**
     * Instantiate a new WalletUpdater.
     * Can override the default `messageTag` allowing more than one updater to run in parallel.
     * Note that the default ServiceWorkerWallet sends messages to the default WalletUpdater tag.
     */
    constructor(options?: { messageTag?: string }) {
        this.messageTag = options?.messageTag ?? DEFAULT_MESSAGE_TAG;
    }

    // lifecycle methods
    async start(...params: Parameters<MessageHandler["start"]>): Promise<void> {
        const [services, repositories] = params;
        this.readonlyWallet = services.readonlyWallet;
        this.wallet = services.wallet;
        this.arkProvider = services.arkProvider;
        this.walletRepository = repositories.walletRepository;
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
                        `[${this.messageTag}] tick failed`,
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

    private requireWallet(): Wallet {
        if (!this.wallet) {
            throw new Error("Read-only wallet: operation requires signing");
        }
        return this.wallet;
    }

    private tagged(res: Partial<WalletUpdaterResponse>): WalletUpdaterResponse {
        return {
            ...res,
            tag: this.messageTag,
        } as WalletUpdaterResponse;
    }

    async handleMessage(
        message: WalletUpdaterRequest
    ): Promise<WalletUpdaterResponse> {
        const id = message.id;
        if (message.type === "INIT_WALLET") {
            await this.handleInitWallet(message);
            return this.tagged({
                id,
                type: "WALLET_INITIALIZED",
            });
        }
        if (!this.readonlyWallet) {
            return this.tagged({
                id,
                error: new Error("Wallet handler not initialized"),
            });
        }
        try {
            switch (message.type) {
                case "SETTLE": {
                    const response = await this.handleSettle(message);
                    return this.tagged({
                        id,
                        ...response,
                    });
                }

                case "SEND_BITCOIN": {
                    const response = await this.handleSendBitcoin(message);
                    return this.tagged({
                        id,
                        ...response,
                    });
                }
                case "GET_ADDRESS": {
                    const address = await this.readonlyWallet.getAddress();
                    return this.tagged({
                        id,
                        type: "ADDRESS",
                        payload: { address },
                    });
                }
                case "GET_BOARDING_ADDRESS": {
                    const address =
                        await this.readonlyWallet.getBoardingAddress();
                    return this.tagged({
                        id,
                        type: "BOARDING_ADDRESS",
                        payload: { address },
                    });
                }
                case "GET_BALANCE": {
                    const balance = await this.handleGetBalance();
                    return this.tagged({
                        id,
                        type: "BALANCE",
                        payload: balance,
                    });
                }
                case "GET_VTXOS": {
                    const vtxos = await this.handleGetVtxos(message);
                    return {
                        tag: this.messageTag,
                        id,
                        type: "VTXOS",
                        payload: { vtxos },
                    };
                }
                case "GET_BOARDING_UTXOS": {
                    const utxos = await this.getAllBoardingUtxos();
                    return this.tagged({
                        id,
                        type: "BOARDING_UTXOS",
                        payload: { utxos },
                    });
                }
                case "GET_TRANSACTION_HISTORY": {
                    const transactions =
                        await this.readonlyWallet.getTransactionHistory();
                    return this.tagged({
                        id,
                        type: "TRANSACTION_HISTORY",
                        payload: { transactions },
                    });
                }
                case "GET_STATUS": {
                    const pubKey =
                        await this.readonlyWallet.identity.xOnlyPublicKey();
                    return this.tagged({
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
                    return this.tagged({
                        id,
                        type: "CLEAR_SUCCESS",
                        payload: { cleared: true },
                    });
                }
                case "RELOAD_WALLET": {
                    await this.onWalletInitialized();
                    return this.tagged({
                        id,
                        type: "RELOAD_SUCCESS",
                        payload: { reloaded: true },
                    });
                }
                case "SIGN_TRANSACTION": {
                    const response = await this.handleSignTransaction(message);
                    return this.tagged({
                        id,
                        ...response,
                    });
                }
                case "CREATE_CONTRACT": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const contract = await manager.createContract(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "CONTRACT_CREATED",
                        payload: { contract },
                    });
                }
                case "GET_CONTRACTS": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const contracts = await manager.getContracts(
                        message.payload.filter
                    );
                    return this.tagged({
                        id,
                        type: "CONTRACTS",
                        payload: { contracts },
                    });
                }
                case "GET_CONTRACTS_WITH_VTXOS": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const contracts = await manager.getContractsWithVtxos(
                        message.payload.filter
                    );
                    return this.tagged({
                        id,
                        type: "CONTRACTS_WITH_VTXOS",
                        payload: { contracts },
                    });
                }
                case "UPDATE_CONTRACT": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const contract = await manager.updateContract(
                        message.payload.script,
                        message.payload.updates
                    );
                    return this.tagged({
                        id,
                        type: "CONTRACT_UPDATED",
                        payload: { contract },
                    });
                }
                case "DELETE_CONTRACT": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    await manager.deleteContract(message.payload.script);
                    return this.tagged({
                        id,
                        type: "CONTRACT_DELETED",
                        payload: { deleted: true },
                    });
                }
                case "GET_SPENDABLE_PATHS": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const paths = await manager.getSpendablePaths(
                        message.payload.options
                    );
                    return this.tagged({
                        id,
                        type: "SPENDABLE_PATHS",
                        payload: { paths },
                    });
                }
                case "GET_ALL_SPENDING_PATHS": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const paths = await manager.getAllSpendingPaths(
                        message.payload.options
                    );
                    return this.tagged({
                        id,
                        type: "ALL_SPENDING_PATHS",
                        payload: { paths },
                    });
                }
                case "IS_CONTRACT_MANAGER_WATCHING": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    const isWatching = await manager.isWatching();
                    return this.tagged({
                        id,
                        type: "CONTRACT_WATCHING",
                        payload: { isWatching },
                    });
                }
                default:
                    console.error("Unknown message type", message);
                    throw new Error("Unknown message");
            }
        } catch (error: unknown) {
            return this.tagged({ id, error: error as Error });
        }
    }

    // Wallet methods
    private async handleInitWallet({ payload }: RequestInitWallet) {
        const { arkServerUrl } = payload;
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);
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
        if (!this.readonlyWallet) return [];
        return this.readonlyWallet.getBoardingUtxos();
    }
    /**
     * Get spendable vtxos for the current wallet address
     */
    private async getSpendableVtxos() {
        if (!this.readonlyWallet) return [];
        const vtxos = await this.readonlyWallet.getVtxos();
        return vtxos.filter(isSpendable);
    }

    /**
     * Get swept vtxos for the current wallet address
     */
    private async getSweptVtxos() {
        if (!this.readonlyWallet) return [];
        const vtxos = await this.readonlyWallet.getVtxos();
        return vtxos.filter((vtxo) => vtxo.virtualStatus.state === "swept");
    }

    private async onWalletInitialized() {
        if (
            !this.readonlyWallet ||
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.walletRepository
        ) {
            return;
        }

        // Get public key script and set the initial vtxos state
        const script = this.readonlyWallet.defaultContractScript;
        const response = await this.indexerProvider.getVtxos({
            scripts: [script],
        });
        const vtxos = response.vtxos.map((vtxo) =>
            extendVirtualCoin(this.readonlyWallet!, vtxo)
        );

        if (this.wallet) {
            try {
                // recover pending transactions if possible
                const { pending, finalized } =
                    await this.wallet.finalizePendingTxs(
                        vtxos.filter(
                            (vtxo) =>
                                vtxo.virtualStatus.state !== "swept" &&
                                vtxo.virtualStatus.state !== "settled"
                        )
                    );
                console.info(
                    `Recovered ${finalized.length}/${pending.length} pending transactions: ${finalized.join(", ")}`
                );
            } catch (error: unknown) {
                console.error("Error recovering pending transactions:", error);
            }
        }

        // Get wallet address and save vtxos using unified repository
        const address = await this.readonlyWallet.getAddress();
        await this.walletRepository.saveVtxos(address, vtxos);

        // Fetch boarding utxos and save using unified repository
        const boardingAddress = await this.readonlyWallet.getBoardingAddress();
        const coins =
            await this.readonlyWallet.onchainProvider.getCoins(boardingAddress);
        await this.walletRepository.saveUtxos(
            boardingAddress,
            coins.map((utxo) => extendCoin(this.readonlyWallet!, utxo))
        );

        // Get transaction history to cache boarding txs
        const txs = await this.readonlyWallet.getTransactionHistory();
        if (txs) await this.walletRepository.saveTransactions(address, txs);

        // unsubscribe previous subscription if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // subscribe for incoming funds and notify all clients when new funds arrive
        this.incomingFundsSubscription =
            await this.readonlyWallet.notifyIncomingFunds(async (funds) => {
                if (funds.type === "vtxo") {
                    const newVtxos =
                        funds.newVtxos.length > 0
                            ? funds.newVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.readonlyWallet!, vtxo)
                              )
                            : [];
                    const spentVtxos =
                        funds.spentVtxos.length > 0
                            ? funds.spentVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.readonlyWallet!, vtxo)
                              )
                            : [];

                    if ([...newVtxos, ...spentVtxos].length === 0) return;

                    // save vtxos using unified repository
                    await this.walletRepository?.saveVtxos(address, [
                        ...newVtxos,
                        ...spentVtxos,
                    ]);

                    // notify all clients about the vtxo update
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "VTXO_UPDATE",
                            broadcast: true,
                            payload: { newVtxos, spentVtxos },
                        })
                    );
                }
                if (funds.type === "utxo") {
                    const utxos = funds.coins.map((utxo) =>
                        extendCoin(this.readonlyWallet!, utxo)
                    );
                    const boardingAddress =
                        await this.readonlyWallet!.getBoardingAddress();
                    // save utxos using unified repository
                    // TODO: remove UTXOS by address
                    //  await this.walletRepository.clearUtxos(boardingAddress);
                    await this.walletRepository?.saveUtxos(
                        boardingAddress,
                        utxos
                    );

                    // notify all clients about the utxo update
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "UTXO_UPDATE",
                            broadcast: true,
                            payload: { coins: utxos },
                        })
                    );
                }
            });

        await this.ensureContractEventBroadcasting();
    }

    private async handleSettle(message: RequestSettle) {
        const wallet = this.requireWallet();
        const txid = await wallet.settle(message.payload.params, (e) => {
            this.scheduleForNextTick(() =>
                this.tagged({
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
        const wallet = this.requireWallet();
        const txid = await wallet.sendBitcoin(message.payload);
        if (!txid) {
            throw new Error("Send bitcoin failed");
        }
        return {
            type: "SEND_BITCOIN_SUCCESS",
            payload: { txid },
        } as ResponseSendBitcoin;
    }

    private async handleSignTransaction(message: RequestSignTransaction) {
        const wallet = this.requireWallet();
        const { tx, inputIndexes } = message.payload;
        const signature = await wallet.identity.sign(tx, inputIndexes);
        if (!signature) {
            throw new Error("Sign transaction failed");
        }
        return {
            type: "SIGN_TRANSACTION",
            payload: { tx: signature },
        } as ResponseSignTransaction;
    }

    private async handleGetVtxos(message: RequestGetVtxos) {
        if (!this.readonlyWallet) {
            throw new Error("Wallet handler not initialized");
        }
        const vtxos = await this.getSpendableVtxos();
        const dustAmount = this.readonlyWallet.dustAmount;
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
        if (!this.readonlyWallet) return;
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();
        if (this.contractEventsSubscription) {
            this.contractEventsSubscription();
            this.contractEventsSubscription = undefined;
        }

        try {
            await this.walletRepository?.clear();
        } catch (_) {
            console.warn("Failed to clear vtxos from wallet repository");
        }

        this.wallet = undefined;
        this.readonlyWallet = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
    }

    private async ensureContractEventBroadcasting() {
        if (!this.readonlyWallet) return;
        if (this.contractEventsSubscription) return;
        try {
            const manager = await this.readonlyWallet.getContractManager();
            this.contractEventsSubscription = manager.onContractEvent(
                (event) => {
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "CONTRACT_EVENT",
                            broadcast: true,
                            payload: { event },
                        })
                    );
                }
            );
        } catch (error) {
            console.error("Error subscribing to contract events:", error);
        }
    }
}
