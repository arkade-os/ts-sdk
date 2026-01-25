import {
    ArkProvider,
    RestArkProvider,
    SettlementEvent,
} from "../../providers/ark";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { ContractRepository, WalletRepository } from "../../repositories";
import {
    ArkTransaction,
    ExtendedCoin,
    GetVtxosFilter,
    isExpired,
    isRecoverable,
    isSpendable,
    isSubdust,
    IWallet,
    SendBitcoinParams,
    SettleParams,
    WalletBalance,
} from "../index";
import { ReadonlySingleKey, SingleKey } from "../../identity";
import { ReadonlyWallet, Wallet } from "../wallet";
import { hex } from "@scure/base";
import { extendCoin, extendVirtualCoin } from "../utils";
import {
    IUpdater,
    RequestEnvelope,
    ResponseEnvelope,
} from "../../serviceWorker/worker";
import { Transaction } from "../../utils/transaction";

export type RequestInitWallet = RequestEnvelope & {
    type: "INIT_WALLET";
    payload: {
        key: { privateKey: string } | { publicKey: string };
        arkServerUrl: string;
        arkServerPublicKey?: string;
    };
};
export type ResponseInitWallet = ResponseEnvelope & {
    type: "WALLET_INITIALIZED";
};

export type RequestSettle = RequestEnvelope & {
    type: "SETTLE";
    payload: SettleParams;
};
export type ResponseSettle = ResponseEnvelope & {
    type: "SETTLE_SUCCESS";
    payload: { txid: string };
};

export type RequestSendBitcoin = RequestEnvelope & {
    type: "SEND_BITCOIN";
    payload: SendBitcoinParams;
};
export type ResponseSendBitcoin = ResponseEnvelope & {
    type: "SEND_BITCOIN_SUCCESS";
    payload: { txid: string };
};

export type RequestGetAddress = RequestEnvelope & { type: "GET_ADDRESS" };
export type ResponseGetAddress = ResponseEnvelope & {
    type: "ADDRESS";
    payload: { address: string };
};

export type RequestGetBoardingAddress = RequestEnvelope & {
    type: "GET_BOARDING_ADDRESS";
};
export type ResponseGetBoardingAddress = ResponseEnvelope & {
    type: "BOARDING_ADDRESS";
    payload: { address: string };
};

export type RequestGetBalance = RequestEnvelope & { type: "GET_BALANCE" };
export type ResponseGetBalance = ResponseEnvelope & {
    type: "BALANCE";
    payload: WalletBalance;
};

export type RequestGetVtxos = RequestEnvelope & {
    type: "GET_VTXOS";
    payload: { filter?: GetVtxosFilter };
};
export type ResponseGetVtxos = ResponseEnvelope & {
    type: "VTXOS";
    payload: { vtxos: Awaited<ReturnType<IWallet["getVtxos"]>> };
};

export type RequestGetBoardingUtxos = RequestEnvelope & {
    type: "GET_BOARDING_UTXOS";
};
export type ResponseGetBoardingUtxos = ResponseEnvelope & {
    type: "BOARDING_UTXOS";
    payload: { utxos: ExtendedCoin[] };
};

export type RequestGetTransactionHistory = RequestEnvelope & {
    type: "GET_TRANSACTION_HISTORY";
};
export type ResponseGetTransactionHistory = ResponseEnvelope & {
    type: "TRANSACTION_HISTORY";
    payload: { transactions: ArkTransaction[] };
};

export type RequestGetStatus = RequestEnvelope & { type: "GET_STATUS" };
export type ResponseGetStatus = ResponseEnvelope & {
    type: "WALLET_STATUS";
    payload: {
        walletInitialized: boolean;
        xOnlyPublicKey: Uint8Array | undefined;
    };
};

export type RequestClear = RequestEnvelope & { type: "CLEAR" };
export type ResponseClear = ResponseEnvelope & {
    type: "CLEAR_SUCCESS";
    payload: { cleared: boolean };
};

export type RequestSignTransaction = RequestEnvelope & {
    type: "SIGN_TRANSACTION";
    payload: { tx: Transaction; inputIndexes?: number[] };
};
export type ResponseSignTransaction = ResponseEnvelope & {
    type: "SIGN_TRANSACTION";
    payload: { tx: Transaction };
};

export type RequestReloadWallet = RequestEnvelope & { type: "RELOAD_WALLET" };
export type ResponseReloadWallet = ResponseEnvelope & {
    type: "RELOAD_SUCCESS";
    payload: { reloaded: boolean };
};

