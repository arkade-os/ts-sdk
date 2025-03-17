import {
    IWallet,
    WalletConfig,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    AddressInfo,
    Coin,
    SpendableVtxo,
    VirtualCoin,
} from "./wallet";
import { Message } from "../sw/message";
import { Response } from "../sw/response";
import { hex } from "@scure/base";
import { SettlementEvent } from "../providers/ark";

export class ServiceWorkerWallet implements IWallet {
    private serviceWorker?: ServiceWorker;

    private async sendMessage<T extends Message.Base>(
        message: T
    ): Promise<Response.Base> {
        if (!this.serviceWorker) {
            throw new Error("Service worker not initialized");
        }

        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data as Response.Base;
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
            if (this.serviceWorker) {
                this.serviceWorker.postMessage(message);
            } else {
                reject(new Error("Service worker not initialized"));
            }
        });
    }

    async setupServiceWorker(path = "/sw.js"): Promise<void> {
        // Check if service workers are supported
        if (!("serviceWorker" in navigator)) {
            throw new Error(
                "Service workers are not supported in this browser"
            );
        }

        try {
            // Check for existing registration
            const existingRegistration =
                await navigator.serviceWorker.getRegistration(path);
            let registration: ServiceWorkerRegistration;

            if (existingRegistration) {
                registration = existingRegistration;
                console.log("Using existing service worker registration");
            } else {
                registration = await navigator.serviceWorker.register(path);
                console.log("New service worker registered");
            }

            const sw =
                registration.active ||
                registration.waiting ||
                registration.installing;
            if (!sw) {
                throw new Error("Failed to get service worker instance");
            }
            this.serviceWorker = sw;

            // Wait for the service worker to be ready
            if (this.serviceWorker?.state !== "activated") {
                await new Promise<void>((resolve) => {
                    if (!this.serviceWorker) return resolve();
                    this.serviceWorker.addEventListener("statechange", () => {
                        if (this.serviceWorker?.state === "activated") {
                            resolve();
                        }
                    });
                });
            }
        } catch (error) {
            throw new Error(`Failed to setup service worker: ${error}`);
        }
    }

    async init(config: WalletConfig): Promise<void> {
        try {
            const message: Message.InitWallet = {
                type: "INIT_WALLET",
                privateKey: hex.encode(config.identity.privateKey()),
                network: config.network,
                arkServerUrl: config.arkServerUrl || "",
                arkServerPubKey: config.arkServerPubKey,
            };

            console.log("Initializing wallet in service worker", message);

            await this.sendMessage(message);
        } catch (error) {
            throw new Error(
                `Failed to initialize service worker wallet: ${error}`
            );
        }
    }

    async getAddress(): Promise<AddressInfo> {
        const message: Message.GetAddress = {
            type: "GET_ADDRESS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isAddress(response)) {
                return response.address;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get address: ${error}`);
        }
    }

    async getBalance(): Promise<WalletBalance> {
        const message: Message.GetBalance = {
            type: "GET_BALANCE",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBalance(response)) {
                return response.balance;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get balance: ${error}`);
        }
    }

    async getCoins(): Promise<Coin[]> {
        const message: Message.GetCoins = {
            type: "GET_COINS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isCoins(response)) {
                return response.coins;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get coins: ${error}`);
        }
    }

    async getVtxos(): Promise<(SpendableVtxo & VirtualCoin)[]> {
        const message: Message.GetVtxos = {
            type: "GET_VTXOS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isVtxos(response)) {
                return response.vtxos;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get vtxos: ${error}`);
        }
    }

    async getBoardingUtxos(): Promise<(SpendableVtxo & Coin)[]> {
        const message: Message.GetBoardingUtxos = {
            type: "GET_BOARDING_UTXOS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBoardingUtxos(response)) {
                return response.boardingUtxos;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get boarding UTXOs: ${error}`);
        }
    }

    async sendBitcoin(
        params: SendBitcoinParams,
        zeroFee?: boolean
    ): Promise<string> {
        const message: Message.SendBitcoin = {
            type: "SEND_BITCOIN",
            params,
            zeroFee,
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isSendBitcoinSuccess(response)) {
                return response.txid;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to send bitcoin: ${error}`);
        }
    }

    async settle(
        params?: SettleParams,
        callback?: (event: SettlementEvent) => void
    ): Promise<string> {
        const message: Message.Settle = {
            type: "SETTLE",
            params,
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
                if (this.serviceWorker) {
                    this.serviceWorker.postMessage(message);
                } else {
                    reject(new Error("Service worker not initialized"));
                }
            });
        } catch (error) {
            throw new Error(`Settlement failed: ${error}`);
        }
    }

    async subscribeToEvents(_: string, __: string, ___: string): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async signMessage(_: string): Promise<string> {
        throw new Error("Method not implemented.");
    }

    async verifyMessage(_: string, __: string, ___: string): Promise<boolean> {
        throw new Error("Method not implemented.");
    }
}
