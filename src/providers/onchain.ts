import { ElectrumWS, ElectrumWSOptions } from "ws-electrumx-client";
import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import type { Network, NetworkName } from "../networks";
import { getNetwork } from "../networks";
import { Coin } from "../wallet";

/**
 * The default base URLs for esplora API providers.
 */
export const ESPLORA_URL: Record<NetworkName, string> = {
    bitcoin: "https://mempool.space/api",
    testnet: "https://mempool.space/testnet/api",
    signet: "https://mempool.space/signet/api",
    mutinynet: "https://mutinynet.com/api",
    regtest: "http://localhost:3000",
};

export const ELECTRUM_WS_URL: Record<NetworkName, string> = {
    bitcoin: "wss://electrum.blockstream.info:50002",
    testnet: "wss://electrum.blockstream.info:60002",
    signet: "wss://mutinynet.com/electrum/ws",
    mutinynet: "wss://mutinynet.com/electrum/ws",
    regtest: "ws://127.0.0.1:60401",
};

export type ExplorerTransaction = {
    txid: string;
    vout: {
        scriptpubkey_address: string;
        value: string;
    }[];
    status: {
        confirmed: boolean;
        block_time: number;
    };
};

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number | undefined>;
    broadcastTransaction(...txs: string[]): Promise<string>;
    getTxOutspends(txid: string): Promise<{ spent: boolean; txid: string }[]>;
    getTransactions(address: string): Promise<ExplorerTransaction[]>;
    getTxStatus(
        txid: string
    ): Promise<
        | { confirmed: false }
        | { confirmed: true; blockTime: number; blockHeight: number }
    >;
    getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }>;
    watchAddresses(
        addresses: string[],
        eventCallback: (txs: ExplorerTransaction[]) => void
    ): Promise<() => void>;
}

type ElectrumUnspent = {
    tx_hash: string;
    tx_pos: number;
    value: number;
    height: number;
};

type ElectrumHistoryItem = {
    tx_hash: string;
    height: number;
};

type ElectrumScriptPubKey = {
    hex?: string;
    address?: string;
    addresses?: string[];
    type?: string;
};

type ElectrumVerboseVin = {
    txid?: string;
    vout?: number;
};

type ElectrumVerboseVout = {
    n: number;
    value: number;
    scriptPubKey: ElectrumScriptPubKey;
};

type ElectrumVerboseTx = {
    txid: string;
    hex: string;
    vout: ElectrumVerboseVout[];
    vin: ElectrumVerboseVin[];
    blockhash?: string;
    blocktime?: number;
    time?: number;
    confirmations?: number;
    height?: number;
};

type BlockInfo = {
    height: number;
    hash: string;
    time: number;
};

export type ElectrumProviderOptions = {
    /**
     * Reuse an existing ElectrumWS instance. Useful for tests.
     */
    electrum?: ElectrumWS;
    /**
     * Options passed to the ElectrumWS constructor when creating a new client.
     */
    electrumOptions?: Partial<ElectrumWSOptions>;
};

/**
 * Implementation of the onchain provider interface for esplora REST API.
 * @see https://mempool.space/docs/api/rest
 * @example
 * ```typescript
 * const provider = new EsploraProvider("https://mempool.space/api");
 * const utxos = await provider.getCoins("bcrt1q679zsd45msawvr7782r0twvmukns3drlstjt77");
 * ```
 */
export class EsploraProvider implements OnchainProvider {
    readonly pollingInterval: number;
    readonly forcePolling: boolean;

    constructor(
        private baseUrl: string,
        opts?: {
            // polling interval in milliseconds
            pollingInterval?: number;
            // if true, will force polling even if websocket is available
            forcePolling?: boolean;
        }
    ) {
        this.pollingInterval = opts?.pollingInterval ?? 15_000;
        this.forcePolling = opts?.forcePolling ?? false;
    }

    async getCoins(address: string): Promise<Coin[]> {
        const response = await fetch(`${this.baseUrl}/address/${address}/utxo`);
        if (!response.ok) {
            throw new Error(`Failed to fetch UTXOs: ${response.statusText}`);
        }
        return response.json();
    }

