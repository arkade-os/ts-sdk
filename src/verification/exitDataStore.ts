import type { Outpoint, VirtualCoin } from "../wallet";
import type { ChainTx } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { TxTreeNode } from "../tree/txTree";

/**
 * All data needed to perform a unilateral exit for a single VTXO,
 * without contacting the ASP's IndexerService.
 */
export interface ExitData {
    /** The VTXO outpoint this exit data belongs to */
    vtxoOutpoint: Outpoint;
    /** The commitment tx that anchors the tree onchain */
    commitmentTxid: string;
    /** The full VTXO chain from leaf to commitment (all ChainTx entries) */
    chain: ChainTx[];
    /** All presigned virtual transaction PSBTs (base64) keyed by txid */
    virtualTxs: Record<string, string>;
    /** The tree structure (txid + children mapping) for reconstruction */
    treeNodes: TxTreeNode[];
    /** Timestamp when this exit data was stored */
    storedAt: number;
}

/**
 * Repository interface for persisting unilateral exit data.
 * Extends the existing storage adapter pattern used by WalletRepository.
 */
export interface ExitDataRepository {
    /** Save exit data for a VTXO */
    saveExitData(data: ExitData): Promise<void>;
    /** Get exit data for a specific VTXO outpoint */
    getExitData(outpoint: Outpoint): Promise<ExitData | null>;
    /** Get all stored exit data */
    getAllExitData(): Promise<ExitData[]>;
    /** Delete exit data for a specific VTXO (e.g. after successful exit or spend) */
    deleteExitData(outpoint: Outpoint): Promise<void>;
    /** Delete all exit data */
    clear(): Promise<void>;
}

/**
 * Analyzes a VTXO chain to determine all data required for unilateral exit.
 *
 * Given a VTXO and its chain from the indexer, identifies:
 * - The full chain of presigned transactions from leaf to batch root
 * - All intermediate virtual transactions and their PSBTs
 * - Merkle proofs and witness data needed to finalize each step
 *
 * Returns an ExitData object containing everything needed to exit
 * without contacting the ASP.
 */
export function collectExitData(
    vtxo: VirtualCoin,
    chain: ChainTx[],
    virtualTxs: Record<string, string>,
    treeNodes: TxTreeNode[]
): ExitData {
    const commitmentEntry = chain.find(
        (c) => c.type === ChainTxType.COMMITMENT
    );

    return {
        vtxoOutpoint: { txid: vtxo.txid, vout: vtxo.vout },
        commitmentTxid: commitmentEntry?.txid ?? "",
        chain,
        virtualTxs,
        treeNodes,
        storedAt: Date.now(),
    };
}

export function validateExitData(data: ExitData): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (!data.commitmentTxid) {
        errors.push("Missing commitment txid");
    }

    if (!data.chain || data.chain.length === 0) {
        errors.push("Chain is empty");
    }

    // Check that all non-commitment chain entries have a virtual tx PSBT
    for (const entry of data.chain) {
        if (entry.type === ChainTxType.COMMITMENT) {
            continue;
        }
        if (!data.virtualTxs[entry.txid]) {
            errors.push(
                `Missing virtual tx PSBT for chain entry ${entry.txid}`
            );
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * In-memory implementation of ExitDataRepository for testing.
 */
export class InMemoryExitDataRepository implements ExitDataRepository {
    private store = new Map<string, ExitData>();

    private key(outpoint: Outpoint): string {
        return `${outpoint.txid}:${outpoint.vout}`;
    }

    async saveExitData(data: ExitData): Promise<void> {
        this.store.set(this.key(data.vtxoOutpoint), data);
    }

    async getExitData(outpoint: Outpoint): Promise<ExitData | null> {
        return this.store.get(this.key(outpoint)) ?? null;
    }

    async getAllExitData(): Promise<ExitData[]> {
        return [...this.store.values()];
    }

    async deleteExitData(outpoint: Outpoint): Promise<void> {
        this.store.delete(this.key(outpoint));
    }

    async clear(): Promise<void> {
        this.store.clear();
    }
}
