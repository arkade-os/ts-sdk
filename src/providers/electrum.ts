import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { sha256 } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import type { ElectrumWS } from "ws-electrumx-client";
import type { Network } from "../networks";
import type { Coin } from "../wallet";
import type { ExplorerTransaction, OnchainProvider } from "./onchain";

// Electrum protocol method names
const BroadcastTransaction = "blockchain.transaction.broadcast";
const EstimateFee = "blockchain.estimatefee";
const GetBlockHeader = "blockchain.block.header";
const GetHistoryMethod = "blockchain.scripthash.get_history";
const GetTransactionMethod = "blockchain.transaction.get";
const SubscribeStatusMethod = "blockchain.scripthash";
const SubscribeHeadersMethod = "blockchain.headers";
const GetRelayFeeMethod = "blockchain.relayfee";
const ListUnspentMethod = "blockchain.scripthash.listunspent";

const MISSING_TRANSACTION = "missingtransaction";
const MAX_FETCH_TRANSACTIONS_ATTEMPTS = 5;

// Bitcoin block header is 80 bytes
const BLOCK_HEADER_SIZE = 80;

export type TransactionHistory = {
    tx_hash: string;
    height: number;
    fee?: number;
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
    value: number;
};

type VerboseTransaction = {
    txid: string;
    confirmations: number;
    blockhash?: string;
    blocktime?: number;
    time?: number;
    vout: {
        n: number;
        value: number;
        scriptPubKey: {
            addresses?: string[];
            address?: string;
            hex: string;
        };
    }[];
    vin: {
        txid: string;
        vout: number;
    }[];
};

type HeaderSubscribeResult = {
    height: number;
    hex: string;
};

/**
 * Parse a raw block header (80 bytes hex = 160 chars) to extract fields.
 * Bitcoin block header layout:
 *   - version: 4 bytes (LE)
 *   - prevHash: 32 bytes
 *   - merkleRoot: 32 bytes
 *   - timestamp: 4 bytes (LE)
 *   - bits: 4 bytes
 *   - nonce: 4 bytes
 */
function parseBlockHeader(headerHex: string): {
    hash: string;
    timestamp: number;
} {
    const headerBytes = hex.decode(headerHex);
    if (headerBytes.length !== BLOCK_HEADER_SIZE) {
        throw new Error(
            `Invalid block header size: ${headerBytes.length}, expected ${BLOCK_HEADER_SIZE}`
        );
    }

    // timestamp is at offset 68 (4+32+32), 4 bytes little-endian
    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset);
    const timestamp = view.getUint32(68, true);

    // block hash = double SHA256 of header, reversed
    const hash1 = sha256(headerBytes);
    const hash2 = sha256(hash1);
    const hashStr = hex.encode(new Uint8Array(hash2).reverse());

    return { hash: hashStr, timestamp };
}

/**
 * WebSocket-based Electrum chain source using ws-electrumx-client.
 * Provides low-level methods for the Electrum protocol.
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
                const msg = e instanceof Error ? e.message : String(e);
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

    async fetchVerboseTransaction(txid: string): Promise<VerboseTransaction> {
        return this.ws.request<VerboseTransaction>(
            GetTransactionMethod,
            txid,
            true
        );
    }

    async fetchVerboseTransactions(
        txids: string[]
    ): Promise<VerboseTransaction[]> {
        if (txids.length === 0) return [];
        const requests = txids.map((txid) => ({
            method: GetTransactionMethod,
            params: [txid, true],
        }));
        return this.ws.batchRequest<VerboseTransaction[]>(...requests);
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

    async fetchHistory(script: Uint8Array): Promise<TransactionHistory[]> {
        const scriptHash = toScriptHash(script);
        return this.ws.request<TransactionHistory[]>(
            GetHistoryMethod,
            scriptHash
        );
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

    async fetchBlockHeader(height: number): Promise<BlockHeader> {
        const headerHex = await this.ws.request<string>(
            GetBlockHeader,
            height
        );
        return { height, hex: headerHex };
    }

    async subscribeHeaders(): Promise<HeaderSubscribeResult> {
        return this.ws.request<HeaderSubscribeResult>(
            SubscribeHeadersMethod + ".subscribe"
        );
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

    /**
     * Get the address string for a script output, if decodable.
     */
    addressForScript(scriptHex: string): string | undefined {
        try {
            const script = hex.decode(scriptHex);
            return Address(this.network).encode(OutScript.decode(script));
        } catch {
            return undefined;
        }
    }
}

