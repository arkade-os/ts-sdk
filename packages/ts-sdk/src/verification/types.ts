import type { ChainTx } from "../providers/indexer";
import type { Transaction } from "../utils/transaction";
import type { Outpoint } from "../wallet";

export interface VtxoProofSource {
    getVtxoChain(vtxo: Outpoint): Promise<ChainTx[]>;
    getVirtualTxs(txids: string[]): Promise<string[]>;
}

export interface VtxoChainSource {
    getTxHex(txid: string): Promise<string>;
    getTxStatus(
        txid: string,
    ): Promise<{ confirmed: false } | { confirmed: true; blockTime: number; blockHeight: number }>;
    getTxOutspends(txid: string): Promise<{ spent: boolean; txid?: string }[]>;
    getChainTip(): Promise<{ height: number; time: number; hash: string }>;
}

export interface VtxoVerificationServerInfo {
    forfeitPubkey: Uint8Array;
}

export interface VtxoVerificationOptions {
    minConfirmationDepth?: number;
}

export type VtxoVerificationCheck = "leaf" | "graph" | "signatures" | "anchors";

export type VtxoVerificationIssue = {
    code: string;
    message: string;
    txid?: string;
    inputIndex?: number;
    outputIndex?: number;
};

type VtxoVerificationBaseResult = {
    outpoint: Outpoint;
    commitmentTxids: string[];
    chainLength: number;
    issues: VtxoVerificationIssue[];
};

export type VtxoVerificationResult =
    | (VtxoVerificationBaseResult & {
          status: "confirmed";
          confirmationDepth: number;
      })
    | (VtxoVerificationBaseResult & {
          status: "preconfirmed";
          partialChecks: Partial<Record<VtxoVerificationCheck, boolean>>;
      })
    | (VtxoVerificationBaseResult & { status: "invalid" })
    | (VtxoVerificationBaseResult & { status: "unavailable" });

export interface ParsedVtxoProof {
    entries: Map<string, ChainTx>;
    transactions: Map<string, Transaction>;
    commitmentTxids: string[];
}
