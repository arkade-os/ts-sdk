import {
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    StorageConfig,
    IReadonlyWallet,
    IReadonlyAssetManager,
    IAssetManager,
    AssetDetails,
    IssuanceParams,
    IssuanceResult,
    ReissuanceParams,
    BurnParams,
    Recipient,
} from "..";
import { SettlementEvent } from "../../providers/ark";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity } from "../../identity";
import { WalletRepository } from "../../repositories/walletRepository";
import { ContractRepository } from "../../repositories/contractRepository";
import { setupServiceWorker } from "../../worker/browser/utils";
import {
    IndexedDBContractRepository,
    IndexedDBWalletRepository,
} from "../../repositories";
import {
    RequestClear,
    RequestCreateContract,
    RequestDeleteContract,
    RequestGetAddress,
    RequestGetBalance,
    RequestGetBoardingAddress,
    RequestGetBoardingUtxos,
    RequestGetContracts,
    RequestGetContractsWithVtxos,
    RequestGetStatus,
    RequestGetSpendablePaths,
    RequestGetTransactionHistory,
    RequestGetVtxos,
    RequestInitWallet,
    RequestIsContractManagerWatching,
    RequestRefreshVtxos,
    RequestReloadWallet,
    RequestSendBitcoin,
    RequestSettle,
    ResponseSettle,
    ResponseSettleEvent,
    RequestUpdateContract,
    ResponseGetAddress,
    ResponseGetBalance,
    ResponseGetBoardingAddress,
    ResponseGetBoardingUtxos,
    ResponseGetContracts,
    ResponseGetContractsWithVtxos,
    ResponseGetStatus,
    ResponseGetSpendablePaths,
    ResponseGetTransactionHistory,
    ResponseGetVtxos,
    ResponseIsContractManagerWatching,
    ResponseReloadWallet,
    ResponseSendBitcoin,
    ResponseUpdateContract,
    ResponseCreateContract,
    ResponseContractEvent,
    WalletUpdaterRequest,
    WalletUpdaterResponse,
    RequestGetAllSpendingPaths,
    ResponseGetAllSpendingPaths,
    RequestSend,
    ResponseSend,
    RequestGetAssetDetails,
    ResponseGetAssetDetails,
    RequestIssue,
    ResponseIssue,
    RequestReissue,
    ResponseReissue,
    RequestBurn,
    ResponseBurn,
    RequestDelegate,
    ResponseDelegate,
    RequestGetDelegateInfo,
    ResponseGetDelegateInfo,
    RequestRecoverVtxos,
    ResponseRecoverVtxos,
    ResponseRecoverVtxosEvent,
    RequestGetRecoverableBalance,
    ResponseGetRecoverableBalance,
    RequestGetExpiringVtxos,
    ResponseGetExpiringVtxos,
    RequestRenewVtxos,
    ResponseRenewVtxos,
    ResponseRenewVtxosEvent,
    RequestGetExpiredBoardingUtxos,
    ResponseGetExpiredBoardingUtxos,
    RequestSweepExpiredBoardingUtxos,
    ResponseSweepExpiredBoardingUtxos,
    DEFAULT_MESSAGE_TAG,
} from "./wallet-message-handler";
import type {
    Contract,
    ContractEventCallback,
    ContractWithVtxos,
    GetContractsFilter,
    PathSelection,
} from "../../contracts";
import type {
    CreateContractParams,
    GetAllSpendingPathsOptions,
    GetSpendablePathsOptions,
    IContractManager,
} from "../../contracts/contractManager";
import type { ContractState } from "../../contracts/types";
import type { IDelegatorManager } from "../delegator";
import type { IVtxoManager, SettlementConfig } from "../vtxo-manager";
import type { ContractWatcherConfig } from "../../contracts/contractWatcher";
import type { DelegateInfo } from "../../providers/delegator";
import { getRandomId } from "../utils";
import {
    MESSAGE_BUS_NOT_INITIALIZED,
    ServiceWorkerTimeoutError,
} from "../../worker/errors";

// Check by error message content instead of instanceof because postMessage uses the
// structured clone algorithm which strips the prototype chain — the page
// receives a plain Error, not the original MessageBusNotInitializedError.
function isMessageBusNotInitializedError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes(MESSAGE_BUS_NOT_INITIALIZED)
    );
}

type RequestType = WalletUpdaterRequest["type"];

export type MessageTimeouts = Partial<Record<RequestType, number>>;