/**
 * Electrum-based implementation of the OnchainProvider interface.
 * Replaces esplora polling with electrum subscriptions where possible.
 *
 * @example
 * ```typescript
 * import { ElectrumWS } from "ws-electrumx-client";
 * import { ElectrumOnchainProvider } from "./providers/electrum";
 * import { networks } from "./networks";
 *
 * const ws = new ElectrumWS("wss://electrum.blockstream.info:50004");
 * const provider = new ElectrumOnchainProvider(ws, networks.bitcoin);
 *
 * const coins = await provider.getCoins("bc1q...");
 * ```
 */
export class ElectrumOnchainProvider implements OnchainProvider {
    private chain: WsElectrumChainSource;

    constructor(
        private ws: ElectrumWS,
        private network: Network
    ) {
        this.chain = new WsElectrumChainSource(ws, network);
    }

    async getCoins(address: string): Promise<Coin[]> {
        const script = OutScript.encode(Address(this.network).decode(address));
        const scriptHash = toScriptHash(script);
        const unspents = await this.ws.request<UnspentElectrum[]>(
            ListUnspentMethod,
            scriptHash
        );

        return unspents.map((u) => ({
            txid: u.tx_hash,
            vout: u.tx_pos,
            value: u.value,
            status: {
                confirmed: u.height > 0,
                block_height: u.height > 0 ? u.height : undefined,
            },
        }));
    }

    async getFeeRate(): Promise<number | undefined> {
        // electrum returns BTC/kB, we need sat/vB
        // 1 BTC = 100_000_000 sat, 1 kB = 1000 bytes
        // sat/vB = (BTC/kB) * 100_000_000 / 1000 = (BTC/kB) * 100_000
        const feePerKb = await this.chain.estimateFees(1);
        if (feePerKb < 0) {
            // -1 means the daemon cannot estimate
            return undefined;
        }
        return Math.max(1, Math.ceil(feePerKb * 100_000));
    }

    async broadcastTransaction(...txs: string[]): Promise<string> {
        if (txs.length === 1) {
            return this.chain.broadcastTransaction(txs[0]);
        }
        if (txs.length === 2) {
            // Broadcast parent first, then child (electrum doesn't support package relay)
            await this.chain.broadcastTransaction(txs[0]);
            return this.chain.broadcastTransaction(txs[1]);
        }
        throw new Error("Only 1 or 1C1P package can be broadcast");
    }

    async getTxOutspends(
        txid: string
    ): Promise<{ spent: boolean; txid: string }[]> {
        // Get the raw transaction to find its outputs
        const [txResult] = await this.chain.fetchTransactions([txid]);
        const tx = Transaction.fromRaw(hex.decode(txResult.hex), {
            allowUnknownOutputs: true,
        });

        const results: { spent: boolean; txid: string }[] = [];

        for (let i = 0; i < tx.outputsLength; i++) {
            const output = tx.getOutput(i);
            if (!output.script) {
                results.push({ spent: false, txid: "" });
                continue;
            }

            const outScriptHash = toScriptHash(output.script);
            const history = await this.ws.request<TransactionHistory[]>(
                GetHistoryMethod,
                outScriptHash
            );

            // Find a spending tx: any tx in the history that is NOT the original tx
            // and spends this output
            let spentByTxid = "";
            let isSpent = false;

            for (const entry of history) {
                if (entry.tx_hash === txid) continue;
                // Fetch this tx and check if it spends our output
                const [spenderResult] = await this.chain.fetchTransactions([
                    entry.tx_hash,
                ]);
                const spenderTx = Transaction.fromRaw(
                    hex.decode(spenderResult.hex),
                    {
                        allowUnknownOutputs: true,
                        allowUnknownInputs: true,
                    }
                );
                for (let j = 0; j < spenderTx.inputsLength; j++) {
                    const input = spenderTx.getInput(j);
                    if (
                        input.txid &&
                        hex.encode(input.txid) === txid &&
                        input.index === i
                    ) {
                        isSpent = true;
                        spentByTxid = entry.tx_hash;
                        break;
                    }
                }
                if (isSpent) break;
            }

            results.push({ spent: isSpent, txid: spentByTxid });
        }

        return results;
    }

