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
    VirtualCoin,
    WalletBalance,
} from "../index";
import { DelegateInfo } from "../../providers/delegate";
import { ReadonlyWallet, Wallet } from "../wallet";
import type { RenewVtxosOptions } from "../vtxo-manager";
import { MessageHandler, RequestEnvelope, ResponseEnvelope } from "../../worker/messageBus";
import { Transaction } from "../../utils/transaction";
import { buildTransactionHistory } from "../../utils/transactionHistory";
import {
    filterVtxosForScript,
    getVtxosForContract,
    saveVtxosForContract,
    warnAndFilterVtxosForScript,
} from "../../contracts/vtxoOwnership";
import { scriptFromArkAddress } from "../../repositories/scriptFromAddress";

export class WalletNotInitializedError extends Error {
    constructor() {
        super("Wallet handler not initialized");
        this.name = "WalletNotInitializedError";
    }
}

/**
 * Type-guard for a {@link SerializedAggregateError} object that has survived
 * the postMessage boundary. Used on the page side of the RESTORE_WALLET path
 * to detect a worker-side AggregateError and reconstruct it.
 */
export function isSerializedAggregateError(value: unknown): value is SerializedAggregateError {
    if (!value || typeof value !== "object") return false;
    const v = value as Partial<SerializedAggregateError>;
    return (
        v.name === "AggregateError" &&
        typeof v.message === "string" &&
        Array.isArray(v.errors) &&
        v.errors.every((e) => e && typeof e.name === "string" && typeof e.message === "string")
    );
}

/** Worker-side serializer for a real {@link AggregateError}. */
export function serializeAggregateError(error: AggregateError): SerializedAggregateError {
    const errors: { name: string; message: string }[] = [];
    for (const child of error.errors ?? []) {
        if (child instanceof Error) {
            errors.push({ name: child.name, message: child.message });
        } else {
            errors.push({ name: "Error", message: String(child) });
        }
    }
    return {
        name: "AggregateError",
        message: error.message,
        errors,
    };
}

/** Page-side reconstructor: rebuild an {@link AggregateError} from the wire form. */
export function deserializeAggregateError(payload: SerializedAggregateError): AggregateError {
    const errs = payload.errors.map((e) => {
        const err = new Error(e.message);
        err.name = e.name;
        return err;
    });
    return new AggregateError(errs, payload.message);
}

export class ReadonlyWalletError extends Error {
    constructor() {
        super("Read-only wallet: operation requires signing");
        this.name = "ReadonlyWalletError";
    }
}

export class DelegateNotConfiguredError extends Error {
    constructor() {
        super("Delegate not configured");
        this.name = "DelegateNotConfiguredError";
    }
}

/** @deprecated alias for DelegateNotConfiguredError */
export const DelegatorNotConfiguredError = DelegateNotConfiguredError;
export type DelegatorNotConfiguredError = DelegateNotConfiguredError;

export const DEFAULT_MESSAGE_TAG = "WALLET_UPDATER";