    async getFeeRate(): Promise<number | undefined> {
        const response = await fetch(`${this.baseUrl}/fee-estimates`);
        if (!response.ok) {
            throw new Error(`Failed to fetch fee rate: ${response.statusText}`);
        }
        const fees = (await response.json()) as Record<string, number>;
        return fees["1"] ?? undefined;
    }

    async broadcastTransaction(...txs: string[]): Promise<string> {
        switch (txs.length) {
            case 1:
                return this.broadcastTx(txs[0]);
            case 2:
                return this.broadcastPackage(txs[0], txs[1]);
            default:
                throw new Error("Only 1 or 1C1P package can be broadcast");
        }
    }

    async getTxOutspends(
        txid: string
    ): Promise<{ spent: boolean; txid: string }[]> {
        const response = await fetch(`${this.baseUrl}/tx/${txid}/outspends`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get transaction outspends: ${error}`);
        }

        return response.json();
    }

    async getTransactions(address: string): Promise<ExplorerTransaction[]> {
        const response = await fetch(`${this.baseUrl}/address/${address}/txs`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get transactions: ${error}`);
        }

        return response.json();
    }

    async getTxStatus(txid: string): Promise<
        | {
              confirmed: false;
          }
        | {
              confirmed: true;
              blockTime: number;
              blockHeight: number;
          }
    > {
        // make sure tx exists in mempool or in block
        const txresponse = await fetch(`${this.baseUrl}/tx/${txid}`);
        if (!txresponse.ok) {
            throw new Error(txresponse.statusText);
        }

        const tx = await txresponse.json();
        if (!tx.status.confirmed) {
            return { confirmed: false };
        }

        const response = await fetch(`${this.baseUrl}/tx/${txid}/status`);
        if (!response.ok) {
            throw new Error(
                `Failed to get transaction status: ${response.statusText}`
            );
        }

        const data = await response.json();
        if (!data.confirmed) {
            return { confirmed: false };
        }

        return {
            confirmed: data.confirmed,
            blockTime: data.block_time,
            blockHeight: data.block_height,
        };
    }

    async watchAddresses(
        addresses: string[],
        callback: (txs: ExplorerTransaction[]) => void
    ): Promise<() => void> {
        let intervalId: ReturnType<typeof setInterval> | null = null;
        const wsUrl = this.baseUrl.replace(/^http(s)?:/, "ws$1:") + "/v1/ws";

        const poll = async () => {
            const getAllTxs = async () => {
                const txArrays = await Promise.all(
                    addresses.map((address) => this.getTransactions(address))
                );
                return txArrays.flat();
            };

            // initial fetch to get existing transactions
            const initialTxs = await getAllTxs();

            // we use block_time in key to also notify when a transaction is confirmed
            const txKey = (tx: ExplorerTransaction) =>
                `${tx.txid}_${tx.status.block_time}`;

            // create a set of existing transactions to avoid duplicates
            const existingTxs = new Set(initialTxs.map(txKey));

            // polling for new transactions
            intervalId = setInterval(async () => {
                try {
                    // get current transactions
                    // we will compare with initialTxs to find new ones
                    const currentTxs = await getAllTxs();

                    // filter out transactions that are already in initialTxs
                    const newTxs = currentTxs.filter(
                        (tx) => !existingTxs.has(txKey(tx))
                    );

                    if (newTxs.length > 0) {
                        // Update the tracking set instead of growing the array
                        newTxs.forEach((tx) => existingTxs.add(txKey(tx)));
                        callback(newTxs);
                    }
                } catch (error) {
                    console.error("Error in polling mechanism:", error);
                }
            }, this.pollingInterval);
        };

        let ws: WebSocket | null = null;

        const stopFunc = () => {
            if (ws) ws.close();
            if (intervalId) clearInterval(intervalId);
        };

        if (this.forcePolling) {
            await poll();
            return stopFunc;
        }

        try {
            ws = new WebSocket(wsUrl);
            ws.addEventListener("open", () => {
                // subscribe to address updates
                const subscribeMsg: SubscribeMessage = {
                    "track-addresses": addresses,
                };
                ws!.send(JSON.stringify(subscribeMsg));
            });

            ws.addEventListener("message", (event: MessageEvent) => {
                try {
                    const newTxs: ExplorerTransaction[] = [];
                    const message: WebSocketMessage = JSON.parse(
                        event.data.toString()
                    );
                    if (!message["multi-address-transactions"]) return;
                    const aux = message["multi-address-transactions"];

                    for (const address in aux) {
                        for (const type of [
                            "mempool",
                            "confirmed",
                            "removed",
                        ] as const) {
                            if (!aux[address][type]) continue;
                            newTxs.push(
                                ...aux[address][type].filter(
                                    isExplorerTransaction
                                )
                            );
                        }
                    }
                    // callback with new transactions
                    if (newTxs.length > 0) callback(newTxs);
                } catch (error) {
                    console.error(
                        "Failed to process WebSocket message:",
                        error
                    );
                }
            });

            ws.addEventListener("error", async () => {
                // if websocket is not available, fallback to polling
                await poll();
            });
        } catch {
            if (intervalId) clearInterval(intervalId);
            // if websocket is not available, fallback to polling
            await poll();
        }

        return stopFunc;
    }

    async getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }> {
        const tipBlocks = await fetch(`${this.baseUrl}/blocks/tip`);
        if (!tipBlocks.ok) {
            throw new Error(`Failed to get chain tip: ${tipBlocks.statusText}`);
        }

        const tip = await tipBlocks.json();
        if (!isValidBlocksTip(tip)) {
            throw new Error(`Invalid chain tip: ${JSON.stringify(tip)}`);
        }

        if (tip.length === 0) {
            throw new Error("No chain tip found");
        }

        const hash = tip[0].id;
        return {
            height: tip[0].height,
            time: tip[0].mediantime,
            hash,
        };
    }

    private async broadcastPackage(
        parent: string,
        child: string
    ): Promise<string> {
        const response = await fetch(`${this.baseUrl}/txs/package`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify([parent, child]),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to broadcast package: ${error}`);
        }

        return response.json();
    }

    private async broadcastTx(tx: string): Promise<string> {
        const response = await fetch(`${this.baseUrl}/tx`, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
            },
            body: tx,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to broadcast transaction: ${error}`);
        }

        return response.text();
    }
}

