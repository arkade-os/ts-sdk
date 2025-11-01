import type { NetworkName } from "../networks";
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

function isValidBlocksTip(
    tip: any
): tip is { id: string; height: number; mediantime: number }[] {
    return (
        Array.isArray(tip) &&
        tip.every((t) => {
            return (
                t &&
                typeof t === "object" &&
                typeof t.id === "string" &&
                t.id.length > 0 &&
                typeof t.height === "number" &&
                t.height >= 0 &&
                typeof t.mediantime === "number" &&
                t.mediantime > 0
            );
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