export const DEFAULT_MESSAGE_TIMEOUTS: Readonly<Record<RequestType, number>> = {
    // Fast reads — fail quickly
    GET_ADDRESS: 10_000,
    GET_BALANCE: 10_000,
    GET_BOARDING_ADDRESS: 10_000,
    GET_STATUS: 10_000,
    GET_DELEGATE_INFO: 10_000,
    IS_CONTRACT_MANAGER_WATCHING: 10_000,

    // Medium reads — may involve indexer queries
    GET_VTXOS: 20_000,
    GET_BOARDING_UTXOS: 20_000,
    GET_TRANSACTION_HISTORY: 20_000,
    GET_CONTRACTS: 20_000,
    GET_CONTRACTS_WITH_VTXOS: 20_000,
    GET_SPENDABLE_PATHS: 20_000,
    GET_ALL_SPENDING_PATHS: 20_000,
    GET_ASSET_DETAILS: 20_000,
    GET_EXPIRING_VTXOS: 20_000,
    GET_EXPIRED_BOARDING_UTXOS: 20_000,
    GET_RECOVERABLE_BALANCE: 20_000,
    RELOAD_WALLET: 20_000,

    // Transactions — need more headroom
    SEND_BITCOIN: 50_000,
    SEND: 50_000,
    SETTLE: 50_000,
    ISSUE: 50_000,
    REISSUE: 50_000,
    BURN: 50_000,
    DELEGATE: 50_000,
    RECOVER_VTXOS: 50_000,
    RENEW_VTXOS: 50_000,
    SWEEP_EXPIRED_BOARDING_UTXOS: 50_000,

    // Misc writes
    INIT_WALLET: 30_000,
    CLEAR: 10_000,
    SIGN_TRANSACTION: 30_000,
    CREATE_CONTRACT: 30_000,
    UPDATE_CONTRACT: 30_000,
    DELETE_CONTRACT: 10_000,
    REFRESH_VTXOS: 30_000,
};

const DEDUPABLE_REQUEST_TYPES: ReadonlySet<string> = new Set([
    "GET_ADDRESS",
    "GET_BALANCE",
    "GET_BOARDING_ADDRESS",
    "GET_BOARDING_UTXOS",
    "GET_STATUS",
    "GET_TRANSACTION_HISTORY",
    "IS_CONTRACT_MANAGER_WATCHING",
    "GET_DELEGATE_INFO",
    "GET_RECOVERABLE_BALANCE",
    "GET_EXPIRED_BOARDING_UTXOS",
    "GET_VTXOS",
    "GET_CONTRACTS",
    "GET_CONTRACTS_WITH_VTXOS",
    "GET_SPENDABLE_PATHS",
    "GET_ALL_SPENDING_PATHS",
    "GET_ASSET_DETAILS",
    "GET_EXPIRING_VTXOS",
    "RELOAD_WALLET",
]);

function getRequestDedupKey(request: WalletUpdaterRequest): string {
    const { id, tag, ...rest } = request;
    return JSON.stringify(rest);
}

type PrivateKeyIdentity = Identity & { toHex(): string };

const isPrivateKeyIdentity = (
    identity: Identity | ReadonlyIdentity
): identity is PrivateKeyIdentity => {
    return typeof (identity as any).toHex === "function";
};

class ServiceWorkerReadonlyAssetManager implements IReadonlyAssetManager {
    constructor(
        protected readonly sendMessage: (
            msg: WalletUpdaterRequest
        ) => Promise<WalletUpdaterResponse>,
        protected readonly messageTag: string
    ) {}

    async getAssetDetails(assetId: string): Promise<AssetDetails> {
        const message: RequestGetAssetDetails = {
            tag: this.messageTag,
            type: "GET_ASSET_DETAILS",
            id: getRandomId(),
            payload: { assetId },
        };
        const response = await this.sendMessage(message);
        return (response as ResponseGetAssetDetails).payload.assetDetails;
    }
}

class ServiceWorkerAssetManager
    extends ServiceWorkerReadonlyAssetManager
    implements IAssetManager
{
    async issue(params: IssuanceParams): Promise<IssuanceResult> {
        const message: RequestIssue = {
            tag: this.messageTag,
            type: "ISSUE",
            id: getRandomId(),
            payload: { params },
        };
        const response = await this.sendMessage(message);
        return (response as ResponseIssue).payload.result;
    }

    async reissue(params: ReissuanceParams): Promise<string> {
        const message: RequestReissue = {
            tag: this.messageTag,
            type: "REISSUE",
            id: getRandomId(),
            payload: { params },
        };
        const response = await this.sendMessage(message);
        return (response as ResponseReissue).payload.txid;
    }

    async burn(params: BurnParams): Promise<string> {
        const message: RequestBurn = {
            tag: this.messageTag,
            type: "BURN",
            id: getRandomId(),
            payload: { params },
        };
        const response = await this.sendMessage(message);
        return (response as ResponseBurn).payload.txid;
    }
}

/**
 * Service Worker-based wallet implementation for browser environments.
 *
 * This wallet uses a service worker as a backend to handle wallet logic,
 * providing secure key storage and transaction signing in web applications.
 * The service worker runs in a separate thread and can persist data between
 * browser sessions.
 *
 * @example
 * ```typescript
 * // SIMPLE: Recommended approach
 * const identity = SingleKey.fromHex('your_private_key_hex');
 * const wallet = await ServiceWorkerWallet.setup({
 *   serviceWorkerPath: '/service-worker.js',
 *   arkServerUrl: 'https://mutinynet.arkade.sh',
 *   identity
 * });
 *
 * // ADVANCED: Manual setup with service worker control
 * const worker = await setupServiceWorker("/service-worker.js");
 * const identity = SingleKey.fromHex('your_private_key_hex');
 * const wallet = await ServiceWorkerWallet.create({
 *   worker,
 *   identity,
 *   arkServerUrl: 'https://mutinynet.arkade.sh'
 * });
 *
 * // Use like any other wallet
 * const address = await wallet.getAddress();
 * const balance = await wallet.getBalance();
 * ```
 */