/**
 * Electrum-based implementation of the OnchainProvider interface.
 * Uses a WebSocket connection to subscribe to script hash updates and
 * fetch onchain data with minimal polling.
 */
export class ElectrumProvider implements OnchainProvider {
    private readonly client: ElectrumWS;
    private readonly network: Network;
    private readonly networkName: NetworkName;

    private readonly blockCache = new Map<number, BlockInfo>();
    private readonly scriptHashCache = new Map<string, string>();
    private readonly txCache = new Map<string, ElectrumVerboseTx>();
    private readonly txPromises = new Map<string, Promise<ElectrumVerboseTx>>();
    private readonly historyPromises = new Map<
        string,
        Promise<ElectrumHistoryItem[]>
    >();
    private readonly watcherStates = new Map<
        string,
        {
            address: string;
            seen: Set<string>;
        }
    >();
    private readonly watcherLocks = new Map<string, Promise<void>>();

    private headersReady: Promise<void>;
    private resolveHeadersReady?: () => void;
    private rejectHeadersReady?: (error: Error) => void;
    private headersInitialized = false;
    private cachedTip?: BlockInfo;

    constructor(
        endpoint: string,
        networkName: NetworkName,
        options: ElectrumProviderOptions = {}
    ) {
        this.networkName = networkName;
        this.network = getNetwork(networkName);
        this.client =
            options.electrum ??
            new ElectrumWS(endpoint, options.electrumOptions ?? {});

        this.headersReady = new Promise<void>((resolve, reject) => {
            this.resolveHeadersReady = resolve;
            this.rejectHeadersReady = reject;
        });

        this.client
            .subscribe("blockchain.headers", (...payload: unknown[]) => {
                try {
                    this.onHeaderUpdate(payload);
                } catch (err) {
                    const error =
                        err instanceof Error
                            ? err
                            : new Error(String(err ?? "Unknown header error"));
                    if (!this.headersInitialized) {
                        this.rejectHeadersReady?.(error);
                    } else {
                        console.error(
                            "ElectrumProvider header subscription error:",
                            error
                        );
                    }
                }
            })
            .catch((err) => {
                const error =
                    err instanceof Error
                        ? err
                        : new Error(String(err ?? "Unknown header error"));
                this.rejectHeadersReady?.(error);
            });
    }

