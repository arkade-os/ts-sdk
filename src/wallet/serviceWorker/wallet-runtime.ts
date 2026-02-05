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
} from "..";
import { SettlementEvent } from "../../providers/ark";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity } from "../../identity";
import { WalletRepository } from "../../repositories/walletRepository";
import { ContractRepository } from "../../repositories/contractRepository";
import { setupServiceWorker } from "../../serviceWorker/utils";
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
    RequestReloadWallet,
    RequestSendBitcoin,
    RequestSettle,
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
    DEFAULT_MESSAGE_TAG,
} from "./wallet-updater";
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

type PrivateKeyIdentity = Identity & { toHex(): string };

export type ExpoWorkerOptions = WalletRuntimeOptions & {
    minimumInterval?: number;
    taskName?: string;
};

export type ExpoWorkerDeps = {
    BackgroundTask: {
        getStatusAsync: () => Promise<unknown>;
        registerTaskAsync: (
            taskName: string,
            options?: unknown
        ) => Promise<void>;
        unregisterTaskAsync: (taskName: string) => Promise<void>;
    };
    TaskManager: {
        defineTask: (
            taskName: string,
            taskExecutor: (...args: unknown[]) => unknown
        ) => void;
    };
};

export type NodeWorkerDeps = {
    createWorker?: (...args: unknown[]) => unknown;
};

export interface ReadonlyWalletRuntime extends IReadonlyWallet {
    readonly walletRepository: WalletRepository;
    readonly contractRepository: ContractRepository;
    readonly identity: ReadonlyIdentity;
}

export interface ServiceWorkerReadonlyWalletRuntime
    extends ReadonlyWalletRuntime {
    readonly serviceWorker: ServiceWorker;
}

export interface WalletRuntime extends IWallet {
    readonly walletRepository: WalletRepository;
    readonly contractRepository: ContractRepository;
    readonly identity: Identity;
}

export interface ServiceWorkerWalletRuntime extends WalletRuntime {
    readonly serviceWorker: ServiceWorker;
}

export interface NodeWalletRuntime extends WalletRuntime {}
export interface ExpoWalletRuntime extends WalletRuntime {}
export interface NodeReadonlyWalletRuntime extends ReadonlyWalletRuntime {}
export interface ExpoReadonlyWalletRuntime extends ReadonlyWalletRuntime {}