interface ServiceWorkerWalletOptions {
    arkServerPublicKey?: string;
    arkServerUrl: string;
    indexerUrl?: string;
    esploraUrl?: string;
    storage?: StorageConfig;
    identity: ReadonlyIdentity | Identity;
    delegatorUrl?: string;
    // Override the default tag for the messages sent and received from the SW
    walletUpdaterTag?: string;
    messageBusTimeoutMs?: number;
    settlementConfig?: SettlementConfig | false;
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
    messageTimeouts?: MessageTimeouts;
}
export type ServiceWorkerWalletCreateOptions = ServiceWorkerWalletOptions & {
    serviceWorker: ServiceWorker;
};

export type ServiceWorkerWalletSetupOptions = ServiceWorkerWalletOptions & {
    serviceWorkerPath: string;
    serviceWorkerActivationTimeoutMs?: number;
};

type MessageBusInitConfig = {
    wallet:
        | {
              privateKey: string;
          }
        | {
              publicKey: string;
          };
    arkServer: {
        url: string;
        publicKey?: string;
    };
    delegatorUrl?: string;
    indexerUrl?: string;
    esploraUrl?: string;
    timeoutMs?: number;
    settlementConfig?: SettlementConfig | false;
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
};

const initializeMessageBus = (
    serviceWorker: ServiceWorker,
    config: MessageBusInitConfig,
    timeoutMs = 2000
) => {
    const initCmd = {
        tag: "INITIALIZE_MESSAGE_BUS",
        id: getRandomId(),
        config: { ...config, timeoutMs },
    };

    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            navigator.serviceWorker.removeEventListener("message", onMessage);
            clearTimeout(timeoutId);
        };

        const onMessage = (event: any) => {
            const response = event.data;
            if (response?.id !== initCmd.id) return;
            cleanup();
            if (response.error) {
                reject(response.error);
            } else {
                resolve();
            }
        };

        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new ServiceWorkerTimeoutError("MessageBus timed out"));
        }, timeoutMs);

        navigator.serviceWorker.addEventListener("message", onMessage);
        serviceWorker.postMessage(initCmd);
    });
};

export class ServiceWorkerReadonlyWallet implements IReadonlyWallet {
    public readonly walletRepository: WalletRepository;
    public readonly contractRepository: ContractRepository;
    public readonly identity: ReadonlyIdentity;
    private readonly _readonlyAssetManager: IReadonlyAssetManager;
    protected initConfig: MessageBusInitConfig | null = null;
    protected initWalletPayload: RequestInitWallet["payload"] | null = null;
    protected messageBusTimeoutMs?: number;
    protected messageTimeouts: Record<RequestType, number> =
        DEFAULT_MESSAGE_TIMEOUTS as Record<RequestType, number>;
    private reinitPromise: Promise<void> | null = null;
    private pingPromise: Promise<void> | null = null;
    private inflightRequests = new Map<
        string,
        Promise<WalletUpdaterResponse>
    >();

    get assetManager(): IReadonlyAssetManager {
        return this._readonlyAssetManager;
    }

    protected constructor(
        public readonly serviceWorker: ServiceWorker,
        identity: ReadonlyIdentity,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository,
        protected readonly messageTag: string
    ) {
        this.identity = identity;
        this.walletRepository = walletRepository;
        this.contractRepository = contractRepository;
        this._readonlyAssetManager = new ServiceWorkerReadonlyAssetManager(
            (msg) => this.sendMessage(msg),
            messageTag
        );
    }

    private getTimeoutForRequest(request: WalletUpdaterRequest): number {
        return this.messageTimeouts[request.type] ?? 30_000;
    }

    static async create(
        options: ServiceWorkerWalletCreateOptions
    ): Promise<ServiceWorkerReadonlyWallet> {
        const walletRepository =
            options.storage?.walletRepository ??
            new IndexedDBWalletRepository();

        const contractRepository =
            options.storage?.contractRepository ??
            new IndexedDBContractRepository();

        const messageTag = options.walletUpdaterTag ?? DEFAULT_MESSAGE_TAG;

        // Create the wallet instance
        const wallet = new ServiceWorkerReadonlyWallet(
            options.serviceWorker,
            options.identity,
            walletRepository,
            contractRepository,
            messageTag
        );

        const publicKey = await options.identity
            .compressedPublicKey()
            .then(hex.encode);

        const initConfig = {
            key: { publicKey },
            arkServerUrl: options.arkServerUrl,
            arkServerPublicKey: options.arkServerPublicKey,
            delegatorUrl: options.delegatorUrl,
        };

        // Bootstrap the MessageBus in the service worker
        await initializeMessageBus(
            options.serviceWorker,
            {
                wallet: initConfig.key,
                arkServer: {
                    url: initConfig.arkServerUrl,
                    publicKey: initConfig.arkServerPublicKey,
                },
                delegatorUrl: initConfig.delegatorUrl,
                indexerUrl: options.indexerUrl,
                esploraUrl: options.esploraUrl,
                timeoutMs: options.messageBusTimeoutMs,
                watcherConfig: options.watcherConfig,
            },
            options.messageBusTimeoutMs
        );

        // Initialize the wallet handler
        const initMessage: RequestInitWallet = {
            tag: messageTag,
            type: "INIT_WALLET",
            id: getRandomId(),
            payload: initConfig,
        };

        await wallet.sendMessage(initMessage);

        wallet.initConfig = {
            wallet: initConfig.key,
            arkServer: {
                url: initConfig.arkServerUrl,
                publicKey: initConfig.arkServerPublicKey,
            },
            delegatorUrl: initConfig.delegatorUrl,
            indexerUrl: options.indexerUrl,
            esploraUrl: options.esploraUrl,
            watcherConfig: options.watcherConfig,
        };
        wallet.initWalletPayload = initConfig;
        wallet.messageBusTimeoutMs = options.messageBusTimeoutMs;
        if (options.messageTimeouts) {
            wallet.messageTimeouts = {
                ...DEFAULT_MESSAGE_TIMEOUTS,
                ...options.messageTimeouts,
            } as Record<RequestType, number>;
        }

        return wallet;
    }

