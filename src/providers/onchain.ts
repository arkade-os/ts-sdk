import type { NetworkName } from "../networks";
import { Coin } from "../wallet";
import WebSocket from "ws";

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

const isExplorerTransaction = (tx: any): tx is ExplorerTransaction => {
    return (
        typeof tx.txid === "string" &&
        Array.isArray(tx.vout) &&
        tx.vout.every(
            (vout: any) =>
                typeof vout.scriptpubkey_address === "string" &&
                typeof vout.value === "string"
        ) &&
        typeof tx.status === "object" &&
        typeof tx.status.confirmed === "boolean" &&
        typeof tx.status.block_time === "number"
    );
};

interface SubscribeMessage {
    "track-address": string;
}

interface WebSocketMessage {
    "address-transactions"?: ExplorerTransaction[];
    "block-transactions"?: ExplorerTransaction[];
}

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number>;
    broadcastTransaction(txHex: string): Promise<string>;
    getTxOutspends(txid: string): Promise<{ spent: boolean; txid: string }[]>;
    getTransactions(address: string): Promise<ExplorerTransaction[]>;
    getTxStatus(txid: string): Promise<{
        confirmed: boolean;
        blockTime?: number;
        blockHeight?: number;
    }>;
    notifyIncomingFunds(
        address: string,
        eventCallback: (txs: ExplorerTransaction[]) => void
    ): Promise<void>;
}

export class EsploraProvider implements OnchainProvider {
    constructor(private baseUrl: string) {}

    async getCoins(address: string): Promise<Coin[]> {
        const response = await fetch(`${this.baseUrl}/address/${address}/utxo`);
        if (!response.ok) {
            throw new Error(`Failed to fetch UTXOs: ${response.statusText}`);
        }
        return response.json();
    }

    async getFeeRate(): Promise<number> {
        const response = await fetch(`${this.baseUrl}/v1/fees/recommended`);
        if (!response.ok) {
            throw new Error(`Failed to fetch fee rate: ${response.statusText}`);
        }
        const fees = await response.json();
        return fees.halfHourFee; // Return the "medium" priority fee rate
    }

    async broadcastTransaction(txHex: string): Promise<string> {
        const response = await fetch(`${this.baseUrl}/tx`, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
            },
            body: txHex,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to broadcast transaction: ${error}`);
        }

        return response.text(); // Returns the txid
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

    async getTxStatus(txid: string): Promise<{
        confirmed: boolean;
        blockTime?: number;
        blockHeight?: number;
    }> {
        const response = await fetch(`${this.baseUrl}/tx/${txid}/status`);
        if (!response.ok) {
            throw new Error(
                `Failed to get transaction status: ${response.statusText}`
            );
        }

        const data = await response.json();
        return {
            confirmed: data.confirmed,
            blockTime: data.block_time,
            blockHeight: data.block_height,
        };
    }

    async notifyIncomingFunds(
        address: string,
        callback: (txs: ExplorerTransaction[]) => void
    ): Promise<void> {
        const wsUrl = this.baseUrl.replace("http", "ws") + "/v1/ws/";
        const ws = new WebSocket(wsUrl);

        ws.on("open", () => {
            // subscribe to address updates
            const subscribeMsg: SubscribeMessage = {
                "track-address": address,
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: WebSocket.Data) => {
            try {
                const newTxs: ExplorerTransaction[] = [];
                const message: WebSocketMessage = JSON.parse(data.toString());

                // handle address (aka mempool) transactions
                if (
                    message["address-transactions"]?.every((tx: any) =>
                        isExplorerTransaction(tx)
                    )
                ) {
                    newTxs.push(...message["address-transactions"]);
                }

                // handle block (aka confirmed) transactions
                if (
                    message["block-transactions"]?.every((tx: any) =>
                        isExplorerTransaction(tx)
                    )
                ) {
                    newTxs.push(...message["block-transactions"]);
                }

                // callback with new transactions
                if (newTxs.length > 0) callback(newTxs);
            } catch (error) {
                console.error("Error parsing message:", error);
            }
        });

        ws.on("error", async (error: Error) => {
            // websocket is not reliable, so we will fallback to polling
            const pollingInterval = 5_000; // 5 seconds

            // initial fetch to get existing transactions
            const initialTxs = await this.getTransactions(address);

            // we use block_time in key to also notify when a transaction is confirmed
            const txKey = (tx: ExplorerTransaction) =>
                `${tx.txid}_${tx.status.block_time}`;

            // polling for new transactions
            setInterval(async () => {
                // get current transactions
                // we will compare with initialTxs to find new ones
                const currentTxs = await this.getTransactions(address);

                // if current transactions differ from initial, we have new transactions
                if (JSON.stringify(currentTxs) !== JSON.stringify(initialTxs)) {
                    // create a set of existing transactions to avoid duplicates
                    const existingTxs = new Set(initialTxs.map(txKey));

                    // filter out transactions that are already in initialTxs
                    const newTxs = currentTxs.filter(
                        (tx) => !existingTxs.has(txKey(tx))
                    );

                    if (newTxs.length > 0) {
                        initialTxs.push(...newTxs);
                        callback(newTxs);
                    }
                }
            }, pollingInterval);
        });
    }
}
