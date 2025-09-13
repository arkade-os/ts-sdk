/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { SingleKey } from "../identity/singleKey";
import { Wallet as DirectWallet } from "./directWallet";
import { Request } from "./serviceWorker/request";
import { Response } from "./serviceWorker/response";
import { WalletConfig } from ".";
import { IndexedDBStorageAdapter } from "../storage/indexedDB";

/**
 * Bundled service worker for wallet operations.
 *
 * This service worker handles wallet initialization and operations in a secure context,
 * communicating with the main thread via message passing.
 */
class WalletServiceWorker {
    private wallet: DirectWallet | null = null;
    private isInitialized = false;

    constructor() {
        // Activate service worker immediately
        self.addEventListener("install", () => {
            self.skipWaiting();
        });

        // Take control of clients immediately
        self.addEventListener("activate", () => {
            self.clients.claim();
        });

        // Handle messages from the main thread
        self.addEventListener(
            "message",
            async (event: ExtendableMessageEvent) => {
                await this.handleMessage(event);
            }
        );
    }

    /**
     * Handles incoming messages and routes them to appropriate handlers.
     */
    private async handleMessage(event: ExtendableMessageEvent): Promise<void> {
        try {
            const request = event.data as Request.Base;

            if (!Request.isBase(request)) {
                this.sendErrorResponse(event, "Invalid request format", "");
                return;
            }

            let response: Response.Base;

            switch (request.type) {
                case "INIT_WALLET":
                    response = await this.handleInitWallet(
                        request as Request.InitWallet
                    );
                    break;

                case "GET_ADDRESS":
                    response = await this.handleGetAddress(
                        request as Request.GetAddress
                    );
                    break;

                case "GET_BOARDING_ADDRESS":
                    response = await this.handleGetBoardingAddress(
                        request as Request.GetBoardingAddress
                    );
                    break;

                case "GET_BALANCE":
                    response = await this.handleGetBalance(
                        request as Request.GetBalance
                    );
                    break;

                case "GET_VTXOS":
                    response = await this.handleGetVtxos(
                        request as Request.GetVtxos
                    );
                    break;

                case "GET_BOARDING_UTXOS":
                    response = await this.handleGetBoardingUtxos(
                        request as Request.GetBoardingUtxos
                    );
                    break;

                case "GET_TRANSACTION_HISTORY":
                    response = await this.handleGetTransactionHistory(
                        request as Request.GetTransactionHistory
                    );
                    break;

                case "SEND_BITCOIN":
                    response = await this.handleSendBitcoin(
                        request as Request.SendBitcoin
                    );
                    break;

                case "SETTLE":
                    await this.handleSettle(request as Request.Settle, event);
                    return; // Settle handles its own responses

                case "GET_XONLY_PUBLIC_KEY":
                    response = await this.handleGetXOnlyPublicKey(
                        request as Request.GetXOnlyPublicKey
                    );
                    break;

                case "SIGN_TRANSACTION":
                    response = await this.handleSignTransaction(
                        request as Request.SignTransaction
                    );
                    break;

                case "CLEAR":
                    response = await this.handleClear(request as Request.Clear);
                    break;

                default:
                    response = this.createErrorResponse(
                        request.id,
                        `Unknown request type: ${request.type}`
                    );
            }

            this.postMessageToClient(event, response);
        } catch (error) {
            this.sendErrorResponse(event, `Service worker error: ${error}`, "");
        }
    }

    /**
     * Posts a message back to the client.
     */
    private postMessageToClient(
        event: ExtendableMessageEvent,
        response: any
    ): void {
        if (event.ports && event.ports.length > 0) {
            event.ports[0].postMessage(response);
        } else {
            // Broadcast to all clients
            self.clients.matchAll().then((clients) => {
                clients.forEach((client) => client.postMessage(response));
            });
        }
    }

    /**
     * Initializes the wallet with the provided configuration.
     */
    private async handleInitWallet(
        request: Request.InitWallet
    ): Promise<Response.Base> {
        try {
            // Create or load identity
            let identity: SingleKey;

            if (request.privateKey) {
                // Use provided private key
                identity = SingleKey.fromHex(request.privateKey);
            } else {
                // Try to load existing identity from storage or generate new one
                const storage = new IndexedDBStorageAdapter("wallet-identity");
                const storedKey = await storage.getItem("privateKey");

                if (storedKey) {
                    identity = SingleKey.fromHex(storedKey);
                } else {
                    // Generate new identity and store it
                    identity = SingleKey.fromRandomBytes();
                    // Note: We can't easily access the private key from SingleKey,
                    // so we'll generate a hex key and use it
                    const { randomPrivateKeyBytes } = await import(
                        "@scure/btc-signer/utils"
                    );
                    const { hex } = await import("@scure/base");
                    const privateKeyBytes = randomPrivateKeyBytes();
                    const privateKeyHex = hex.encode(privateKeyBytes);
                    identity = SingleKey.fromHex(privateKeyHex);
                    await storage.setItem("privateKey", privateKeyHex);
                }
            }

            // Create wallet configuration
            const config: WalletConfig = {
                identity,
                arkServerUrl: request.arkServerUrl,
                arkServerPublicKey: request.arkServerPublicKey,
                storage: new IndexedDBStorageAdapter("wallet-db"),
            };

            // Create the wallet
            this.wallet = await DirectWallet.create(config);
            this.isInitialized = true;

            return this.createSuccessResponse(request.id, "INIT_SUCCESS", {});
        } catch (error) {
            return this.createErrorResponse(
                request.id,
                `Failed to initialize wallet: ${error}`
            );
        }
    }

