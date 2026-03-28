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
    AssetDetails,
    BurnParams,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    IssuanceParams,
    IssuanceResult,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    IWallet,
    Recipient,
    ReissuanceParams,
    SendBitcoinParams,
    SettleParams,
    WalletBalance,
} from "../index";
import { DelegateInfo } from "../../providers/delegator";
import { ReadonlyWallet, Wallet } from "../wallet";
import { extendCoin, extendVirtualCoin } from "../utils";
import {
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,
} from "../../worker/messageBus";
import { Transaction } from "../../utils/transaction";
import { buildTransactionHistory } from "../../utils/transactionHistory";

export class WalletNotInitializedError extends Error {
    constructor() {
        super("Wallet handler not initialized");
        this.name = "WalletNotInitializedError";
    }
}

export class ReadonlyWalletError extends Error {
    constructor() {
        super("Read-only wallet: operation requires signing");
        this.name = "ReadonlyWalletError";
    }
}

export class DelegatorNotConfiguredError extends Error {
    constructor() {
        super("Delegator not configured");
        this.name = "DelegatorNotConfiguredError";
    }
}

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

export type RequestRefreshVtxos = RequestEnvelope & {
    type: "REFRESH_VTXOS";
    payload?: {
        scripts?: string[];
        after?: number;
        before?: number;
    };
};
export type ResponseRefreshVtxos = ResponseEnvelope & {
    type: "REFRESH_VTXOS_SUCCESS";
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
export type ResponseRecoverVtxosEvent = ResponseEnvelope & {
    type: "RECOVER_VTXOS_EVENT";
    payload: SettlementEvent;
};
export type ResponseRenewVtxosEvent = ResponseEnvelope & {
    type: "RENEW_VTXOS_EVENT";
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

// Asset operations
export type RequestSend = RequestEnvelope & {
    type: "SEND";
    payload: { recipients: Recipient[] };
};
export type ResponseSend = ResponseEnvelope & {
    type: "SEND_SUCCESS";
    payload: { txid: string };
};

export type RequestGetAssetDetails = RequestEnvelope & {
    type: "GET_ASSET_DETAILS";
    payload: { assetId: string };
};
export type ResponseGetAssetDetails = ResponseEnvelope & {
    type: "ASSET_DETAILS";
    payload: { assetDetails: AssetDetails };
};

export type RequestIssue = RequestEnvelope & {
    type: "ISSUE";
    payload: { params: IssuanceParams };
};
export type ResponseIssue = ResponseEnvelope & {
    type: "ISSUE_SUCCESS";
    payload: { result: IssuanceResult };
};

export type RequestReissue = RequestEnvelope & {
    type: "REISSUE";
    payload: { params: ReissuanceParams };
};
export type ResponseReissue = ResponseEnvelope & {
    type: "REISSUE_SUCCESS";
    payload: { txid: string };
};

export type RequestBurn = RequestEnvelope & {
    type: "BURN";
    payload: { params: BurnParams };
};
export type ResponseBurn = ResponseEnvelope & {
    type: "BURN_SUCCESS";
    payload: { txid: string };
};

export type RequestDelegate = RequestEnvelope & {
    type: "DELEGATE";
    payload: {
        vtxoOutpoints: { txid: string; vout: number }[];
        destination: string;
        delegateAt?: number;
    };
};
export type ResponseDelegate = ResponseEnvelope & {
    type: "DELEGATE_SUCCESS";
    payload: {
        delegated: { txid: string; vout: number }[];
        failed: {
            outpoints: { txid: string; vout: number }[];
            error: string;
        }[];
    };
};

export type RequestGetDelegateInfo = RequestEnvelope & {
    type: "GET_DELEGATE_INFO";
};
export type ResponseGetDelegateInfo = ResponseEnvelope & {
    type: "DELEGATE_INFO";
    payload: { info: DelegateInfo };
};

// VtxoManager operations
export type RequestRecoverVtxos = RequestEnvelope & {
    type: "RECOVER_VTXOS";
};
export type ResponseRecoverVtxos = ResponseEnvelope & {
    type: "RECOVER_VTXOS_SUCCESS";
    payload: { txid: string };
};

export type RequestGetRecoverableBalance = RequestEnvelope & {
    type: "GET_RECOVERABLE_BALANCE";
};
export type ResponseGetRecoverableBalance = ResponseEnvelope & {
    type: "RECOVERABLE_BALANCE";
    payload: {
        recoverable: string;
        subdust: string;
        includesSubdust: boolean;
        vtxoCount: number;
    };
};

export type RequestGetExpiringVtxos = RequestEnvelope & {
    type: "GET_EXPIRING_VTXOS";
    payload: { thresholdMs?: number };
};
export type ResponseGetExpiringVtxos = ResponseEnvelope & {
    type: "EXPIRING_VTXOS";
    payload: { vtxos: ExtendedVirtualCoin[] };
};

export type RequestRenewVtxos = RequestEnvelope & {
    type: "RENEW_VTXOS";
};
export type ResponseRenewVtxos = ResponseEnvelope & {
    type: "RENEW_VTXOS_SUCCESS";
    payload: { txid: string };
};

export type RequestGetExpiredBoardingUtxos = RequestEnvelope & {
    type: "GET_EXPIRED_BOARDING_UTXOS";
};
export type ResponseGetExpiredBoardingUtxos = ResponseEnvelope & {
    type: "EXPIRED_BOARDING_UTXOS";
    payload: { utxos: ExtendedCoin[] };
};

export type RequestSweepExpiredBoardingUtxos = RequestEnvelope & {
    type: "SWEEP_EXPIRED_BOARDING_UTXOS";
};
export type ResponseSweepExpiredBoardingUtxos = ResponseEnvelope & {
    type: "SWEEP_EXPIRED_BOARDING_UTXOS_SUCCESS";
    payload: { txid: string };
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
    | RequestIsContractManagerWatching
    | RequestRefreshVtxos
    | RequestSend
    | RequestGetAssetDetails
    | RequestIssue
    | RequestReissue
    | RequestBurn
    | RequestDelegate
    | RequestGetDelegateInfo
    | RequestRecoverVtxos
    | RequestGetRecoverableBalance
    | RequestGetExpiringVtxos
    | RequestRenewVtxos
    | RequestGetExpiredBoardingUtxos
    | RequestSweepExpiredBoardingUtxos;

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
        | ResponseRefreshVtxos
        | ResponseContractEvent
        | ResponseSend
        | ResponseGetAssetDetails
        | ResponseIssue
        | ResponseReissue
        | ResponseBurn
        | ResponseDelegate
        | ResponseGetDelegateInfo
        | ResponseRecoverVtxos
        | ResponseRecoverVtxosEvent
        | ResponseGetRecoverableBalance
        | ResponseGetExpiringVtxos
        | ResponseRenewVtxos
        | ResponseRenewVtxosEvent
        | ResponseGetExpiredBoardingUtxos
        | ResponseSweepExpiredBoardingUtxos
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
        if (this.incomingFundsSubscription) {
            this.incomingFundsSubscription();
            this.incomingFundsSubscription = undefined;
        }
        if (this.contractEventsSubscription) {
            this.contractEventsSubscription();
            this.contractEventsSubscription = undefined;
        }

        // Dispose the wallet to stop VtxoManager background tasks
        // (auto-renewal, boarding UTXO polling) and ContractWatcher.
        try {
            if (this.wallet) {
                await this.wallet.dispose();
            } else if (this.readonlyWallet) {
                await this.readonlyWallet.dispose();
            }
        } catch (_) {
            // best-effort teardown
        }

        this.wallet = undefined;
        this.readonlyWallet = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
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
            throw new ReadonlyWalletError();
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
                error: new WalletNotInitializedError(),
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
                    const allVtxos = await this.getVtxosFromRepo();
                    const transactions =
                        (await this.buildTransactionHistoryFromCache(
                            allVtxos
                        )) ?? [];
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
                    await this.reloadWallet();
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
                case "REFRESH_VTXOS": {
                    const manager =
                        await this.readonlyWallet.getContractManager();
                    await manager.refreshVtxos(
                        (message as RequestRefreshVtxos).payload
                    );
                    return this.tagged({
                        id,
                        type: "REFRESH_VTXOS_SUCCESS",
                    });
                }
                case "SEND": {
                    const { recipients } = (message as RequestSend).payload;
                    const txid = await (this.wallet as IWallet).send(
                        ...recipients
                    );
                    return this.tagged({
                        id,
                        type: "SEND_SUCCESS",
                        payload: { txid },
                    });
                }
                case "GET_ASSET_DETAILS": {
                    const { assetId } = (message as RequestGetAssetDetails)
                        .payload;
                    const assetDetails =
                        await this.readonlyWallet.assetManager.getAssetDetails(
                            assetId
                        );
                    return this.tagged({
                        id,
                        type: "ASSET_DETAILS",
                        payload: { assetDetails },
                    });
                }
                case "ISSUE": {
                    const { params } = (message as RequestIssue).payload;
                    const result = await (
                        this.wallet as IWallet
                    ).assetManager.issue(params);
                    return this.tagged({
                        id,
                        type: "ISSUE_SUCCESS",
                        payload: { result },
                    });
                }
                case "REISSUE": {
                    const { params } = (message as RequestReissue).payload;
                    const txid = await (
                        this.wallet as IWallet
                    ).assetManager.reissue(params);
                    return this.tagged({
                        id,
                        type: "REISSUE_SUCCESS",
                        payload: { txid },
                    });
                }
                case "BURN": {
                    const { params } = (message as RequestBurn).payload;
                    const txid = await (
                        this.wallet as IWallet
                    ).assetManager.burn(params);
                    return this.tagged({
                        id,
                        type: "BURN_SUCCESS",
                        payload: { txid },
                    });
                }
                case "DELEGATE": {
                    const response = await this.handleDelegate(
                        message as RequestDelegate
                    );
                    return this.tagged({ id, ...response });
                }
                case "GET_DELEGATE_INFO": {
                    const wallet = this.requireWallet();
                    const delegatorManager = await wallet.getDelegatorManager();
                    if (!delegatorManager) {
                        throw new DelegatorNotConfiguredError();
                    }
                    const info = await delegatorManager.getDelegateInfo();
                    return this.tagged({
                        id,
                        type: "DELEGATE_INFO",
                        payload: { info },
                    });
                }
                case "RECOVER_VTXOS": {
                    const wallet = this.requireWallet();
                    const vtxoManager = await wallet.getVtxoManager();
                    const txid = await vtxoManager.recoverVtxos((e) => {
                        this.scheduleForNextTick(() =>
                            this.tagged({
                                id,
                                type: "RECOVER_VTXOS_EVENT",
                                payload: e,
                            })
                        );
                    });
                    return this.tagged({
                        id,
                        type: "RECOVER_VTXOS_SUCCESS",
                        payload: { txid },
                    });
                }
                case "GET_RECOVERABLE_BALANCE": {
                    const wallet = this.requireWallet();
                    const vtxoManager = await wallet.getVtxoManager();
                    const balance = await vtxoManager.getRecoverableBalance();
                    return this.tagged({
                        id,
                        type: "RECOVERABLE_BALANCE",
                        payload: {
                            recoverable: balance.recoverable.toString(),
                            subdust: balance.subdust.toString(),
                            includesSubdust: balance.includesSubdust,
                            vtxoCount: balance.vtxoCount,
                        },
                    });
                }
                case "GET_EXPIRING_VTXOS": {
                    const wallet = this.requireWallet();
                    const vtxoManager = await wallet.getVtxoManager();
                    const vtxos = await vtxoManager.getExpiringVtxos(
                        (message as RequestGetExpiringVtxos).payload.thresholdMs
                    );
                    return this.tagged({
                        id,
                        type: "EXPIRING_VTXOS",
                        payload: { vtxos },
                    });
                }
                case "RENEW_VTXOS": {
                    const wallet = this.requireWallet();
                    const vtxoManager = await wallet.getVtxoManager();
                    const txid = await vtxoManager.renewVtxos((e) => {
                        this.scheduleForNextTick(() =>
                            this.tagged({
                                id,
                                type: "RENEW_VTXOS_EVENT",
                                payload: e,
                            })
                        );
                    });
                    return this.tagged({
                        id,
                        type: "RENEW_VTXOS_SUCCESS",
                        payload: { txid },
                    });
                }
                case "GET_EXPIRED_BOARDING_UTXOS": {
                    const wallet = this.requireWallet();
                    const vtxoManager = await wallet.getVtxoManager();
                    const utxos = await vtxoManager.getExpiredBoardingUtxos();
                    return this.tagged({
                        id,
                        type: "EXPIRED_BOARDING_UTXOS",
                        payload: { utxos },
                    });
                }
                case "SWEEP_EXPIRED_BOARDING_UTXOS": {
                    const wallet = this.requireWallet();
                    const vtxoManager = await wallet.getVtxoManager();
                    const txid = await vtxoManager.sweepExpiredBoardingUtxos();
                    return this.tagged({
                        id,
                        type: "SWEEP_EXPIRED_BOARDING_UTXOS_SUCCESS",
                        payload: { txid },
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
        const [boardingUtxos, allVtxos] = await Promise.all([
            this.getAllBoardingUtxos(),
            this.getVtxosFromRepo(),
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

        // offchain — split spendable vs swept from single repo read
        const spendableVtxos = allVtxos.filter(isSpendable);
        const sweptVtxos = allVtxos.filter(
            (vtxo) => vtxo.virtualStatus.state === "swept"
        );

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

        // aggregate asset balances from spendable vtxos
        const assetBalances = new Map<string, number>();
        for (const vtxo of spendableVtxos) {
            if (vtxo.assets) {
                for (const a of vtxo.assets) {
                    const current = assetBalances.get(a.assetId) ?? 0;
                    assetBalances.set(a.assetId, current + a.amount);
                }
            }
        }
        const assets = Array.from(assetBalances.entries()).map(
            ([assetId, amount]) => ({ assetId, amount })
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
    private async getAllBoardingUtxos(): Promise<ExtendedCoin[]> {
        if (!this.readonlyWallet) return [];
        return this.readonlyWallet.getBoardingUtxos();
    }
    /**
     * Get spendable vtxos from the repository
     */
    private async getSpendableVtxos() {
        const vtxos = await this.getVtxosFromRepo();
        return vtxos.filter(isSpendable);
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

        // Initialize contract manager FIRST — this populates the repository
        // with full VTXO history for all contracts (one indexer call per contract)
        await this.ensureContractEventBroadcasting();

        // Refresh cached data (VTXOs, boarding UTXOs, tx history)
        await this.refreshCachedData();

        // Recover pending transactions (init-only, not on reload).
        // Pending txs only exist if a send was interrupted mid-finalization.
        if (this.wallet) {
            try {
                const vtxos = await this.getVtxosFromRepo();
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

        // unsubscribe previous subscription if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        const address = await this.readonlyWallet.getAddress();

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

        // Eagerly start the VtxoManager so its background tasks (auto-renewal,
        // boarding UTXO polling/sweep) run inside the service worker without
        // waiting for a client to send a vtxo-manager message first.
        if (this.wallet) {
            try {
                await this.wallet.getVtxoManager();
            } catch (error) {
                console.error("Error starting VtxoManager:", error);
            }
        }
    }

    /**
     * Refresh VTXOs, boarding UTXOs, and transaction history from cache.
     * Shared by onWalletInitialized (full bootstrap) and reloadWallet
     * (post-refresh), avoiding duplicate subscriptions and VtxoManager restarts.
     */
    private async refreshCachedData() {
        if (!this.readonlyWallet || !this.walletRepository) {
            return;
        }

        // Read VTXOs from repository (now populated by contract manager)
        const vtxos = await this.getVtxosFromRepo();

        // Fetch boarding utxos and save using unified repository
        const boardingAddress = await this.readonlyWallet.getBoardingAddress();
        const coins =
            await this.readonlyWallet.onchainProvider.getCoins(boardingAddress);
        await this.walletRepository.deleteUtxos(boardingAddress);
        await this.walletRepository.saveUtxos(
            boardingAddress,
            coins.map((utxo) => extendCoin(this.readonlyWallet!, utxo))
        );

        // Build transaction history from cached VTXOs (no indexer call)
        const address = await this.readonlyWallet.getAddress();
        const txs = await this.buildTransactionHistoryFromCache(vtxos);
        if (txs) await this.walletRepository.saveTransactions(address, txs);
    }

    /**
     * Force a full VTXO refresh from the indexer, then refresh cached data.
     * Used by RELOAD_WALLET to ensure fresh data without re-subscribing
     * to incoming funds or restarting the VtxoManager.
     */
    private async reloadWallet() {
        if (!this.readonlyWallet) return;
        const manager = await this.readonlyWallet.getContractManager();
        await manager.refreshVtxos();
        await this.refreshCachedData();
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

    private async handleDelegate(
        message: RequestDelegate
    ): Promise<ResponseDelegate> {
        const wallet = this.requireWallet();
        const delegatorManager = await wallet.getDelegatorManager();
        if (!delegatorManager) {
            throw new DelegatorNotConfiguredError();
        }

        const { vtxoOutpoints, destination, delegateAt } = message.payload;
        const allVtxos = await wallet.getVtxos();
        const outpointSet = new Set(
            vtxoOutpoints.map((o) => `${o.txid}:${o.vout}`)
        );
        const filtered = allVtxos.filter((v) =>
            outpointSet.has(`${v.txid}:${v.vout}`)
        );

        const result = await delegatorManager.delegate(
            filtered,
            destination,
            delegateAt !== undefined ? new Date(delegateAt) : undefined
        );

        return {
            tag: this.messageTag,
            type: "DELEGATE_SUCCESS",
            payload: {
                delegated: result.delegated.map((o) => ({
                    txid: o.txid,
                    vout: o.vout,
                })),
                failed: result.failed.map((f) => ({
                    outpoints: f.outpoints.map((o) => ({
                        txid: o.txid,
                        vout: o.vout,
                    })),
                    error: String(f.error),
                })),
            },
        };
    }

    private async handleGetVtxos(message: RequestGetVtxos) {
        if (!this.readonlyWallet) {
            throw new WalletNotInitializedError();
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

        // Dispose the wallet to stop the ContractWatcher (and its polling
        // intervals) before clearing the repositories, otherwise the poller
        // will hit a closing IndexedDB connection.
        try {
            if (this.wallet) {
                await this.wallet.dispose();
            } else {
                await this.readonlyWallet.dispose();
            }
        } catch (_) {
            // best-effort teardown
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

    /**
     * Read all VTXOs from the repository, aggregated across all contract
     * addresses and the wallet's primary address, with deduplication.
     */
    private async getVtxosFromRepo(): Promise<ExtendedVirtualCoin[]> {
        if (!this.walletRepository || !this.readonlyWallet) return [];
        const seen = new Set<string>();
        const allVtxos: ExtendedVirtualCoin[] = [];

        const addVtxos = (vtxos: ExtendedVirtualCoin[]) => {
            for (const vtxo of vtxos) {
                const key = `${vtxo.txid}:${vtxo.vout}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    allVtxos.push(vtxo);
                }
            }
        };

        // Aggregate VTXOs from all contract addresses
        const manager = await this.readonlyWallet.getContractManager();
        const contracts = await manager.getContracts();
        for (const contract of contracts) {
            const vtxos = await this.walletRepository.getVtxos(
                contract.address
            );
            addVtxos(vtxos);
        }

        // Also check the wallet's primary address
        const walletAddress = await this.readonlyWallet.getAddress();
        const walletVtxos = await this.walletRepository.getVtxos(walletAddress);
        addVtxos(walletVtxos);

        return allVtxos;
    }

    /**
     * Build transaction history from cached VTXOs without hitting the indexer.
     * Falls back to indexer only for uncached transaction timestamps.
     */
    private async buildTransactionHistoryFromCache(
        vtxos: ExtendedVirtualCoin[]
    ): Promise<ArkTransaction[] | null> {
        if (!this.readonlyWallet) return null;

        const { boardingTxs, commitmentsToIgnore } =
            await this.readonlyWallet.getBoardingTxs();

        // Build a lookup for cached VTXO timestamps, keyed by txid.
        // Multiple VTXOs can share a txid (different vouts) — we keep the
        // earliest createdAt so the history ordering is stable.
        const vtxoCreatedAt = new Map<string, number>();
        for (const vtxo of vtxos) {
            const existing = vtxoCreatedAt.get(vtxo.txid);
            const ts = vtxo.createdAt.getTime();
            if (existing === undefined || ts < existing) {
                vtxoCreatedAt.set(vtxo.txid, ts);
            }
        }

        // Pre-fetch uncached timestamps in a single batched indexer call.
        // buildTransactionHistory needs these for spent-offchain VTXOs with
        // no change outputs (i.e. arkTxId is set but no VTXO has txid === arkTxId).
        if (this.indexerProvider) {
            const uncachedTxids = new Set<string>();
            for (const vtxo of vtxos) {
                if (
                    vtxo.isSpent &&
                    vtxo.arkTxId &&
                    !vtxoCreatedAt.has(vtxo.arkTxId) &&
                    !vtxos.some((v) => v.txid === vtxo.arkTxId)
                ) {
                    uncachedTxids.add(vtxo.arkTxId);
                }
            }

            if (uncachedTxids.size > 0) {
                const outpoints = [...uncachedTxids].map((txid) => ({
                    txid,
                    vout: 0,
                }));
                const BATCH_SIZE = 100;
                for (let i = 0; i < outpoints.length; i += BATCH_SIZE) {
                    const res = await this.indexerProvider.getVtxos({
                        outpoints: outpoints.slice(i, i + BATCH_SIZE),
                    });
                    for (const v of res.vtxos) {
                        vtxoCreatedAt.set(v.txid, v.createdAt.getTime());
                    }
                }
            }
        }

        const getTxCreatedAt = async (
            txid: string
        ): Promise<number | undefined> => {
            return vtxoCreatedAt.get(txid);
        };

        return buildTransactionHistory(
            vtxos,
            boardingTxs,
            commitmentsToIgnore,
            getTxCreatedAt
        );
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