    /**
     * Simplified setup method that handles service worker registration,
     * identity creation, and wallet initialization automatically.
     *
     * @example
     * ```typescript
     * // One-liner setup - handles everything automatically!
     * const wallet = await ServiceWorkerReadonlyWallet.setup({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh'
     * });
     *
     * // With custom readonly identity
     * const identity = ReadonlySingleKey.fromPublicKey('your_public_key_hex');
     * const wallet = await ServiceWorkerReadonlyWallet.setup({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh',
     *   identity
     * });
     * ```
     */
    static async setup(
        options: ServiceWorkerWalletSetupOptions
    ): Promise<ServiceWorkerReadonlyWallet> {
        // Register and setup the service worker
        const serviceWorker = await setupServiceWorker({
            path: options.serviceWorkerPath,
            activationTimeoutMs: options.serviceWorkerActivationTimeoutMs,
        });

        // Use the existing create method
        return await ServiceWorkerReadonlyWallet.create({
            ...options,
            serviceWorker,
        });
    }

    private sendMessageDirect(
        request: WalletUpdaterRequest,
        timeoutMs: number
    ): Promise<WalletUpdaterResponse> {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeoutId);
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(
                    new ServiceWorkerTimeoutError(
                        `Service worker message timed out (${request.type})`
                    )
                );
            }, timeoutMs);

            const messageHandler = (
                event: MessageEvent<WalletUpdaterResponse>
            ) => {
                const response = event.data;
                if (request.id !== response.id) {
                    return;
                }

                cleanup();
                if (response.error) {
                    reject(response.error);
                } else {
                    resolve(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            this.serviceWorker.postMessage(request);
        });
    }

    // Like sendMessageDirect but supports streaming responses: intermediate
    // messages are forwarded via onEvent while the promise resolves on the
    // first response for which isComplete returns true. The timeout resets
    // on every intermediate event so long-running but progressing operations
    // don't time out prematurely.
    private sendMessageStreaming(
        request: WalletUpdaterRequest,
        onEvent: (response: WalletUpdaterResponse) => void,
        isComplete: (response: WalletUpdaterResponse) => boolean,
        timeoutMs: number
    ): Promise<WalletUpdaterResponse> {
        return new Promise((resolve, reject) => {
            const resetTimeout = () => {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                    cleanup();
                    reject(
                        new ServiceWorkerTimeoutError(
                            `Service worker message timed out (${request.type})`
                        )
                    );
                }, timeoutMs);
            };

            const cleanup = () => {
                clearTimeout(timeoutId);
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );
            };

            let timeoutId: ReturnType<typeof setTimeout>;
            resetTimeout();

            const messageHandler = (
                event: MessageEvent<WalletUpdaterResponse>
            ) => {
                const response = event.data;
                if (request.id !== response.id) return;

                if (response.error) {
                    cleanup();
                    reject(response.error);
                    return;
                }

                if (isComplete(response)) {
                    cleanup();
                    resolve(response);
                } else {
                    resetTimeout();
                    onEvent(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            this.serviceWorker.postMessage(request);
        });
    }

    protected async sendMessage(
        request: WalletUpdaterRequest
    ): Promise<WalletUpdaterResponse> {
        if (!DEDUPABLE_REQUEST_TYPES.has(request.type)) {
            return this.sendMessageWithRetry(request);
        }

        const key = getRequestDedupKey(request);
        const existing = this.inflightRequests.get(key);
        if (existing) return existing;

        const promise = this.sendMessageWithRetry(request).finally(() => {
            this.inflightRequests.delete(key);
        });
        this.inflightRequests.set(key, promise);
        return promise;
    }

    private pingServiceWorker(): Promise<void> {
        if (this.pingPromise) return this.pingPromise;

        this.pingPromise = new Promise<void>((resolve, reject) => {
            const pingId = getRandomId();

            const cleanup = () => {
                clearTimeout(timeoutId);
                navigator.serviceWorker.removeEventListener(
                    "message",
                    onMessage
                );
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(
                    new ServiceWorkerTimeoutError(
                        "Service worker ping timed out"
                    )
                );
            }, 2_000);

            const onMessage = (event: MessageEvent) => {
                if (event.data?.id === pingId && event.data?.tag === "PONG") {
                    cleanup();
                    resolve();
                }
            };

            navigator.serviceWorker.addEventListener("message", onMessage);
            this.serviceWorker.postMessage({
                id: pingId,
                tag: "PING",
            });
        }).finally(() => {
            this.pingPromise = null;
        });

        return this.pingPromise;
    }

    // send a message, retrying up to 2 times if the service worker was
    // killed and restarted by the OS (mobile browsers do this aggressively)
    private async sendMessageWithRetry(
        request: WalletUpdaterRequest
    ): Promise<WalletUpdaterResponse> {
        // Skip the preflight ping during the initial INIT_WALLET call:
        // create() hasn't set initConfig yet, so reinitialize() would throw.
        if (this.initConfig) {
            try {
                await this.pingServiceWorker();
            } catch {
                await this.reinitialize();
            }
        }

        const timeoutMs = this.getTimeoutForRequest(request);
        const maxRetries = 2;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.sendMessageDirect(request, timeoutMs);
            } catch (error: any) {
                if (
                    !isMessageBusNotInitializedError(error) ||
                    attempt >= maxRetries
                ) {
                    throw error;
                }

                await this.reinitialize();
            }
        }
    }

    // Like sendMessage but for streaming responses — retries with
    // reinitialize when the service worker has been killed/restarted.
    protected async sendMessageWithEvents(
        request: WalletUpdaterRequest,
        onEvent: (response: WalletUpdaterResponse) => void,
        isComplete: (response: WalletUpdaterResponse) => boolean
    ): Promise<WalletUpdaterResponse> {
        if (this.initConfig) {
            try {
                await this.pingServiceWorker();
            } catch {
                await this.reinitialize();
            }
        }

        const timeoutMs = this.getTimeoutForRequest(request);
        const maxRetries = 2;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.sendMessageStreaming(
                    request,
                    onEvent,
                    isComplete,
                    timeoutMs
                );
            } catch (error: any) {
                if (
                    !isMessageBusNotInitializedError(error) ||
                    attempt >= maxRetries
                ) {
                    throw error;
                }

                await this.reinitialize();
            }
        }
    }

    private async reinitialize(): Promise<void> {
        if (this.reinitPromise) return this.reinitPromise;

        this.reinitPromise = (async () => {
            if (!this.initConfig || !this.initWalletPayload) {
                throw new Error("Cannot re-initialize: missing configuration");
            }

            await initializeMessageBus(
                this.serviceWorker,
                this.initConfig,
                this.messageBusTimeoutMs
            );

            const initMessage: RequestInitWallet = {
                tag: this.messageTag,
                type: "INIT_WALLET",
                id: getRandomId(),
                payload: this.initWalletPayload,
            };

            await this.sendMessageDirect(
                initMessage,
                this.getTimeoutForRequest(initMessage)
            );
        })().finally(() => {
            this.reinitPromise = null;
        });

        return this.reinitPromise;
    }

    async clear() {
        const message: RequestClear = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "CLEAR",
        };
        // Clear page-side storage to maintain parity with SW
        try {
            const address = await this.getAddress();
            await this.walletRepository.deleteVtxos(address);
        } catch (_) {
            console.warn("Failed to clear vtxos from wallet repository");
        }

        await this.sendMessage(message);
    }

    async getAddress(): Promise<string> {
        const message: RequestGetAddress = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_ADDRESS",
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetAddress).payload.address;
        } catch (error) {
            throw new Error(`Failed to get address: ${error}`);
        }
    }

    async getBoardingAddress(): Promise<string> {
        const message: RequestGetBoardingAddress = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_BOARDING_ADDRESS",
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetBoardingAddress).payload.address;
        } catch (error) {
            throw new Error(`Failed to get boarding address: ${error}`);
        }
    }

    async getBalance(): Promise<WalletBalance> {
        const message: RequestGetBalance = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_BALANCE",
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetBalance).payload;
        } catch (error) {
            throw new Error(`Failed to get balance: ${error}`);
        }
    }

    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        const message: RequestGetBoardingUtxos = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_BOARDING_UTXOS",
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetBoardingUtxos).payload.utxos;
        } catch (error) {
            throw new Error(`Failed to get boarding UTXOs: ${error}`);
        }
    }

    async getStatus(): Promise<ResponseGetStatus["payload"]> {
        const message: RequestGetStatus = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_STATUS",
        };
        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetStatus).payload;
        } catch (error) {
            throw new Error(`Failed to get status: ${error}`);
        }
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const message: RequestGetTransactionHistory = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_TRANSACTION_HISTORY",
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetTransactionHistory).payload
                .transactions;
        } catch (error) {
            throw new Error(`Failed to get transaction history: ${error}`);
        }
    }

    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        const message: RequestGetVtxos = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "GET_VTXOS",
            payload: { filter },
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseGetVtxos).payload.vtxos;
        } catch (error) {
            throw new Error(`Failed to get vtxos: ${error}`);
        }
    }

    async reload(): Promise<boolean> {
        const message: RequestReloadWallet = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "RELOAD_WALLET",
        };
        try {
            const response = await this.sendMessage(message);
            return (response as ResponseReloadWallet).payload.reloaded;
        } catch (error) {
            throw new Error(`Failed to reload wallet: ${error}`);
        }
    }

    async getContractManager(): Promise<IContractManager> {
        const wallet = this;

        const sendContractMessage = async <T extends WalletUpdaterRequest>(
            message: T
        ): Promise<WalletUpdaterResponse> => {
            return wallet.sendMessage(message as WalletUpdaterRequest);
        };

        const messageTag = this.messageTag;

        const manager: IContractManager = {
            async createContract(
                params: CreateContractParams
            ): Promise<Contract> {
                const message: RequestCreateContract = {
                    type: "CREATE_CONTRACT",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: params,
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseCreateContract).payload
                        .contract;
                } catch (e) {
                    throw new Error("Failed to create contract");
                }
            },

            async getContracts(
                filter?: GetContractsFilter
            ): Promise<Contract[]> {
                const message: RequestGetContracts = {
                    type: "GET_CONTRACTS",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { filter },
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseGetContracts).payload.contracts;
                } catch (e) {
                    throw new Error("Failed to get contracts");
                }
            },

            async getContractsWithVtxos(
                filter: GetContractsFilter
            ): Promise<ContractWithVtxos[]> {
                const message: RequestGetContractsWithVtxos = {
                    type: "GET_CONTRACTS_WITH_VTXOS",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { filter },
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseGetContractsWithVtxos).payload
                        .contracts;
                } catch (e) {
                    throw new Error("Failed to get contracts with vtxos");
                }
            },

            async updateContract(
                script: string,
                updates: Partial<Omit<Contract, "script" | "createdAt">>
            ): Promise<Contract> {
                const message: RequestUpdateContract = {
                    type: "UPDATE_CONTRACT",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { script, updates },
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseUpdateContract).payload
                        .contract;
                } catch (e) {
                    throw new Error("Failed to update contract");
                }
            },

            async setContractState(
                script: string,
                state: ContractState
            ): Promise<void> {
                const message: RequestUpdateContract = {
                    type: "UPDATE_CONTRACT",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { script, updates: { state } },
                };
                try {
                    await sendContractMessage(message);
                    return;
                } catch (e) {
                    throw new Error("Failed to update contract state");
                }
            },

            async deleteContract(script: string): Promise<void> {
                const message: RequestDeleteContract = {
                    type: "DELETE_CONTRACT",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { script },
                };
                try {
                    await sendContractMessage(message);
                    return;
                } catch (e) {
                    throw new Error("Failed to delete contract");
                }
            },

            async getSpendablePaths(
                options: GetSpendablePathsOptions
            ): Promise<PathSelection[]> {
                const message: RequestGetSpendablePaths = {
                    type: "GET_SPENDABLE_PATHS",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { options },
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseGetSpendablePaths).payload
                        .paths;
                } catch (e) {
                    throw new Error("Failed to get spendable paths");
                }
            },

            async getAllSpendingPaths(
                options: GetAllSpendingPathsOptions
            ): Promise<PathSelection[]> {
                const message: RequestGetAllSpendingPaths = {
                    type: "GET_ALL_SPENDING_PATHS",
                    id: getRandomId(),
                    tag: messageTag,
                    payload: { options },
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseGetAllSpendingPaths).payload
                        .paths;
                } catch (e) {
                    throw new Error("Failed to get all spending paths");
                }
            },

            onContractEvent(callback: ContractEventCallback): () => void {
                const messageHandler = (event: MessageEvent) => {
                    const response = event.data as WalletUpdaterResponse;
                    if (response.type !== "CONTRACT_EVENT") {
                        return;
                    }
                    if (response.tag !== messageTag) {
                        return;
                    }
                    callback((response as ResponseContractEvent).payload.event);
                };

                navigator.serviceWorker.addEventListener(
                    "message",
                    messageHandler
                );

                return () => {
                    navigator.serviceWorker.removeEventListener(
                        "message",
                        messageHandler
                    );
                };
            },

            async refreshVtxos(): Promise<void> {
                const message: RequestRefreshVtxos = {
                    type: "REFRESH_VTXOS",
                    id: getRandomId(),
                    tag: messageTag,
                };
                await sendContractMessage(message);
            },

            async isWatching(): Promise<boolean> {
                const message: RequestIsContractManagerWatching = {
                    type: "IS_CONTRACT_MANAGER_WATCHING",
                    id: getRandomId(),
                    tag: messageTag,
                };
                try {
                    const response = await sendContractMessage(message);
                    return (response as ResponseIsContractManagerWatching)
                        .payload.isWatching;
                } catch (e) {
                    throw new Error(
                        "Failed to check if contract manager is watching"
                    );
                }
            },

            dispose(): void {
                return;
            },

            [Symbol.dispose](): void {
                // no-op
                return;
            },
        };

        return manager;
    }
}

