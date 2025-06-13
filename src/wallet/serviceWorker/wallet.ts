import {
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    AddressInfo,
    Coin,
    ArkTransaction,
    WalletConfig,
    ExtendedCoin,
    ExtendedVirtualCoin,
    Addresses,
    Outpoint,
} from "..";
import { Request } from "./request";
import { Response } from "./response";
import { SettlementEvent } from "../../providers/ark";
import { hex } from "@scure/base";

class UnexpectedResponseError extends Error {
    constructor(response: Response.Base) {
        super(
            `Unexpected response type. Got: ${JSON.stringify(response, null, 2)}`
        );
        this.name = "UnexpectedResponseError";
    }
}

// ServiceWorkerWallet is a wallet that uses a service worker as "backend" to handle the wallet logic
export class ServiceWorkerWallet implements IWallet {
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
            network: config.network,
            arkServerUrl: config.arkServerUrl || "",
            arkServerPublicKey: config.arkServerPublicKey,
        };

        await this.sendMessage(message);
    }

    async clear() {
        const message: Request.Clear = {
            type: "CLEAR",
            id: getRandomId(),
        };
        await this.sendMessage(message);
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

    async getAddress(): Promise<Addresses> {
        const message: Request.GetAddress = {
            type: "GET_ADDRESS",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isAddress(response)) {
                return response.addresses;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get address: ${error}`);
        }
    }

    async getAddressInfo(): Promise<AddressInfo> {
        const message: Request.GetAddressInfo = {
            type: "GET_ADDRESS_INFO",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isAddressInfo(response)) {
                return response.addressInfo;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get address info: ${error}`);
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

    async getCoins(): Promise<Coin[]> {
        const message: Request.GetCoins = {
            type: "GET_COINS",
            id: getRandomId(),
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isCoins(response)) {
                return response.coins;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to get coins: ${error}`);
        }
    }

    async getVtxos(): Promise<ExtendedVirtualCoin[]> {
        const message: Request.GetVtxos = {
            type: "GET_VTXOS",
            id: getRandomId(),
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

    async sendBitcoin(
        params: SendBitcoinParams,
        zeroFee?: boolean
    ): Promise<string> {
        const message: Request.SendBitcoin = {
            type: "SEND_BITCOIN",
            params,
            zeroFee,
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

    async exit(outpoints?: Outpoint[]): Promise<void> {
        const message: Request.Exit = {
            type: "EXIT",
            outpoints,
            id: getRandomId(),
        };
        try {
            const response = await this.sendMessage(message);
            if (response.type === "EXIT_SUCCESS") {
                return;
            }
            throw new UnexpectedResponseError(response);
        } catch (error) {
            throw new Error(`Failed to exit: ${error}`);
        }
    }
}

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}