export type ResponseSettleEvent = ResponseEnvelope & {
    broadcast: true;
    type: "SETTLE_EVENT";
    payload: SettlementEvent;
};
export type ResponseUtxoUpdate = ResponseEnvelope & {
    broadcast: true;
    type: "UTXO_UPDATE";
    payload: { coins: ExtendedCoin[] };
};
export type ResponseVtxoUpdate = ResponseEnvelope & {
    broadcast: true;
    type: "VTXO_UPDATE";
    payload: { newVtxos: ExtendedCoin[]; spentVtxos: ExtendedCoin[] };
};

// WalletUpdater
export type WalletUpdaterRequest =
    | RequestInitWallet
    | RequestSettle
    | RequestSendBitcoin
    | RequestGetAddress
    | RequestGetBoardingAddress
    | RequestGetBalance
    | RequestGetVtxos
    | RequestGetBoardingUtxos
    | RequestGetTransactionHistory
    | RequestGetStatus
    | RequestClear
    | RequestReloadWallet
    | RequestSignTransaction;

export type WalletUpdaterResponse =
    | ResponseInitWallet
    | ResponseSettle
    | ResponseSettleEvent
    | ResponseSendBitcoin
    | ResponseGetAddress
    | ResponseGetBoardingAddress
    | ResponseGetBalance
    | ResponseGetVtxos
    | ResponseGetBoardingUtxos
    | ResponseGetTransactionHistory
    | ResponseGetStatus
    | ResponseClear
    | ResponseReloadWallet
    | ResponseUtxoUpdate
    | ResponseVtxoUpdate
    | ResponseSignTransaction;

