/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

import { ReadonlySingleKey, SingleKey } from "../../identity/singleKey";
import {
    ExtendedCoin,
    ExtendedVirtualCoin,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    StorageConfig,
} from "..";
import { ReadonlyWallet, Wallet } from "../wallet";
import { Request } from "./request";
import { Response } from "./response";
import { ArkProvider, RestArkProvider } from "../../providers/ark";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { hex } from "@scure/base";
import { WalletRepository } from "../../repositories/walletRepository";
import { extendCoin, extendVirtualCoin } from "../utils";
import { ContractRepository } from "../../repositories/contractRepository";

class ReadonlyHandler {
    constructor(protected readonly wallet: ReadonlyWallet) {}

    get offchainTapscript() {
        return this.wallet.offchainTapscript;
    }
    get boardingTapscript() {
        return this.wallet.boardingTapscript;
    }
    get onchainProvider() {
        return this.wallet.onchainProvider;
    }
    get dustAmount() {
        return this.wallet.dustAmount;
    }
    get identity() {
        return this.wallet.identity;
    }

    notifyIncomingFunds(
        ...args: Parameters<ReadonlyWallet["notifyIncomingFunds"]>
    ) {
        return this.wallet.notifyIncomingFunds(...args);
    }

    getAddress() {
        return this.wallet.getAddress();
    }

    getBoardingAddress() {
        return this.wallet.getBoardingAddress();
    }

    getTransactionHistory() {
        return this.wallet.getTransactionHistory();
    }

    getContractManager() {
        return this.wallet.getContractManager();
    }

    async handleReload(
        _: ExtendedVirtualCoin[]
    ): Promise<Awaited<ReturnType<Wallet["finalizePendingTxs"]>>> {
        const pending = await this.wallet.fetchPendingTxs();
        return { pending, finalized: [] };
    }

    async handleSettle(
        ..._: Parameters<Wallet["settle"]>
    ): Promise<Awaited<ReturnType<Wallet["settle"]>> | undefined> {
        return undefined;
    }

    async handleSendBitcoin(
        ..._: Parameters<Wallet["sendBitcoin"]>
    ): Promise<Awaited<ReturnType<Wallet["sendBitcoin"]>> | undefined> {
        return undefined;
    }
}

class Handler extends ReadonlyHandler {
    constructor(protected readonly wallet: Wallet) {
        super(wallet);
    }

    async handleReload(vtxos: ExtendedVirtualCoin[]) {
        return this.wallet.finalizePendingTxs(
            vtxos.filter(
                (vtxo) =>
                    vtxo.virtualStatus.state !== "swept" &&
                    vtxo.virtualStatus.state !== "settled"
            )
        );
    }

    async handleSettle(...args: Parameters<Wallet["settle"]>) {
        return this.wallet.settle(...args);
    }

    async handleSendBitcoin(
        ...args: Parameters<Wallet["sendBitcoin"]>
    ): Promise<Awaited<ReturnType<Wallet["sendBitcoin"]>> | undefined> {
        return this.wallet.sendBitcoin(...args);
    }
}

/**
 * Worker is a class letting to interact with ServiceWorkerWallet and ServiceWorkerReadonlyWallet from
 * the client; it aims to be run in a service worker context.
 *
 * The messages requiring a Wallet rather than a ReadonlyWallet result in no-op
 * without errors.
 */
export class Worker {
    private handler: ReadonlyHandler | undefined;
    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private incomingFundsSubscription: (() => void) | undefined;
    private contractEventsSubscription: (() => void) | undefined;
    private walletRepository: WalletRepository;
    private contractRepository: ContractRepository;

    constructor(
        storage: StorageConfig,
        private readonly messageCallback: (
            message: ExtendableMessageEvent
        ) => void = () => {}
    ) {
        this.walletRepository = storage.walletRepository;
        this.contractRepository = storage.contractRepository;
    }

