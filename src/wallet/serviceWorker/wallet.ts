import {
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    ArkTransaction,
    WalletConfig,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
} from "..";
import { Request } from "./request";
import { Response } from "./response";
import { SettlementEvent } from "../../providers/ark";
import { base64, hex } from "@scure/base";
import { SingleKey } from "../../identity/singleKey";
import { Identity } from "../../identity";
import { SignerSession, TreeSignerSession } from "../../tree/signingSession";
import { Transaction } from "@scure/btc-signer";

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
 * // Create and initialize the service worker wallet
 * const serviceWorker = await setupServiceWorker("/service-worker.js");
 * const wallet = new ServiceWorkerWallet(serviceWorker);
 * await wallet.init({
 *   privateKey: 'your_private_key_hex',
 *   arkServerUrl: 'https://ark.example.com'
 * });
 *
 * // Use like any other wallet
 * const address = await wallet.getAddress();
 * const balance = await wallet.getBalance();
 * ```
 */
export class ServiceWorkerWallet implements IWallet, Identity {
    private cachedXOnlyPublicKey: Uint8Array | undefined;

    constructor(public readonly serviceWorker: ServiceWorker) {}

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

    async init(
        config: Omit<WalletConfig, "identity"> & { privateKey: string },
        failIfInitialized = false
    ): Promise<void> {
        // Check if wallet is already initialized
        const statusMessage: Request.GetStatus = {
            type: "GET_STATUS",
            id: getRandomId(),
        };
        const response = await this.sendMessage(statusMessage);

        if (
            Response.isWalletStatus(response) &&
            response.status.walletInitialized
        ) {
            if (failIfInitialized) {
                throw new Error("Wallet already initialized");
            }
            return;
        }

        // If not initialized, proceed with initialization
        const message: Request.InitWallet = {
            type: "INIT_WALLET",
            id: getRandomId(),
            privateKey: config.privateKey,
            arkServerUrl: config.arkServerUrl,
            arkServerPublicKey: config.arkServerPublicKey,
        };

        await this.sendMessage(message);

        const privKeyBytes = hex.decode(config.privateKey);
        // cache the identity xOnlyPublicKey
        this.cachedXOnlyPublicKey =
            SingleKey.fromPrivateKey(privKeyBytes).xOnlyPublicKey();
    }

    async clear() {
        const message: Request.Clear = {
            type: "CLEAR",
            id: getRandomId(),
        };
        await this.sendMessage(message);

        // clear the cached xOnlyPublicKey
        this.cachedXOnlyPublicKey = undefined;
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

    xOnlyPublicKey(): Uint8Array {
        if (!this.cachedXOnlyPublicKey) {
            throw new Error("Wallet not initialized");
        }
        return this.cachedXOnlyPublicKey;
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const message: Request.Sign = {
            type: "SIGN",
            tx: base64.encode(tx.toPSBT()),
            inputIndexes,
            id: getRandomId(),
        };
        try {
            const response = await this.sendMessage(message);
            if (Response.isSignSuccess(response)) {
                return Transaction.fromPSBT(base64.decode(response.tx), {
                    allowUnknown: true,
                    allowUnknownInputs: true,
                });
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to sign: ${error}`);
        }
    }
}

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}
