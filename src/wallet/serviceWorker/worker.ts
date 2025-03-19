/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { InMemoryKey } from "../../identity/inMemoryKey";
import { IWallet } from "..";
import { Wallet } from "../wallet";
import { Request } from "./request";
import { Response } from "./response";

// Worker is a class letting to interact with ServiceWorkerWallet from the client
// it aims to be run in a service worker context
export class Worker {
    private wallet: IWallet | undefined;

    async start() {
        self.addEventListener(
            "message",
            async (event: ExtendableMessageEvent) => {
                await this.handleMessage(event);
            }
        );
    }

    async handleInitWallet(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isInitWallet(message)) {
            console.error("Invalid INIT_WALLET message format", message);
            event.source?.postMessage(
                Response.error("Invalid INIT_WALLET message format")
            );
            return;
        }

        try {
            this.wallet = await Wallet.create({
                network: message.network,
                identity: InMemoryKey.fromHex(message.privateKey),
                arkServerUrl: message.arkServerUrl,
                arkServerPublicKey: message.arkServerPublicKey,
            });

            event.source?.postMessage(Response.walletInitialized);
        } catch (error: unknown) {
            console.error("Error initializing wallet:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleSettle(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSettle(message)) {
            console.error("Invalid SETTLE message format", message);
            event.source?.postMessage(
                Response.error("Invalid SETTLE message format")
            );
            return;
        }

        try {
            if (!this.wallet) {
                console.error("Wallet not initialized");
                event.source?.postMessage(
                    Response.error("Wallet not initialized")
                );
                return;
            }

            const txid = await this.wallet.settle(message.params, (e) => {
                event.source?.postMessage(Response.settleEvent(e));
            });

            event.source?.postMessage(Response.settleSuccess(txid));
        } catch (error: unknown) {
            console.error("Error settling:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleSendBitcoin(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSendBitcoin(message)) {
            console.error("Invalid SEND_BITCOIN message format", message);
            event.source?.postMessage(
                Response.error("Invalid SEND_BITCOIN message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const txid = await this.wallet.sendBitcoin(
                message.params,
                message.zeroFee
            );
            event.source?.postMessage(Response.sendBitcoinSuccess(txid));
        } catch (error: unknown) {
            console.error("Error sending bitcoin:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetAddress(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetAddress(message)) {
            console.error("Invalid GET_ADDRESS message format", message);
            event.source?.postMessage(
                Response.error("Invalid GET_ADDRESS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const address = await this.wallet.getAddress();
            event.source?.postMessage(Response.address(address));
        } catch (error: unknown) {
            console.error("Error getting address:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetBalance(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBalance(message)) {
            console.error("Invalid GET_BALANCE message format", message);
            event.source?.postMessage(
                Response.error("Invalid GET_BALANCE message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const balance = await this.wallet.getBalance();
            event.source?.postMessage(Response.balance(balance));
        } catch (error: unknown) {
            console.error("Error getting balance:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetCoins(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetCoins(message)) {
            console.error("Invalid GET_COINS message format", message);
            event.source?.postMessage(
                Response.error("Invalid GET_COINS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const coins = await this.wallet.getCoins();
            event.source?.postMessage(Response.coins(coins));
        } catch (error: unknown) {
            console.error("Error getting coins:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetVtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetVtxos(message)) {
            console.error("Invalid GET_VTXOS message format", message);
            event.source?.postMessage(
                Response.error("Invalid GET_VTXOS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const vtxos = await this.wallet.getVtxos();
            event.source?.postMessage(Response.vtxos(vtxos));
        } catch (error: unknown) {
            console.error("Error getting vtxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetBoardingUtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBoardingUtxos(message)) {
            console.error("Invalid GET_BOARDING_UTXOS message format", message);
            event.source?.postMessage(
                Response.error("Invalid GET_BOARDING_UTXOS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const boardingUtxos = await this.wallet.getBoardingUtxos();
            event.source?.postMessage(Response.boardingUtxos(boardingUtxos));
        } catch (error: unknown) {
            console.error("Error getting boarding utxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetTransactionHistory(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetTransactionHistory(message)) {
            console.error(
                "Invalid GET_TRANSACTION_HISTORY message format",
                message
            );
            event.source?.postMessage(
                Response.error("Invalid GET_TRANSACTION_HISTORY message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        try {
            const transactions = await this.wallet.getTransactionHistory();
            event.source?.postMessage(
                Response.transactionHistory(transactions)
            );
        } catch (error: unknown) {
            console.error("Error getting transaction history:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(errorMessage));
        }
    }

    async handleGetStatus(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetStatus(message)) {
            console.error("Invalid GET_STATUS message format", message);
            event.source?.postMessage(
                Response.error("Invalid GET_STATUS message format")
            );
            return;
        }

        event.source?.postMessage(
            Response.walletStatus(this.wallet !== undefined)
        );
    }

    async handleMessage(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isBase(message)) {
            event.source?.postMessage(Response.error("Invalid message format"));
            return;
        }

        console.log("Received message in service worker", message);

        switch (message.type) {
            case "INIT_WALLET": {
                await this.handleInitWallet(event);
                break;
            }
            case "SETTLE": {
                await this.handleSettle(event);
                break;
            }
            case "SEND_BITCOIN": {
                await this.handleSendBitcoin(event);
                break;
            }
            case "GET_ADDRESS": {
                await this.handleGetAddress(event);
                break;
            }
            case "GET_BALANCE": {
                await this.handleGetBalance(event);
                break;
            }
            case "GET_COINS": {
                await this.handleGetCoins(event);
                break;
            }
            case "GET_VTXOS": {
                await this.handleGetVtxos(event);
                break;
            }
            case "GET_BOARDING_UTXOS": {
                await this.handleGetBoardingUtxos(event);
                break;
            }
            case "GET_TRANSACTION_HISTORY": {
                await this.handleGetTransactionHistory(event);
                break;
            }
            case "GET_STATUS": {
                await this.handleGetStatus(event);
                break;
            }
            default:
                event.source?.postMessage(
                    Response.error("Unknown message type")
                );
        }
    }
}