    /**
     * Ensures the wallet is initialized before processing requests.
     */
    private ensureWalletInitialized(): void {
        if (!this.wallet || !this.isInitialized) {
            throw new Error("Wallet not initialized. Call INIT_WALLET first.");
        }
    }

    private async handleGetAddress(
        request: Request.GetAddress
    ): Promise<Response.Address> {
        this.ensureWalletInitialized();
        const address = await this.wallet!.getAddress();

        return {
            type: "ADDRESS",
            id: request.id,
            success: true,
            address,
        };
    }

    private async handleGetBoardingAddress(
        request: Request.GetBoardingAddress
    ): Promise<Response.BoardingAddress> {
        this.ensureWalletInitialized();
        const address = await this.wallet!.getBoardingAddress();

        return {
            type: "BOARDING_ADDRESS",
            id: request.id,
            success: true,
            address,
        };
    }

    private async handleGetBalance(
        request: Request.GetBalance
    ): Promise<Response.Balance> {
        this.ensureWalletInitialized();
        const balance = await this.wallet!.getBalance();

        return {
            type: "BALANCE",
            id: request.id,
            success: true,
            balance,
        };
    }

    private async handleGetVtxos(
        request: Request.GetVtxos
    ): Promise<Response.Vtxos> {
        this.ensureWalletInitialized();
        const vtxos = await this.wallet!.getVtxos(request.filter);

        return {
            type: "VTXOS",
            id: request.id,
            success: true,
            vtxos,
        };
    }

    private async handleGetBoardingUtxos(
        request: Request.GetBoardingUtxos
    ): Promise<Response.BoardingUtxos> {
        this.ensureWalletInitialized();
        const boardingUtxos = await this.wallet!.getBoardingUtxos();

        return {
            type: "BOARDING_UTXOS",
            id: request.id,
            success: true,
            boardingUtxos,
        };
    }

    private async handleGetTransactionHistory(
        request: Request.GetTransactionHistory
    ): Promise<Response.TransactionHistory> {
        this.ensureWalletInitialized();
        const transactions = await this.wallet!.getTransactionHistory();

        return {
            type: "TRANSACTION_HISTORY",
            id: request.id,
            success: true,
            transactions,
        };
    }

    private async handleSendBitcoin(
        request: Request.SendBitcoin
    ): Promise<Response.SendBitcoinSuccess> {
        this.ensureWalletInitialized();
        const txid = await this.wallet!.sendBitcoin(request.params);

        return {
            type: "SEND_BITCOIN_SUCCESS",
            id: request.id,
            success: true,
            txid,
        };
    }

    private async handleSettle(
        request: Request.Settle,
        event: ExtendableMessageEvent
    ): Promise<void> {
        try {
            this.ensureWalletInitialized();

            const txid = await this.wallet!.settle(
                request.params,
                (settlementEvent) => {
                    // Send settlement events back to the main thread
                    const response: Response.SettleEvent = {
                        type: "SETTLE_EVENT",
                        id: request.id,
                        success: true,
                        event: settlementEvent,
                    };

                    this.postMessageToClient(event, response);
                }
            );

            // Send final success response
            const successResponse: Response.SettleSuccess = {
                type: "SETTLE_SUCCESS",
                id: request.id,
                success: true,
                txid,
            };

            this.postMessageToClient(event, successResponse);
        } catch (error) {
            const errorResponse = this.createErrorResponse(
                request.id,
                `Settlement failed: ${error}`
            );
            this.postMessageToClient(event, errorResponse);
        }
    }

    private async handleGetXOnlyPublicKey(
        request: Request.GetXOnlyPublicKey
    ): Promise<Response.XOnlyPublicKey> {
        this.ensureWalletInitialized();
        const publicKey = await this.wallet!.identity.xOnlyPublicKey();

        return {
            type: "XONLY_PUBLIC_KEY",
            id: request.id,
            success: true,
            publicKey: Array.from(publicKey),
        };
    }

    private async handleSignTransaction(
        request: Request.SignTransaction
    ): Promise<Response.TransactionSigned> {
        this.ensureWalletInitialized();

        const { Transaction } = await import("@scure/btc-signer");
        const tx = Transaction.fromPSBT(new Uint8Array(request.transaction));
        const signedTx = await this.wallet!.identity.sign(
            tx,
            request.inputIndexes
        );

        return {
            type: "TRANSACTION_SIGNED",
            id: request.id,
            success: true,
            transaction: Array.from(signedTx.toPSBT()),
        };
    }

    private async handleClear(request: Request.Clear): Promise<Response.Base> {
        // Clear wallet state
        this.wallet = null;
        this.isInitialized = false;

        // Clear stored identity
        try {
            const storage = new IndexedDBStorageAdapter("wallet-identity");
            await storage.clear();
        } catch (error) {
            // Ignore clear errors
        }

        return this.createSuccessResponse(request.id, "CLEAR_SUCCESS", {});
    }

    private createSuccessResponse(
        id: string,
        type: string,
        data: any
    ): Response.Base {
        return {
            id,
            success: true,
            type,
            ...data,
        };
    }

    private createErrorResponse(id: string, message: string): Response.Error {
        return {
            type: "ERROR",
            id,
            success: false,
            message,
        };
    }

    private sendErrorResponse(
        event: ExtendableMessageEvent,
        message: string,
        id: string
    ): void {
        const errorResponse = this.createErrorResponse(id, message);
        this.postMessageToClient(event, errorResponse);
    }
}

// Initialize the service worker
new WalletServiceWorker();
