import {
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    IReadonlyWallet,
} from "..";
import { Request } from "./request";
import { Response } from "./response";
import { SettlementEvent } from "../../providers/ark";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity, ReadonlySingleKey } from "../../identity";
import { IndexedDBStorageAdapter } from "../../storage/indexedDB";
import { WalletRepository } from "../../repositories/walletRepository";
import { WalletRepositoryImpl } from "../../repositories/walletRepository";
import { ContractRepository } from "../../repositories/contractRepository";
import { ContractRepositoryImpl } from "../../repositories/contractRepository";
import { DEFAULT_DB_NAME, setupServiceWorker } from "./utils";
import {
    RequestClear,
    RequestGetAddress,
    RequestGetBalance,
    RequestGetBoardingAddress,
    RequestGetBoardingUtxos,
    RequestGetStatus,
    RequestGetTransactionHistory,
    RequestGetVtxos,
    RequestInitWallet,
    RequestReloadWallet,
    RequestSendBitcoin,
    RequestSettle,
    ResponseClear,
    ResponseGetAddress,
    ResponseGetBalance,
    ResponseGetBoardingAddress,
    ResponseGetBoardingUtxos,
    ResponseGetStatus,
    ResponseGetTransactionHistory,
    ResponseGetVtxos,
    ResponseReloadWallet,
    ResponseSendBitcoin,
    ResponseSettle,
    WalletUpdater,
    WalletUpdaterRequest,
    WalletUpdaterResponse,
} from "./wallet-updater";
import { RequestEnvelope, ResponseEnvelope } from "./ark-serviceworker";
import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./service-worker-manager";

type PrivateKeyIdentity = Identity & { toHex(): string };

const isPrivateKeyIdentity = (
    identity: Identity | ReadonlyIdentity
): identity is PrivateKeyIdentity => {
    return typeof (identity as any).toHex === "function";
};

class UnexpectedResponseError extends Error {
    constructor(response: unknown) {
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
    dbName?: string;
    dbVersion?: number;
    identity: ReadonlyIdentity | Identity;
}
export type ServiceWorkerWalletCreateOptions = ServiceWorkerWalletOptions & {
    serviceWorker: ServiceWorker;
};

export type ServiceWorkerWalletSetupOptions = ServiceWorkerWalletOptions & {
    serviceWorkerPath: string;
};

const createCommon = (options: ServiceWorkerWalletCreateOptions) => {
    // Default to IndexedDB for service worker context
    const storage = new IndexedDBStorageAdapter(
        options.dbName || DEFAULT_DB_NAME,
        options.dbVersion
    );
    // Create repositories
    return {
        walletRepo: new WalletRepositoryImpl(storage),
        contractRepo: new ContractRepositoryImpl(storage),
    };
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
        const { walletRepo, contractRepo } = createCommon(options);

        // Create the wallet instance
        const wallet = new ServiceWorkerReadonlyWallet(
            options.serviceWorker,
            options.identity,
            walletRepo,
            contractRepo
        );

        const publicKey = await options.identity
            .compressedPublicKey()
            .then(hex.encode);

        // Initialize the service worker with the config
        const initMessage: RequestInitWallet = {
            tag: WalletUpdater.messageTag,
            type: "INIT_WALLET",
            id: getRandomId(),
            payload: {
                key: { publicKey },
                arkServerUrl: options.arkServerUrl,
                arkServerPublicKey: options.arkServerPublicKey,
            },
        };

        navigator.serviceWorker.addEventListener("message", (m) => {
            if (m.data.tag === undefined) {
                console.error("message received without tag: ", m.data);
            }
            if (m.data.tag !== WalletUpdater.messageTag) return;
            console.debug("[Wallet] broadcast received", m.data);
        });

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
    protected async sendMessage<
        REQ extends RequestEnvelope,
        RES extends ResponseEnvelope,
    >(message: Partial<REQ>): Promise<RES> {
        const id = getRandomId();
        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data as RES;
                // console.log("Received message from SW:", response);
                if (!response) {
                    console.log("Invalid response received from SW", event);
                }
                if (response.id === "") {
                    reject(new Error("Invalid response id"));
                    return;
                }
                if (response.id !== id) {
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
            // console.log("Sending message to SW:", message);
            this.serviceWorker.postMessage({
                tag: WalletUpdater.messageTag,
                id,
                type: "type" in message ? message.type : "NO_TYPE",
                payload: "payload" in message ? message.payload : undefined,
            });
        });
    }

