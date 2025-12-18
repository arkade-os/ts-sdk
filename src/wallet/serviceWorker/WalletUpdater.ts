import { ArkProvider, RestArkProvider } from "../../providers/ark";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { WalletRepository, WalletRepositoryImpl } from "../../repositories";
import { IndexedDBStorageAdapter } from "../../storage/indexedDB";
import { Handler, ReadonlyHandler } from "./worker";
import { DEFAULT_DB_NAME } from "./utils";
import { Response } from "./response";
import {
    ArkTransaction,
    ExtendedCoin,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
} from "../index";
import { Request } from "./request";
import { ReadonlySingleKey, SingleKey } from "../../identity";
import { ReadonlyWallet, Wallet } from "../wallet";
import { hex } from "@scure/base";
import { extendCoin, extendVirtualCoin } from "../utils";
import { vtxosToTxs } from "../../utils/transactionHistory";

// Generic
export type RequestEnvelope<T, U> = {
    type: T;
    id: string;
    payload: U;
};
export type ResponseEnvelope<T, U> = {
    type: T;
    id?: string;
    error?: Error;
    broadcast?: boolean;
    payload?: U;
};
export interface IUpdater<M = string, MP = unknown, R = string, RP = unknown> {
    readonly messagePrefix: string;

    /** Called once when the SW starts */
    // TODO: paramteric start?
    // start(
    //     message: RequestEnvelope<M, MP>
    // ): Promise<ResponseEnvelope<R, RP> | null>;
    start(): Promise<void>;

    /** Called once when the SW is shutting down */
    stop(): Promise<void>;

    /** Called periodically by the Worker */
    tick(now: number): Promise<ResponseEnvelope<R, RP>[]>;

    /** Handle routed messages */
    handleMessage(
        message: RequestEnvelope<M, MP>
    ): Promise<ResponseEnvelope<R, RP> | null>;
}

// WalletUpdater
type WalletUpdaterMessage = RequestEnvelope<
    Request.Type,
    | Request.Settle
    | Request.GetAddress
    | Request.GetBoardingAddress
    | Request.SendBitcoin
    | Request.InitWallet
    | Request.GetBalance
    | Request.Clear
    | Request.GetVirtualCoins
>;
type WalletUpdaterResponse = ResponseEnvelope<
    Response.Type,
    | Response.SettleEvent
    | Response.ClearResponse
    | Response.WalletStatus
    | Response.Balance
    | Response.VtxoUpdate
    | Response.UtxoUpdate
    | Response.SendBitcoinSuccess
    | Response.Base