    async getCoins(address: string): Promise<Coin[]> {
        try {
            const scriptHash = this.addressToScriptHash(address);
            const utxos = await this.client.request<ElectrumUnspent[]>(
                "blockchain.scripthash.listunspent",
                scriptHash
            );

            const coins = await Promise.all(
                utxos.map(async (utxo) => {
                    const status = await this.statusFromHeight(utxo.height);
                    return {
                        txid: utxo.tx_hash,
                        vout: utxo.tx_pos,
                        value: utxo.value,
                        status,
                    };
                })
            );

            return coins;
        } catch (error) {
            throw new Error(
                `Failed to fetch UTXOs from Electrum: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    async getFeeRate(): Promise<number | undefined> {
        try {
            const feePerKb = await this.client.request<number>(
                "blockchain.estimatefee",
                1
            );
            if (typeof feePerKb !== "number" || !isFinite(feePerKb)) {
                return undefined;
            }
            if (feePerKb <= 0) {
                return undefined;
            }

            const satPerVByte = Math.ceil((feePerKb * 1e8) / 1000);
            return satPerVByte > 0 ? satPerVByte : undefined;
        } catch (error) {
            throw new Error(
                `Failed to fetch fee rate from Electrum: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    async broadcastTransaction(...txs: string[]): Promise<string> {
        if (txs.length === 0 || txs.length > 2) {
            throw new Error(
                "Only single transactions or 1C1P packages can be broadcast"
            );
        }

        if (txs.length === 1) {
            return this.broadcastSingle(txs[0]);
        }

        await this.broadcastSingle(txs[0]);
        return this.broadcastSingle(txs[1]);
    }

    async getTxOutspends(
        txid: string
    ): Promise<{ spent: boolean; txid: string }[]> {
        const tx = await this.getVerboseTransaction(txid);
        const scriptHistoryCache = new Map<string, ElectrumHistoryItem[]>();
        const results: { spent: boolean; txid: string }[] = [];

        for (const output of tx.vout) {
            const scriptHex = output.scriptPubKey.hex;
            if (!scriptHex) {
                results.push({ spent: false, txid: "" });
                continue;
            }

            const scriptHash = this.scriptHexToHash(scriptHex);
            let history = scriptHistoryCache.get(scriptHash);
            if (!history) {
                history = await this.getScriptHistory(scriptHash);
                scriptHistoryCache.set(scriptHash, history);
            }

            let spentBy = "";
            let spent = false;
            for (const entry of history) {
                if (entry.tx_hash === txid) continue;
                const candidate = await this.getVerboseTransaction(
                    entry.tx_hash
                );
                const isSpending = candidate.vin?.some(
                    (vin) => vin.txid === txid && vin.vout === output.n
                );
                if (isSpending) {
                    spent = true;
                    spentBy = candidate.txid;
                    break;
                }
            }

            results.push({ spent, txid: spentBy });
        }

        return results;
    }

    async getTransactions(address: string): Promise<ExplorerTransaction[]> {
        const scriptHash = this.addressToScriptHash(address);
        const history = await this.getScriptHistory(scriptHash);

        const transactions = await Promise.all(
            history.map((item) => this.buildExplorerTransaction(item, address))
        );

        return transactions;
    }

    async getTxStatus(
        txid: string
    ): Promise<
        | { confirmed: false }
        | { confirmed: true; blockTime: number; blockHeight: number }
    > {
        const verbose = await this.getVerboseTransaction(txid);
        const confirmations = verbose.confirmations ?? 0;
        const confirmed =
            confirmations > 0 ||
            typeof verbose.blockhash === "string" ||
            (verbose.height ?? 0) > 0;

        if (!confirmed) {
            return { confirmed: false };
        }

        let blockHeight = verbose.height ?? 0;
        if (!blockHeight) {
            try {
                const heightInfo = await this.client.request<{
                    height: number;
                }>("blockchain.transaction.get_height", txid);
                if (heightInfo?.height && heightInfo.height > 0) {
                    blockHeight = heightInfo.height;
                }
            } catch {
                // fallback to confirmations below
            }
        }

        if (!blockHeight && confirmations > 0) {
            const tip = await this.getChainTip();
            blockHeight = tip.height - confirmations + 1;
        }

        if (!blockHeight) {
            throw new Error(
                `Unable to determine confirmation height for transaction ${txid}`
            );
        }

        let blockTime = verbose.blocktime ?? verbose.time;
        if (blockTime === undefined) {
            const info = await this.getBlockInfo(blockHeight);
            blockTime = info.time;
        }

        return {
            confirmed: true,
            blockTime,
            blockHeight,
        };
    }

    async getChainTip(): Promise<BlockInfo> {
        await this.ensureHeadersReady();
        if (!this.cachedTip) {
            throw new Error("Chain tip not available");
        }
        return this.cachedTip;
    }

    async watchAddresses(
        addresses: string[],
        eventCallback: (txs: ExplorerTransaction[]) => void
    ): Promise<() => void> {
        const cleanupFns = await Promise.all(
            addresses.map((address) =>
                this.setupWatcher(address, eventCallback)
            )
        );

        return () => {
            for (const fn of cleanupFns) {
                void fn();
            }
        };
    }

    private async setupWatcher(
        address: string,
        callback: (txs: ExplorerTransaction[]) => void
    ): Promise<() => Promise<void>> {
        const scriptHash = this.addressToScriptHash(address);
        const state = {
            address,
            seen: new Set<string>(),
        };

        this.watcherStates.set(scriptHash, state);

        // Prime the cache with existing transactions so we only emit deltas.
        const existing = await this.getTransactions(address);
        for (const tx of existing) {
            state.seen.add(this.txEventKey(tx));
        }

        const handler = async (...payload: unknown[]) => {
            const [incomingScriptHash] = payload;
            if (
                typeof incomingScriptHash === "string" &&
                incomingScriptHash !== scriptHash
            ) {
                return;
            }
            await this.enqueueWatcherUpdate(scriptHash, async () => {
                const watcher = this.watcherStates.get(scriptHash);
                if (!watcher) return;

                const txs = await this.getTransactions(watcher.address);
                const newTxs = txs.filter((tx) => {
                    const key = this.txEventKey(tx);
                    if (watcher.seen.has(key)) {
                        return false;
                    }
                    watcher.seen.add(key);
                    return true;
                });

                if (newTxs.length > 0) {
                    callback(newTxs);
                }
            });
        };

        await this.client.subscribe(
            "blockchain.scripthash",
            handler,
            scriptHash
        );

        return async () => {
            await this.client
                .unsubscribe("blockchain.scripthash", scriptHash)
                .catch(() => {});
            this.watcherStates.delete(scriptHash);
        };
    }

    private enqueueWatcherUpdate(
        scriptHash: string,
        task: () => Promise<void>
    ): Promise<void> {
        const current = this.watcherLocks.get(scriptHash) ?? Promise.resolve();
        const next = current
            .catch(() => undefined)
            .then(task, task)
            .finally(() => {
                if (this.watcherLocks.get(scriptHash) === next) {
                    this.watcherLocks.delete(scriptHash);
                }
            }) as Promise<void>;
        this.watcherLocks.set(scriptHash, next);
        return next;
    }

    private async broadcastSingle(tx: string): Promise<string> {
        try {
            return await this.client.request<string>(
                "blockchain.transaction.broadcast",
                tx
            );
        } catch (error) {
            throw new Error(
                `Failed to broadcast transaction: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    private async statusFromHeight(height: number): Promise<Coin["status"]> {
        if (height > 0) {
            const info = await this.getBlockInfo(height);
            return {
                confirmed: true,
                block_height: height,
                block_hash: info.hash,
                block_time: info.time,
            };
        }

        return { confirmed: false };
    }

    private txEventKey(tx: ExplorerTransaction): string {
        const blockTime = tx.status.block_time ?? 0;
        const confirmed = tx.status.confirmed ? "1" : "0";
        return `${tx.txid}:${blockTime}:${confirmed}`;
    }

    private async ensureHeadersReady(): Promise<void> {
        if (this.headersInitialized) {
            return;
        }
        try {
            await this.headersReady;
        } finally {
            this.resolveHeadersReady = undefined;
            this.rejectHeadersReady = undefined;
        }
    }

    private onHeaderUpdate(payload: unknown[]): void {
        const header = this.extractHeader(payload);
        if (!header) return;

        const info = this.parseBlockHeader(header.hex, header.height);
        this.cachedTip = info;

        if (!this.headersInitialized) {
            this.headersInitialized = true;
            this.resolveHeadersReady?.();
            this.resolveHeadersReady = undefined;
            this.rejectHeadersReady = undefined;
        }
    }

    private extractHeader(
        payload: unknown[]
    ): { hex: string; height: number } | null {
        for (const item of payload) {
            if (
                item &&
                typeof item === "object" &&
                "hex" in item &&
                "height" in item &&
                typeof (item as any).hex === "string" &&
                typeof (item as any).height === "number"
            ) {
                return {
                    hex: (item as any).hex,
                    height: (item as any).height,
                };
            }
        }
        return null;
    }

    private parseBlockHeader(headerHex: string, height: number): BlockInfo {
        const bytes = hex.decode(headerHex);
        if (bytes.length < 80) {
            throw new Error("Invalid block header received from Electrum");
        }

        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );
        const time = view.getUint32(68, true);

        const hashLE = sha256(sha256(bytes));
        const hashBE = Uint8Array.from(hashLE);
        hashBE.reverse();
        const hash = hex.encode(hashBE);

        const info = { height, time, hash };
        this.blockCache.set(height, info);
        return info;
    }

    private async getBlockInfo(height: number): Promise<BlockInfo> {
        if (height <= 0) {
            throw new Error(`Invalid block height "${height}"`);
        }
        const cached = this.blockCache.get(height);
        if (cached) {
            return cached;
        }
        const headerHex = await this.client.request<string>(
            "blockchain.block.header",
            height
        );
        return this.parseBlockHeader(headerHex, height);
    }

    private addressToScriptHash(address: string): string {
        const cached = this.scriptHashCache.get(address);
        if (cached) return cached;

        const decoded = Address(this.network).decode(address);
        const script = OutScript.encode(decoded);
        const hash = this.hashScript(script);
        this.scriptHashCache.set(address, hash);
        return hash;
    }

    private scriptHexToHash(scriptHex: string): string {
        return this.hashScript(hex.decode(scriptHex));
    }

    private hashScript(script: Uint8Array): string {
        const digest = sha256(script);
        const reversed = Uint8Array.from(digest);
        reversed.reverse();
        return hex.encode(reversed);
    }

    private async getScriptHistory(
        scriptHash: string
    ): Promise<ElectrumHistoryItem[]> {
        const inFlight = this.historyPromises.get(scriptHash);
        if (inFlight) {
            return inFlight;
        }
        const promise = this.client
            .request<
                ElectrumHistoryItem[]
            >("blockchain.scripthash.get_history", scriptHash)
            .finally(() => {
                this.historyPromises.delete(scriptHash);
            });
        this.historyPromises.set(scriptHash, promise);
        return promise;
    }

    private async getVerboseTransaction(
        txid: string
    ): Promise<ElectrumVerboseTx> {
        const cached = this.txCache.get(txid);
        if (cached) return cached;

        const inFlight = this.txPromises.get(txid);
        if (inFlight) return inFlight;

        const promise = this.client
            .request<ElectrumVerboseTx>(
                "blockchain.transaction.get",
                txid,
                true
            )
            .then((tx) => {
                this.txCache.set(txid, tx);
                return tx;
            })
            .finally(() => {
                this.txPromises.delete(txid);
            });

        this.txPromises.set(txid, promise);
        return promise;
    }

    private async buildExplorerTransaction(
        historyItem: ElectrumHistoryItem,
        address?: string
    ): Promise<ExplorerTransaction> {
        const tx = await this.getVerboseTransaction(historyItem.tx_hash);
        const status = await this.buildExplorerStatus(tx, historyItem.height);

        const outputs = tx.vout.map((output) => ({
            scriptpubkey_address: this.outputAddress(output, address),
            value: this.valueToSats(output.value),
        }));

        return {
            txid: tx.txid,
            vout: outputs,
            status,
        };
    }

    private async buildExplorerStatus(
        tx: ElectrumVerboseTx,
        height: number
    ): Promise<ExplorerTransaction["status"]> {
        if (height > 0) {
            const block = await this.getBlockInfo(height);
            return {
                confirmed: true,
                block_time: tx.blocktime ?? tx.time ?? block.time,
            };
        }

        return {
            confirmed: false,
            block_time: tx.time ?? 0,
        };
    }

    private outputAddress(
        output: ElectrumVerboseVout,
        fallbackAddress?: string
    ): string {
        const { scriptPubKey } = output;

        if (typeof scriptPubKey.address === "string") {
            return scriptPubKey.address;
        }

        if (
            Array.isArray(scriptPubKey.addresses) &&
            scriptPubKey.addresses.length > 0
        ) {
            return scriptPubKey.addresses[0] ?? "";
        }

        if (scriptPubKey.hex) {
            try {
                const script = hex.decode(scriptPubKey.hex);
                const decoded = OutScript.decode(script);
                return Address(this.network).encode(decoded);
            } catch {
                if (fallbackAddress) {
                    try {
                        const expected =
                            this.addressToScriptHash(fallbackAddress);
                        const actual = this.scriptHexToHash(scriptPubKey.hex);
                        if (expected === actual) {
                            return fallbackAddress;
                        }
                    } catch {
                        // ignore
                    }
                }
            }
        }

        return fallbackAddress ?? "";
    }

    private valueToSats(value: number): string {
        return Math.round(value * 1e8).toString();
    }
}

function isValidBlocksTip(
    tip: any
): tip is { id: string; height: number; mediantime: number }[] {
    return (
        Array.isArray(tip) &&
        tip.every((t) => {
            t &&
                typeof t === "object" &&
                typeof t.id === "string" &&
                t.id.length > 0 &&
                typeof t.height === "number" &&
                t.height >= 0 &&
                typeof t.mediantime === "number" &&
                t.mediantime > 0;
        })
    );
}

const isExplorerTransaction = (tx: any): tx is ExplorerTransaction => {
    return (
        typeof tx.txid === "string" &&
        Array.isArray(tx.vout) &&
        tx.vout.every(
            (vout: any) =>
                typeof vout.scriptpubkey_address === "string" &&
                typeof vout.value === "number"
        ) &&
        typeof tx.status === "object" &&
        typeof tx.status.confirmed === "boolean"
    );
};

interface SubscribeMessage {
    "track-addresses": string[];
}

interface WebSocketMessage {
    "multi-address-transactions"?: Record<
        string,
        {
            mempool: ExplorerTransaction[];
            confirmed: ExplorerTransaction[];
            removed: ExplorerTransaction[];
        }
    >;
}