export class ServiceWorkerWallet
    extends ServiceWorkerReadonlyWallet
    implements IWallet
{
    public readonly walletRepository: WalletRepository;
    public readonly contractRepository: ContractRepository;
    public readonly identity: Identity;
    private readonly _assetManager: IAssetManager;
    private readonly hasDelegator: boolean;

    protected constructor(
        public readonly serviceWorker: ServiceWorker,
        identity: PrivateKeyIdentity,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository,
        messageTag: string,
        hasDelegator: boolean
    ) {
        super(
            serviceWorker,
            identity,
            walletRepository,
            contractRepository,
            messageTag
        );
        this.identity = identity;
        this.walletRepository = walletRepository;
        this.contractRepository = contractRepository;
        this._assetManager = new ServiceWorkerAssetManager(
            (msg) => this.sendMessage(msg),
            messageTag
        );
        this.hasDelegator = hasDelegator;
    }

    get assetManager(): IAssetManager {
        return this._assetManager;
    }

    static async create(
        options: ServiceWorkerWalletCreateOptions
    ): Promise<ServiceWorkerWallet> {
        const walletRepository =
            options.storage?.walletRepository ??
            new IndexedDBWalletRepository();

        const contractRepository =
            options.storage?.contractRepository ??
            new IndexedDBContractRepository();

        // Extract identity and check if it can expose private key
        const identity = isPrivateKeyIdentity(options.identity)
            ? options.identity
            : null;
        if (!identity) {
            throw new Error(
                "ServiceWorkerWallet.create() requires a Identity that can expose a single private key"
            );
        }

        // Extract private key for service worker initialization
        const privateKey = identity.toHex();

        const messageTag = options.walletUpdaterTag ?? DEFAULT_MESSAGE_TAG;

        // Create the wallet instance
        const wallet = new ServiceWorkerWallet(
            options.serviceWorker,
            identity,
            walletRepository,
            contractRepository,
            messageTag,
            !!options.delegatorUrl
        );

        const initConfig = {
            key: { privateKey },
            arkServerUrl: options.arkServerUrl,
            arkServerPublicKey: options.arkServerPublicKey,
            delegatorUrl: options.delegatorUrl,
        };

        await initializeMessageBus(
            options.serviceWorker,
            {
                wallet: initConfig.key,
                arkServer: {
                    url: initConfig.arkServerUrl,
                    publicKey: initConfig.arkServerPublicKey,
                },
                delegatorUrl: initConfig.delegatorUrl,
                indexerUrl: options.indexerUrl,
                esploraUrl: options.esploraUrl,
                timeoutMs: options.messageBusTimeoutMs,
                settlementConfig: options.settlementConfig,
                watcherConfig: options.watcherConfig,
            },
            options.messageBusTimeoutMs
        );
        // Initialize the service worker with the config
        const initMessage: RequestInitWallet = {
            tag: messageTag,
            type: "INIT_WALLET",
            id: getRandomId(),
            payload: initConfig,
        };

        // Initialize the service worker
        await wallet.sendMessage(initMessage);

        wallet.initConfig = {
            wallet: initConfig.key,
            arkServer: {
                url: initConfig.arkServerUrl,
                publicKey: initConfig.arkServerPublicKey,
            },
            delegatorUrl: initConfig.delegatorUrl,
            indexerUrl: options.indexerUrl,
            esploraUrl: options.esploraUrl,
            settlementConfig: options.settlementConfig,
            watcherConfig: options.watcherConfig,
        };
        wallet.initWalletPayload = initConfig;
        wallet.messageBusTimeoutMs = options.messageBusTimeoutMs;
        if (options.messageTimeouts) {
            wallet.messageTimeouts = {
                ...DEFAULT_MESSAGE_TIMEOUTS,
                ...options.messageTimeouts,
            } as Record<RequestType, number>;
        }

        return wallet;
    }

    /**
     * Simplified setup method that handles service worker registration,
     * identity creation, and wallet initialization automatically.
     *
     * @example
     * ```typescript
     * // One-liner setup - handles everything automatically!
     * const wallet = await ServiceWorkerWallet.setup({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh'
     * });
     *
     * // With custom identity
     * const identity = SingleKey.fromHex('your_private_key_hex');
     * const wallet = await ServiceWorkerWallet.setup({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh',
     *   identity
     * });
     * ```
     */
    static async setup(
        options: ServiceWorkerWalletSetupOptions
    ): Promise<ServiceWorkerWallet> {
        // Register and setup the service worker
        const serviceWorker = await setupServiceWorker({
            path: options.serviceWorkerPath,
            activationTimeoutMs: options.serviceWorkerActivationTimeoutMs,
        });

        // Use the existing create method
        return ServiceWorkerWallet.create({
            ...options,
            serviceWorker,
        });
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        const message: RequestSendBitcoin = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "SEND_BITCOIN",
            payload: params,
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseSendBitcoin).payload.txid;
        } catch (error) {
            throw new Error(`Failed to send bitcoin: ${error}`);
        }
    }

    async settle(
        params?: SettleParams,
        callback?: (event: SettlementEvent) => void
    ): Promise<string> {
        const message: RequestSettle = {
            id: getRandomId(),
            tag: this.messageTag,
            type: "SETTLE",
            payload: { params },
        };

        try {
            const response = await this.sendMessageWithEvents(
                message,
                (resp) => callback?.((resp as ResponseSettleEvent).payload),
                (resp) => resp.type === "SETTLE_SUCCESS"
            );
            return (response as ResponseSettle).payload.txid;
        } catch (error) {
            throw new Error(`Settlement failed: ${error}`);
        }
    }

    async send(...recipients: Recipient[]): Promise<string> {
        const message: RequestSend = {
            tag: this.messageTag,
            type: "SEND",
            id: getRandomId(),
            payload: { recipients },
        };

        try {
            const response = await this.sendMessage(message);
            return (response as ResponseSend).payload.txid;
        } catch (error) {
            throw new Error(`Send failed: ${error}`);
        }
    }

    async getDelegatorManager(): Promise<IDelegatorManager | undefined> {
        if (!this.hasDelegator) {
            return undefined;
        }

        const wallet = this;
        const messageTag = this.messageTag;

        const manager: IDelegatorManager = {
            async delegate(vtxos, destination, delegateAt?) {
                const message: RequestDelegate = {
                    tag: messageTag,
                    type: "DELEGATE",
                    id: getRandomId(),
                    payload: {
                        vtxoOutpoints: vtxos.map((v) => ({
                            txid: v.txid,
                            vout: v.vout,
                        })),
                        destination,
                        delegateAt: delegateAt?.getTime(),
                    },
                };

                try {
                    const response = await wallet.sendMessage(message);
                    const payload = (response as ResponseDelegate).payload;
                    return {
                        delegated: payload.delegated,
                        failed: payload.failed.map((f) => ({
                            outpoints: f.outpoints,
                            error: f.error,
                        })),
                    };
                } catch (error) {
                    throw new Error(`Delegation failed: ${error}`);
                }
            },

            async getDelegateInfo(): Promise<DelegateInfo> {
                const message: RequestGetDelegateInfo = {
                    type: "GET_DELEGATE_INFO",
                    id: getRandomId(),
                    tag: messageTag,
                };
                try {
                    const response = await wallet.sendMessage(message);
                    return (response as ResponseGetDelegateInfo).payload.info;
                } catch (e) {
                    throw new Error("Failed to get delegate info");
                }
            },
        };

        return manager;
    }

    async getVtxoManager(): Promise<IVtxoManager> {
        const wallet = this;
        const messageTag = this.messageTag;

        const manager: IVtxoManager = {
            async recoverVtxos(
                eventCallback?: (event: SettlementEvent) => void
            ): Promise<string> {
                const message: RequestRecoverVtxos = {
                    tag: messageTag,
                    type: "RECOVER_VTXOS",
                    id: getRandomId(),
                };
                try {
                    const response = await wallet.sendMessageWithEvents(
                        message,
                        (resp) =>
                            eventCallback?.(
                                (resp as ResponseRecoverVtxosEvent).payload
                            ),
                        (resp) => resp.type === "RECOVER_VTXOS_SUCCESS"
                    );
                    return (response as ResponseRecoverVtxos).payload.txid;
                } catch (e) {
                    throw new Error(`Failed to recover vtxos: ${e}`);
                }
            },

            async getRecoverableBalance() {
                const message: RequestGetRecoverableBalance = {
                    tag: messageTag,
                    type: "GET_RECOVERABLE_BALANCE",
                    id: getRandomId(),
                };
                try {
                    const response = await wallet.sendMessage(message);
                    const payload = (response as ResponseGetRecoverableBalance)
                        .payload;
                    return {
                        recoverable: BigInt(payload.recoverable),
                        subdust: BigInt(payload.subdust),
                        includesSubdust: payload.includesSubdust,
                        vtxoCount: payload.vtxoCount,
                    };
                } catch (e) {
                    throw new Error(`Failed to get recoverable balance: ${e}`);
                }
            },

            async getExpiringVtxos(thresholdMs?) {
                const message: RequestGetExpiringVtxos = {
                    tag: messageTag,
                    type: "GET_EXPIRING_VTXOS",
                    id: getRandomId(),
                    payload: { thresholdMs },
                };
                try {
                    const response = await wallet.sendMessage(message);
                    return (response as ResponseGetExpiringVtxos).payload.vtxos;
                } catch (e) {
                    throw new Error(`Failed to get expiring vtxos: ${e}`);
                }
            },

            async renewVtxos(
                eventCallback?: (event: SettlementEvent) => void
            ): Promise<string> {
                const message: RequestRenewVtxos = {
                    tag: messageTag,
                    type: "RENEW_VTXOS",
                    id: getRandomId(),
                };
                try {
                    const response = await wallet.sendMessageWithEvents(
                        message,
                        (resp) =>
                            eventCallback?.(
                                (resp as ResponseRenewVtxosEvent).payload
                            ),
                        (resp) => resp.type === "RENEW_VTXOS_SUCCESS"
                    );
                    return (response as ResponseRenewVtxos).payload.txid;
                } catch (e) {
                    throw new Error(`Failed to renew vtxos: ${e}`);
                }
            },

            async getExpiredBoardingUtxos() {
                const message: RequestGetExpiredBoardingUtxos = {
                    tag: messageTag,
                    type: "GET_EXPIRED_BOARDING_UTXOS",
                    id: getRandomId(),
                };
                try {
                    const response = await wallet.sendMessage(message);
                    return (response as ResponseGetExpiredBoardingUtxos).payload
                        .utxos;
                } catch (e) {
                    throw new Error(
                        `Failed to get expired boarding utxos: ${e}`
                    );
                }
            },

            async sweepExpiredBoardingUtxos(): Promise<string> {
                const message: RequestSweepExpiredBoardingUtxos = {
                    tag: messageTag,
                    type: "SWEEP_EXPIRED_BOARDING_UTXOS",
                    id: getRandomId(),
                };
                try {
                    const response = await wallet.sendMessage(message);
                    return (response as ResponseSweepExpiredBoardingUtxos)
                        .payload.txid;
                } catch (e) {
                    throw new Error(
                        `Failed to sweep expired boarding utxos: ${e}`
                    );
                }
            },

            async dispose(): Promise<void> {
                return;
            },
        };

        return manager;
    }
}