>;
export class WalletUpdater
    implements
        IUpdater<
            WalletUpdaterMessage["type"],
            WalletUpdaterMessage["payload"],
            WalletUpdaterResponse["type"],
            WalletUpdaterResponse["payload"]
        >
{
    static messagePrefix = "WalletUpdater";
    readonly messagePrefix = WalletUpdater.messagePrefix;

    private handler: ReadonlyHandler | undefined;
    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private incomingFundsSubscription: (() => void) | undefined;
    private walletRepository: WalletRepository;
    private storage: IndexedDBStorageAdapter;
    private onNextTick: (() => WalletUpdaterResponse | null)[] = [];

    constructor(
        readonly dbName: string = DEFAULT_DB_NAME,
        readonly dbVersion: number = 1
    ) {
        this.storage = new IndexedDBStorageAdapter(dbName, dbVersion);
        this.walletRepository = new WalletRepositoryImpl(this.storage);
    }

    // lifecycle methods
    async start() {
        // TODO: load config from storage/db
    }

    async stop() {
        // optional cleanup and persistence
    }

    async tick(now: number) {
        const results = await Promise.allSettled(
            this.onNextTick.map((fn) => fn())
        );
        this.onNextTick = [];
        return results
            .map((result) => {
                if (result.status === "fulfilled") {
                    return result.value;
                } else {
                    console.error(
                        `[${WalletUpdater.messagePrefix}] tick failed`,
                        result.reason
                    );
                    // TODO: how to deliver errors down the stream? a broadcast?
                    return null;
                }
            })
            .filter((response) => response !== null);
    }

    private scheduleForNextTick(callback: () => WalletUpdaterResponse | null) {
        this.onNextTick.push(callback);
    }

    async handleMessage(
        message: WalletUpdaterMessage
    ): Promise<WalletUpdaterResponse | null> {
        if (message.type === "INIT_WALLET") {
            await this.handleInitWallet(message.payload as Request.InitWallet);
            const payload = Response.walletInitialized(message.id);
            return { id: message.id, type: payload.type, payload };
        }
        if (!this.handler) {
            return Response.error(message.id, "Handler not initialized");
        }
        switch (message.type) {
            case "SETTLE": {
                const payload = await this.handleSettle(
                    message.payload as Request.Settle
                );
                if (payload)
                    return { id: message.id, type: payload.type, payload };
                return null;
            }
            case "SEND_BITCOIN": {
                const payload = await this.handleSendBitcoin(
                    message.payload as Request.SendBitcoin
                );
                if (payload)
                    return { id: message.id, type: payload.type, payload };
                return null;
            }
            case "GET_ADDRESS": {
                const address = await this.handler.getAddress();
                const payload = Response.address(message.id, address);
                return { id: message.id, type: payload.type, payload };
            }
            case "GET_BOARDING_ADDRESS": {
                const address = await this.handler.getBoardingAddress();
                const payload = Response.boardingAddress(message.id, address);
                return { id: message.id, type: payload.type, payload };
            }
            case "GET_BALANCE": {
                const address = await this.handler.getAddress();
                const payload = Response.address(message.id, address);
                return { id: message.id, type: payload.type, payload };
            }
            case "GET_VTXOS": {
                const payload = await this.handleGetVtxos(
                    message as Request.GetVtxos
                );
                if (payload) {
                    return { id: message.id, type: payload.type, payload };
                }
                return null;
            }
            case "GET_BOARDING_UTXOS": {
                const boardingUtxos = await this.getAllBoardingUtxos();
                const payload = Response.boardingUtxos(
                    message.id,
                    boardingUtxos
                );
                return { id: message.id, type: payload.type, payload };
            }
            case "GET_TRANSACTION_HISTORY": {
                const txs = await this.getTransactionHistory();
                const payload = Response.transactionHistory(message.id, txs);
                return { id: message.id, type: payload.type, payload };
            }
            case "GET_STATUS": {
                const pubKey = await this.handler.identity.xOnlyPublicKey();
                const payload = Response.walletStatus(
                    message.id,
                    this.handler !== undefined,
                    pubKey
                );
                return { id: message.id, type: payload.type, payload };
            }
            case "CLEAR": {
                await this.clear();
                const payload = Response.clearResponse(message.id, true);
                return { id: message.id, type: payload.type, payload };
            }
            case "RELOAD_WALLET": {
                await await this.onWalletInitialized();
                const payload = Response.walletReloaded(message.id, true);
                return { id: message.id, type: payload.type, payload };
            }
            default:
                console.error(`Unknown message type: ${message.type}`);
                throw new Error("Unknown message");
        }
    }

    // Wallet methods
    private async handleInitWallet(message: Request.InitWallet) {
        console.log("handleInitWallet", message);
        const { arkServerPublicKey, arkServerUrl } = message;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);

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
            });
            this.handler = new ReadonlyHandler(wallet);
        } else {
            throw new Error("Missing privateKey or publicKey in key object");
        }

        // TODO: check if can be blocking
        await this.onWalletInitialized();
    }

    private async handleGetBalance(message: Request.GetBalance) {
        const [boardingUtxos, spendableVtxos, sweptVtxos] = await Promise.all([
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

        return Response.balance(message.id, {
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
        });
    }
    private async getAllBoardingUtxos(): Promise<ExtendedCoin[]> {
        if (!this.handler) return [];
        const address = await this.handler.getBoardingAddress();

        return await this.walletRepository.getUtxos(address);
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

    private async onWalletInitialized() {
        console.log("onWalletInitialized - Initializing wallet...");
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
        const txs = await this.getTransactionHistory();
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
                    this.scheduleForNextTick(() => ({
                        type: "VTXO_UPDATE",
                        broadcast: true,
                        payload: Response.vtxoUpdate(newVtxos, spentVtxos),
                    }));
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
                    this.scheduleForNextTick(() => ({
                        type: "UTXO_UPDATE",
                        broadcast: true,
                        payload: Response.utxoUpdate(utxos),
                    }));
                }
            }
        );
    }

    private async getTransactionHistory(): Promise<ArkTransaction[]> {
        if (!this.handler) return [];

        let txs: ArkTransaction[] = [];

        try {
            const { boardingTxs, commitmentsToIgnore: roundsToIgnore } =
                await this.handler.getBoardingTxs();

            const { spendable, spent } = await this.getAllVtxos();

            // convert VTXOs to offchain transactions
            const offchainTxs = vtxosToTxs(spendable, spent, roundsToIgnore);

            txs = [...boardingTxs, ...offchainTxs];

            // sort transactions by creation time in descending order (newest first)
            txs.sort(
                // place createdAt = 0 (unconfirmed txs) first, then descending
                (a, b) => {
                    if (a.createdAt === 0) return -1;
                    if (b.createdAt === 0) return 1;
                    return b.createdAt - a.createdAt;
                }
            );
        } catch (error: unknown) {
            console.error("Error getting transaction history:", error);
        }
        return txs;
    }

    private async getAllVtxos() {
        if (!this.handler) return { spendable: [], spent: [] };
        const address = await this.handler.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);

        return {
            spendable: allVtxos.filter(isSpendable),
            spent: allVtxos.filter((vtxo) => !isSpendable(vtxo)),
        };
    }

    private async handleSettle(message: Request.Settle) {
        if (!this.handler) {
            return null;
        }
        const txid = await this.handler.handleSettle(message.params, (e) => {
            this.scheduleForNextTick(() => Response.settleEvent(message.id, e));
        });
        if (txid) {
            return Response.settleSuccess(message.id, txid);
        } else {
            return Response.error(
                message.id,
                "Operation not supported in readonly mode"
            );
        }
    }

    private async handleSendBitcoin(message: Request.SendBitcoin) {
        if (!this.handler) {
            return null;
        }
        const txid = await this.handler.handleSendBitcoin(message.params);
        if (txid) {
            return Response.sendBitcoinSuccess(message.id, txid);
        } else {
            return Response.error(
                message.id,
                "Operation not supported in readonly mode"
            );
        }
    }

    private async handleGetVtxos(message: Request.GetVtxos) {
        if (!this.handler) {
            return null;
        }
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

        return Response.vtxos(message.id, filteredVtxos);
    }

    private async clear() {
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // Clear storage - this replaces vtxoRepository.close()
        await this.storage.clear();

        // Reset in-memory caches by recreating the repository
        this.walletRepository = new WalletRepositoryImpl(this.storage);

        this.handler = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
    }
}
