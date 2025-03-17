/// <reference lib="webworker" />

import { InMemoryKey } from "../core/identity";
import { IWallet, Wallet } from "../core/wallet";
import { Request } from "./request";
import { Response } from "./response";

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// ensure crypto is available in the service worker context
if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    Object.defineProperty(self, "crypto", {
        value: {
            getRandomValues: Crypto.prototype.getRandomValues,
        },
        writable: false,
        configurable: false,
    });
}

let wallet: IWallet | undefined;

// handler for the INIT_WALLET message
async function handleInitWallet(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isInitWallet(message)) {
        console.error("Invalid INIT_WALLET message format", message);
        event.source?.postMessage(
            Response.error("Invalid INIT_WALLET message format")
        );
        return;
    }

    try {
        wallet = await Wallet.create({
            network: message.network,
            identity: InMemoryKey.fromHex(message.privateKey),
            arkServerUrl: message.arkServerUrl,
            arkServerPubKey: message.arkServerPubKey,
        });

        event.source?.postMessage(Response.walletInitialized);
    } catch (error: unknown) {
        console.error("Error initializing wallet:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the SETTLE message
async function handleSettle(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isSettle(message)) {
        console.error("Invalid SETTLE message format", message);
        event.source?.postMessage(
            Response.error("Invalid SETTLE message format")
        );
        return;
    }

    try {
        if (!wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(Response.error("Wallet not initialized"));
            return;
        }

        const txid = await wallet.settle(message.params, (e) => {
            event.source?.postMessage(Response.settleEvent(e));
        });

        event.source?.postMessage(Response.settleSuccess(txid));
    } catch (error: unknown) {
        console.error("Error settling:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the SEND_BITCOIN message
async function handleSendBitcoin(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isSendBitcoin(message)) {
        console.error("Invalid SEND_BITCOIN message format", message);
        event.source?.postMessage(
            Response.error("Invalid SEND_BITCOIN message format")
        );
        return;
    }

    if (!wallet) {
        console.error("Wallet not initialized");
        event.source?.postMessage(Response.error("Wallet not initialized"));
        return;
    }

    try {
        const txid = await wallet.sendBitcoin(message.params, message.zeroFee);
        event.source?.postMessage(Response.sendBitcoinSuccess(txid));
    } catch (error: unknown) {
        console.error("Error sending bitcoin:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the GET_ADDRESS message
async function handleGetAddress(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isGetAddress(message)) {
        console.error("Invalid GET_ADDRESS message format", message);
        event.source?.postMessage(
            Response.error("Invalid GET_ADDRESS message format")
        );
        return;
    }

    if (!wallet) {
        console.error("Wallet not initialized");
        event.source?.postMessage(Response.error("Wallet not initialized"));
        return;
    }

    try {
        const address = await wallet.getAddress();
        event.source?.postMessage(Response.address(address));
    } catch (error: unknown) {
        console.error("Error getting address:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the GET_BALANCE message
async function handleGetBalance(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isGetBalance(message)) {
        console.error("Invalid GET_BALANCE message format", message);
        event.source?.postMessage(
            Response.error("Invalid GET_BALANCE message format")
        );
        return;
    }

    if (!wallet) {
        console.error("Wallet not initialized");
        event.source?.postMessage(Response.error("Wallet not initialized"));
        return;
    }

    try {
        const balance = await wallet.getBalance();
        event.source?.postMessage(Response.balance(balance));
    } catch (error: unknown) {
        console.error("Error getting balance:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the GET_COINS message
async function handleGetCoins(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isGetCoins(message)) {
        console.error("Invalid GET_COINS message format", message);
        event.source?.postMessage(
            Response.error("Invalid GET_COINS message format")
        );
        return;
    }

    if (!wallet) {
        console.error("Wallet not initialized");
        event.source?.postMessage(Response.error("Wallet not initialized"));
        return;
    }

    try {
        const coins = await wallet.getCoins();
        event.source?.postMessage(Response.coins(coins));
    } catch (error: unknown) {
        console.error("Error getting coins:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the GET_VTXOS message
async function handleGetVtxos(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isGetVtxos(message)) {
        console.error("Invalid GET_VTXOS message format", message);
        event.source?.postMessage(
            Response.error("Invalid GET_VTXOS message format")
        );
        return;
    }

    if (!wallet) {
        console.error("Wallet not initialized");
        event.source?.postMessage(Response.error("Wallet not initialized"));
        return;
    }

    try {
        const vtxos = await wallet.getVtxos();
        event.source?.postMessage(Response.vtxos(vtxos));
    } catch (error: unknown) {
        console.error("Error getting vtxos:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// handler for the GET_BOARDING_UTXOS message
async function handleGetBoardingUtxos(event: ExtendableMessageEvent) {
    const message = event.data;
    if (!Request.isGetBoardingUtxos(message)) {
        console.error("Invalid GET_BOARDING_UTXOS message format", message);
        event.source?.postMessage(
            Response.error("Invalid GET_BOARDING_UTXOS message format")
        );
        return;
    }

    if (!wallet) {
        console.error("Wallet not initialized");
        event.source?.postMessage(Response.error("Wallet not initialized"));
        return;
    }

    try {
        const boardingUtxos = await wallet.getBoardingUtxos();
        event.source?.postMessage(Response.boardingUtxos(boardingUtxos));
    } catch (error: unknown) {
        console.error("Error getting boarding utxos:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
        event.source?.postMessage(Response.error(errorMessage));
    }
}

// Handle messages from the client
self.addEventListener("message", async (event: ExtendableMessageEvent) => {
    const message = event.data;
    if (!Request.isBase(message)) {
        event.source?.postMessage(Response.error("Invalid message format"));
        return;
    }

    console.log("Received message in service worker", message);

    switch (message.type) {
        case "INIT_WALLET": {
            await handleInitWallet(event);
            break;
        }

        case "SETTLE": {
            await handleSettle(event);
            break;
        }

        case "SEND_BITCOIN": {
            await handleSendBitcoin(event);
            break;
        }

        case "GET_ADDRESS": {
            await handleGetAddress(event);
            break;
        }

        case "GET_BALANCE": {
            await handleGetBalance(event);
            break;
        }

        case "GET_COINS": {
            await handleGetCoins(event);
            break;
        }

        case "GET_VTXOS": {
            await handleGetVtxos(event);
            break;
        }

        case "GET_BOARDING_UTXOS": {
            await handleGetBoardingUtxos(event);
            break;
        }

        default:
            event.source?.postMessage(Response.error("Unknown message type"));
    }
});