export type RequestInitWallet = RequestEnvelope & {
    type: "INIT_WALLET";
    payload: {
        /**
         * Legacy per-request key material. Ignored by the current handler —
         * identity hydration happens during INITIALIZE_MESSAGE_BUS. Retained
         * for wire compatibility with older workers that may still read it.
         * Slated for removal in the next major.
         *
         * @deprecated Identity is now carried by INITIALIZE_MESSAGE_BUS.
         */
        key?: { privateKey: string } | { publicKey: string } | {};
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

export type RequestAnnotateVtxos = RequestEnvelope & {
    type: "ANNOTATE_VTXOS";
    payload: { vtxos: VirtualCoin[] };
};
export type ResponseAnnotateVtxos = ResponseEnvelope & {
    type: "ANNOTATED_VTXOS";
    payload: { vtxos: ExtendedVirtualCoin[] };
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

export type RequestRefreshOutpoints = RequestEnvelope & {
    type: "REFRESH_OUTPOINTS";
    payload: {
        outpoints: { txid: string; vout: number }[];
    };
};
export type ResponseRefreshOutpoints = ResponseEnvelope & {
    type: "REFRESH_OUTPOINTS_SUCCESS";
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
    payload: { recipients: [Recipient, ...Recipient[]] };
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
    payload?: RenewVtxosOptions;
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

export type RequestRestoreWallet = RequestEnvelope & {
    type: "RESTORE_WALLET";
    payload: { gapLimit?: number };
};
export type ResponseRestoreWallet = ResponseEnvelope & {
    type: "RESTORE_WALLET_SUCCESS";
};

/**
 * Wire envelope used to transmit an AggregateError across the postMessage
 * boundary. `AggregateError` and its `.errors` array are not portable enough
 * to rely on raw structured-clone behaviour across target browsers, so the
 * RESTORE_WALLET path serializes/reconstructs explicitly. Non-Error entries
 * are converted to Error on the worker side.
 */
export type SerializedAggregateError = {
    name: "AggregateError";
    message: string;
    errors: { name: string; message: string }[];
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
    | RequestAnnotateVtxos
    | RequestUpdateContract
    | RequestDeleteContract
    | RequestGetSpendablePaths
    | RequestGetAllSpendingPaths
    | RequestIsContractManagerWatching
    | RequestRefreshVtxos
    | RequestRefreshOutpoints
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
    | RequestSweepExpiredBoardingUtxos
    | RequestRestoreWallet;

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
        | ResponseAnnotateVtxos
        | ResponseUpdateContract
        | ResponseDeleteContract
        | ResponseGetSpendablePaths
        | ResponseGetAllSpendingPaths
        | ResponseIsContractManagerWatching
        | ResponseRefreshVtxos
        | ResponseRefreshOutpoints
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
        | ResponseRestoreWallet
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
        // (auto-renewal, boarding input polling) and ContractWatcher.
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
        const results = await Promise.allSettled(this.onNextTick.map((fn) => fn()));
        this.onNextTick = [];
        return results
            .map((result) => {
                if (result.status === "fulfilled") {
                    return result.value;
                } else {
                    console.error(`[${this.messageTag}] tick failed`, result.reason);
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

    // Flows that surrender control to the Ark server and the other participants
    // in a batch round: quiet gaps between protocol events can easily exceed
    // the bus-level messageTimeoutMs. Liveness is covered out-of-band by the
    // page-side PING / MESSAGE_BUS_NOT_INITIALIZED path triggered by concurrent
    // short requests (GET_STATUS, GET_BALANCE, ...).
    isLongRunning(message: WalletUpdaterRequest): boolean {
        return (
            message.type === "SETTLE" ||
            message.type === "RECOVER_VTXOS" ||
            message.type === "RENEW_VTXOS" ||
            // HD restore walks the index range with one indexer round-trip per
            // step until it hits gapLimit consecutive unused indices. The bus
            // deadline must not race the scan; liveness stays covered by PING.
            message.type === "RESTORE_WALLET"
        );
    }

    async handleMessage(message: WalletUpdaterRequest): Promise<WalletUpdaterResponse> {
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
                    const address = await this.readonlyWallet.getBoardingAddress();
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
                        (await this.buildTransactionHistoryFromCache(allVtxos)) ?? [];
                    return this.tagged({
                        id,
                        type: "TRANSACTION_HISTORY",
                        payload: { transactions },
                    });
                }
                case "GET_STATUS": {
                    const pubKey = await this.readonlyWallet.identity.xOnlyPublicKey();
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
                    const manager = await this.readonlyWallet.getContractManager();
                    const contract = await manager.createContract(message.payload);
                    return this.tagged({
                        id,
                        type: "CONTRACT_CREATED",
                        payload: { contract },
                    });
                }
                case "GET_CONTRACTS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const contracts = await manager.getContracts(message.payload.filter);
                    return this.tagged({
                        id,
                        type: "CONTRACTS",
                        payload: { contracts },
                    });
                }
                case "GET_CONTRACTS_WITH_VTXOS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const contracts = await manager.getContractsWithVtxos(message.payload.filter);
                    return this.tagged({
                        id,
                        type: "CONTRACTS_WITH_VTXOS",
                        payload: { contracts },
                    });
                }
                case "ANNOTATE_VTXOS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const annotated = await manager.annotateVtxos(message.payload.vtxos);
                    return this.tagged({
                        id,
                        type: "ANNOTATED_VTXOS",
                        payload: { vtxos: annotated },
                    });
                }
                case "UPDATE_CONTRACT": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const contract = await manager.updateContract(
                        message.payload.script,
                        message.payload.updates,
                    );
                    return this.tagged({
                        id,
                        type: "CONTRACT_UPDATED",
                        payload: { contract },
                    });
                }
                case "DELETE_CONTRACT": {
                    const manager = await this.readonlyWallet.getContractManager();
                    await manager.deleteContract(message.payload.script);
                    return this.tagged({
                        id,
                        type: "CONTRACT_DELETED",
                        payload: { deleted: true },
                    });
                }
                case "GET_SPENDABLE_PATHS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const paths = await manager.getSpendablePaths(message.payload.options);
                    return this.tagged({
                        id,
                        type: "SPENDABLE_PATHS",
                        payload: { paths },
                    });
                }
                case "GET_ALL_SPENDING_PATHS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const paths = await manager.getAllSpendingPaths(message.payload.options);
                    return this.tagged({
                        id,
                        type: "ALL_SPENDING_PATHS",
                        payload: { paths },
                    });
                }
                case "IS_CONTRACT_MANAGER_WATCHING": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const isWatching = await manager.isWatching();
                    return this.tagged({
                        id,
                        type: "CONTRACT_WATCHING",
                        payload: { isWatching },
                    });
                }
                case "REFRESH_VTXOS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    await manager.refreshVtxos((message as RequestRefreshVtxos).payload);
                    return this.tagged({
                        id,
                        type: "REFRESH_VTXOS_SUCCESS",
                    });
                }
                case "REFRESH_OUTPOINTS": {
                    const manager = await this.readonlyWallet.getContractManager();
                    const { outpoints } = (message as RequestRefreshOutpoints).payload;
                    await manager.refreshOutpoints(outpoints);
                    return this.tagged({
                        id,
                        type: "REFRESH_OUTPOINTS_SUCCESS",
                    });
                }
                case "SEND": {
                    const { recipients } = (message as RequestSend).payload;
                    const txid = await (this.wallet as IWallet).send(...recipients);
                    return this.tagged({
                        id,
                        type: "SEND_SUCCESS",
                        payload: { txid },
                    });
                }
                case "GET_ASSET_DETAILS": {
                    const { assetId } = (message as RequestGetAssetDetails).payload;
                    const assetDetails =
                        await this.readonlyWallet.assetManager.getAssetDetails(assetId);
                    return this.tagged({
                        id,
                        type: "ASSET_DETAILS",
                        payload: { assetDetails },
                    });
                }
                case "ISSUE": {
                    const { params } = (message as RequestIssue).payload;
                    const result = await (this.wallet as IWallet).assetManager.issue(params);
                    return this.tagged({
                        id,
                        type: "ISSUE_SUCCESS",
                        payload: { result },
                    });
                }
                case "REISSUE": {
                    const { params } = (message as RequestReissue).payload;
                    const txid = await (this.wallet as IWallet).assetManager.reissue(params);
                    return this.tagged({
                        id,
                        type: "REISSUE_SUCCESS",
                        payload: { txid },
                    });
                }
                case "BURN": {
                    const { params } = (message as RequestBurn).payload;
                    const txid = await (this.wallet as IWallet).assetManager.burn(params);
                    return this.tagged({
                        id,
                        type: "BURN_SUCCESS",
                        payload: { txid },
                    });
                }
                case "DELEGATE": {
                    const response = await this.handleDelegate(message as RequestDelegate);
                    return this.tagged({ id, ...response });
                }
                case "GET_DELEGATE_INFO": {
                    const wallet = this.requireWallet();
                    const delegateManager = await wallet.getDelegateManager();
                    if (!delegateManager) {
                        throw new DelegateNotConfiguredError();
                    }
                    const info = await delegateManager.getDelegateInfo();
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
                            }),
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
                        (message as RequestGetExpiringVtxos).payload.thresholdMs,
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
                            }),
                        );
                    }, message.payload);
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
                case "RESTORE_WALLET": {
                    const wallet = this.requireWallet();
                    try {
                        await wallet.restore(message.payload);
                    } catch (error: unknown) {
                        // AggregateError loses its prototype across postMessage
                        // and `.errors` is not portable enough to round-trip
                        // raw — serialize explicitly so the page can rebuild
                        // it. Other errors fall through to the generic catch.
                        if (error instanceof AggregateError) {
                            return this.tagged({
                                id,
                                error: serializeAggregateError(error) as unknown as Error,
                            });
                        }
                        throw error;
                    }
                    return this.tagged({
                        id,
                        type: "RESTORE_WALLET_SUCCESS",
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
        const sweptVtxos = allVtxos.filter((vtxo) => vtxo.virtualStatus.state === "swept");

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

        // aggregate asset balances from spendable virtual outputs
        const assetBalances = new Map<string, bigint>();
        for (const vtxo of spendableVtxos) {
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
        // with full virtual output history for all contracts (one indexer call per contract)
        await this.ensureContractEventBroadcasting();

        // Refresh cached data (virtual outputs, boarding inputs, tx history)
        await this.refreshCachedData();

        // Recover pending transactions (init-only, not on reload).
        // Pending txs only exist if a send was interrupted mid-finalization.
        if (this.wallet) {
            try {
                const vtxos = await this.getVtxosFromRepo();
                const { pending, finalized } = await this.wallet.finalizePendingTxs(
                    vtxos.filter(
                        (vtxo) =>
                            vtxo.virtualStatus.state !== "swept" &&
                            vtxo.virtualStatus.state !== "settled",
                    ),
                );
                console.info(
                    `Recovered ${finalized.length}/${pending.length} pending transactions: ${finalized.join(", ")}`,
                );
            } catch (error: unknown) {
                console.error("Error recovering pending transactions:", error);
            }
        }

        // unsubscribe previous subscription if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        const address = await this.readonlyWallet.getAddress();

        // subscribe for incoming funds and notify all clients when new funds arrive
        this.incomingFundsSubscription = await this.readonlyWallet.notifyIncomingFunds(
            async (funds) => {
                if (funds.type === "vtxo") {
                    // `funds.newVtxos` / `funds.spentVtxos` are already
                    // ExtendedVirtualCoin — annotation happened inside the
                    // underlying Wallet's subscription handler before this
                    // callback fired. Re-annotating here would only duplicate
                    // work and re-expose us to `annotateVtxos` throws.
                    const { newVtxos, spentVtxos } = funds;

                    if (newVtxos.length + spentVtxos.length === 0) return;

                    // Save virtual outputs using unified repository. The
                    // event may carry rows for several scripts (other
                    // contracts the wallet watches), so split by script and
                    // save each bucket under its own contract address rather
                    // than saving a mixed-script array under one address.
                    const byScript = new Map<string, ExtendedVirtualCoin[]>();
                    for (const v of [...newVtxos, ...spentVtxos]) {
                        if (!v.script) {
                            // Without a script we can't route the row to the
                            // right contract bucket; surface the drop instead
                            // of silently losing the VTXO.
                            console.warn(
                                `WalletMessageHandler.notifyIncomingFunds: dropping VTXO without script ${v.txid}:${v.vout}`,
                            );
                            continue;
                        }
                        const arr = byScript.get(v.script) ?? [];
                        arr.push(v);
                        byScript.set(v.script, arr);
                    }
                    let walletScript: string | undefined;
                    try {
                        walletScript = scriptFromArkAddress(address);
                    } catch {
                        walletScript = undefined;
                    }
                    const cm = await this.readonlyWallet!.getContractManager();
                    const contracts = await cm.getContracts();
                    const addrByScript = new Map(contracts.map((c) => [c.script, c.address]));
                    for (const [script, vtxos] of byScript) {
                        const filtered = warnAndFilterVtxosForScript(
                            vtxos,
                            script,
                            "WalletMessageHandler.notifyIncomingFunds",
                        );
                        if (filtered.length === 0) continue;
                        const targetAddress =
                            script === walletScript ? address : addrByScript.get(script);
                        if (!targetAddress) continue;
                        if (this.walletRepository) {
                            await saveVtxosForContract(
                                this.walletRepository,
                                { script, address: targetAddress },
                                filtered,
                            );
                        }
                    }

                    // notify all clients about the virtual output state update
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "VTXO_UPDATE",
                            broadcast: true,
                            payload: { newVtxos, spentVtxos },
                        }),
                    );
                }
                if (funds.type === "utxo") {
                    // A deposit may land on the current OR a previous boarding
                    // address (per-derivation rotation, plan §6-IV.2). The
                    // notified `coins` carry no address, so re-fetch + re-cache
                    // the full boarding-address set via getBoardingUtxos, which
                    // buckets each UTXO under the address it sits on with the
                    // correct per-UTXO tapscript — instead of assuming the
                    // current boarding address.
                    const utxos = await this.readonlyWallet!.getBoardingUtxos();

                    // notify all clients about the boarding input state update
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "UTXO_UPDATE",
                            broadcast: true,
                            payload: { coins: utxos },
                        }),
                    );
                }
            },
        );

        // Eagerly start the VtxoManager so its background tasks (auto-renewal,
        // boarding input polling/sweep) run inside the service worker without
        // waiting for a client to send a VtxoManager message first.
        if (this.wallet) {
            try {
                await this.wallet.getVtxoManager();
            } catch (error) {
                console.error("Error starting VtxoManager:", error);
            }
        }
    }

    /**
     * Refresh virtual outputs, boarding inputs, and transaction history from cache.
     * Shared by onWalletInitialized (full bootstrap) and reloadWallet
     * (post-refresh), avoiding duplicate subscriptions and VtxoManager restarts.
     */
    private async refreshCachedData() {
        if (!this.readonlyWallet || !this.walletRepository) {
            return;
        }

        // Read virtual outputs from repository (now populated by contract manager)
        const vtxos = await this.getVtxosFromRepo();

        // Fetch boarding inputs across the full boarding-address set (current +
        // historical rotated; plan §6-IV.2). Fetch FIRST: getBoardingUtxos
        // re-fetches each boarding address from the onchain provider and saves
        // it, so a transient failure throws here before we touch the cache and
        // the previous snapshot survives (offline-first). saveUtxos merges, so
        // only once the fetch succeeds do we prune spent coins the merge would
        // otherwise keep — per address, mirroring updateDbAfterSettle.
        const boardingAddresses = await this.readonlyWallet.getBoardingAddresses();
        const fresh = await this.readonlyWallet.getBoardingUtxos();
        const freshKeys = new Set(fresh.map((u) => `${u.txid}:${u.vout}`));
        for (const addr of boardingAddresses) {
            const cached = await this.walletRepository.getUtxos(addr);
            const kept = cached.filter((u) => freshKeys.has(`${u.txid}:${u.vout}`));
            if (kept.length === cached.length) continue; // nothing stale
            await this.walletRepository.deleteUtxos(addr);
            if (kept.length > 0) await this.walletRepository.saveUtxos(addr, kept);
        }

        // Build transaction history from cached virtual outputs (no indexer call)
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
                }),
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

    private async handleDelegate(message: RequestDelegate): Promise<ResponseDelegate> {
        const wallet = this.requireWallet();
        const delegateManager = await wallet.getDelegateManager();
        if (!delegateManager) {
            throw new DelegateNotConfiguredError();
        }

        const { vtxoOutpoints, destination, delegateAt } = message.payload;
        const allVtxos = await wallet.getVtxos();
        const outpointSet = new Set(vtxoOutpoints.map((o) => `${o.txid}:${o.vout}`));
        const filtered = allVtxos
            .filter((v) => outpointSet.has(`${v.txid}:${v.vout}`))
            .map((v) => ({ ...v, contractScript: v.script }));

        const result = await delegateManager.delegate(
            filtered,
            destination,
            delegateAt !== undefined ? new Date(delegateAt) : undefined,
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
        const includeRecoverable = message.payload.filter?.withRecoverable ?? false;
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
     * Read all virtual outputs from the repository, aggregated across all contract
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

        // Aggregate virtual outputs from all contract addresses. Address
        // buckets may carry legacy duplicate rows from other contracts; gate
        // each bucket by its owning contract script before deduplication so a
        // wrong-script row never wins the txid:vout race.
        const manager = await this.readonlyWallet.getContractManager();
        const contracts = await manager.getContracts();
        for (const contract of contracts) {
            addVtxos(await getVtxosForContract(this.walletRepository, contract));
        }

        // Also check the wallet's primary address. Decode it to its script
        // and apply the same script gate. Failing to decode the wallet's own
        // address is a structural bug — surfacing the error is safer than
        // silently dropping the primary bucket and zeroing the user's
        // visible balance.
        const walletAddress = await this.readonlyWallet.getAddress();
        let walletScript: string;
        try {
            walletScript = scriptFromArkAddress(walletAddress);
        } catch (e) {
            throw new Error(
                `WalletMessageHandler.getVtxosFromRepo: failed to derive script from wallet address ${walletAddress}: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        const walletVtxos = await this.walletRepository.getVtxos(walletAddress);
        addVtxos(filterVtxosForScript(walletVtxos, walletScript));

        return allVtxos;
    }

    /**
     * Build transaction history from cached virtual outputs without hitting the indexer.
     * Falls back to indexer only for uncached transaction timestamps.
     */
    private async buildTransactionHistoryFromCache(
        vtxos: ExtendedVirtualCoin[],
    ): Promise<ArkTransaction[] | null> {
        if (!this.readonlyWallet) return null;

        const { boardingTxs, commitmentsToIgnore } = await this.readonlyWallet.getBoardingTxs();

        // Build a lookup for cached virtual output timestamps, keyed by txid.
        // Multiple virtual outputs can share a txid (different vouts) — we keep the
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
        // buildTransactionHistory needs these for spent-offchain virtual outputs with
        // no change outputs (i.e. arkTxId is set but no virtual output has txid === arkTxId).
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

        const getTxCreatedAt = async (txid: string): Promise<number | undefined> => {
            return vtxoCreatedAt.get(txid);
        };

        return buildTransactionHistory(vtxos, boardingTxs, commitmentsToIgnore, getTxCreatedAt);
    }

    private async ensureContractEventBroadcasting() {
        if (!this.readonlyWallet) return;
        if (this.contractEventsSubscription) return;
        try {
            const manager = await this.readonlyWallet.getContractManager();
            this.contractEventsSubscription = manager.onContractEvent((event) => {
                this.scheduleForNextTick(() =>
                    this.tagged({
                        type: "CONTRACT_EVENT",
                        broadcast: true,
                        payload: { event },
                    }),
                );
            });
        } catch (error) {
            console.error("Error subscribing to contract events:", error);
        }
    }
}
