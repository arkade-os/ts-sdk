/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { SingleKey } from "../../identity/singleKey";
import { ExtendedVirtualCoin, isSpendable, isSubdust } from "..";
import { Wallet } from "../wallet";
import { Request } from "./request";
import { Response } from "./response";
import { ArkProvider, RestArkProvider } from "../../providers/ark";
import { vtxosToTxs } from "../../utils/transactionHistory";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { hex } from "@scure/base";
import { IndexedDBStorageAdapter } from "../../storage/indexedDB";
import {
    WalletRepository,
    WalletRepositoryImpl,
} from "../../repositories/walletRepository";
import { extendVirtualCoin } from "./utils";

/**
 * Worker is a class letting to interact with ServiceWorkerWallet from the client
 * it aims to be run in a service worker context
 */
export class Worker {
    private wallet: Wallet | undefined;
    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private incomingFundsSubscription: (() => void) | undefined;
    private walletRepository: WalletRepository;
    private storage: IndexedDBStorageAdapter;

    constructor(
        private readonly messageCallback: (
            message: ExtendableMessageEvent
        ) => void = () => {}
    ) {
        this.storage = new IndexedDBStorageAdapter("arkade-service-worker", 1);
        this.walletRepository = new WalletRepositoryImpl(this.storage);
    }

