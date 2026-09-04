/**
 * ============================================================================
 *  Bitcoin RPC Provider — Tier 1: On-chain Anchoring
 * ============================================================================
 *
 *  Implements the OnchainProvider interface by communicating with a
 *  local Bitcoin Core full node via JSON-RPC.
 *
 *  This provider:
 *    1. Connects to Bitcoin Core via HTTP JSON-RPC.
 *    2. Fetches raw transactions for commitment verification.
 *    3. Verifies confirmation depth in a regtest environment.
 *
 *  Usage:
 *    const rpc = new BitcoinRpcProvider("http://localhost:18443", "user", "pass");
 * ============================================================================
 */

import { base64 } from "@scure/base";
import { type VerificationOnchainProvider } from "../tree/vtxoDAGVerification.js";

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

export class BitcoinRpcProvider implements VerificationOnchainProvider {
    private rpcId = 1;
    private txIndexChecked: boolean | null = null;

    constructor(
        public readonly url: string = "http://localhost:18443",
        private readonly user: string = "user",
        private readonly pass: string = "password",
        private readonly timeoutMs: number = 30000,
    ) {}

    /**
     * Internal JSON-RPC caller.
     */
    private async call<T>(method: string, params: any[] = []): Promise<T> {
        const auth = base64.encode(new TextEncoder().encode(`${this.user}:${this.pass}`));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
            response = await fetch(this.url, {
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
        } catch (error: any) {
            if (error.name === "AbortError") {
                throw new BitcoinRpcError(`RPC Request timed out after ${this.timeoutMs}ms`, 408);
            }
            throw new BitcoinRpcError(`Network error: ${error.message}`, -1);
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            if (response.status === 401) {
                throw new BitcoinRpcError("Unauthorized (wrong RPC credentials)", 401);
            }
            throw new BitcoinRpcError(
                `HTTP Error: ${response.status} ${response.statusText}`,
                response.status,
            );
        }

        const data = (await response.json()) as RpcResult<T>;

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
    ): Promise<{
        confirmed: boolean;
        blockHeight?: number;
        blockTime?: number;
        blockHash?: string;
        confirmations?: number;
    }> {
        try {
            // getrawtransaction txid [verbose=true] [blockhash]
            const params: (string | boolean)[] = [txid, true];
            if (blockhash) params.push(blockhash);
            const tx = await this.call<VerboseTx>("getrawtransaction", params);

            const confirmations = tx.confirmations ?? 0;
            const confirmed = confirmations > 0;

            let blockHeight: number | undefined;
            if (confirmed && tx.blockhash) {
                try {
                    const header = await this.call<{ height: number }>("getblockheader", [
                        tx.blockhash,
                    ]);
                    if (typeof header?.height === "number") {
                        blockHeight = header.height;
                    }
                } catch {
                    // if getblockheader is unavailable, leave blockHeight undefined
                }
            }

            return {
                confirmed,
                blockHeight,
                blockTime: tx.blocktime,
                blockHash: tx.blockhash,
                confirmations,
            };
        } catch (e) {
            if (e instanceof BitcoinRpcError && e.code === -5) {
                // If the error explicitly asks to activate -txindex, throw so caller knows index is missing
                if (e.message.includes("activate -txindex") && !blockhash) {
                    throw new BitcoinRpcError(
                        `Bitcoin Core requires -txindex to query historical transactions without blockhash for ${txid}`,
                        -5,
                    );
                }
                return { confirmed: false, confirmations: 0 };
            }
            throw e;
        }
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
     * Orchestrate and push a signed raw transaction completely to the Bitcoin network.
     * Uses Bitcoin Core sendrawtransaction RPC.
     * @param txHex Fully signed transaction in hex format.
     * @returns Network transaction ID (txid)
     */
    async broadcastTransaction(txHex: string): Promise<string> {
        return await this.call<string>("sendrawtransaction", [txHex]);
    }
}
