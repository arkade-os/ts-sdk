import { BaseOnchainProvider } from "./base";
import type { NetworkName } from "../types/networks";
import type { UTXO } from "../types/internal";
import { Coin } from "../types/wallet";
import type { ExplorerTransaction } from "./base";

export const ESPLORA_URL: Record<NetworkName, string> = {
    bitcoin: "https://mempool.space/api",
    testnet: "https://mempool.space/testnet/api",
    signet: "https://mempool.space/signet/api",
    mutinynet: "https://mutinynet.com/api",
    regtest: "http://localhost:3000",
};

export class EsploraProvider extends BaseOnchainProvider {
    constructor(protected baseUrl: string) {
        super(baseUrl);
    }

    async getCoins(address: string): Promise<Coin[]> {
        const utxos = await this.getUTXOs(address);
        return this.convertUTXOsToCoin(utxos);
    }

    private async getUTXOs(address: string): Promise<UTXO[]> {
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
}