    /**
     * Get spendable vtxos for the current wallet address
     */
    private async getSpendableVtxos() {
        if (!this.wallet) return [];
        const address = await this.wallet.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);
        return allVtxos.filter(isSpendable);
    }

    /**
     * Get swept vtxos for the current wallet address
     */
    private async getSweptVtxos() {
        if (!this.wallet) return [];
        const address = await this.wallet.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);
        return allVtxos.filter(
            (vtxo) => vtxo.virtualStatus.state === "swept" && isSpendable(vtxo)
        );
    }

    /**
     * Get all vtxos categorized by type
     */
    private async getAllVtxos() {
        if (!this.wallet) return { spendable: [], spent: [] };
        const address = await this.wallet.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);

        return {
            spendable: allVtxos.filter(isSpendable),
            spent: allVtxos.filter((vtxo) => !isSpendable(vtxo)),
        };
    }

    async start(withServiceWorkerUpdate = true) {
        self.addEventListener(
            "message",
            async (event: ExtendableMessageEvent) => {
                await this.handleMessage(event);
            }
        );
        if (withServiceWorkerUpdate) {
            // activate service worker immediately
            self.addEventListener("install", () => {
                self.skipWaiting();
            });
            // take control of clients immediately
            self.addEventListener("activate", () => {
                self.clients.claim();
            });
        }
    }

    async clear() {
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // Clear storage - this replaces vtxoRepository.close()
        await this.storage.clear();

        this.wallet = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
    }

    async reload() {
        await this.onWalletInitialized();
    }

    private async onWalletInitialized() {
        if (
            !this.wallet ||
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.wallet.offchainTapscript ||
            !this.wallet.boardingTapscript
        ) {
            return;
        }

        // Get public key script and set the initial vtxos state
        const script = hex.encode(this.wallet.offchainTapscript.pkScript);
        const response = await this.indexerProvider.getVtxos({
            scripts: [script],
        });
        const vtxos = response.vtxos.map((vtxo) =>
            extendVirtualCoin(this.wallet!, vtxo)
        ) as ExtendedVirtualCoin[];

        // Get wallet address and save vtxos using unified repository
        const address = await this.wallet.getAddress();
        await this.walletRepository.saveVtxos(address, vtxos);

        // Get transaction history to cache boarding txs
        const txs = await this.wallet.getTransactionHistory();
        if (txs) await this.walletRepository.saveTransactions(address, txs);

        // stop previous subscriptions if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // subscribe for incoming funds and notify all clients when new funds arrive
        this.incomingFundsSubscription = await this.wallet.notifyIncomingFunds(
            async (funds) => {
                if (funds.type === "vtxo" && funds.vtxos.length > 0) {
                    // extend vtxos with taproot scripts
                    const extendedVtxos = funds.vtxos.map((vtxo) =>
                        extendVirtualCoin(this.wallet!, vtxo)
                    );

                    // save vtxos using unified repository
                    await this.walletRepository.saveVtxos(
                        address,
                        funds.vtxos.map((vtxo) =>
                            extendVirtualCoin(this.wallet!, vtxo)
                        )
                    );

                    // notify all clients about the vtxo update
                    this.sendMessageToAllClients(
                        "VTXO_UPDATE",
                        JSON.stringify(extendedVtxos)
                    );
                }
                if (funds.type === "utxo" && funds.coins.length > 0) {
                    // notify all clients about the utxo update
                    this.sendMessageToAllClients(
                        "UTXO_UPDATE",
                        JSON.stringify(funds.coins)
                    );
                }
            }
        );
    }

    private async handleClear(event: ExtendableMessageEvent) {
        await this.clear();
        if (Request.isBase(event.data)) {
            event.source?.postMessage(
                Response.clearResponse(event.data.id, true)
            );
        }
    }

    private async handleInitWallet(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isInitWallet(message)) {
            console.error("Invalid INIT_WALLET message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid INIT_WALLET message format")
            );
            return;
        }

        if (!message.privateKey) {
            const err = "Missing privateKey";
            event.source?.postMessage(Response.error(message.id, err));
            console.error(err);
            return;
        }

        try {
            const { arkServerPublicKey, arkServerUrl, privateKey } = message;
            const identity = SingleKey.fromHex(privateKey);
            this.arkProvider = new RestArkProvider(arkServerUrl);
            this.indexerProvider = new RestIndexerProvider(arkServerUrl);

            this.wallet = await Wallet.create({
                identity,
                arkServerUrl,
                arkServerPublicKey,
                storage: this.storage, // Use unified storage for wallet too
            });

            event.source?.postMessage(Response.walletInitialized(message.id));
            await this.onWalletInitialized();
        } catch (error: unknown) {
            console.error("Error initializing wallet:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleSettle(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSettle(message)) {
            console.error("Invalid SETTLE message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid SETTLE message format")
            );
            return;
        }

        try {
            if (!this.wallet) {
                console.error("Wallet not initialized");
                event.source?.postMessage(
                    Response.error(message.id, "Wallet not initialized")
                );
                return;
            }

            const txid = await this.wallet.settle(message.params, (e) => {
                event.source?.postMessage(Response.settleEvent(message.id, e));
            });

            event.source?.postMessage(Response.settleSuccess(message.id, txid));
        } catch (error: unknown) {
            console.error("Error settling:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleSendBitcoin(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSendBitcoin(message)) {
            console.error("Invalid SEND_BITCOIN message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid SEND_BITCOIN message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const txid = await this.wallet.sendBitcoin(message.params);
            event.source?.postMessage(
                Response.sendBitcoinSuccess(message.id, txid)
            );
        } catch (error: unknown) {
            console.error("Error sending bitcoin:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetAddress(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetAddress(message)) {
            console.error("Invalid GET_ADDRESS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_ADDRESS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const address = await this.wallet.getAddress();
            event.source?.postMessage(Response.address(message.id, address));
        } catch (error: unknown) {
            console.error("Error getting address:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetBoardingAddress(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBoardingAddress(message)) {
            console.error(
                "Invalid GET_BOARDING_ADDRESS message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_BOARDING_ADDRESS message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const address = await this.wallet.getBoardingAddress();
            event.source?.postMessage(
                Response.boardingAddress(message.id, address)
            );
        } catch (error: unknown) {
            console.error("Error getting boarding address:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetBalance(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBalance(message)) {
            console.error("Invalid GET_BALANCE message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_BALANCE message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const [boardingUtxos, spendableVtxos, sweptVtxos] =
                await Promise.all([
                    this.wallet.getBoardingUtxos(),
                    this.getSpendableVtxos(),
                    this.getSweptVtxos(),
                ]);

            // boarding
            let confirmed = 0;
            let unconfirmed = 0;
            for (const utxo of boardingUtxos) {
                if (utxo.status.confirmed) {
                    confirmed += utxo.value;
                } else {
                    unconfirmed += utxo.value;
                }
            }

            // offchain
            let settled = 0;
            let preconfirmed = 0;
            let recoverable = 0;
            for (const vtxo of spendableVtxos) {
                if (vtxo.virtualStatus.state === "settled") {
                    settled += vtxo.value;
                } else if (vtxo.virtualStatus.state === "preconfirmed") {
                    preconfirmed += vtxo.value;
                }
            }
            for (const vtxo of sweptVtxos) {
                if (isSpendable(vtxo)) {
                    recoverable += vtxo.value;
                }
            }

            const totalBoarding = confirmed + unconfirmed;
            const totalOffchain = settled + preconfirmed + recoverable;

            event.source?.postMessage(
                Response.balance(message.id, {
                    boarding: {
                        confirmed,
                        unconfirmed,
                        total: totalBoarding,
                    },
                    settled,
                    preconfirmed,
                    available: settled + preconfirmed,
                    recoverable,
                    total: totalBoarding + totalOffchain,
                })
            );
        } catch (error: unknown) {
            console.error("Error getting balance:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetVtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetVtxos(message)) {
            console.error("Invalid GET_VTXOS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_VTXOS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            let vtxos = await this.getSpendableVtxos();
            if (!message.filter?.withRecoverable) {
                if (!this.wallet) throw new Error("Wallet not initialized");
                // exclude subdust is we don't want recoverable
                vtxos = vtxos.filter(
                    (v: any) => !isSubdust(v, this.wallet!.dustAmount!)
                );
            }

            if (message.filter?.withRecoverable) {
                // get also swept and spendable vtxos
                const sweptVtxos = await this.getSweptVtxos();
                vtxos.push(...sweptVtxos.filter(isSpendable));
            }
            event.source?.postMessage(Response.vtxos(message.id, vtxos));
        } catch (error: unknown) {
            console.error("Error getting vtxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetBoardingUtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBoardingUtxos(message)) {
            console.error("Invalid GET_BOARDING_UTXOS message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_BOARDING_UTXOS message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const boardingUtxos = await this.wallet.getBoardingUtxos();
            event.source?.postMessage(
                Response.boardingUtxos(message.id, boardingUtxos)
            );
        } catch (error: unknown) {
            console.error("Error getting boarding utxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetTransactionHistory(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetTransactionHistory(message)) {
            console.error(
                "Invalid GET_TRANSACTION_HISTORY message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_TRANSACTION_HISTORY message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const { boardingTxs, commitmentsToIgnore: roundsToIgnore } =
                await this.wallet.getBoardingTxs();

            const { spendable, spent } = await this.getAllVtxos();

            // convert VTXOs to offchain transactions
            const offchainTxs = vtxosToTxs(spendable, spent, roundsToIgnore);

            const txs = [...boardingTxs, ...offchainTxs];

            // sort transactions by creation time in descending order (newest first)
            txs.sort(
                // place createdAt = 0 (unconfirmed txs) first, then descending
                (a, b) => {
                    if (a.createdAt === 0) return -1;
                    if (b.createdAt === 0) return 1;
                    return b.createdAt - a.createdAt;
                }
            );

            event.source?.postMessage(
                Response.transactionHistory(message.id, txs)
            );
        } catch (error: unknown) {
            console.error("Error getting transaction history:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetStatus(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetStatus(message)) {
            console.error("Invalid GET_STATUS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_STATUS message format")
            );
            return;
        }

        const pubKey = this.wallet
            ? await this.wallet.identity.xOnlyPublicKey()
            : undefined;
        event.source?.postMessage(
            Response.walletStatus(message.id, this.wallet !== undefined, pubKey)
        );
    }

    private async handleMessage(event: ExtendableMessageEvent) {
        this.messageCallback(event);
        const message = event.data;
        if (!Request.isBase(message)) {
            console.warn("Invalid message format", JSON.stringify(message));
            // ignore invalid messages
            return;
        }

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
            case "GET_BOARDING_ADDRESS": {
                await this.handleGetBoardingAddress(event);
                break;
            }
            case "GET_BALANCE": {
                await this.handleGetBalance(event);
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
            case "CLEAR": {
                await this.handleClear(event);
                break;
            }
            default:
                event.source?.postMessage(
                    Response.error(message.id, "Unknown message type")
                );
        }
    }

    private async sendMessageToAllClients(type: string, message: any) {
        self.clients
            .matchAll({ includeUncontrolled: true, type: "window" })
            .then((clients) => {
                clients.forEach((client) => {
                    client.postMessage({
                        type,
                        message,
                    });
                });
            });
    }
}
