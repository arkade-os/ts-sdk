import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { sha256 } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import type { ElectrumWS } from "ws-electrumx-client";
import type { Network } from "../networks";
import type { Coin } from "../wallet";
import type { ExplorerTransaction, OnchainProvider } from "./onchain";

// Electrum protocol method names
const BroadcastTransaction = "blockchain.transaction.broadcast";
const BroadcastPackageMethod = "blockchain.transaction.broadcast_package";
const EstimateFee = "blockchain.estimatefee";
const GetBlockHeader = "blockchain.block.header";
const GetHistoryMethod = "blockchain.scripthash.get_history";
const GetTransactionMethod = "blockchain.transaction.get";
const GetTransactionMerkleMethod = "blockchain.transaction.get_merkle";
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
    /** Raw transaction hex. Bitcoin Core's getrawtransaction <tx> 1 always
     *  includes this; we use it to derive exact satoshi amounts instead of
     *  multiplying the floating-point `value` field by 1e8. */
    hex?: string;
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
 * Server response for `blockchain.transaction.broadcast_package` (verbose=false).
 * `errors` is null/undefined on success and populated when at least one
 * transaction in the package was rejected by the mempool. The exact error
 * shape mirrors bitcoind's `submitpackage` RPC and varies across Core
 * versions.
 */