const isPrivateKeyIdentity = (
    identity: Identity | ReadonlyIdentity
): identity is PrivateKeyIdentity => {
    return typeof (identity as any).toHex === "function";
};

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
 * const wallet = await WalletRuntime.setupServiceWorker({
 *   serviceWorkerPath: '/service-worker.js',
 *   arkServerUrl: 'https://mutinynet.arkade.sh',
 *   identity
 * });
 *
 * // ADVANCED: Manual setup with service worker control
 * const serviceWorker = await setupServiceWorker("/service-worker.js");
 * const identity = SingleKey.fromHex('your_private_key_hex');
 * const wallet = await WalletRuntime.create({
 *   serviceWorker,
 *   identity,
 *   arkServerUrl: 'https://mutinynet.arkade.sh'
 * });
 *
 * // Use like any other wallet
 * const address = await wallet.getAddress();
 * const balance = await wallet.getBalance();
 * ```
 */
interface WalletRuntimeOptions {
    arkServerPublicKey?: string;
    arkServerUrl: string;
    esploraUrl?: string;
    storage?: StorageConfig;
    identity: ReadonlyIdentity | Identity;
    // Override the default target tag for the messages sent to the SW
    walletUpdaterTag?: string;
}
export type WalletRuntimeCreateOptions = WalletRuntimeOptions & {
    serviceWorker: ServiceWorker;
};

export type WalletRuntimeSetupOptions = WalletRuntimeOptions & {
    serviceWorkerPath: string;
};

export class SwReadonlyWalletRuntime
    implements ServiceWorkerReadonlyWalletRuntime
{
    public readonly walletRepository: WalletRepository;
    public readonly contractRepository: ContractRepository;
    public readonly identity: ReadonlyIdentity;

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
    }

    static async create(
        options: WalletRuntimeCreateOptions
    ): Promise<SwReadonlyWalletRuntime> {
        const walletRepository =
            options.storage?.walletRepository ??
            new IndexedDBWalletRepository();

        const contractRepository =
            options.storage?.contractRepository ??
            new IndexedDBContractRepository();

        const messageTag = options.walletUpdaterTag ?? DEFAULT_MESSAGE_TAG;

        // Create the wallet instance
        const wallet = new SwReadonlyWalletRuntime(
            options.serviceWorker,
            options.identity,
            walletRepository,
            contractRepository,
            messageTag
        );

        const publicKey = await options.identity
            .compressedPublicKey()
            .then(hex.encode);

        // Initialize the service worker with the config
        const initMessage: RequestInitWallet = {
            id: getRandomId(),
            targetTag: messageTag,
            type: "INIT_WALLET",
            payload: {
                key: { publicKey },
                arkServerUrl: options.arkServerUrl,
                arkServerPublicKey: options.arkServerPublicKey,
            },
        };

        // Initialize the service worker
        await wallet.sendMessage(initMessage);

        return wallet;
    }

    /**
     * Simplified setup method that handles service worker registration,
     * identity creation, and wallet initialization automatically.
     *
     * @example
     * ```typescript
     * // One-liner setup - handles everything automatically!
     * const wallet = await ReadonlyWalletRuntime.setupServiceWorker({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh'
     * });
     *
     * // With custom readonly identity
     * const identity = ReadonlySingleKey.fromPublicKey('your_public_key_hex');
     * const wallet = await ReadonlyWalletRuntime.setupServiceWorker({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh',
     *   identity
     * });
     * ```
     */
    static async setupServiceWorker(
        options: WalletRuntimeSetupOptions
    ): Promise<SwReadonlyWalletRuntime> {
        // Register and setup the service worker
        const serviceWorker = await setupServiceWorker(
            options.serviceWorkerPath
        );

        // Use the existing create method
        return await SwReadonlyWalletRuntime.create({
            ...options,
            serviceWorker,
        });
    }

    // send a message and wait for a response
    protected async sendMessage(
        request: WalletUpdaterRequest
    ): Promise<WalletUpdaterResponse> {
        return new Promise((resolve, reject) => {
            const messageHandler = (
                event: MessageEvent<WalletUpdaterResponse>
            ) => {
                const response = event.data;
                if (request.id !== response.id) {
                    return;
                }

                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );
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

    async clear() {
        const message: RequestClear = {
            id: getRandomId(),
            targetTag: this.messageTag,
            type: "CLEAR",
        };
        // Clear page-side storage to maintain parity with SW
        // TODO: isn't that the same DB we access?
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
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
                    targetTag: messageTag,
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
                    targetTag: messageTag,
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
                    targetTag: messageTag,
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
                    targetTag: messageTag,
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
                    targetTag: messageTag,
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
                    targetTag: messageTag,
                    payload: { script },
                };
                try {
                    const response = await sendContractMessage(message);
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
                    targetTag: messageTag,
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
                    targetTag: messageTag,
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
                    if (response.sourceTag !== messageTag) {
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

            async isWatching(): Promise<boolean> {
                const message: RequestIsContractManagerWatching = {
                    type: "IS_CONTRACT_MANAGER_WATCHING",
                    id: getRandomId(),
                    targetTag: messageTag,
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

export class SwWalletRuntime
    extends SwReadonlyWalletRuntime
    implements ServiceWorkerWalletRuntime
{
    public readonly walletRepository: WalletRepository;
    public readonly contractRepository: ContractRepository;
    public readonly identity: Identity;

    protected constructor(
        public readonly serviceWorker: ServiceWorker,
        identity: PrivateKeyIdentity,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository,
        messageTag: string
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
    }

    static async create(
        options: WalletRuntimeCreateOptions
    ): Promise<SwWalletRuntime> {
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
                "SwWalletRuntime.create() requires a Identity that can expose a single private key"
            );
        }

        // Extract private key for service worker initialization
        const privateKey = identity.toHex();

        const messageTag = options.walletUpdaterTag ?? DEFAULT_MESSAGE_TAG;

        // Create the wallet instance
        const wallet = new SwWalletRuntime(
            options.serviceWorker,
            identity,
            walletRepository,
            contractRepository,
            messageTag
        );

        // Initialize the service worker with the config
        const initMessage: RequestInitWallet = {
            targetTag: messageTag,
            type: "INIT_WALLET",
            id: getRandomId(),
            payload: {
                key: { privateKey },
                arkServerUrl: options.arkServerUrl,
                arkServerPublicKey: options.arkServerPublicKey,
            },
        };

        // Initialize the service worker
        await wallet.sendMessage(initMessage);

        return wallet;
    }

    /**
     * Simplified setup method that handles service worker registration,
     * identity creation, and wallet initialization automatically.
     *
     * @example
     * ```typescript
     * // One-liner setup - handles everything automatically!
     * const wallet = await WalletRuntime.setupServiceWorker({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh'
     * });
     *
     * // With custom identity
     * const identity = SingleKey.fromHex('your_private_key_hex');
     * const wallet = await WalletRuntime.setupServiceWorker({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://mutinynet.arkade.sh',
     *   identity
     * });
     * ```
     */
    static async setupServiceWorker(
        options: WalletRuntimeSetupOptions
    ): Promise<SwWalletRuntime> {
        // Register and setup the service worker
        const serviceWorker = await setupServiceWorker(
            options.serviceWorkerPath
        );

        // Use the existing create method
        return SwWalletRuntime.create({
            ...options,
            serviceWorker,
        });
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        const message: RequestSendBitcoin = {
            id: getRandomId(),
            targetTag: this.messageTag,
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
            targetTag: this.messageTag,
            type: "SETTLE",
            payload: { params },
        };

        try {
            return new Promise((resolve, reject) => {
                const messageHandler = (
                    event: MessageEvent<WalletUpdaterResponse>
                ) => {
                    const response = event.data;
                    if (response.id !== message.id) {
                        return;
                    }

                    if (response.error) {
                        navigator.serviceWorker.removeEventListener(
                            "message",
                            messageHandler
                        );
                        reject(response.error);
                        return;
                    }

                    switch (response.type) {
                        case "SETTLE_EVENT":
                            if (callback) {
                                callback(response.payload);
                            }
                            break;
                        case "SETTLE_SUCCESS":
                            navigator.serviceWorker.removeEventListener(
                                "message",
                                messageHandler
                            );
                            resolve(response.payload.txid);
                            break;
                        default:
                            console.error(
                                `Unexpected response type for SETTLE request: ${response.type}`
                            );
                    }
                };

                navigator.serviceWorker.addEventListener(
                    "message",
                    messageHandler
                );
                this.serviceWorker.postMessage(message);
            });
        } catch (error) {
            throw new Error(`Settlement failed: ${error}`);
        }
    }
}

async function setupNodeReadonlyWalletRuntime(
    _options: WalletRuntimeOptions,
    _deps?: NodeWorkerDeps
): Promise<NodeReadonlyWalletRuntime> {
    throw new Error("ReadonlyWalletRuntime.setupNodeWorker is not implemented");
}

async function setupExpoReadonlyWalletRuntime(
    _options: ExpoWorkerOptions,
    _deps: ExpoWorkerDeps
): Promise<ExpoReadonlyWalletRuntime> {
    throw new Error("ReadonlyWalletRuntime.setupExpoWorker is not implemented");
}

async function setupNodeWalletRuntime(
    _options: WalletRuntimeOptions,
    _deps?: NodeWorkerDeps
): Promise<NodeWalletRuntime> {
    throw new Error("WalletRuntime.setupNodeWorker is not implemented");
}

async function setupExpoWalletRuntime(
    _options: ExpoWorkerOptions,
    _deps: ExpoWorkerDeps
): Promise<ExpoWalletRuntime> {
    throw new Error("WalletRuntime.setupExpoWorker is not implemented");
}

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}

export const ReadonlyWalletRuntimeFactory = {
    setupServiceWorker: SwReadonlyWalletRuntime.setupServiceWorker,
    setupNodeWorker: setupNodeReadonlyWalletRuntime,
    setupExpoWorker: setupExpoReadonlyWalletRuntime,
};

export const WalletRuntimeFactory = {
    setupServiceWorker: SwWalletRuntime.setupServiceWorker,
    setupNodeWorker: setupNodeWalletRuntime,
    setupExpoWorker: setupExpoWalletRuntime,
};
