/**
 * ============================================================================
 *  Arkd Indexer Provider — Production Integration
 * ============================================================================
 *
 *  Implements the IndexerProvider interface by communicating with a
 *  live arkd instance via its REST API.
 *
 *  This provider:
 *    1. Fetches VTXO chains for a commitment batch.
 *    2. Fetches raw virtual transaction PSBTs.
 *    3. Handles network errors and JSON schema validation.
 *
 *  Default Port: 18080 (arkd IndexerService)
 * ============================================================================
 */

import { 
  type IndexerProvider, 
  type VtxoChain,
  VtxoVerificationError 
} from "./vtxoDAGVerification.js";

export class ArkdIndexerProvider implements IndexerProvider {
  constructor(
    public readonly baseUrl: string = "http://localhost:18080"
  ) {}

  /**
   * Internal REST caller with strict error handling.
   */
  private async call<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new VtxoVerificationError(
          `arkd HTTP Error: ${response.status} ${response.statusText}`,
          "INDEXER_SERVICE_ERROR",
          { url, status: response.status }
        );
      }

      return (await response.json()) as T;
    } catch (e: any) {
      if (e instanceof VtxoVerificationError) throw e;
      throw new VtxoVerificationError(
        `Failed to reach arkd Indexer at ${url}`,
        "INDEXER_CONNECTION_FAILED",
        { originalError: e.message }
      );
    }
  }

  /**
   * Get all VTXO chains associated with a specific commitment batch.
   * Endpoint: GET /v1/batch/{commitmentTxid}/vtxos
   */
  async getBatchVtxos(commitmentTxid: string): Promise<VtxoChain[]> {
    const data = await this.call<{ vtxos: VtxoChain[] }>(`/v1/batch/${commitmentTxid}/vtxos`);
    
    if (!data || !Array.isArray(data.vtxos)) {
      throw new VtxoVerificationError(
        "Invalid response format from getBatchVtxos",
        "INDEXER_INVALID_RESPONSE"
      );
    }

    return data.vtxos;
  }

  /**
   * Fetch raw virtual transaction PSBTs (base64-encoded).
   * Endpoint: POST /v1/virtual-txs
   * Body: { txids: string[] }
   */
  async getVirtualTxs(txids: string[]): Promise<{ txs: string[] }> {
    const data = await this.call<{ txs: string[] }>("/v1/virtual-txs", {
      method: "POST",
      body: JSON.stringify({ txids }),
    });

    if (!data || !Array.isArray(data.txs)) {
      throw new VtxoVerificationError(
        "Invalid response format from getVirtualTxs",
        "INDEXER_INVALID_RESPONSE"
      );
    }

    return data;
  }
}