type BroadcastPackageResult = {
    success: boolean;
    errors?: Array<Record<string, unknown>> | null;
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
    // Cached chain tip kept fresh by the headers subscription. Initialized
    // lazily on first call to subscribeHeaders().
    private cachedTip: HeaderSubscribeResult | null = null;
    private headersSubscribePromise: Promise<HeaderSubscribeResult> | null =
        null;

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

    /**
     * Look up the block height of a confirmed transaction without relying
     * on the verbose-tx endpoint. `blockchain.transaction.get_merkle` is
     * part of the standard SPV protocol and is supported by both Fulcrum
     * and electrs (whereas `blockchain.transaction.get` with verbose=true
     * is Fulcrum-only). Returns `null` when the tx is in the mempool —
     * electrs in that case rejects with a "not yet in a block" error.
     */
    async fetchTxMerkle(txid: string): Promise<{ blockHeight: number } | null> {
        let result: { block_height: number } | undefined;
        try {
            result = await this.ws.request<{ block_height: number }>(
                GetTransactionMerkleMethod,
                txid
            );
        } catch (err) {
            // electrs/Fulcrum raise a specific error when the tx isn't yet in
            // a block. Map ONLY that case to mempool/unknown; everything else
            // (auth failure, network outage, malformed response) must surface
            // so callers can fail rather than silently treat the tx as
            // unconfirmed forever.
            if (isTxNotInBlockError(err)) return null;
            throw err;
        }
        if (
            !result ||
            typeof result.block_height !== "number" ||
            result.block_height <= 0
        ) {
            return null;
        }
        return { blockHeight: result.block_height };
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
        const headerHex = await this.ws.request<string>(GetBlockHeader, height);
        return { height, hex: headerHex };
    }

    /**
     * Returns the current chain tip and keeps it fresh via a single
     * server-side subscription. Subsequent calls return the cached tip
     * (updated by background notifications) without round-tripping to the
     * server. Previously each call issued `blockchain.headers.subscribe` as
     * a regular request, leaving a stale subscription on the server every
     * time — under polling that adds up. ws-electrumx-client deduplicates
     * `subscribe()` by method+params, so registering once is enough.
     */
    async subscribeHeaders(): Promise<HeaderSubscribeResult> {
        if (this.cachedTip) return this.cachedTip;
        if (this.headersSubscribePromise) return this.headersSubscribePromise;

        this.headersSubscribePromise = new Promise<HeaderSubscribeResult>(
            (resolve, reject) => {
                let resolved = false;
                this.ws
                    .subscribe(SubscribeHeadersMethod, (header: unknown) => {
                        if (!isHeaderSubscribeResult(header)) return;
                        this.cachedTip = header;
                        if (!resolved) {
                            resolved = true;
                            resolve(header);
                        }
                    })
                    .catch((err) => {
                        if (!resolved) {
                            resolved = true;
                            reject(err);
                        }
                    });
            }
        );

        try {
            return await this.headersSubscribePromise;
        } catch (err) {
            // Allow the next call to retry from scratch.
            this.headersSubscribePromise = null;
            throw err;
        }
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

    /**
     * Submit a package of raw transactions atomically via Fulcrum's
     * `blockchain.transaction.broadcast_package` method, the on-the-wire
     * equivalent of bitcoind's `submitpackage` RPC.
     *
     * Required for TRUC (BIP 431) 1P1C relay where the parent has zero
     * (or below-minfee) fee and depends on the child to pay for both via
     * CPFP — sequential broadcast cannot work in that case because the
     * parent would be rejected from the mempool on its own.
     *
     * @param txHexes - Topologically sorted raw transactions; child must
     *                  be the last element. Currently must be a 1P1C pair
     *                  (length 2). Parents may not depend on each other.
     * @returns The child transaction id (the last entry in the array),
     *          computed locally — `broadcast_package` itself returns
     *          `{success, errors}` rather than a txid.
     * @throws If the server does not implement `broadcast_package` (e.g.
     *         ElectrumX, or older Fulcrum, or Fulcrum backed by bitcoind
     *         < v28.0.0). Callers must surface this clearly to users —
     *         this method does NOT silently fall back to sequential
     *         broadcasts because doing so would let TRUC packages fail
     *         in subtle ways.
     * @throws If the server returns `success=false`, surfacing the
     *         underlying mempool rejection in the error message.
     */
    async broadcastPackage(txHexes: string[]): Promise<string> {
        const result = await this.ws.request<BroadcastPackageResult>(
            BroadcastPackageMethod,
            txHexes,
            false
        );
        if (!result.success) {
            const detail = result.errors
                ? JSON.stringify(result.errors)
                : "unknown error";
            throw new Error(`Package broadcast rejected: ${detail}`);
        }
        // The child txid is not in the response — derive it from the raw
        // bytes (double-SHA256 of the serialized tx, reversed).
        return childTxidFromHex(txHexes[txHexes.length - 1]);
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
        const script = this.encodeAddress(address);
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

    /**
     * Broadcast a single transaction or a TRUC (BIP 431) 1P1C package
     * atomically.
     *
     * **Server requirements for 1P1C packages:** the backing Electrum
     * server must implement `blockchain.transaction.broadcast_package`
     * (Fulcrum ≥ 1.10) and be backed by bitcoind ≥ v28.0.0. ElectrumX
     * does not implement this method. There is **no fallback** to
     * sequential parent-then-child broadcast: TRUC packages typically
     * have a zero-fee parent and would be rejected from the mempool on
     * their own, so a fallback would silently fail in subtle ways.
     * Callers receiving a "method not found" error here should route
     * through a different provider for that submission.
     *
     * @param txs - One transaction (single broadcast) or two
     *              topologically-sorted transactions (parent first,
     *              child last) for 1P1C package relay.
     * @returns The broadcast txid (or the child txid for 1P1C packages).
     */
    async broadcastTransaction(...txs: string[]): Promise<string> {
        if (txs.length === 1) {
            return this.chain.broadcastTransaction(txs[0]);
        }
        if (txs.length === 2) {
            return this.chain.broadcastPackage(txs);
        }
        throw new Error("Only 1 or 1P1C package can be broadcast");
    }

    async getTxOutspends(
        txid: string
    ): Promise<{ spent: boolean; txid: string }[]> {
        // Step 1: fetch the creating tx to get its output scripts (1 round trip)
        const [txResult] = await this.chain.fetchTransactions([txid]);
        const tx = Transaction.fromRaw(hex.decode(txResult.hex), {
            allowUnknownOutputs: true,
        });

        const outputCount = tx.outputsLength;
        const outputScriptHashes: (string | undefined)[] = [];
        for (let i = 0; i < outputCount; i++) {
            const output = tx.getOutput(i);
            outputScriptHashes.push(
                output.script ? toScriptHash(output.script) : undefined
            );
        }

        const validScriptHashes = outputScriptHashes.filter(
            (h): h is string => h !== undefined
        );

        const results: { spent: boolean; txid: string }[] = Array.from(
            { length: outputCount },
            () => ({ spent: false, txid: "" })
        );

        if (validScriptHashes.length === 0) return results;

        // Step 2: batch listunspent for all output scripthashes (1 round trip)
        // This tells us exactly which txid:vout pairs are still unspent.
        const unspentBatch = await this.ws.batchRequest<UnspentElectrum[][]>(
            ...validScriptHashes.map((sh) => ({
                method: ListUnspentMethod,
                params: [sh],
            }))
        );

        const unspentSet = new Set<string>();
        let validIdx = 0;
        for (let i = 0; i < outputCount; i++) {
            if (outputScriptHashes[i] !== undefined) {
                for (const u of unspentBatch[validIdx]) {
                    unspentSet.add(`${u.tx_hash}:${u.tx_pos}`);
                }
                validIdx++;
            }
        }

        // Step 3: batch get_history only for spent outputs (1 round trip)
        const spentIndices: number[] = [];
        const spentScriptHashes: string[] = [];
        for (let i = 0; i < outputCount; i++) {
            const sh = outputScriptHashes[i];
            if (sh && !unspentSet.has(`${txid}:${i}`)) {
                spentIndices.push(i);
                spentScriptHashes.push(sh);
            }
        }

        if (spentIndices.length === 0) return results;

        const histories = await this.ws.batchRequest<TransactionHistory[][]>(
            ...spentScriptHashes.map((sh) => ({
                method: GetHistoryMethod,
                params: [sh],
            }))
        );

        // For each spent output find the spender in its history.
        // Common case: history has exactly 2 entries (creating + spending tx).
        // Ambiguous case (same script reused): batch-fetch all candidates at once.
        const ambiguousIndices: number[] = [];
        const ambiguousCandidates: string[][] = [];

        for (let j = 0; j < spentIndices.length; j++) {
            const i = spentIndices[j];
            const candidates = histories[j]
                .map((h) => h.tx_hash)
                .filter((hash) => hash !== txid);

            if (candidates.length === 1) {
                // Fast path: one candidate = the spender
                results[i] = { spent: true, txid: candidates[0] };
            } else if (candidates.length > 1) {
                ambiguousIndices.push(i);
                ambiguousCandidates.push(candidates);
            }
            // candidates.length === 0 → mempool eviction, treat as unspent
        }

        // Step 4 (rare): batch-fetch all ambiguous candidate txs at once
        if (ambiguousIndices.length > 0) {
            const allCandidateTxids = [...new Set(ambiguousCandidates.flat())];
            const fetched =
                await this.chain.fetchTransactions(allCandidateTxids);
            const txMap = new Map(fetched.map((t) => [t.txID, t.hex]));

            for (let j = 0; j < ambiguousIndices.length; j++) {
                const i = ambiguousIndices[j];
                for (const candidateTxid of ambiguousCandidates[j]) {
                    const rawHex = txMap.get(candidateTxid);
                    if (!rawHex) continue;
                    const candidateTx = Transaction.fromRaw(
                        hex.decode(rawHex),
                        { allowUnknownOutputs: true, allowUnknownInputs: true }
                    );
                    let found = false;
                    for (let k = 0; k < candidateTx.inputsLength; k++) {
                        const input = candidateTx.getInput(k);
                        if (
                            input.txid &&
                            hex.encode(input.txid) === txid &&
                            input.index === i
                        ) {
                            results[i] = { spent: true, txid: candidateTxid };
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
            }
        }

        return results;
    }

    async getTransactions(address: string): Promise<ExplorerTransaction[]> {
        const script = this.encodeAddress(address);
        const history = await this.chain.fetchHistory(script);
        if (history.length === 0) return [];
        return this.historyToExplorerTxs(history);
    }

    /**
     * Resolve a list of `{tx_hash, height}` entries (as returned by the
     * scripthash history endpoint) into ExplorerTransaction shape **without
     * using the verbose-tx endpoint**, which only Fulcrum implements. We
     * reconstruct everything the verbose response would have given us:
     *   - vouts ← parse the raw tx (exact sat amounts, no float precision risk)
     *   - block_time ← batch-fetch the block headers for the heights present
     *   - addresses ← decode each output's scriptPubKey via @scure/btc-signer
     */
    private async historyToExplorerTxs(
        history: TransactionHistory[]
    ): Promise<ExplorerTransaction[]> {
        const txids = history.map((h) => h.tx_hash);
        const rawTxs = await this.chain.fetchTransactions(txids);
        const rawHexByTxid = new Map(rawTxs.map((t) => [t.txID, t.hex]));

        // De-duplicated per-height header lookup via Promise.allSettled.
        //
        // We deliberately avoid `fetchBlockHeaders` (which uses the library's
        // batchRequest) here: when one element of a batch fails (e.g. a height
        // that hits electrs's "missingheight" index-lag race), the library's
        // `Promise.all` rejects with that one error but leaves the other
        // in-flight requests pending. When their responses arrive later, the
        // library rejects them too — and nobody's awaiting them, so they
        // surface as unhandled rejections that crash the test runner.
        //
        // Per-height fetches with allSettled give every promise a handler,
        // and missing block_time degrades to 0 the same way the old verbose-
        // tx code did via `vtx.blocktime || vtx.time || 0`. Txid + confirmed
        // status are still authoritative.
        const confirmedHeights = [
            ...new Set(history.map((h) => h.height).filter((h) => h > 0)),
        ];
        const blockTimeByHeight = new Map<number, number>();
        if (confirmedHeights.length > 0) {
            const settled = await Promise.allSettled(
                confirmedHeights.map((h) => this.chain.fetchBlockHeader(h))
            );
            settled.forEach((res) => {
                if (res.status === "fulfilled") {
                    blockTimeByHeight.set(
                        res.value.height,
                        parseBlockHeader(res.value.hex).timestamp
                    );
                }
                // Rejections leave the height absent from the map →
                // buildExplorerTx falls back to block_time = 0.
            });
        }

        return history.map((entry) =>
            this.buildExplorerTx(
                entry,
                rawHexByTxid.get(entry.tx_hash),
                blockTimeByHeight
            )
        );
    }

    /**
     * Build an ExplorerTransaction from a history entry plus the raw tx hex
     * (when known) and a height→block_time map. Parse errors propagate —
     * silently returning an empty vout would hide real outputs (e.g. a
     * deposit) and is far worse for protocol-level money handling than
     * failing the whole batch.
     */
    private buildExplorerTx(
        entry: TransactionHistory,
        rawHex: string | undefined,
        blockTimeByHeight: Map<number, number>
    ): ExplorerTransaction {
        const vout: ExplorerTransaction["vout"] = [];
        if (rawHex) {
            let tx: Transaction;
            try {
                tx = Transaction.fromRaw(hex.decode(rawHex), {
                    allowUnknownOutputs: true,
                    allowUnknownInputs: true,
                });
            } catch (err) {
                throw new Error(
                    `Failed to parse raw tx for ${entry.tx_hash}: ${err instanceof Error ? err.message : String(err)}`
                );
            }
            for (let i = 0; i < tx.outputsLength; i++) {
                const output = tx.getOutput(i);
                const scriptHex = output.script
                    ? hex.encode(output.script)
                    : "";
                vout.push({
                    scriptpubkey_address: scriptHex
                        ? (this.chain.addressForScript(scriptHex) ?? "")
                        : "",
                    value: (output.amount ?? 0n).toString(),
                });
            }
        }

        return {
            txid: entry.tx_hash,
            vout,
            status: {
                confirmed: entry.height > 0,
                block_time: blockTimeByHeight.get(entry.height) ?? 0,
            },
        };
    }

    /**
     * Decode `address` into its scriptPubKey, throwing a clear error if the
     * input is malformed. @scure/btc-signer raises a generic decode error
     * which is hard to map back to user input — this wraps it.
     */
    private encodeAddress(address: string): Uint8Array {
        try {
            return OutScript.encode(Address(this.network).decode(address));
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`Invalid address ${address}: ${reason}`);
        }
    }

    async getTxStatus(
        txid: string
    ): Promise<
        | { confirmed: false }
        | { confirmed: true; blockTime: number; blockHeight: number }
    > {
        // Use `transaction.get_merkle` rather than the verbose `transaction.get`
        // because electrs (used by mempool.space, blockstream.info, and the
        // nigiri regtest) doesn't implement verbose. get_merkle is part of the
        // standard SPV protocol and supported by every Electrum server.
        const merkle = await this.chain.fetchTxMerkle(txid);
        if (!merkle) return { confirmed: false };

        // Header lookup can transiently race with electrs's index right
        // after a fresh block — listunspent/get_merkle expose the new
        // height before block.header(N) is queryable. Tolerate that the
        // same way historyToExplorerTxs does: confirmation status and
        // height are still authoritative; only block_time degrades.
        let blockTime = 0;
        try {
            const header = await this.chain.fetchBlockHeader(
                merkle.blockHeight
            );
            blockTime = parseBlockHeader(header.hex).timestamp;
        } catch (err) {
            if (!isMissingHeightError(err)) throw err;
        }
        return {
            confirmed: true,
            blockHeight: merkle.blockHeight,
            blockTime,
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
        const scripts = addresses.map((addr) => this.encodeAddress(addr));
        const scriptHashes = scripts.map(toScriptHash);
        // O(1) scripthash → script lookup, kept in sync with the
        // scripts/scriptHashes arrays. Server notifications hit this on
        // every push, so the previous indexOf was O(n) per event.
        const scriptByHash = new Map<string, Uint8Array>(
            scriptHashes.map((h, i) => [h, scripts[i]])
        );

        // Track known history per script to detect new txs.
        const knownTxids = new Map<string, Set<string>>();

        // Initialize known-set in parallel — for a wallet watching many
        // addresses this avoids n sequential round trips on first call.
        const initialHistories = await Promise.all(
            scripts.map((s) => this.chain.fetchHistory(s))
        );
        initialHistories.forEach((history, i) => {
            knownTxids.set(
                scriptHashes[i],
                new Set(history.map((h) => h.tx_hash))
            );
        });

        // Per-scripthash mutex serializing concurrent notifications so
        // two pushes for the same address can't fetch history in parallel
        // and emit duplicate events. Each call chains onto the previous
        // one's tail; failures are swallowed to keep the chain alive.
        const inFlight = new Map<string, Promise<void>>();

        const processStatusChange = async (
            scripthash: string
        ): Promise<void> => {
            const script = scriptByHash.get(scripthash);
            if (!script) return;

            const history = await this.chain.fetchHistory(script);
            const known = knownTxids.get(scripthash) ?? new Set<string>();
            const newEntries = history.filter(
                (entry) => !known.has(entry.tx_hash)
            );

            if (newEntries.length === 0) return;

            // Map the new history entries through the same non-verbose
            // pipeline getTransactions uses, so subscribe-driven and
            // poll-driven callers see ExplorerTransactions of identical shape.
            // The dedupe set is updated ONLY after delivery succeeds —
            // otherwise a failed fetch or callback would permanently mark
            // these txids as seen and the next notification wouldn't
            // re-deliver them.
            const explorerTxs = await this.historyToExplorerTxs(newEntries);
            eventCallback(explorerTxs);
            for (const entry of newEntries) known.add(entry.tx_hash);
            knownTxids.set(scripthash, known);
        };

        const handleStatusChange = (scripthash: string): Promise<void> => {
            const previous = inFlight.get(scripthash) ?? Promise.resolve();
            const next = previous.then(() => processStatusChange(scripthash));
            // Keep the chain alive even when one link rejects.
            inFlight.set(
                scripthash,
                next.catch(() => undefined)
            );
            return next;
        };

        // Register all subscriptions in parallel; if any one fails, tear
        // down the others so we don't leak server-side subscriptions on
        // a connection the caller never gets a stop() handle for.
        const subscribed: Uint8Array[] = [];
        try {
            await Promise.all(
                scripts.map(async (script) => {
                    await this.chain.subscribeScriptStatus(
                        script,
                        (scripthash, status) => {
                            if (status !== null) {
                                handleStatusChange(scripthash).catch(
                                    console.error
                                );
                            }
                        }
                    );
                    subscribed.push(script);
                })
            );
        } catch (err) {
            await Promise.allSettled(
                subscribed.map((s) => this.chain.unsubscribeScriptStatus(s))
            );
            throw err;
        }

        return () => {
            for (const script of scripts) {
                this.chain.unsubscribeScriptStatus(script).catch(() => {});
            }
        };
    }

    /** Close the underlying WebSocket connection. */
    async close(): Promise<void> {
        await this.chain.close();
    }
}

function toScriptHash(script: Uint8Array): string {
    return hex.encode(sha256(script).reverse());
}

function isHeaderSubscribeResult(v: unknown): v is HeaderSubscribeResult {
    if (typeof v !== "object" || v === null) return false;
    const obj = v as Record<string, unknown>;
    return typeof obj.height === "number" && typeof obj.hex === "string";
}

/**
 * Recognise the "block header not yet indexable" failure shape returned by
 * electrum servers (electrs in particular) when `block.header(N)` runs
 * against a height that's already in `listunspent`/`get_merkle` but hasn't
 * been indexed yet. Surfaced as `missingheight`. Tolerated by callers so
 * the index-lag race doesn't poison confirmed-status reads; genuine
 * failures (auth/network) propagate.
 */
function isMissingHeightError(err: unknown): boolean {
    const msg =
        err instanceof Error ? err.message : typeof err === "string" ? err : "";
    return msg.toLowerCase().includes("missingheight");
}

/**
 * Recognise the "transaction not in a block yet" failure shape returned by
 * electrum servers when `blockchain.transaction.get_merkle` is asked about a
 * mempool tx. electrs surfaces this as the strings below; Fulcrum mirrors
 * the wording. We match conservatively so genuine errors (auth, network,
 * malformed response) still propagate.
 */
function isTxNotInBlockError(err: unknown): boolean {
    const msg =
        err instanceof Error ? err.message : typeof err === "string" ? err : "";
    const normalized = msg.toLowerCase();
    return (
        normalized.includes("not yet in a block") ||
        normalized.includes("not in a block") ||
        normalized.includes("not in block") ||
        normalized.includes("no confirmed transaction")
    );
}

/**
 * Compute the txid of a serialized transaction. For segwit transactions
 * (every Ark transaction), the broadcast hex includes witness data, but
 * the txid is the double-SHA256 of the legacy (witness-stripped)
 * serialization. Hashing the raw broadcast bytes directly would yield
 * the wtxid instead — silently breaking any caller that tracks the tx
 * by id (round settlement, forfeit monitoring, exit paths).
 *
 * Delegating to `Transaction.fromRaw(...).id` lets @scure/btc-signer
 * handle the witness-stripping correctly.
 */
function childTxidFromHex(txHex: string): string {
    const tx = Transaction.fromRaw(hex.decode(txHex), {
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
    });
    return tx.id;
}