export class WalletUpdater
    implements IUpdater<WalletUpdaterRequest, WalletUpdaterResponse>
{
    static messageTag = "WalletUpdater";
    readonly messageTag = WalletUpdater.messageTag;

    // declared as Readonly, it uses the flag and a helper function
    // to run specific IWallet methods
    private isReadonly = true;
    private wallet: ReadonlyWallet | undefined;

    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private incomingFundsSubscription: (() => void) | undefined;
    private onNextTick: (() => WalletUpdaterResponse | null)[] = [];

    constructor(
        private walletRepository: WalletRepository,
        private contractRepository: ContractRepository
    ) {}

    // lifecycle methods
    async start() {
        // TODO: load config from storage/db
    }

    async stop() {
        // optional cleanup and persistence
    }

    async tick(_now: number) {
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
                        `[${WalletUpdater.messageTag}] tick failed`,
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

    private tagged(res: Partial<WalletUpdaterResponse>): WalletUpdaterResponse {
        return {
            ...res,
            tag: this.messageTag,
        } as WalletUpdaterResponse;
    }

    async handleMessage(
        message: WalletUpdaterRequest
    ): Promise<WalletUpdaterResponse> {
        const id = message.id;
        // console.log(`[${this.messageTag}] handleMessage`, message);
        if (message.type === "INIT_WALLET") {
            await this.handleInitWallet(message);
            return this.tagged({
                id,
                type: "WALLET_INITIALIZED",
            });
        }
        if (!this.wallet) {
            return this.tagged({
                id,
                error: new Error("Wallet handler not initialized"),
            });
        }
        try {
            switch (message.type) {
                case "SETTLE": {
                    const response = await this.handleSettle(message);
                    return this.tagged({
                        id,
                        ...response,
                    });
                }

                case "SEND_BITCOIN": {
                    const response = await this.handleSendBitcoin(message);
                    return this.tagged({
                        id,
                        ...response,
                    });
                }
                case "GET_ADDRESS": {
                    const address = await this.wallet.getAddress();
                    return this.tagged({
                        id,
                        type: "ADDRESS",
                        payload: { address },
                    });
                }
                case "GET_BOARDING_ADDRESS": {
                    const address = await this.wallet.getBoardingAddress();
                    return this.tagged({
                        id,
                        type: "BOARDING_ADDRESS",
                        payload: { address },
                    });
                }
                case "GET_BALANCE": {
                    const balance = await this.handleGetBalance();
                    return this.tagged({
                        id,
                        type: "BALANCE",
                        payload: balance,
                    });
                }
                case "GET_VTXOS": {
                    const vtxos = await this.handleGetVtxos(message);
                    return {
                        tag: this.messageTag,
                        id,
                        type: "VTXOS",
                        payload: { vtxos },
                    };
                }
                case "GET_BOARDING_UTXOS": {
                    const utxos = await this.getAllBoardingUtxos();
                    return this.tagged({
                        id,
                        type: "BOARDING_UTXOS",
                        payload: { utxos },
                    });
                }
                case "GET_TRANSACTION_HISTORY": {
                    const transactions =
                        await this.wallet.getTransactionHistory();
                    return this.tagged({
                        id,
                        type: "TRANSACTION_HISTORY",
                        payload: { transactions },
                    });
                }
                case "GET_STATUS": {
                    const pubKey = await this.wallet.identity.xOnlyPublicKey();
                    return this.tagged({
                        id,
                        type: "WALLET_STATUS",
                        payload: {
                            walletInitialized: true,
                            xOnlyPublicKey: pubKey,
                        },
                    });
                }
                case "CLEAR": {
                    await this.clear();
                    return this.tagged({
                        id,
                        type: "CLEAR_SUCCESS",
                        payload: { cleared: true },
                    });
                }
                case "RELOAD_WALLET": {
                    await this.onWalletInitialized();
                    return this.tagged({
                        id,
                        type: "RELOAD_SUCCESS",
                        payload: { reloaded: true },
                    });
                }
                case "SIGN_TRANSACTION": {
                    const response = await this.handleSignTransaction(message);
                    return this.tagged({
                        id,
                        ...response,
                    });
                }
                default:
                    console.error("Unknown message type", message);
                    throw new Error("Unknown message");
            }
        } catch (error: unknown) {
            return this.tagged({ id, error: error as Error });
        }
    }

    // Wallet methods
    private async handleInitWallet({ payload }: RequestInitWallet) {
        const { arkServerPublicKey, arkServerUrl } = payload;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);
        const storage = {
            walletRepository: this.walletRepository,
            contractRepository: this.contractRepository,
        };

        if (
            "privateKey" in payload.key &&
            typeof payload.key.privateKey === "string"
        ) {
            this.isReadonly = false;
            const {
                key: { privateKey },
            } = payload;
            const identity = SingleKey.fromHex(privateKey);
            this.wallet = await Wallet.create({
                identity,
                arkServerUrl,
                arkServerPublicKey,
                storage,
            });
        } else if (
            "publicKey" in payload.key &&
            typeof payload.key.publicKey === "string"
        ) {
            this.isReadonly = true;
            const {
                key: { publicKey },
            } = payload;
            const identity = ReadonlySingleKey.fromPublicKey(
                hex.decode(publicKey)
            );
            this.wallet = await ReadonlyWallet.create({
                identity,
                arkServerUrl,
                arkServerPublicKey,
                storage,
            });
        } else {
            throw new Error("Missing privateKey or publicKey in key object");
        }

        // TODO: check if can be blocking
        await this.onWalletInitialized();
    }

    private async handleGetBalance() {
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

        return {
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
        };
    }
    private async getAllBoardingUtxos(): Promise<ExtendedCoin[]> {
        if (!this.wallet) return [];
        const address = await this.wallet.getBoardingAddress();

        return await this.walletRepository.getUtxos(address);
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
        return allVtxos.filter((vtxo) => vtxo.virtualStatus.state === "swept");
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
        );

        try {
            // recover pending transactions if possible
            const { pending, finalized } = await this.withWallet((w) =>
                w.finalizePendingTxs(
                    vtxos.filter(
                        (vtxo) =>
                            vtxo.virtualStatus.state !== "swept" &&
                            vtxo.virtualStatus.state !== "settled"
                    )
                )
            );
            console.info(
                `Recovered ${finalized.length}/${pending.length} pending transactions: ${finalized.join(", ")}`
            );
        } catch (error: unknown) {
            console.error("Error recovering pending transactions:", error);
        }

        // Get wallet address and save vtxos using unified repository
        const address = await this.wallet.getAddress();
        await this.walletRepository.saveVtxos(address, vtxos);

        // Fetch boarding utxos and save using unified repository
        const boardingAddress = await this.wallet.getBoardingAddress();
        const coins =
            await this.wallet.onchainProvider.getCoins(boardingAddress);
        await this.walletRepository.saveUtxos(
            boardingAddress,
            coins.map((utxo) => extendCoin(this.wallet!, utxo))
        );

        // Get transaction history to cache boarding txs
        const txs = await this.wallet.getTransactionHistory();
        if (txs) await this.walletRepository.saveTransactions(address, txs);

        // unsubscribe previous subscription if any
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // subscribe for incoming funds and notify all clients when new funds arrive
        this.incomingFundsSubscription = await this.wallet.notifyIncomingFunds(
            async (funds) => {
                console.log("incomng funds: ", funds);
                if (funds.type === "vtxo") {
                    const newVtxos =
                        funds.newVtxos.length > 0
                            ? funds.newVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.wallet!, vtxo)
                              )
                            : [];
                    const spentVtxos =
                        funds.spentVtxos.length > 0
                            ? funds.spentVtxos.map((vtxo) =>
                                  extendVirtualCoin(this.wallet!, vtxo)
                              )
                            : [];

                    if ([...newVtxos, ...spentVtxos].length === 0) return;

                    // save vtxos using unified repository
                    await this.walletRepository.saveVtxos(address, [
                        ...newVtxos,
                        ...spentVtxos,
                    ]);

                    // notify all clients about the vtxo update
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "VTXO_UPDATE",
                            broadcast: true,
                            payload: { newVtxos, spentVtxos },
                        })
                    );
                }
                if (funds.type === "utxo") {
                    const utxos = funds.coins.map((utxo) =>
                        extendCoin(this.wallet!, utxo)
                    );

                    const boardingAddress =
                        await this.wallet?.getBoardingAddress()!;

                    // save utxos using unified repository
                    await this.walletRepository.clearUtxos(boardingAddress);
                    await this.walletRepository.saveUtxos(
                        boardingAddress,
                        utxos
                    );

                    // notify all clients about the utxo update
                    this.scheduleForNextTick(() =>
                        this.tagged({
                            type: "UTXO_UPDATE",
                            broadcast: true,
                            payload: { coins: utxos },
                        })
                    );
                }
            }
        );
    }

    private async getAllVtxos() {
        if (!this.wallet) return { spendable: [], spent: [] };
        const address = await this.wallet.getAddress();
        const allVtxos = await this.walletRepository.getVtxos(address);

        return {
            spendable: allVtxos.filter(isSpendable),
            spent: allVtxos.filter((vtxo) => !isSpendable(vtxo)),
        };
    }

    private async handleSettle(message: RequestSettle) {
        if (!this.wallet) {
            throw new Error("Wallet handler not initialized");
        }
        const txid = await this.withWallet((w) =>
            w.settle(message.payload, (e) => {
                this.scheduleForNextTick(() =>
                    this.tagged({
                        id: message.id,
                        type: "SETTLE_EVENT",
                        payload: e,
                    })
                );
            })
        );

        if (!txid) {
            throw new Error("Settlement failed");
        }
        return { type: "SETTLE_SUCCESS", payload: { txid } } as ResponseSettle;
    }

    private async handleSendBitcoin(message: RequestSendBitcoin) {
        if (!this.wallet) {
            throw new Error("Wallet handler not initialized");
        }
        const txid = await this.withWallet((w) =>
            w.sendBitcoin(message.payload)
        );
        if (!txid) {
            throw new Error("Send bitcoin failed");
        }
        return {
            type: "SEND_BITCOIN_SUCCESS",
            payload: { txid },
        } as ResponseSendBitcoin;
    }

    private async handleSignTransaction(message: RequestSignTransaction) {
        if (!this.wallet) {
            throw new Error("Wallet handler not initialized");
        }
        const { tx, inputIndexes } = message.payload;
        const signature = await this.withWallet((w) =>
            w.identity.sign(tx, inputIndexes)
        );
        if (!signature) {
            throw new Error("Sign transaction failed");
        }
        return {
            type: "SIGN_TRANSACTION",
            payload: { tx: signature },
        } as ResponseSignTransaction;
    }

    private async handleGetVtxos(message: RequestGetVtxos) {
        if (!this.wallet) {
            throw new Error("Wallet handler not initialized");
        }
        const vtxos = await this.getSpendableVtxos();
        const dustAmount = this.wallet.dustAmount;
        const includeRecoverable =
            message.payload.filter?.withRecoverable ?? false;
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

        return filteredVtxos;
    }

    private async clear() {
        if (!this.wallet) return;
        if (this.incomingFundsSubscription) this.incomingFundsSubscription();

        // Clear page-side storage to maintain parity with SW
        try {
            const address = await this.wallet.getAddress();
            await this.walletRepository.clearVtxos(address);
        } catch (_) {
            console.warn("Failed to clear vtxos from wallet repository");
        }

        this.wallet = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
    }

    private async withWallet<T>(
        fn: (wallet: Wallet) => Promise<T>
    ): Promise<T> {
        if (!this.isReadonly) {
            throw new Error("Cannot execute action on read-only wallet");
        }
        return fn(this.wallet as Wallet);
    }
}