    /**
     * Get spendable vtxos for the current wallet address
     */
    private async getSpendableVtxos() {
        if (!this.handler) return [];
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);
        return allVtxos.filter(isSpendable);
    }

    /**
     * Get swept vtxos for the current wallet address
     */
    private async getSweptVtxos() {
        if (!this.handler) return [];
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);
        return allVtxos.filter((vtxo) => vtxo.virtualStatus.state === "swept");
    }

    /**
     * Get all vtxos categorized by type
     */
    private async getAllVtxos() {
        if (!this.handler) return { spendable: [], spent: [] };
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);

        return {
            spendable: allVtxos.filter(isSpendable),
            spent: allVtxos.filter((vtxo) => !isSpendable(vtxo)),
        };
    }

    /**
     * Get all boarding utxos from wallet repository
     */
    private async getAllBoardingUtxos(): Promise<ExtendedCoin[]> {
        if (!this.handler) return [];
        const address = await this.handler.getBoardingAddress();

        return await this.walletRepository.getUtxos(address);
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
        if (this.contractEventsSubscription) {
            this.contractEventsSubscription();
            this.contractEventsSubscription = undefined;
        }

        this.handler = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
    }

    async reload() {
        await this.onWalletInitialized();
    }

    private async onWalletInitialized() {
        if (
            !this.handler ||
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.handler.offchainTapscript ||
            !this.handler.boardingTapscript
        ) {
            return;
        }

        // Get public key script and set the initial vtxos state
        const script = hex.encode(this.handler.offchainTapscript.pkScript);
        const response = await this.indexerProvider.getVtxos({
            scripts: [script],
        });
        const vtxos = response.vtxos.map((vtxo) =>
            extendVirtualCoin(this.handler!, vtxo)
        );

        try {
            // recover pending transactions if possible
            const { pending, finalized } =
                await this.handler.handleReload(vtxos);
            console.info(
                `Recovered ${finalized.length}/${pending.length} pending transactions: ${finalized.join(", ")}`
            );
        } catch (error: unknown) {
            console.error("Error recovering pending transactions:", error);
        }

        // Get wallet address and save vtxos using unified repository
        const address = await this.handler.getAddress();
        await this.walletRepository.saveVtxos(address, vtxos);

        // Fetch boarding utxos and save using unified repository
        const boardingAddress = await this.handler.getBoardingAddress();
        const coins =
            await this.handler.onchainProvider.getCoins(boardingAddress);
        await this.walletRepository.saveUtxos(
            boardingAddress,
            coins.map((utxo) => extendCoin(this.handler!, utxo))
        );

        // Get transaction history to cache boarding txs
        const txs = await this.handler.getTransactionHistory();
        if (txs) await this.walletRepository.saveTransactions(address, txs);

        // unsubscribe previous subscription if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // subscribe for incoming funds and notify all clients when new funds arrive
        this.incomingFundsSubscription = await this.handler.notifyIncomingFunds(
            async (funds) => {
                if (funds.type === "vtxo") {
                    const newVtxos =
                        funds.newVtxos.length > 0
                            ? funds.newVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.handler!, vtxo)
                              )
                            : [];
                    const spentVtxos =
                        funds.spentVtxos.length > 0
                            ? funds.spentVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.handler!, vtxo)
                              )
                            : [];

                    if ([...newVtxos, ...spentVtxos].length === 0) return;

                    // save vtxos using unified repository
                    await this.walletRepository.saveVtxos(address, [
                        ...newVtxos,
                        ...spentVtxos,
                    ]);

                    // notify all clients about the vtxo update
                    await this.sendMessageToAllClients(
                        Response.vtxoUpdate(newVtxos, spentVtxos)
                    );
                }
                if (funds.type === "utxo") {
                    const utxos = funds.coins.map((utxo) =>
                        extendCoin(this.handler!, utxo)
                    );

                    const boardingAddress =
                        await this.handler?.getBoardingAddress()!;

                    // save utxos using unified repository
                    await this.walletRepository.deleteUtxos(boardingAddress);
                    await this.walletRepository.saveUtxos(
                        boardingAddress,
                        utxos
                    );

                    // notify all clients about the utxo update
                    await this.sendMessageToAllClients(
                        Response.utxoUpdate(utxos)
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
        if (!Request.isInitWallet(event.data)) {
            console.error("Invalid INIT_WALLET message format", event.data);
            event.source?.postMessage(
                Response.error(
                    event.data.id,
                    "Invalid INIT_WALLET message format"
                )
            );
            return;
        }

        const message = event.data;
        const { arkServerPublicKey, arkServerUrl } = message;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);

        try {
            if (
                "privateKey" in message.key &&
                typeof message.key.privateKey === "string"
            ) {
                const {
                    key: { privateKey },
                } = message;
                const identity = SingleKey.fromHex(privateKey);
                const wallet = await Wallet.create({
                    identity,
                    arkServerUrl,
                    arkServerPublicKey,
                    storage: {
                        walletRepository: this.walletRepository,
                        contractRepository: this.contractRepository,
                    },
                });
                this.handler = new Handler(wallet);
            } else if (
                "publicKey" in message.key &&
                typeof message.key.publicKey === "string"
            ) {
                const {
                    key: { publicKey },
                } = message;
                const identity = ReadonlySingleKey.fromPublicKey(
                    hex.decode(publicKey)
                );
                const wallet = await ReadonlyWallet.create({
                    identity,
                    arkServerUrl,
                    arkServerPublicKey,
                    storage: {
                        walletRepository: this.walletRepository,
                        contractRepository: this.contractRepository,
                    },
                });
                this.handler = new ReadonlyHandler(wallet);
            } else {
                const err = "Missing privateKey or publicKey in key object";
                event.source?.postMessage(Response.error(message.id, err));
                console.error(err);
                return;
            }
        } catch (error: unknown) {
            console.error("Error initializing wallet:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
            return;
        }

        event.source?.postMessage(Response.walletInitialized(message.id));
        await this.onWalletInitialized();
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
            if (!this.handler) {
                console.error("Wallet not initialized");
                event.source?.postMessage(
                    Response.error(message.id, "Wallet not initialized")
                );
                return;
            }

            const txid = await this.handler.handleSettle(
                message.params,
                (e) => {
                    event.source?.postMessage(
                        Response.settleEvent(message.id, e)
                    );
                }
            );

            if (txid) {
                event.source?.postMessage(
                    Response.settleSuccess(message.id, txid)
                );
            } else {
                event.source?.postMessage(
                    Response.error(
                        message.id,
                        "Operation not supported in readonly mode"
                    )
                );
            }
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const txid = await this.handler.handleSendBitcoin(message.params);
            if (txid) {
                event.source?.postMessage(
                    Response.sendBitcoinSuccess(message.id, txid)
                );
            } else {
                event.source?.postMessage(
                    Response.error(
                        message.id,
                        "Operation not supported in readonly mode"
                    )
                );
            }
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const address = await this.handler.getAddress();
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const address = await this.handler.getBoardingAddress();
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const [boardingUtxos, spendableVtxos, sweptVtxos] =
                await Promise.all([
                    this.getAllBoardingUtxos(),
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const vtxos = await this.getSpendableVtxos();
            const dustAmount = this.handler.dustAmount;
            const includeRecoverable = message.filter?.withRecoverable ?? false;

            const filteredVtxos = includeRecoverable
                ? vtxos
                : vtxos.filter((v) => {
                      if (dustAmount != null && isSubdust(v, dustAmount)) {
                          return false;
                      }
                      if (isRecoverable(v)) {
                          return false;
                      }
                      if (isExpired(v)) {
                          return false;
                      }
                      return true;
                  });

            event.source?.postMessage(
                Response.vtxos(message.id, filteredVtxos)
            );
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const boardingUtxos = await this.getAllBoardingUtxos();
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

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const txs = await this.handler.getTransactionHistory();
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

        const pubKey = this.handler
            ? await this.handler.identity.xOnlyPublicKey()
            : undefined;
        event.source?.postMessage(
            Response.walletStatus(
                message.id,
                this.handler !== undefined,
                pubKey
            )
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
            case "RELOAD_WALLET": {
                await this.handleReloadWallet(event);
                break;
            }

            // Contract Manager events
            case "CREATE_CONTRACT": {
                await this.handleCreateContract(event);
                break;
            }
            case "GET_CONTRACTS": {
                await this.handleGetContracts(event);
                break;
            }
            case "GET_CONTRACTS_WITH_VTXOS": {
                await this.handleGetContractsWithVtxos(event);
                break;
            }
            case "UPDATE_CONTRACT": {
                await this.handleUpdateContract(event);
                break;
            }
            case "DELETE_CONTRACT": {
                await this.handleDeleteContract(event);
                break;
            }
            case "GET_SPENDABLE_PATHS": {
                await this.handleGetSpendablePaths(event);
                break;
            }
            case "GET_ALL_SPENDING_PATHS": {
                await this.handleGetAllSpendingPaths(event);
                break;
            }
            case "IS_CONTRACT_MANAGER_WATCHING": {
                await this.handleIsContractManagerWatching(event);
                break;
            }
            case "SUBSCRIBE_CONTRACT_EVENTS": {
                await this.handleSubscribeContractEvents(event);
                break;
            }
            case "UNSUBSCRIBE_CONTRACT_EVENTS": {
                await this.handleUnsubscribeContractEvents(event);
                break;
            }

            default:
                event.source?.postMessage(
                    Response.error(message.id, "Unknown message type")
                );
        }
    }

    private async sendMessageToAllClients(message: any) {
        self.clients
            .matchAll({ includeUncontrolled: true, type: "window" })
            .then((clients) => {
                clients.forEach((client) => {
                    client.postMessage(message);
                });
            });
    }

    private async handleReloadWallet(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isReloadWallet(message)) {
            console.error("Invalid RELOAD_WALLET message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid RELOAD_WALLET message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.walletReloaded(message.id, false)
            );
            return;
        }

        try {
            await this.onWalletInitialized();
            event.source?.postMessage(
                Response.walletReloaded(message.id, true)
            );
        } catch (error: unknown) {
            console.error("Error reloading wallet:", error);
            event.source?.postMessage(
                Response.walletReloaded(message.id, false)
            );
        }
    }

    // =====================================================================
    // Contract Manager handlers
    // =====================================================================

    private async handleCreateContract(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isCreateContract(message)) {
            console.error("Invalid CREATE_CONTRACT message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid CREATE_CONTRACT message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const contract = await manager.createContract(message.params);
            event.source?.postMessage(
                Response.contractCreated(message.id, contract)
            );
        } catch (error: unknown) {
            console.error("Error creating contract:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetContracts(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetContracts(message)) {
            console.error("Invalid GET_CONTRACTS message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_CONTRACTS message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const contracts = await manager.getContracts(message.filter);
            event.source?.postMessage(
                Response.contracts(message.id, contracts)
            );
        } catch (error: unknown) {
            console.error("Error getting contracts:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetContractsWithVtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetContractsVtxos(message)) {
            console.error(
                "Invalid GET_CONTRACTS_WITH_VTXOS message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_CONTRACTS_WITH_VTXOS message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const contracts = await manager.getContractsWithVtxos(
                message.filter
            );
            event.source?.postMessage(
                Response.contractsWithVtxos(message.id, contracts)
            );
        } catch (error: unknown) {
            console.error("Error getting contracts with vtxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleUpdateContract(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isUpdateContract(message)) {
            console.error("Invalid UPDATE_CONTRACT message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid UPDATE_CONTRACT message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const contract = await manager.updateContract(
                message.contractScript,
                message.updates
            );
            event.source?.postMessage(
                Response.contractUpdated(message.id, contract)
            );
        } catch (error: unknown) {
            console.error("Error updating contract:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleDeleteContract(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isDeleteContract(message)) {
            console.error("Invalid DELETE_CONTRACT message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid DELETE_CONTRACT message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            await manager.deleteContract(message.contractScript);
            event.source?.postMessage(Response.contractDeleted(message.id));
        } catch (error: unknown) {
            console.error("Error deleting contract:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetSpendablePaths(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetSpendablePaths(message)) {
            console.error(
                "Invalid GET_SPENDABLE_PATHS message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_SPENDABLE_PATHS message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const paths = await manager.getSpendablePaths(message.options);
            event.source?.postMessage(
                Response.spendablePaths(message.id, paths)
            );
        } catch (error: unknown) {
            console.error("Error getting spendable paths:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetAllSpendingPaths(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetAllSpendingPaths(message)) {
            console.error(
                "Invalid GET_ALL_SPENDING_PATHS message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_ALL_SPENDING_PATHS message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const paths = await manager.getAllSpendingPaths(message.options);
            event.source?.postMessage(
                Response.allSpendingPaths(message.id, paths)
            );
        } catch (error: unknown) {
            console.error("Error getting all spending paths:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleIsContractManagerWatching(
        event: ExtendableMessageEvent
    ) {
        const message = event.data;
        if (!Request.isIsContractWatching(message)) {
            console.error(
                "Invalid IS_CONTRACT_MANAGER_WATCHING message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid IS_CONTRACT_MANAGER_WATCHING message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            const isWatching = await manager.isWatching();
            event.source?.postMessage(
                Response.contractWatching(message.id, isWatching)
            );
        } catch (error: unknown) {
            console.error("Error checking contract manager state:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleSubscribeContractEvents(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSubscribeContractEvents(message)) {
            console.error(
                "Invalid SUBSCRIBE_CONTRACT_EVENTS message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid SUBSCRIBE_CONTRACT_EVENTS message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const manager = await this.handler.getContractManager();
            if (this.contractEventsSubscription) {
                this.contractEventsSubscription();
            }
            this.contractEventsSubscription = manager.onContractEvent(
                (contractEvent) => {
                    this.sendMessageToAllClients(
                        Response.contractEvent(contractEvent)
                    );
                }
            );
            event.source?.postMessage(
                Response.contractEventsSubscribed(message.id)
            );
        } catch (error: unknown) {
            console.error("Error subscribing to contract events:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleUnsubscribeContractEvents(
        event: ExtendableMessageEvent
    ) {
        const message = event.data;
        if (!Request.isUnsubscribeContractEvents(message)) {
            console.error(
                "Invalid UNSUBSCRIBE_CONTRACT_EVENTS message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid UNSUBSCRIBE_CONTRACT_EVENTS message format"
                )
            );
            return;
        }

        if (!this.handler) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            if (this.contractEventsSubscription) {
                this.contractEventsSubscription();
                this.contractEventsSubscription = undefined;
            }
            event.source?.postMessage(
                Response.contractEventsUnsubscribed(message.id)
            );
        } catch (error: unknown) {
            console.error("Error unsubscribing from contract events:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }
}
