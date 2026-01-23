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
import { Request } from "./request";
import { Response } from "./response";
import { SettlementEvent } from "../../providers/ark";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity } from "../../identity";
import { WalletRepository } from "../../repositories/walletRepository";
import { ContractRepository } from "../../repositories/contractRepository";
import { setupServiceWorker } from "./utils";
import {
    IndexedDBContractRepository,
    IndexedDBWalletRepository,
} from "../../repositories";
import type {
    Contract,
    ContractEventCallback,
    ContractWithVtxos,
    GetContractsFilter,
    PathSelection,
} from "../../contracts";
import type {
    CreateContractParams,
    GetSpendablePathsOptions,
    IContractManager,
} from "../../contracts/contractManager";
import type { ContractState } from "../../contracts/types";

type PrivateKeyIdentity = Identity & { toHex(): string };

const isPrivateKeyIdentity = (
    identity: Identity | ReadonlyIdentity
): identity is PrivateKeyIdentity => {
    return typeof (identity as any).toHex === "function";
};

class UnexpectedResponseError extends Error {
    constructor(response: Response.Base) {
        super(
            `Unexpected response type. Got: ${JSON.stringify(response, null, 2)}`
        );
        this.name = "UnexpectedResponseError";
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
 * const serviceWorker = await setupServiceWorker("/service-worker.js");
 * const identity = SingleKey.fromHex('your_private_key_hex');
 * const wallet = await ServiceWorkerWallet.create({
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
interface ServiceWorkerWalletOptions {
    arkServerPublicKey?: string;
    arkServerUrl: string;
    esploraUrl?: string;
    storage?: StorageConfig;
    identity: ReadonlyIdentity | Identity;
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
        contractRepository: ContractRepository
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

        // Create the wallet instance
        const wallet = new ServiceWorkerReadonlyWallet(
            options.serviceWorker,
            options.identity,
            walletRepository,
            contractRepository
        );

        const publicKey = await options.identity
            .compressedPublicKey()
            .then(hex.encode);

        // Initialize the service worker with the config
        const initMessage: Request.InitWallet = {
            type: "INIT_WALLET",
            id: getRandomId(),
            key: { publicKey },
            arkServerUrl: options.arkServerUrl,
            arkServerPublicKey: options.arkServerPublicKey,
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
        return ServiceWorkerReadonlyWallet.create({
            ...options,
            serviceWorker,
        });
    }

    // send a message and wait for a response
    protected async sendMessage<T extends Request.Base>(
        message: T
    ): Promise<Response.Base> {
        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data as Response.Base;
                if (response.id === "") {
                    reject(new Error("Invalid response id"));
                    return;
                }
                if (response.id !== message.id) {
                    return;
                }
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );

                if (!response.success) {
                    reject(new Error((response as Response.Error).message));
                } else {
                    resolve(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            this.serviceWorker.postMessage(message);
        });
    }

    async clear() {
        const message: Request.Clear = {
            type: "CLEAR",
            id: getRandomId(),
        };
        // Clear page-side storage to maintain parity with SW
        try {
            const address = await this.getAddress();
            await this.walletRepository.clearVtxos(address);
        } catch (_) {
            console.warn("Failed to clear vtxos from wallet repository");
        }

        await this.sendMessage(message);
    }

    async getAddress(): Promise<string> {
        const message: Request.GetAddress = {
            type: "GET_ADDRESS",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isAddress(response)) {
                return response.address;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get address: ${error}`);
        }
    }

    async getBoardingAddress(): Promise<string> {
        const message: Request.GetBoardingAddress = {
            type: "GET_BOARDING_ADDRESS",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBoardingAddress(response)) {
                return response.address;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get boarding address: ${error}`);
        }
    }

    async getBalance(): Promise<WalletBalance> {
        const message: Request.GetBalance = {
            type: "GET_BALANCE",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBalance(response)) {
                return response.balance;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get balance: ${error}`);
        }
    }

    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        const message: Request.GetBoardingUtxos = {
            type: "GET_BOARDING_UTXOS",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBoardingUtxos(response)) {
                return response.boardingUtxos;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get boarding UTXOs: ${error}`);
        }
    }

    async getStatus(): Promise<Response.WalletStatus["status"]> {
        const message: Request.GetStatus = {
            type: "GET_STATUS",
            id: getRandomId(),
        };
        const response = await this.sendMessage(message);
        if (Response.isWalletStatus(response)) {
            return response.status;
        }
        throw new UnexpectedResponseError(response);
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const message: Request.GetTransactionHistory = {
            type: "GET_TRANSACTION_HISTORY",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isTransactionHistory(response)) {
                return response.transactions;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get transaction history: ${error}`);
        }
    }

    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        const message: Request.GetVtxos = {
            type: "GET_VTXOS",
            id: getRandomId(),
            filter,
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isVtxos(response)) {
                return response.vtxos;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get vtxos: ${error}`);
        }
    }

