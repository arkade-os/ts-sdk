import { describe, it, expect, vi } from "vitest";
import { hex, base64 } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { BitcoinRpcProvider, BitcoinRpcError } from "../bitcoinRpc.js";
import { verifyNodeSignature } from "../signatureVerification.js";
import { VtxoVerificationError, ChainTxType } from "../vtxoDAGVerification.js";

describe("Extreme Edge-Case Security & Fuzzing", () => {
  
  /**
   * 1. Garbage Injection (PSBT Parsing)
   * Ensures the SDK doesn't crash on malformed binary/base64 inputs.
   */
  describe("Garbage Injection", () => {
    it("should throw a typed VtxoVerificationError on truncated PSBTs", async () => {
      const truncatedPsbt = base64.encode(Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff])); 
      const { reconstructAndValidateVtxoDAG } = await import("../vtxoDAGVerification.js");
      
      const mockIndexer = {
        getBatchVtxos: vi.fn().mockResolvedValue([{ 
          chain: [
            { txid: "commitment-txid", type: ChainTxType.COMMITMENT, expiresAt: "", spends: [] },
            { txid: "fake-txid", type: ChainTxType.TREE, expiresAt: "", spends: ["commitment-txid"] }
          ] 
        }]),
        getVirtualTxs: vi.fn().mockResolvedValue({ txs: [truncatedPsbt] })
      };

      await expect(reconstructAndValidateVtxoDAG(
        { txid: "fake-txid", vout: 0 },
        mockIndexer as any,
        {} as any
      )).rejects.toThrow(/INVALID_PSBT/);
    });

    it("should reject a PSBT that is valid base64 but invalid structure", async () => {
      const invalidPsbt = base64.encode(Buffer.from("this is just a random string of text that is not a psbt"));
      const { reconstructAndValidateVtxoDAG } = await import("../vtxoDAGVerification.js");
      
      const mockIndexer = {
        getBatchVtxos: vi.fn().mockResolvedValue([{ 
          chain: [
            { txid: "commitment-txid", type: ChainTxType.COMMITMENT, expiresAt: "", spends: [] },
            { txid: "fake-txid", type: ChainTxType.TREE, expiresAt: "", spends: ["commitment-txid"] }
          ] 
        }]),
        getVirtualTxs: vi.fn().mockResolvedValue({ txs: [invalidPsbt] })
      };

      await expect(reconstructAndValidateVtxoDAG(
        { txid: "fake-txid", vout: 0 },
        mockIndexer as any,
        {} as any
      )).rejects.toThrow(/INVALID_PSBT/);
    });
  });

  /**
   * 2. RPC Oracle Poisoning (Spoofing)
   * Ensures the RPC client validates schemas and rejects malformed node responses.
   */
  describe("RPC Spoofing & Schema Validation", () => {
    it("should reject an RPC response with invalid hex characters in txid", async () => {
      const rpc = new BitcoinRpcProvider("http://localhost:18443");
      
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: { txid: "ZZZZZZZZZZZZZZZZZZZZ" }, // Invalid hex
          error: null,
          id: 1
        })
      });

      await expect(rpc.getTxStatus("fake")).rejects.toThrow(/Oracle Poisoning Detected|Invalid TXID format/);
    });

    it("should handle HTTP 200 responses that contain a JSON-RPC error object properly", async () => {
      const rpc = new BitcoinRpcProvider("http://localhost:18443");
      
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: null,
          error: { code: -32600, message: "Invalid Request" },
          id: 1
        })
      });

      await expect(rpc.getTxStatus("fake")).rejects.toThrow(BitcoinRpcError);
    });
  });

  /**
   * 3. Sighash Maleability (Flags)
   * Ensures only SIGHASH_DEFAULT and SIGHASH_ALL are accepted.
   */
  describe("Sighash Maleability", () => {
    it("should reject a signature using SIGHASH_NONE (0x02)", () => {
      const tx = new Transaction(); // dummy
      const mockNode = {
        txid: "mock",
        tx: {
          getInput: () => ({
            tapKeySig: Buffer.concat([Buffer.alloc(64, 0x01), Buffer.from([0x02])]), // 64-byte sig + 0x02
            tapInternalKey: Buffer.alloc(32, 0x02)
          })
        },
        children: new Map(),
        parent: null
      } as any;

      expect(() => verifyNodeSignature(mockNode)).toThrow(/UNSUPPORTED_SIGHASH/);
    });

    it("should reject a signature using SIGHASH_ALL | ANYONECANPAY (0x81)", () => {
      const mockNode = {
        txid: "mock",
        tx: {
          getInput: () => ({
            tapKeySig: Buffer.concat([Buffer.alloc(64, 0x01), Buffer.from([0x81])]), // 0x81
            tapInternalKey: Buffer.alloc(32, 0x02)
          })
        },
        children: new Map(),
        parent: null
      } as any;

      expect(() => verifyNodeSignature(mockNode)).toThrow(/UNSUPPORTED_SIGHASH/);
    });
  });
});
