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
import { getRandomId } from "../utils";

type PrivateKeyIdentity = Identity & { toHex(): string };

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
    esploraUrl?: string;
    storage?: StorageConfig;
    identity: ReadonlyIdentity | Identity;
    // Override the default tag for the messages sent and received from the SW
    walletUpdaterTag?: string;
}
export type ServiceWorkerWalletCreateOptions = ServiceWorkerWalletOptions & {
    serviceWorker: ServiceWorker;
};

export type ServiceWorkerWalletSetupOptions = ServiceWorkerWalletOptions & {
    serviceWorkerPath: string;
};

export class ServiceWorkerReadonlyWallet implements IReadonlyWallet {
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
        };

        // Bootstrap the MessageBus in the service worker
        await Promise.race([
            new Promise((resolve, reject) => {
                const initCmd = {
                    tag: "INITIALIZE_MESSAGE_BUS",
                    id: getRandomId(),
                    config: {
                        wallet: initConfig.key,
                        arkServer: {
                            url: initConfig.arkServerUrl,
                            publicKey: initConfig.arkServerPublicKey,
                        },
                    },
                };
                const messageHandler = (event: any) => {
                    const response = event.data;
                    if (initCmd.id !== response.id) {
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
                navigator.serviceWorker.addEventListener(
                    "message",
                    messageHandler
                );
                options.serviceWorker.postMessage(initCmd);
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject("MessageBus timed out!"), 2000)
            ),
        ]);

        // Initialize the wallet handler
        const initMessage: RequestInitWallet = {
            tag: messageTag,
            type: "INIT_WALLET",
            id: getRandomId(),
            payload: initConfig,
        };

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
        const serviceWorker = await setupServiceWorker(
            options.serviceWorkerPath
        );

        // Use the existing create method
        return await ServiceWorkerReadonlyWallet.create({
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
            messageTag
        );

        const initConfig = {
            key: { privateKey },
            arkServerUrl: options.arkServerUrl,
            arkServerPublicKey: options.arkServerPublicKey,
        };

        const r = await Promise.race([
            new Promise((resolve, reject) => {
                const initCmd = {
                    tag: "INITIALIZE_MESSAGE_BUS",
                    id: getRandomId(),
                    config: {
                        wallet: initConfig.key,
                        arkServer: {
                            url: initConfig.arkServerUrl,
                            publicKey: initConfig.arkServerPublicKey,
                        },
                    },
                };
                const messageHandler = (event: any) => {
                    const response = event.data;
                    if (initCmd.id !== response.id) {
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
                navigator.serviceWorker.addEventListener(
                    "message",
                    messageHandler
                );
                options.serviceWorker.postMessage(initCmd);
            }),
            new Promise((resolve, reject) =>
                setTimeout(() => reject("MessageBus timed out!"), 2000)
            ),
        ]);
        // Initialize the service worker with the config
        const initMessage: RequestInitWallet = {
            tag: messageTag,
            type: "INIT_WALLET",
            id: getRandomId(),
            payload: initConfig,
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
        const serviceWorker = await setupServiceWorker(
            options.serviceWorkerPath
        );

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
