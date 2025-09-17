import {
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
} from "..";
import { Request } from "./request";
import { Response } from "./response";
import { SettlementEvent } from "../../providers/ark";
import { hex } from "@scure/base";
import { Identity } from "../../identity";
import { StorageAdapter } from "../../storage";
import { IndexedDBStorageAdapter } from "../../storage/indexedDB";
import { WalletRepository } from "../../repositories/walletRepository";
import { WalletRepositoryImpl } from "../../repositories/walletRepository";
import { ContractRepository } from "../../repositories/contractRepository";
import { ContractRepositoryImpl } from "../../repositories/contractRepository";
import { setupServiceWorker } from "./utils";

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
export interface ServiceWorkerWalletCreateOptions {
    serviceWorker: ServiceWorker;
    identity: Identity;
    arkServerUrl: string;
    esploraUrl?: string;
    arkServerPublicKey?: string;
    storage?: StorageAdapter;
}

export interface ServiceWorkerWalletSetupOptions {
    serviceWorkerPath: string;
    arkServerUrl: string;
    esploraUrl?: string;
    arkServerPublicKey?: string;
    storage?: StorageAdapter;
    identity: Identity;
}

export class ServiceWorkerWallet implements IWallet {
    public readonly walletRepository: WalletRepository;
    public readonly contractRepository: ContractRepository;
    public readonly identity: Identity;

    private constructor(
        public readonly serviceWorker: ServiceWorker,
        identity: Identity,
        walletRepository: WalletRepository,
        contractRepository: ContractRepository
    ) {
        this.identity = identity;
        this.walletRepository = walletRepository;
        this.contractRepository = contractRepository;
    }

    static async create(
        options: ServiceWorkerWalletCreateOptions
    ): Promise<ServiceWorkerWallet> {
        // Default to IndexedDB for service worker context
        const storage =
            options.storage || new IndexedDBStorageAdapter("wallet-db");

        // Create repositories
        const walletRepo = new WalletRepositoryImpl(storage);
        const contractRepo = new ContractRepositoryImpl(storage);

        // Extract private key for service worker initialization
        const privateKey =
            "identity" in options &&
            "toHex" in options.identity &&
            typeof options.identity.toHex === "function"
                ? options.identity.toHex()
                : null;

        if (!privateKey) {
            throw new Error(
                "ServiceWorkerWallet.create() requires a Identity that can expose its private key"
            );
        }

        // Create the wallet instance
        const wallet = new ServiceWorkerWallet(
            options.serviceWorker,
            options.identity,
            walletRepo,
            contractRepo
        );

        // Initialize the service worker with the config
        const initMessage: Request.InitWallet = {
            type: "INIT_WALLET",
            id: getRandomId(),
            privateKey,
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
        return await ServiceWorkerWallet.create({
            serviceWorker,
            identity: options.identity,
            arkServerUrl: options.arkServerUrl,
            esploraUrl: options.esploraUrl,
            storage: options.storage,
        });
    }

    // send a message and wait for a response
    private async sendMessage<T extends Request.Base>(
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
