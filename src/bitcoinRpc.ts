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

import { type OnchainProvider } from "./vtxoDAGVerification.js";

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
    public readonly code?: number
  ) {
    super(`[BITCOIN-RPC] ${message} (code: ${code})`);
    this.name = "BitcoinRpcError";
  }
}

export class BitcoinRpcProvider implements OnchainProvider {
  private rpcId = 1;

  constructor(
    public readonly url: string = "http://localhost:18443",
    private readonly user: string = "user",
    private readonly pass: string = "password"
  ) {}

  /**
   * Internal JSON-RPC caller.
   */
  private async call<T>(method: string, params: any[] = []): Promise<T> {
    const auth = Buffer.from(`${this.user}:${this.pass}`).toString("base64");
    
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`,
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: this.rpcId++,
        method,
        params,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new BitcoinRpcError("Unauthorized (wrong RPC credentials)", 401);
      }
      throw new BitcoinRpcError(`HTTP Error: ${response.status} ${response.statusText}`, response.status);
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
         throw new BitcoinRpcError(`Oracle Poisoning Detected: Invalid TXID format in RPC response: ${res.txid}`, -32603);
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
   * Returns the raw transaction hex.
   */
  async getRawTransaction(txid: string): Promise<string> {
    // getrawtransaction txid [verbose=false]
    return await this.call<string>("getrawtransaction", [txid, false]);
  }

  /**
   * Check if a transaction is confirmed and at what depth.
   */
  async getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    blockTime?: number;
  }> {
    try {
      // getrawtransaction txid [verbose=true]
      const tx = await this.call<VerboseTx>("getrawtransaction", [txid, true]);
      
      const confirmations = tx.confirmations ?? 0;
      const confirmed = confirmations > 0;
      
      // Bitcoin Core verbose output doesn't directly return block height,
      // but we can infer it or assume it's part of the metadata if needed.
      // (For verification, 'confirmed' and 'confirmations' are the key metrics).
      
      return {
        confirmed,
        blockTime: tx.blocktime,
      };
    } catch (e) {
      // If tx is not found in mempool or blockchain
      if (e instanceof BitcoinRpcError && 
          (e.code === -5 || e.message.includes("No such mempool transaction"))) {
        return { confirmed: false };
      }
      throw e;
    }
  }

  /**
   * Helper to verify commitment depth (Tier 1 Task 3).
   */
  async verifyCommitmentDepth(txid: string, minConfirmations: number = 1): Promise<boolean> {
    const tx = await this.call<VerboseTx>("getrawtransaction", [txid, true]);
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
