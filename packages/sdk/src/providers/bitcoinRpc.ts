/**
 * ============================================================================
 *  Bitcoin RPC Provider — Tier 1: On-chain Anchoring & Package Broadcast
 * ============================================================================
 *
 *  Implements VerificationOnchainProvider and ExitOnchainProvider by
 *  communicating with a Bitcoin Core full node via JSON-RPC.
 *
 *  Usage:
 *    const rpc = new BitcoinRpcProvider("http://localhost:18443", "user", "pass");
 * ============================================================================
 */

import { base64 } from "@scure/base";

/** Simplified Bitcoin RPC Result. */
export interface RpcResult<T> {
    result: T | null;
    error: { code: number; message: string } | null;
    id: string | number;
}

/** RPC raw transaction with verbose=true output. */
export interface VerboseTx {
    txid: string;
    hash: string;
    version: number;
    locktime: number;
    vin: any[];
    vout: {
        value: number;
        n: number;
        scriptPubKey: {
            asm: string;
            hex: string;
            address?: string;
            type: string;
        };
    }[];
    hex: string;
    confirmations?: number;
    blockhash?: string;
    blocktime?: number;
    time?: number;
}

export class BitcoinRpcError extends Error {
    constructor(
        message: string,
        public readonly code?: number,
    ) {
        super(`[BITCOIN-RPC] ${message} (code: ${code})`);
        this.name = "BitcoinRpcError";
    }
}

function isLoopbackHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    if (lower === "localhost" || lower === "::1" || lower === "[::1]") {
        return true;
    }
    const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
    if (ipv4) {
        return ipv4.slice(1).every((octet) => Number(octet) <= 255);
    }
    return false;
}

function assertSafeRpcUrl(url: string): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new BitcoinRpcError(`Invalid Bitcoin RPC URL: ${url}`, -1);
    }
    if (parsed.protocol === "https:") {
        return;
    }
    if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
        return;
    }
    throw new BitcoinRpcError(
        `Insecure Bitcoin RPC transport "${parsed.protocol}" for non-loopback host "${parsed.hostname}"; use https:// for remote RPC endpoints`,
        -1,
    );
}

/**
 * Bitcoin Core JSON-RPC provider for VTXO verification and package broadcast.
 *
 * Prerequisite: the verification pipeline reads the commitment transaction by txid only, so
 * the node must run with `-txindex=1`; otherwise `getTxStatus` throws `BitcoinRpcError`
 * (code -5, "-txindex"). Use `isTxIndexEnabled()` to check up front.
 */
export class BitcoinRpcProvider {
    private rpcId = 1;
    private txIndexChecked: boolean | null = null;

    constructor(
        public readonly url: string = "http://localhost:18443",
        private readonly user: string = "user",
        private readonly pass: string = "password",
        private readonly timeoutMs: number = 30000,
    ) {
        assertSafeRpcUrl(url);
    }

