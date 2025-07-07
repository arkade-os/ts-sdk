import type { NetworkName } from "../networks";
import { Coin } from "../wallet";

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
        value: bigint;
    }[];
    status: {
        confirmed: boolean;
        block_time: number;
    };
};

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number>;
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
        const response = await fetch(`${this.baseUrl}/fee-estimates`);
        if (!response.ok) {
            throw new Error(`Failed to fetch fee rate: ${response.statusText}`);
        }
        const fees = (await response.json()) as Record<string, number>;
        return fees["1"];
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

    async getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }> {
        const tipResponse = await fetch(`${this.baseUrl}/blocks/tip/hash`);
        if (!tipResponse.ok) {
            throw new Error(
                `Failed to get chain tip: ${tipResponse.statusText}`
            );
        }

        const hash = await tipResponse.text();
        const blockResponse = await fetch(`${this.baseUrl}/block/${hash}`);
        const block = await blockResponse.json();
        return {
            height: block.height,
            time: block.mediantime,
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