    async getTransactions(address: string): Promise<ExplorerTransaction[]> {
        const script = OutScript.encode(Address(this.network).decode(address));
        const history = await this.chain.fetchHistory(script);

        if (history.length === 0) return [];

        const txids = history.map((h) => h.tx_hash);
        const verboseTxs =
            await this.chain.fetchVerboseTransactions(txids);

        return verboseTxs.map((vtx) => ({
            txid: vtx.txid,
            vout: vtx.vout.map((v) => ({
                scriptpubkey_address:
                    v.scriptPubKey.address ||
                    v.scriptPubKey.addresses?.[0] ||
                    this.chain.addressForScript(v.scriptPubKey.hex) ||
                    "",
                value: String(Math.round(v.value * 1e8)),
            })),
            status: {
                confirmed: vtx.confirmations > 0,
                block_time: vtx.blocktime || vtx.time || 0,
            },
        }));
    }

    async getTxStatus(
        txid: string
    ): Promise<
        | { confirmed: false }
        | { confirmed: true; blockTime: number; blockHeight: number }
    > {
        const vtx = await this.chain.fetchVerboseTransaction(txid);
        if (vtx.confirmations <= 0) {
            return { confirmed: false };
        }

        // Get block height from the verbose tx's blockhash
        // We need the height, which is confirmations-based:
        // height = tipHeight - confirmations + 1
        const tip = await this.chain.subscribeHeaders();
        const blockHeight = tip.height - vtx.confirmations + 1;

        return {
            confirmed: true,
            blockTime: vtx.blocktime || vtx.time || 0,
            blockHeight,
        };
    }

    async getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }> {
        const tip = await this.chain.subscribeHeaders();
        const { hash, timestamp } = parseBlockHeader(tip.hex);

        return {
            height: tip.height,
            time: timestamp,
            hash,
        };
    }

    async watchAddresses(
        addresses: string[],
        eventCallback: (txs: ExplorerTransaction[]) => void
    ): Promise<() => void> {
        const scripts = addresses.map((addr) =>
            OutScript.encode(Address(this.network).decode(addr))
        );
        const scriptHashes = scripts.map(toScriptHash);

        // Track known history per script to detect new txs
        const knownTxids = new Map<string, Set<string>>();

        // Initialize with current history
        for (let i = 0; i < scripts.length; i++) {
            const history = await this.chain.fetchHistory(scripts[i]);
            knownTxids.set(
                scriptHashes[i],
                new Set(history.map((h) => h.tx_hash))
            );
        }

        // Subscribe to each script hash
        const handleStatusChange = async (scripthash: string) => {
            // Find which script this is
            const scriptIndex = scriptHashes.indexOf(scripthash);
            if (scriptIndex === -1) return;

            const script = scripts[scriptIndex];
            const history = await this.chain.fetchHistory(script);
            const known = knownTxids.get(scripthash) || new Set();
            const newTxids = history
                .map((h) => h.tx_hash)
                .filter((txid) => !known.has(txid));

            if (newTxids.length === 0) return;

            // Update known set
            for (const txid of newTxids) {
                known.add(txid);
            }
            knownTxids.set(scripthash, known);

            // Fetch verbose transactions for new txids
            const verboseTxs =
                await this.chain.fetchVerboseTransactions(newTxids);

            const explorerTxs: ExplorerTransaction[] = verboseTxs.map(
                (vtx) => ({
                    txid: vtx.txid,
                    vout: vtx.vout.map((v) => ({
                        scriptpubkey_address:
                            v.scriptPubKey.address ||
                            v.scriptPubKey.addresses?.[0] ||
                            this.chain.addressForScript(v.scriptPubKey.hex) ||
                            "",
                        value: String(Math.round(v.value * 1e8)),
                    })),
                    status: {
                        confirmed: vtx.confirmations > 0,
                        block_time: vtx.blocktime || vtx.time || 0,
                    },
                })
            );

            eventCallback(explorerTxs);
        };

        for (let i = 0; i < scripts.length; i++) {
            await this.chain.subscribeScriptStatus(
                scripts[i],
                (scripthash, status) => {
                    if (status !== null) {
                        handleStatusChange(scripthash).catch(console.error);
                    }
                }
            );
        }

        // Return cleanup function
        return () => {
            for (const script of scripts) {
                this.chain.unsubscribeScriptStatus(script).catch(() => {});
            }
        };
    }
}

function toScriptHash(script: Uint8Array): string {
    return hex.encode(sha256(script).reverse());
}
