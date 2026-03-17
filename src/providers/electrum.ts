import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { sha256 } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import type { ElectrumWS } from "ws-electrumx-client";
import type { Network } from "../networks";

const BroadcastTransaction = "blockchain.transaction.broadcast"; // returns txid
const EstimateFee = "blockchain.estimatefee"; // returns fee rate in sats/kBytes
const GetBlockHeader = "blockchain.block.header"; // returns block header as hex string
const GetHistoryMethod = "blockchain.scripthash.get_history";
const GetTransactionMethod = "blockchain.transaction.get"; // returns hex string
const SubscribeStatusMethod = "blockchain.scripthash"; // ElectrumWS automatically adds '.subscribe'
const GetRelayFeeMethod = "blockchain.relayfee";
const ListUnspentMethod = "blockchain.scripthash.listunspent";

const MISSING_TRANSACTION = "missingtransaction";
const MAX_FETCH_TRANSACTIONS_ATTEMPTS = 5;

export type TransactionHistory = {
    tx_hash: string;
    height: number;
};

export type BlockHeader = {
    height: number;
    hex: string;
};

export type Unspent = {
    txid: string;
    vout: number;
    witnessUtxo: {
        script: Uint8Array;
        value: bigint;
    };
};

type UnspentElectrum = {
    height: number;
    tx_pos: number;
    tx_hash: string;
};

/**
 * WebSocket-based Electrum chain source using ws-electrumx-client.
 * Provides methods for querying transaction history, fetching transactions,
 * subscribing to script status updates, and broadcasting transactions.
 *
 * @example
 * ```typescript
 * import { ElectrumWS } from "ws-electrumx-client";
 * import { WsElectrumChainSource } from "./providers/electrum";
 * import { networks } from "./networks";
 *
 * const ws = new ElectrumWS("wss://electrum.blockstream.info:50004");
 * const chain = new WsElectrumChainSource(ws, networks.bitcoin);
 *
 * const history = await chain.fetchHistories([script]);
 * await chain.close();
 * ```
 */
export class WsElectrumChainSource {
    constructor(
        private ws: ElectrumWS,
        private network: Network
    ) {}

    async fetchTransactions(
        txids: string[]
    ): Promise<{ txID: string; hex: string }[]> {
        const requests = txids.map((txid) => ({
            method: GetTransactionMethod,
            params: [txid],
        }));
        for (let i = 0; i < MAX_FETCH_TRANSACTIONS_ATTEMPTS; i++) {
            try {
                const responses = await this.ws.batchRequest<string[]>(
                    ...requests
                );
                return responses.map((hexStr, i) => ({
                    txID: txids[i],
                    hex: hexStr,
                }));
            } catch (e) {
                const msg =
                    e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes(MISSING_TRANSACTION)) {
                    console.warn("missing transaction error, retrying");
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    continue;
                }
                throw e;
            }
        }
        throw new Error("Unable to fetch transactions: " + txids);
    }

    async unsubscribeScriptStatus(script: Uint8Array): Promise<void> {
        await this.ws
            .unsubscribe(SubscribeStatusMethod, toScriptHash(script))
            .catch(() => {});
    }

    async subscribeScriptStatus(
        script: Uint8Array,
        callback: (scripthash: string, status: string | null) => void
    ): Promise<void> {
        const scriptHash = toScriptHash(script);
        await this.ws.subscribe(
            SubscribeStatusMethod,
            (scripthash: unknown, status: unknown) => {
                if (scripthash === scriptHash) {
                    callback(scripthash as string, status as string | null);
                }
            },
            scriptHash
        );
    }

    async fetchHistories(
        scripts: Uint8Array[]
    ): Promise<TransactionHistory[][]> {
        const scriptsHashes = scripts.map((s) => toScriptHash(s));
        const responses = await this.ws.batchRequest<TransactionHistory[][]>(
            ...scriptsHashes.map((s) => ({
                method: GetHistoryMethod,
                params: [s],
            }))
        );
        return responses;
    }

    async fetchBlockHeaders(heights: number[]): Promise<BlockHeader[]> {
        const responses = await this.ws.batchRequest<string[]>(
            ...heights.map((h) => ({ method: GetBlockHeader, params: [h] }))
        );
        return responses.map((hexStr, i) => ({
            height: heights[i],
            hex: hexStr,
        }));
    }

    async estimateFees(targetNumberBlocks: number): Promise<number> {
        const feeRate = await this.ws.request<number>(
            EstimateFee,
            targetNumberBlocks
        );
        return feeRate;
    }

    async broadcastTransaction(txHex: string): Promise<string> {
        return this.ws.request<string>(BroadcastTransaction, txHex);
    }

    async getRelayFee(): Promise<number> {
        return this.ws.request<number>(GetRelayFeeMethod);
    }

    async close(): Promise<void> {
        try {
            await this.ws.close("close");
        } catch (e) {
            console.debug("error closing ws:", e);
        }
    }

    waitForAddressReceivesTx(addr: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const script = OutScript.encode(Address(this.network).decode(addr));
            this.subscribeScriptStatus(script, (_, status) => {
                if (status !== null) {
                    resolve();
                }
            }).catch(reject);
        });
    }

    async listUnspents(addr: string): Promise<Unspent[]> {
        const script = OutScript.encode(Address(this.network).decode(addr));
        const scriptHash = toScriptHash(script);
        const unspentsFromElectrum = await this.ws.request<UnspentElectrum[]>(
            ListUnspentMethod,
            scriptHash
        );
        const txs = await this.fetchTransactions(
            unspentsFromElectrum.map((u) => u.tx_hash)
        );

        return unspentsFromElectrum.map((u, index) => {
            const tx = Transaction.fromRaw(hex.decode(txs[index].hex), {
                allowUnknownOutputs: true,
            });
            const output = tx.getOutput(u.tx_pos);
            if (!output.script || output.amount === undefined) {
                throw new Error(
                    `Missing output data for ${u.tx_hash}:${u.tx_pos}`
                );
            }
            return {
                txid: u.tx_hash,
                vout: u.tx_pos,
                witnessUtxo: {
                    script: output.script,
                    value: output.amount,
                },
            };
        });
    }
}

function toScriptHash(script: Uint8Array): string {
    return hex.encode(sha256(script).reverse());
}