    async reload(): Promise<boolean> {
        const message: Request.ReloadWallet = {
            type: "RELOAD_WALLET",
            id: getRandomId(),
        };
        const response = await this.sendMessage(message);
        if (Response.isWalletReloaded(response)) {
            return response.success;
        }
        throw new UnexpectedResponseError(response);
    }

    async getContractManager(): Promise<IContractManager> {
        const wallet = this;

        const sendContractMessage = async <T extends Request.Base>(
            message: T
        ): Promise<Response.Base> => {
            return wallet.sendMessage(message);
        };

        const manager: IContractManager = {
            async createContract(
                params: CreateContractParams
            ): Promise<Contract> {
                const message: Request.CreateContract = {
                    type: "CREATE_CONTRACT",
                    id: getRandomId(),
                    params,
                };
                const response = await sendContractMessage(message);
                if (Response.isContractCreated(response)) {
                    return response.contract;
                }
                throw new UnexpectedResponseError(response);
            },

            async getContracts(
                filter?: GetContractsFilter
            ): Promise<Contract[]> {
                const message: Request.GetContracts = {
                    type: "GET_CONTRACTS",
                    id: getRandomId(),
                    filter,
                };
                const response = await sendContractMessage(message);
                if (Response.isContracts(response)) {
                    return response.contracts;
                }
                throw new UnexpectedResponseError(response);
            },

            async getContractsWithVtxos(
                filter: GetContractsFilter
            ): Promise<ContractWithVtxos[]> {
                const message: Request.GetContractsWithVtxos = {
                    type: "GET_CONTRACTS_WITH_VTXOS",
                    id: getRandomId(),
                    filter,
                };
                const response = await sendContractMessage(message);
                if (Response.isContractsWithVtxos(response)) {
                    return response.contracts;
                }
                throw new UnexpectedResponseError(response);
            },

            async updateContract(
                id: string,
                updates: Partial<Omit<Contract, "id" | "createdAt">>
            ): Promise<Contract> {
                const message: Request.UpdateContract = {
                    type: "UPDATE_CONTRACT",
                    id: getRandomId(),
                    contractId: id,
                    updates,
                };
                const response = await sendContractMessage(message);
                if (Response.isContractUpdated(response)) {
                    return response.contract;
                }
                throw new UnexpectedResponseError(response);
            },

            async setContractState(
                id: string,
                state: ContractState
            ): Promise<void> {
                const message: Request.UpdateContract = {
                    type: "UPDATE_CONTRACT",
                    id: getRandomId(),
                    contractId: id,
                    updates: { state },
                };
                const response = await sendContractMessage(message);
                if (Response.isContractUpdated(response)) {
                    return;
                }
                throw new UnexpectedResponseError(response);
            },

            async deleteContract(id: string): Promise<void> {
                const message: Request.DeleteContract = {
                    type: "DELETE_CONTRACT",
                    id: getRandomId(),
                    contractId: id,
                };
                const response = await sendContractMessage(message);
                if (Response.isContractDeleted(response)) {
                    return;
                }
                throw new UnexpectedResponseError(response);
            },

            async getSpendablePaths(
                options: GetSpendablePathsOptions
            ): Promise<PathSelection[]> {
                const message: Request.GetSpendablePaths = {
                    type: "GET_SPENDABLE_PATHS",
                    id: getRandomId(),
                    options,
                };
                const response = await sendContractMessage(message);
                if (Response.isSpendablePaths(response)) {
                    return response.paths;
                }
                throw new UnexpectedResponseError(response);
            },

            onContractEvent(callback: ContractEventCallback): () => void {
                // TODO: the subscription model requires scheduler to be present
                // (the `tick` method) in service worker
                const message: Request.SubscribeContractEvents = {
                    type: "SUBSCRIBE_CONTRACT_EVENTS",
                    id: getRandomId(),
                };

                const messageHandler = (event: MessageEvent) => {
                    const response = event.data as Response.Base;
                    if (Response.isContractEvent(response)) {
                        callback(response.event);
                    }
                };

                navigator.serviceWorker.addEventListener(
                    "message",
                    messageHandler
                );
                wallet.serviceWorker.postMessage(message);

                return () => {
                    const unsubscribeMessage: Request.UnsubscribeContractEvents =
                        {
                            type: "UNSUBSCRIBE_CONTRACT_EVENTS",
                            id: getRandomId(),
                        };
                    navigator.serviceWorker.removeEventListener(
                        "message",
                        messageHandler
                    );
                    wallet.serviceWorker.postMessage(unsubscribeMessage);
                };
            },

            async isWatching(): Promise<boolean> {
                const message: Request.isContractManagerWatching = {
                    type: "IS_CONTRACT_MANAGER_WATCHING",
                    id: getRandomId(),
                };
                const response = await sendContractMessage(message);
                if (Response.isContractWatching(response)) {
                    return response.isWatching;
                }
                throw new UnexpectedResponseError(response);
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
        contractRepository: ContractRepository
    ) {
        super(serviceWorker, identity, walletRepository, contractRepository);
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

        // Create the wallet instance
        const wallet = new ServiceWorkerWallet(
            options.serviceWorker,
            identity,
            walletRepository,
            contractRepository
        );

        // Initialize the service worker with the config
        const initMessage: Request.InitWallet = {
            type: "INIT_WALLET",
            id: getRandomId(),
            key: { privateKey },
            arkServerUrl: options.arkServerUrl,
            arkServerPublicKey: options.arkServerPublicKey,
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
        const message: Request.SendBitcoin = {
            type: "SEND_BITCOIN",
            params,
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isSendBitcoinSuccess(response)) {
                return response.txid;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to send bitcoin: ${error}`);
        }
    }

    async settle(
        params?: SettleParams,
        callback?: (event: SettlementEvent) => void
    ): Promise<string> {
        const message: Request.Settle = {
            type: "SETTLE",
            params,
            id: getRandomId(),
        };

        try {
            return new Promise((resolve, reject) => {
                const messageHandler = (event: MessageEvent) => {
                    const response = event.data as Response.Base;
                    if (response.id !== message.id) {
                        return;
                    }

                    if (!response.success) {
                        navigator.serviceWorker.removeEventListener(
                            "message",
                            messageHandler
                        );
                        reject(new Error((response as Response.Error).message));
                        return;
                    }

                    switch (response.type) {
                        case "SETTLE_EVENT":
                            if (callback) {
                                callback(
                                    (response as Response.SettleEvent).event
                                );
                            }
                            break;
                        case "SETTLE_SUCCESS":
                            navigator.serviceWorker.removeEventListener(
                                "message",
                                messageHandler
                            );
                            resolve((response as Response.SettleSuccess).txid);
                            break;
                        default:
                            break;
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

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}