    async clear() {
        // Clear page-side storage to maintain parity with SW
        try {
            const address = await this.getAddress();
            await this.walletRepository.clearVtxos(address);
        } catch (_) {
            console.warn("Failed to clear vtxos from wallet repository");
        }

        await this.sendMessage<RequestClear, ResponseClear>({ type: "CLEAR" });
    }

    async getAddress(): Promise<string> {
        const response = await this.sendMessage<
            RequestGetAddress,
            ResponseGetAddress
        >({ type: "GET_ADDRESS" });
        if (response.payload.address) {
            return response.payload.address;
        }
        throw new UnexpectedResponseError(response);
    }

    async getBoardingAddress(): Promise<string> {
        const response = await this.sendMessage<
            RequestGetBoardingAddress,
            ResponseGetBoardingAddress
        >({
            type: "GET_BOARDING_ADDRESS",
        });
        if (response.payload.address) {
            return response.payload.address;
        }
        throw new UnexpectedResponseError(response);
    }

    async getBalance(): Promise<WalletBalance> {
        const response = await this.sendMessage<
            RequestGetBalance,
            ResponseGetBalance
        >({ type: "GET_BALANCE" });
        if (response.payload) {
            return response.payload;
        }
        throw new UnexpectedResponseError(response);
    }

    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        const response = await this.sendMessage<
            RequestGetBoardingUtxos,
            ResponseGetBoardingUtxos
        >({ type: "GET_BOARDING_UTXOS" });
        if (response.payload.utxos) {
            return response.payload.utxos;
        }
        throw new UnexpectedResponseError(response);
    }

    async getStatus(): Promise<ResponseGetStatus["payload"]> {
        const response = await this.sendMessage<
            RequestGetStatus,
            ResponseGetStatus
        >({ type: "GET_STATUS" });
        if (response.payload) {
            return response.payload;
        }
        throw new UnexpectedResponseError(response);
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const response = await this.sendMessage<
            RequestGetTransactionHistory,
            ResponseGetTransactionHistory
        >({
            type: "GET_TRANSACTION_HISTORY",
        });
        if (response.payload.transactions) {
            return response.payload.transactions;
        }
        throw new UnexpectedResponseError(response);
    }

    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        const response = await this.sendMessage<
            RequestGetVtxos,
            ResponseGetVtxos
        >({
            type: "GET_VTXOS",
            payload: { filter },
        });
        if (response.payload.vtxos) {
            return response.payload.vtxos;
        }
        throw new UnexpectedResponseError(response);
    }

    async reload(): Promise<boolean> {
        const response = await this.sendMessage<
            RequestReloadWallet,
            ResponseReloadWallet
        >({ type: "RELOAD_WALLET" });
        if (response.payload.reloaded) {
            return true;
        }
        throw new UnexpectedResponseError(response);
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
        const { walletRepo, contractRepo } = createCommon(options);

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
            walletRepo,
            contractRepo
        );

        // Initialize the service worker with the config
        const initMessage: RequestInitWallet = {
            tag: WalletUpdater.messageTag,
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
        await setupServiceWorkerOnce(options.serviceWorkerPath);
        const serviceWorker = await getActiveServiceWorker(
            options.serviceWorkerPath
        );

        // Use the existing create method
        return ServiceWorkerWallet.create({
            ...options,
            serviceWorker,
        });
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        const response = await this.sendMessage<
            RequestSendBitcoin,
            ResponseSendBitcoin
        >({
            type: "SEND_BITCOIN",
            payload: params,
        });
        if (response.payload.txid) {
            return response.payload.txid;
        }
        throw new UnexpectedResponseError(response);
    }

    async settle(
        params?: SettleParams,
        callback?: (event: SettlementEvent) => void
    ): Promise<string> {
        const response = await this.sendMessage<RequestSettle, ResponseSettle>({
            type: "SETTLE",
            payload: params,
        });
        return response.payload.txid;
    }
}

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}
