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
} from "..";
import { ReadonlyWallet, Wallet } from "../wallet";
import { Request } from "./request";
import { Response } from "./response";
import { ArkProvider, RestArkProvider } from "../../providers/ark";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { hex } from "@scure/base";
import { IndexedDBStorageAdapter } from "../../storage/indexedDB";
import {
    WalletRepository,
    WalletRepositoryImpl,
} from "../../repositories/walletRepository";
import { extendCoin, extendVirtualCoin } from "../utils";
import { DEFAULT_DB_NAME } from "./utils";
import {
    DelegatorProvider,
    RestDelegatorProvider,
} from "../../providers/delegator";
import { DelegatorManager } from "../delegator";

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

    async handleGetAssetDetails(
        ...args: Parameters<Wallet["assetManager"]["getAssetDetails"]>
    ) {
        return this.wallet.assetManager.getAssetDetails(...args);
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

    async handleIssue(
        ..._: Parameters<Wallet["assetManager"]["issue"]>
    ): Promise<
        Awaited<ReturnType<Wallet["assetManager"]["issue"]>> | undefined
    > {
        return undefined;
    }

    async handleReissue(
        ..._: Parameters<Wallet["assetManager"]["reissue"]>
    ): Promise<
        Awaited<ReturnType<Wallet["assetManager"]["reissue"]>> | undefined
    > {
        return undefined;
    }

    async handleBurn(
        ..._: Parameters<Wallet["assetManager"]["burn"]>
    ): Promise<
        Awaited<ReturnType<Wallet["assetManager"]["burn"]>> | undefined
    > {
        return undefined;
    }

    async handleSend(
        ..._: Parameters<Wallet["send"]>
    ): Promise<Awaited<ReturnType<Wallet["send"]>> | undefined> {
        return undefined;
    }

    async handleDelegate(): Promise<
        Awaited<ReturnType<DelegatorManager["delegate"]>> | undefined
    > {
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

    async handleIssue(...args: Parameters<Wallet["assetManager"]["issue"]>) {
        return this.wallet.assetManager.issue(...args);
    }

    async handleReissue(
        ...args: Parameters<Wallet["assetManager"]["reissue"]>
    ) {
        return this.wallet.assetManager.reissue(...args);
    }

    async handleBurn(...args: Parameters<Wallet["assetManager"]["burn"]>) {
        return this.wallet.assetManager.burn(...args);
    }

    async handleSend(...args: Parameters<Wallet["send"]>) {
        return this.wallet.send(...args);
    }

    async handleGetAssetDetails(
        ...args: Parameters<Wallet["assetManager"]["getAssetDetails"]>
    ) {
        return this.wallet.assetManager.getAssetDetails(...args);
    }

    async handleDelegate(): Promise<
        Awaited<ReturnType<DelegatorManager["delegate"]>> | undefined
    > {
        if (!this.wallet.delegatorManager) return;
        const spendableVtxos = (
            await this.wallet.getVtxos({ withRecoverable: true })
        ).filter(isSpendable);
        if (spendableVtxos.length === 0) return;
        return this.wallet.delegatorManager.delegate(
            spendableVtxos,
            await this.wallet.getAddress()
        );
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
    private walletRepository: WalletRepository;
    private storage: IndexedDBStorageAdapter;

    constructor(
        readonly dbName: string = DEFAULT_DB_NAME,
        readonly dbVersion: number = 1,
        private readonly messageCallback: (
            message: ExtendableMessageEvent
        ) => void = () => {}
    ) {
        this.storage = new IndexedDBStorageAdapter(dbName, dbVersion);
        this.walletRepository = new WalletRepositoryImpl(this.storage);
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

        // Clear storage - this replaces vtxoRepository.close()
        await this.storage.clear();

        // Reset in-memory caches by recreating the repository
        this.walletRepository = new WalletRepositoryImpl(this.storage);

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

                    // delegate vtxos
                    const result = await this.handler
                        ?.handleDelegate()
                        .catch((error) => {
                            console.error("Error delegating vtxos:", error);
                        });

                    if (result && result.delegated.length > 0) {
                        console.log(
                            `Delegated ${result.delegated.length} vtxos`
                        );
                    }
                    if (result && result.failed.length > 0) {
                        console.error(
                            `Failed to delegate ${result.failed.length} vtxos`
                        );
                    }
                }
                if (funds.type === "utxo") {
                    const utxos = funds.coins.map((utxo) =>
                        extendCoin(this.handler!, utxo)
                    );

                    const boardingAddress =
                        await this.handler?.getBoardingAddress()!;

                    // save utxos using unified repository
                    await this.walletRepository.clearUtxos(boardingAddress);
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

        // delegate vtxos
        await this.handler.handleDelegate().catch((error) => {
            console.error("Error delegating vtxos:", error);
        });
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
        const { arkServerPublicKey, arkServerUrl, delegatorUrl } = message;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);

        let delegatorProvider: DelegatorProvider | undefined;
        if (delegatorUrl) {
            delegatorProvider = new RestDelegatorProvider(delegatorUrl);
        }

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
                    storage: this.storage, // Use unified storage for wallet too
                    delegatorProvider,
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
                    storage: this.storage, // Use unified storage for wallet too
                    delegatorProvider,
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

            // aggregate asset balances from spendable vtxos
            const assetBalances = new Map<string, number>();
            for (const vtxo of [...spendableVtxos, ...sweptVtxos]) {
                if (!isSpendable(vtxo)) continue;
                if (vtxo.assets) {
                    for (const a of vtxo.assets) {
                        const current = assetBalances.get(a.assetId) ?? 0;
                        assetBalances.set(a.assetId, current + a.amount);
                    }
                }
            }
            const assets = Array.from(assetBalances.entries()).map(
                ([assetId, amount]) => ({ assetId, amount })
            );

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
                    assets,
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
            case "ISSUE": {
                await this.handleIssueMessage(event);
                break;
            }
            case "REISSUE": {
                await this.handleReissueMessage(event);
                break;
            }
            case "BURN": {
                await this.handleBurnMessage(event);
                break;
            }
            case "SEND": {
                await this.handleSendMessage(event);
                break;
            }
            case "GET_ASSET_DETAILS": {
                await this.handleGetAssetDetails(event);
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

    private async handleIssueMessage(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isIssue(message)) {
            console.error("Invalid ISSUE message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid ISSUE message format")
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
            const result = await this.handler.handleIssue(message.params);
            if (result === undefined) {
                event.source?.postMessage(
                    Response.error(
                        message.id,
                        "Asset issuance not supported for readonly wallet"
                    )
                );
                return;
            }
            event.source?.postMessage(
                Response.issueSuccess(message.id, result)
            );
        } catch (error: unknown) {
            console.error("Error issuing asset:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleReissueMessage(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isReissue(message)) {
            console.error("Invalid REISSUE message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid REISSUE message format")
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
            const txid = await this.handler.handleReissue(message.params);
            if (txid === undefined) {
                event.source?.postMessage(
                    Response.error(
                        message.id,
                        "Asset reissuance not supported for readonly wallet"
                    )
                );
                return;
            }
            event.source?.postMessage(
                Response.reissueSuccess(message.id, txid)
            );
        } catch (error: unknown) {
            console.error("Error reissuing asset:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleBurnMessage(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isBurn(message)) {
            console.error("Invalid BURN message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid BURN message format")
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
            const txid = await this.handler.handleBurn(message.params);
            if (txid === undefined) {
                event.source?.postMessage(
                    Response.error(
                        message.id,
                        "Asset burning not supported for readonly wallet"
                    )
                );
                return;
            }
            event.source?.postMessage(Response.burnSuccess(message.id, txid));
        } catch (error: unknown) {
            console.error("Error burning asset:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleSendMessage(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSend(message)) {
            console.error("Invalid SEND message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid SEND message format")
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
            const txid = await this.handler.handleSend(...message.recipients);
            if (txid === undefined) {
                event.source?.postMessage(
                    Response.error(
                        message.id,
                        "Asset sending not supported for readonly wallet"
                    )
                );
                return;
            }
            event.source?.postMessage(Response.sendSuccess(message.id, txid));
        } catch (error: unknown) {
            console.error("Error sending asset:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetAssetDetails(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetAssetDetails(message)) {
            console.error("Invalid GET_ASSET_DETAILS message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_ASSET_DETAILS message format"
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
            const assetDetails = await this.handler.handleGetAssetDetails(
                message.assetId
            );
            event.source?.postMessage(
                Response.assetDetails(message.id, assetDetails)
            );
        } catch (error: unknown) {
            console.error("Error getting asset details:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }
}