    /**
     * Internal JSON-RPC caller.
     */
    private async call<T>(method: string, params: any[] = []): Promise<T> {
        assertSafeRpcUrl(this.url);
        const auth = base64.encode(new TextEncoder().encode(`${this.user}:${this.pass}`));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let data: RpcResult<T>;
        try {
            const response = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Basic ${auth}`,
                },
                body: JSON.stringify({
                    jsonrpc: "1.0",
                    id: this.rpcId++,
                    method,
                    params,
                }),
                signal: controller.signal,
            });

            if (response.status === 401) {
                throw new BitcoinRpcError("Unauthorized (wrong RPC credentials)", 401);
            }

            let parsed: RpcResult<T> | null = null;
            let parseError: unknown = null;
            try {
                parsed = (await response.json()) as RpcResult<T>;
            } catch (err: any) {
                if (err?.name === "AbortError" || controller.signal.aborted) {
                    throw new BitcoinRpcError(
                        `RPC Request timed out after ${this.timeoutMs}ms`,
                        408,
                    );
                }
                parseError = err;
            }

            // Bitcoin Core returns JSON-RPC error payloads (e.g. -5, -27, -32601) on HTTP
            // 500/404/400 responses; surface the RPC error before falling back to HTTP status.
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.error &&
                typeof parsed.error === "object" &&
                typeof parsed.error.message === "string"
            ) {
                throw new BitcoinRpcError(
                    parsed.error.message,
                    typeof parsed.error.code === "number" ? parsed.error.code : response.status,
                );
            }

            if (!response.ok) {
                throw new BitcoinRpcError(
                    `HTTP Error: ${response.status} ${response.statusText}`,
                    response.status,
                );
            }

            if (parseError !== null) {
                const msg = parseError instanceof Error ? parseError.message : String(parseError);
                throw new BitcoinRpcError(`Invalid JSON-RPC response body: ${msg}`, -32700);
            }

            data = parsed as RpcResult<T>;
        } catch (error: any) {
            if (error instanceof BitcoinRpcError) {
                throw error;
            }
            if (error?.name === "AbortError" || controller.signal.aborted) {
                throw new BitcoinRpcError(`RPC Request timed out after ${this.timeoutMs}ms`, 408);
            }
            throw new BitcoinRpcError(`Network error: ${error?.message ?? String(error)}`, -1);
        } finally {
            clearTimeout(timeoutId);
        }

        // Strict Schema Validation
        if (typeof data !== "object" || data === null) {
            throw new BitcoinRpcError("Invalid JSON-RPC response format", -32603);
        }

        if (data.error) {
            throw new BitcoinRpcError(data.error.message, data.error.code);
        }

        if (data.result === null) {
            throw new BitcoinRpcError(`Method ${method} returned null`, -1);
        }

        // Sanitize common outputs: raw hex or objects with txid/hash fields
        const res = data.result as any;
        if (res && typeof res === "object") {
            if (res.txid && !/^[0-9a-fA-F]{64}$/.test(res.txid)) {
                throw new BitcoinRpcError(
                    `Oracle Poisoning Detected: Invalid TXID format in RPC response: ${res.txid}`,
                    -32603,
                );
            }
        } else if (typeof res === "string") {
            // If the result is a txid, it must be hex
            if (method === "sendrawtransaction" && !/^[0-9a-fA-F]{64}$/.test(res)) {
                throw new BitcoinRpcError("Invalid TXID format in broadcast response", -32603);
            }
        }

        return data.result;
    }

    /**
     * Checks if Bitcoin Core has txindex enabled and synced.
     */
    async isTxIndexEnabled(): Promise<boolean> {
        if (this.txIndexChecked !== null) return this.txIndexChecked;
        try {
            const indexInfo = await this.call<Record<string, { synced: boolean }>>("getindexinfo");
            if (
                typeof indexInfo === "object" &&
                indexInfo !== null &&
                indexInfo.txindex &&
                indexInfo.txindex.synced === true
            ) {
                this.txIndexChecked = true;
                return true;
            }
            this.txIndexChecked = false;
            return false;
        } catch (e) {
            // Finding E: Distinguish unsupported RPC method (-32601 / method not found)
            // from transient network/auth failures.
            // If getindexinfo is unsupported (-32601 or "Method not found"), treat as unverified/false.
            // Transient network/auth failures are rethrown so they are not cached or mistaken for index state.
            if (
                e instanceof BitcoinRpcError &&
                (e.code === -32601 || e.message.toLowerCase().includes("method not found"))
            ) {
                this.txIndexChecked = false;
                return false;
            }
            throw e;
        }
    }

    /**
     * Returns the raw transaction hex.
     * @param txid Transaction ID in hex.
     * @param blockhash Optional block hash where transaction was confirmed (required if txindex=0).
     */
    async getRawTransaction(txid: string, blockhash?: string): Promise<string> {
        const params: (string | boolean)[] = [txid, false];
        if (blockhash) params.push(blockhash);
        return await this.call<string>("getrawtransaction", params);
    }

    /**
     * Check if a transaction is confirmed and at what depth.
     * @param txid Transaction ID in hex.
     * @param blockhash Optional block hash where transaction was confirmed.
     */
    async getTxStatus(
        txid: string,
        blockhash?: string,
    ): Promise<
        | { confirmed: false; inMempool: boolean }
        | {
              confirmed: true;
              blockHeight: number;
              blockTime: number;
              blockHash?: string;
              confirmations?: number;
          }
    > {
        let tx: VerboseTx;
        try {
            // getrawtransaction txid [verbose=true] [blockhash]
            const params: (string | boolean)[] = [txid, true];
            if (blockhash) params.push(blockhash);
            tx = await this.call<VerboseTx>("getrawtransaction", params);
        } catch (e) {
            if (e instanceof BitcoinRpcError && e.code === -5) {
                // If Core indicates -txindex is disabled ("Use -txindex or provide a block hash..."
                // or older "activate -txindex"), throw so the caller knows historical lookup failed.
                if (e.message.includes("-txindex") && !blockhash) {
                    throw new BitcoinRpcError(
                        `Bitcoin Core requires -txindex to query historical transactions without blockhash for ${txid}`,
                        -5,
                    );
                }
                return { confirmed: false, inMempool: false };
            }
            throw e;
        }

        const confirmations = tx.confirmations ?? 0;
        if (confirmations <= 0) {
            return { confirmed: false, inMempool: true };
        }
        if (tx.blocktime === undefined) {
            throw new BitcoinRpcError(`Transaction ${txid} is confirmed but missing blocktime`, -1);
        }
        if (!tx.blockhash) {
            throw new BitcoinRpcError(`Transaction ${txid} is confirmed but missing blockhash`, -1);
        }

        // Run getblockheader outside the getrawtransaction -5 catch so a header lookup
        // failure (including RPC -5 "Block not found") never misclassifies a confirmed tx
        // as unconfirmed.
        const header = await this.call<{ height: number }>("getblockheader", [tx.blockhash]);
        if (typeof header?.height !== "number") {
            throw new BitcoinRpcError(`Failed to get block height for block ${tx.blockhash}`, -1);
        }

        return {
            confirmed: true,
            blockHeight: header.height,
            blockTime: tx.blocktime,
            blockHash: tx.blockhash,
            confirmations,
        };
    }

    /**
     * Helper to verify commitment depth (Tier 1 Task 3).
     */
    async verifyCommitmentDepth(
        txid: string,
        minConfirmations: number = 1,
        blockhash?: string,
    ): Promise<boolean> {
        const params: (string | boolean)[] = [txid, true];
        if (blockhash) params.push(blockhash);
        const tx = await this.call<VerboseTx>("getrawtransaction", params);
        const confirmations = tx.confirmations ?? 0;
        return confirmations >= minConfirmations;
    }

    /**
     * Returns current blockchain tip info (Tier 2 Phase 2: Timelock Verification).
     * Used for satisfiability checks of CLTV/CSV constraints.
     */
    async getBlockchainInfo(): Promise<{ height: number; medianTime: number }> {
        const info = await this.call<{
            blocks: number;
            mediantime: number;
            chain: string;
        }>("getblockchaininfo", []);

        return {
            height: info.blocks,
            medianTime: info.mediantime,
        };
    }

    /**
     * Broadcast a single raw transaction (`sendrawtransaction`) or a topologically
     * ordered transaction package (`submitpackage`, e.g. 1P1C CPFP for zero-fee P2A
     * virtual transactions).
     *
     * @param txHexes One raw transaction hex, or a package `[parentHex, childHex, ...]`.
     * @returns Network transaction ID (txid of the single tx or package parent).
     */
    async broadcastTransaction(...txHexes: string[]): Promise<string> {
        if (txHexes.length === 0) {
            throw new BitcoinRpcError("At least one transaction hex is required", -1);
        }
        if (txHexes.length === 1) {
            return await this.call<string>("sendrawtransaction", [txHexes[0]]);
        }

        const result = await this.call<{
            package_msg?: string;
            "tx-results"?: Record<string, { txid?: string; error?: string }>;
        }>("submitpackage", [txHexes]);

        const txResults =
            result["tx-results"] && typeof result["tx-results"] === "object"
                ? Object.values(result["tx-results"])
                : [];
        const errors = txResults
            .filter((entry) => entry && typeof entry === "object" && entry.error)
            .map((entry) => `${entry.txid ?? "unknown tx"}: ${entry.error}`);

        if (result.package_msg !== "success" || errors.length > 0) {
            const summary = result.package_msg ?? "unknown error";
            throw new BitcoinRpcError(
                errors.length > 0
                    ? `Package rejected (${summary}) — ${errors.join("; ")}`
                    : `Package rejected (${summary})`,
                -26,
            );
        }

        const firstTxid = txResults.find(
            (entry) => typeof entry?.txid === "string" && /^[0-9a-fA-F]{64}$/.test(entry.txid),
        )?.txid;
        return firstTxid ?? "success";
    }
}
