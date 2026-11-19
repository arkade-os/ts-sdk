/**
 * ============================================================================
 *  VTXO DAG Verification — Tier 1: Chain Reconstruction & Structural Validation
 * ============================================================================
 *
 *  Implements client-side verification of VTXO chains for the Arkade SDK.
 *
 *  Given a VTXO (Root) received from the ASP, this module:
 *    1. Fetches the full chain of virtual transactions from the IndexerService.
 *    2. Fetches the raw PSBT data for each virtual transaction.
 *    3. Reconstructs the complete DAG of presigned virtual transactions
 *       from the Root (VTXO) back to the batch output (Anchoring Leaf).
 *    4. Validates that every transaction's inputs correctly reference
 *       the outputs of its ancestor in the DAG.
 *    5. Validates checkpoint transactions (if present), verifying:
 *       – Their structural coherence with the sweep delay.
 *       – Their correct integration into the DAG.
 *    6. Validates that the Anchoring Leaf of the DAG is anchored onto a
 *       valid batch output on the commitment transaction.
 *
 *  ZERO TRUST: Every piece of data from the ASP is treated as potentially
 *  malicious. The function fails loudly on any inconsistency.
 *
 *  Dependencies: @scure/btc-signer, @scure/base (standard Arkade SDK deps).
 * ============================================================================
 */

import { Transaction } from "../utils/transaction.js";
import { hex, base64 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { verifyDAGSignatures } from "./signatureVerification.js";
import { verifyNodeTaproot } from "./taprootVerification.js";
import { verifyDAGTimelocks } from "./timelockVerification.js";
import { verifyDAGHashPreimages } from "./hashPreimageVerification.js";
import { ConcurrencyLimiter } from "../utils/performanceUtils.js";
import type { Outpoint } from "../wallet/index.js";
import { ChainTxType, type ChainTx, type VtxoChain } from "../providers/indexer.js";
export { ChainTxType, type ChainTx, type VtxoChain, type Outpoint };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the txid of a Transaction (including unfinalized PSBTs) as
 * REVERSE(SHA256d(non-witness serialization)).
 */
export function computeTxid(tx: Transaction): string {
    const rawBytes = tx.toBytes(true, false);
    const hash1 = sha256(rawBytes);
    const hash2 = sha256(hash1);
    const reversed = new Uint8Array(hash2);
    reversed.reverse();
    return hex.encode(reversed);
}

// ─── Provider Interfaces (subset needed for verification) ────────────────────

/**
 * Interface for the IndexerService in verification context.
 * Compile-time enforced to provide at least one chain lookup method:
 *   - `getVtxoChain`: direct mode (implemented by `RestIndexerProvider`; reveals the
 *     queried outpoint to the indexer).
 *   - `getBatchVtxos`: batch-scoped mode (requires a custom/extended indexer; fetches all
 *     chains in a commitment batch and requests the sorted union of their virtual txs).
 */
export type VerificationIndexerProvider = {
    getVirtualTxs(virtualTxids: string[]): Promise<{ txs: string[] }>;
} & (
    | {
          /** Fetch the ancestry chain for a specific VTXO outpoint (direct mode). */
          getVtxoChain(outpoint: Outpoint): Promise<VtxoChain>;
          /** Fetch all VTXO chains associated with a commitment batch (batch-scoped mode). */
          getBatchVtxos?(commitmentTxid: string): Promise<VtxoChain[]>;
      }
    | {
          /** Fetch all VTXO chains associated with a commitment batch (batch-scoped mode). */
          getBatchVtxos(commitmentTxid: string): Promise<VtxoChain[]>;
          /** Fetch the ancestry chain for a specific VTXO outpoint (direct mode). */
          getVtxoChain?(outpoint: Outpoint): Promise<VtxoChain>;
      }
);

/**
 * Read-only on-chain explorer/node interface for VTXO verification.
 * Decoupled from transaction broadcasting so watch-only and read-only
 * providers can run verification without implementing broadcast methods.
 */
export interface VerificationOnchainProvider {
    /** Get a raw transaction by txid (hex-encoded), optionally specifying blockhash if txindex is disabled. */
    getRawTransaction(txid: string, blockhash?: string): Promise<string>;
    /** Get current blockchain tip info (optional — needed for timelock validation). */
    getBlockchainInfo?(): Promise<{ height: number; medianTime: number }>;
    /** Get transaction confirmation status, optionally providing a known block hash for providers without txindex. */
    getTxStatus(
        txid: string,
        blockhash?: string,
    ): Promise<
        | { confirmed: false }
        | {
              confirmed: true;
              blockHeight?: number;
              blockTime?: number;
              blockHash?: string;
              confirmations?: number;
          }
    >;
}

/**
 * On-chain provider capability required to execute unilateral sovereign exits
 * via the canonical `UnilateralExit.Executor` (1P1C CPFP package broadcasts).
 * Satisfied by both `OnchainProvider` (`EsploraProvider`, `ElectrumOnchainProvider`)
 * and `BitcoinRpcProvider`.
 */
export interface ExitOnchainProvider {
    /**
     * Query transaction confirmation status. Providers should either throw when a
     * transaction is unknown (matching `OnchainProvider` / `EsploraProvider`) or return
     * `{ confirmed: false, inMempool: false }` (as `BitcoinRpcProvider` does).
     */
    getTxStatus(txid: string): Promise<
        | { confirmed: false; inMempool?: boolean }
        | {
              confirmed: true;
              blockHeight?: number;
              blockTime?: number;
              blockHash?: string;
              confirmations?: number;
          }
    >;
    /**
     * Chain tip (height + median-time-past). Needed to check hop timelocks before broadcast;
     * `OnchainProvider` implements it. Either this or `getBlockchainInfo` should be provided.
     */
    getChainTip?(): Promise<{ height: number; time: number }>;
    /** Chain tip as exposed by `BitcoinRpcProvider`. */
    getBlockchainInfo?(): Promise<{ height: number; medianTime: number }>;
    /** Broadcast a single raw transaction or a 1P1C CPFP package (`parentHex, childHex`). */
    broadcastTransaction(...txHexes: string[]): Promise<string>;
}

/**
 * Interface for the Storage Adapter in verification context.
 */
export interface VerificationStorageProvider {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
}

export type StorageProvider = VerificationStorageProvider;

// ─── DAG Node & Result Types ─────────────────────────────────────────────────

/** A single node in the reconstructed DAG. */
export interface DAGNode {
    /** Virtual txid (computed from the PSBT). */
    txid: string;

    /** The deserialized Bitcoin transaction (from PSBT). */
    tx: Transaction;

    /** Chain metadata from the Indexer. */
    chainTx: ChainTx;

    /** Raw base64 PSBT as received from the ASP. */
    rawPsbt: string;

    /** Child nodes (keyed by the output index they spend). */
    children: Map<number, DAGNode>;

    /** Ancestor node (closer to the user's VTXO Root). */
    descendant: DAGNode | null;

    /** Ancestor node (null for the VTXO Root itself). */
    ancestor: DAGNode | null;

    /** The output index in the ancestor that this node spends. */
    ancestorOutputIndex: number | null;

    /** Commitment batch output context for the anchoring leaf node. */
    prevOutContext?: { script: Uint8Array; amount: bigint };
}

/** Validation result for the DAG. */
export interface DAGValidationResult {
    /** Whether all validations passed and the DAG is structurally sound and authentic. */
    valid: boolean;

    /** Whether all relative and absolute timelocks have matured under current chain state. */
    timelocksSatisfied: boolean;

    /** Whether the VTXO is structurally valid and immediately broadcastable on L1. */
    broadcastable: boolean;

    /** The reconstructed VTXO Root (the starting point). */
    vtxoRoot: DAGNode;

    /** The anchoring leaf (the commitment-anchored ancestor). */
    anchoringLeaf: DAGNode;

    /** The commitment tx that anchors the DAG on-chain. */
    commitmentTxid: string;

    /** Optional block hash where commitment transaction was confirmed. */
    commitmentBlockHash?: string;

    /** The batch output index on the commitment tx. */
    batchOutputIndex: number;

    /** The raw transaction hex for the commitment tx. */
    commitmentTxHex?: string;

    /** Details of checkpoint validations performed. */
    checkpointValidations: CheckpointValidation[];

    /** Diagnostic messages for each validation step. */
    diagnostics: string[];
}

/** Validation result specific to a checkpoint transaction. */
export interface CheckpointValidation {
    txid: string;
    /** Whether the checkpoint's expiry is coherent with the sweep delay. */
    expiryCoherent: boolean;
    /** Whether the checkpoint's parent was found and validated in the chain. */
    parentChainValid: boolean;
    /** Detailed notes / diagnostic strings for this checkpoint. */
    notes: string[];
}

// ─── Error Definitions ───────────────────────────────────────────────────────

export class VtxoVerificationError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly context?: Record<string, unknown>,
    ) {
        super(`[VTXO-VERIFY:${code}] ${message}`);
        this.name = "VtxoVerificationError";
    }
}

const Errors = {
    EMPTY_CHAIN: (vtxo: Outpoint) =>
        new VtxoVerificationError(
            `Empty chain returned for VTXO ${vtxo.txid}:${vtxo.vout}`,
            "EMPTY_CHAIN",
            { vtxo },
        ),

    NO_COMMITMENT: () =>
        new VtxoVerificationError(
            "No commitment transaction found at the anchoring leaf of the chain",
            "NO_COMMITMENT",
        ),

    MISSING_TX: (txid: string) =>
        new VtxoVerificationError(
            `Virtual transaction ${txid} not returned by the ASP`,
            "MISSING_TX",
            { txid },
        ),

    TXID_MISMATCH: (expected: string, actual: string) =>
        new VtxoVerificationError(
            `Txid mismatch: ASP claims ${expected} but PSBT computes to ${actual}`,
            "TXID_MISMATCH",
            { expected, actual },
        ),

    INPUT_CHAIN_BREAK: (childTxid: string, expectedParent: string, actualParent: string) =>
        new VtxoVerificationError(
            `Input chain break: tx ${childTxid} should reference parent ${expectedParent} but references ${actualParent}`,
            "INPUT_CHAIN_BREAK",
            { childTxid, expectedParent, actualParent },
        ),

    AMOUNT_MISMATCH: (
        parentTxid: string,
        outputIndex: number,
        parentAmount: bigint,
        childSum: bigint,
    ) =>
        new VtxoVerificationError(
            `Amount mismatch: parent ${parentTxid} output[${outputIndex}] = ${parentAmount} sats, but child outputs sum = ${childSum} sats`,
            "AMOUNT_MISMATCH",
            {
                parentTxid,
                outputIndex,
                parentAmount: parentAmount.toString(),
                childSum: childSum.toString(),
            },
        ),

    INVALID_INPUT_COUNT: (txid: string, count: number) =>
        new VtxoVerificationError(
            `Virtual transaction ${txid} has ${count} inputs, expected exactly 1`,
            "INVALID_INPUT_COUNT",
            { txid, count },
        ),

    CHECKPOINT_EXPIRY_INCOHERENT: (txid: string, details: string) =>
        new VtxoVerificationError(
            `Checkpoint ${txid} has incoherent expiry: ${details}`,
            "CHECKPOINT_EXPIRY_INCOHERENT",
            { txid },
        ),

    CHECKPOINT_PARENT_MISMATCH: (txid: string, details: string) =>
        new VtxoVerificationError(
            `Checkpoint ${txid} ancestor error: ${details}`,
            "CHECKPOINT_PARENT_MISMATCH",
            { txid },
        ),

    MALFORMED_VTXO_TREE: (details: string) =>
        new VtxoVerificationError(
            `Malformed VTXO tree structure: ${details}`,
            "MALFORMED_VTXO_TREE",
        ),

    ORPHAN_TX: (txid: string) =>
        new VtxoVerificationError(
            `Transaction ${txid} is orphaned — not reachable from the VTXO root`,
            "ORPHAN_TX",
            { txid },
        ),
} as const;

// ─── Batch output index convention (from SDK tree/validation.ts) ─────────────
export const BATCH_OUTPUT_VTXO_INDEX = 0;
export const MAX_VTXO_CHAIN_NODES = 10_000;

// ─── Main Public Function ────────────────────────────────────────────────────

/**
 * Reconstructs and validates a single-input VTXO ancestry chain from Root (VTXO)
 * back to its on-chain commitment transaction output.
 *
 * Scope: validates single-input virtual transaction chains (TREE, CHECKPOINT, and
 * single-input ARK transactions). Multi-input off-chain consolidation transactions
 * are outside this verifier's scope and fail closed with `INVALID_INPUT_COUNT`.
 *
 * Lookup modes:
 *   - Direct mode (`commitmentTxid` omitted): calls `getVtxoChain(vtxoRootOutpoint)`
 *     and fetches only that chain's virtual transactions (supported by `RestIndexerProvider`).
 *   - Batch-scoped mode (`commitmentTxid` provided): requires `indexer.getBatchVtxos`
 *     and fails closed (`INVALID_PROVIDER`) if absent — never falls back to `getVtxoChain`.
 *     Fetches all chains in the batch and requests the sorted union of all virtual txids
 *     across the batch via `getVirtualTxs` BEFORE any check that depends on the target, so
 *     the requests do not depend on which chain is being verified.
 *     Privacy scope (deliberately narrow): the indexer still learns the commitment txid and
 *     that a client is verifying inside it; the anonymity set is exactly the chains the
 *     indexer itself returns from `getBatchVtxos` (an indexer that returns a reduced or
 *     adversarial batch shrinks it, and cannot be detected from here); on-chain provider
 *     queries are separate and unaffected. `RestIndexerProvider` has no `getBatchVtxos`.
 *
 * On-chain prerequisite: the commitment tx is looked up by txid without a block hash, so a
 * Bitcoin Core backend (`BitcoinRpcProvider`) must run with `-txindex=1` (without it
 * verification fails with `BitcoinRpcError` code -5), or the provider must resolve the
 * commitment's block itself.
 *
 * @param vtxoRootOutpoint  The user's starting VTXO Root outpoint to verify.
 * @param indexer           A VerificationIndexerProvider (e.g. RestIndexerProvider for direct mode).
 * @param onchain           A VerificationOnchainProvider (e.g. BitcoinRpcProvider or Esplora adapter).
 * @param witnessPreimages  Optional map of witness hashes to preimages for HTLC validation.
 * @param commitmentTxid    Optional commitment txid requesting fail-closed batch-scoped lookup via `getBatchVtxos`.
 * @throws VtxoVerificationError on any structural, cryptographic, or provider violation.
 * @returns A DAGValidationResult with the full reconstructed + validated DAG.
 */
export async function reconstructAndValidateVtxoDAG(
    vtxoRootOutpoint: Outpoint,
    indexer: VerificationIndexerProvider,
    onchain: VerificationOnchainProvider,
    witnessPreimages?: Map<string, Uint8Array>,
    commitmentTxid?: string,
): Promise<DAGValidationResult> {
    const diagnostics: string[] = [];

    // ── Step 1: Fetch the VTXO chain ────────────────────────────────────────
    diagnostics.push(
        `[1/6] Fetching VTXO chain for ${vtxoRootOutpoint.txid}:${vtxoRootOutpoint.vout}`,
    );

    let chain: ChainTx[];
    let prefetchedPsbts: Map<string, string> | null = null;

    if (commitmentTxid) {
        // Fail closed when batch-scoped verification is requested on an indexer without
        // getBatchVtxos; never silently fall back to direct getVtxoChain.
        if (!indexer.getBatchVtxos) {
            throw new VtxoVerificationError(
                "Batch-scoped verification requires an indexer implementing getBatchVtxos; refusing to fall back to direct getVtxoChain when commitmentTxid is specified",
                "INVALID_PROVIDER",
                { commitmentTxid },
            );
        }
        diagnostics.push(
            `  → Batch mode: fetching all chains in batch for commitment ${commitmentTxid}`,
        );
        const allChains = await indexer.getBatchVtxos(commitmentTxid);

        // ALL batch-wide work happens before any check that depends on the target: the sorted
        // union of every chain's virtual txids is requested first, so neither a missing target,
        // a commitment mismatch nor a size rejection can change what the indexer observes.
        const uniqueBatchTxids = new Set<string>();
        for (const candidate of allChains) {
            for (const link of candidate.chain ?? []) {
                if (link.type !== ChainTxType.COMMITMENT && link.type !== ChainTxType.UNSPECIFIED) {
                    uniqueBatchTxids.add(link.txid);
                }
            }
        }
        const batchVirtualTxids = Array.from(uniqueBatchTxids).sort();
        if (batchVirtualTxids.length > MAX_VTXO_CHAIN_NODES) {
            throw new VtxoVerificationError(
                `Batch has ${batchVirtualTxids.length} virtual transactions, exceeding the maximum of ${MAX_VTXO_CHAIN_NODES}`,
                "DAG_TOO_LARGE",
            );
        }
        // No txid is required here: requiredness is judged only after the fetch completed.
        prefetchedPsbts = await fetchAllVirtualTxs(batchVirtualTxids, indexer, new Set());

        const vtxoChain = allChains.find((vc) =>
            vc.chain.some((link) => link.txid === vtxoRootOutpoint.txid),
        );

        if (!vtxoChain || !vtxoChain.chain || vtxoChain.chain.length === 0) {
            throw Errors.EMPTY_CHAIN(vtxoRootOutpoint);
        }

        chain = vtxoChain.chain;
        diagnostics.push(
            `  → Identified target chain with ${chain.length} links within batch of ${allChains.length} chain(s) (${batchVirtualTxids.length} batch virtual tx(s) fetched)`,
        );
    } else if (indexer.getVtxoChain) {
        // Direct mode: fetch the specific VTXO chain
        const vtxoChain: VtxoChain = await indexer.getVtxoChain(vtxoRootOutpoint);
        if (!vtxoChain || !vtxoChain.chain || vtxoChain.chain.length === 0) {
            throw Errors.EMPTY_CHAIN(vtxoRootOutpoint);
        }
        chain = vtxoChain.chain;
        diagnostics.push(`  → Direct mode: fetched chain with ${chain.length} links`);
    } else if (indexer.getBatchVtxos) {
        throw new VtxoVerificationError(
            "Batch-scoped verification (getBatchVtxos) requires commitmentTxid to fetch batch VTXOs without revealing the specific VTXO outpoint",
            "INVALID_PROVIDER",
        );
    } else {
        throw new VtxoVerificationError(
            "IndexerProvider must implement either getVtxoChain or getBatchVtxos",
            "INVALID_PROVIDER",
        );
    }

    // ── Step 2: Separate commitment from virtual transactions ────────────────
    const commitmentLinks = chain.filter((c) => c.type === ChainTxType.COMMITMENT);
    const virtualLinks = chain.filter(
        (c) => c.type !== ChainTxType.COMMITMENT && c.type !== ChainTxType.UNSPECIFIED,
    );

    if (commitmentLinks.length === 0) {
        throw Errors.NO_COMMITMENT();
    }

    const actualCommitmentTxid = commitmentLinks[0].txid;
    if (commitmentTxid && actualCommitmentTxid !== commitmentTxid) {
        throw Errors.TXID_MISMATCH(commitmentTxid, actualCommitmentTxid);
    }

    diagnostics.push(`[2/6] Commitment tx: ${actualCommitmentTxid}`);
    diagnostics.push(`  → ${virtualLinks.length} virtual transaction(s) in target chain`);

    if (virtualLinks.length > MAX_VTXO_CHAIN_NODES) {
        throw new VtxoVerificationError(
            `Chain has ${virtualLinks.length} virtual transactions, exceeding the maximum of ${MAX_VTXO_CHAIN_NODES}`,
            "DAG_TOO_LARGE",
        );
    }

    // ── Step 3: Fetch virtual transaction PSBTs ──────────────────────────────
    diagnostics.push(`[3/6] Fetching virtual transaction PSBTs from ASP`);
    const virtualTxids = virtualLinks.map((l) => l.txid);
    const rawPsbts =
        prefetchedPsbts ?? (await fetchAllVirtualTxs(virtualTxids, indexer, new Set(virtualTxids)));

    const txMap = new Map<string, { tx: Transaction; rawPsbt: string; chainTx: ChainTx }>();
    for (const link of virtualLinks) {
        const rawPsbt = rawPsbts.get(link.txid);
        if (!rawPsbt) throw Errors.MISSING_TX(link.txid);

        let tx: Transaction;
        try {
            tx = Transaction.fromPSBT(base64.decode(rawPsbt), { allowUnknownOutputs: true });
        } catch (e: any) {
            throw new VtxoVerificationError(
                `Failed to parse PSBT for ${link.txid}: ${e.message}`,
                "INVALID_PSBT",
                { txid: link.txid, originalError: e.message },
            );
        }

        // Scope constraint: TREE and CHECKPOINT transactions are strictly single-input by Ark
        // protocol rules (TxTree.validate / buildCheckpointTx). Multi-input ChainTxType.ARK
        // offchain consolidation transactions (spending multiple checkpoints across one or more
        // rounds) are explicitly unsupported by this single-input chain verifier and rejected here.
        if (tx.inputsLength !== 1) {
            throw Errors.INVALID_INPUT_COUNT(link.txid, tx.inputsLength);
        }

        if (computeTxid(tx) !== link.txid) throw Errors.TXID_MISMATCH(link.txid, computeTxid(tx));
        txMap.set(link.txid, { tx, rawPsbt, chainTx: link });
    }

    // ── Step 4: Reconstruct the DAG ──────────────────────────────────────────
    diagnostics.push(`[4/6] Reconstructing DAG structure`);
    const chainLookup = new Map<string, ChainTx>();
    for (const link of chain) chainLookup.set(link.txid, link);

    let anchoringLeaf: DAGNode | null = null;
    const allNodes = new Map<string, DAGNode>();

    // 4a. Create all nodes
    for (const [txid, { tx, rawPsbt, chainTx }] of txMap) {
        allNodes.set(txid, {
            txid,
            tx,
            chainTx,
            rawPsbt,
            children: new Map(),
            ancestor: null,
            ancestorOutputIndex: null,
            descendant: null, // Reversing terminology: VTXO is Root
        });
    }

    // 4b. Wire relationships with Cycle Detection
    diagnostics.push(`[4b/6] Reconstructing functional DAG (max ${MAX_VTXO_CHAIN_NODES} nodes)`);
    if (allNodes.size > MAX_VTXO_CHAIN_NODES) {
        throw new VtxoVerificationError(
            `Chain length ${allNodes.size} exceeds max allowed (${MAX_VTXO_CHAIN_NODES})`,
            "DAG_TOO_LARGE",
        );
    }

    const globalVisited = new Set<string>();
    const visiting = new Set<string>();

    for (const node of allNodes.values()) {
        if (!globalVisited.has(node.txid)) {
            let tracer: DAGNode | null = node;
            const currentPath: string[] = [];

            while (tracer && !globalVisited.has(tracer.txid)) {
                if (visiting.has(tracer.txid)) {
                    throw new VtxoVerificationError(
                        `Cycle detected at ${tracer.txid}`,
                        "CYCLE_DETECTED",
                    );
                }
                visiting.add(tracer.txid);
                currentPath.push(tracer.txid);

                const input = tracer.tx.getInput(0);
                if (!input.txid) break;
                const pTxid = hex.encode(input.txid);
                if (pTxid === actualCommitmentTxid) break;
                tracer = allNodes.get(pTxid) ?? null;
            }

            for (const visitedTxid of currentPath) {
                visiting.delete(visitedTxid);
                globalVisited.add(visitedTxid);
            }
        }

        const input = node.tx.getInput(0);
        if (!input.txid) {
            throw new VtxoVerificationError(
                `Transaction ${node.txid} input 0 is missing previous txid reference`,
                "INVALID_INPUT_REF",
                { txid: node.txid },
            );
        }
        const ancestorTxid = hex.encode(input.txid);
        const ancestorOutputIndex = input.index ?? 0;

        if (ancestorTxid === actualCommitmentTxid) {
            node.ancestor = null;
            node.ancestorOutputIndex = ancestorOutputIndex;
            anchoringLeaf = node;
        } else {
            const ancestorNode = allNodes.get(ancestorTxid);
            if (!ancestorNode)
                throw Errors.INPUT_CHAIN_BREAK(node.txid, ancestorTxid, "(not in DAG)");
            node.ancestor = ancestorNode;
            node.ancestorOutputIndex = ancestorOutputIndex;
            ancestorNode.children.set(ancestorOutputIndex, node);
        }
    }

    if (!anchoringLeaf) throw Errors.NO_COMMITMENT();

    const reachable = new Set<string>();
    collectReachable(anchoringLeaf, reachable);
    for (const txid of allNodes.keys()) {
        if (!reachable.has(txid)) throw Errors.ORPHAN_TX(txid);
    }

    // VTXO represents the Root of the verification tree
    const vtxoRoot: DAGNode | null = allNodes.get(vtxoRootOutpoint.txid) || null;
    if (!vtxoRoot) {
        throw new VtxoVerificationError(
            `VTXO Root ${vtxoRootOutpoint.txid} not found in the chain`,
            "ROOT_NOT_FOUND",
        );
    }

    if (vtxoRootOutpoint.vout < 0 || vtxoRootOutpoint.vout >= vtxoRoot.tx.outputsLength) {
        throw new VtxoVerificationError(
            `VTXO Root ${vtxoRootOutpoint.txid} does not have output index ${vtxoRootOutpoint.vout} (total outputs: ${vtxoRoot.tx.outputsLength})`,
            "INVALID_VOUT",
            {
                txid: vtxoRootOutpoint.txid,
                vout: vtxoRootOutpoint.vout,
                outputsLength: vtxoRoot.tx.outputsLength,
            },
        );
    }

    diagnostics.push(`[5/9] Fetching on-chain anchoring status`);
    const onchainStatus = await onchain.getTxStatus(actualCommitmentTxid);
    const commitmentBlockHash = onchainStatus.confirmed ? onchainStatus.blockHash : undefined;
    const blockHash = commitmentBlockHash;
    const commitmentRaw = await onchain.getRawTransaction(actualCommitmentTxid, blockHash);
    let commitmentTx: Transaction;
    try {
        commitmentTx = Transaction.fromRaw(hex.decode(commitmentRaw), {
            allowUnknownOutputs: true,
        });
    } catch (e: any) {
        throw new VtxoVerificationError(
            `Failed to decode on-chain commitment transaction ${actualCommitmentTxid}: ${e.message}`,
            "INVALID_ONCHAIN_TX",
            { commitmentTxid: actualCommitmentTxid, originalError: e.message },
        );
    }
    const computedCommitmentTxid = computeTxid(commitmentTx);
    if (computedCommitmentTxid !== actualCommitmentTxid) {
        throw Errors.TXID_MISMATCH(actualCommitmentTxid, computedCommitmentTxid);
    }
    const batchOutputIndex = anchoringLeaf.ancestorOutputIndex ?? BATCH_OUTPUT_VTXO_INDEX;
    if (batchOutputIndex < 0 || batchOutputIndex >= commitmentTx.outputsLength) {
        throw new VtxoVerificationError(
            `Commitment ${actualCommitmentTxid} has no output at index ${batchOutputIndex}`,
            "ANCHOR_OUTPUT_NOT_FOUND",
            { commitmentTxid: actualCommitmentTxid, outputIndex: batchOutputIndex },
        );
    }
    const batchOutput = commitmentTx.getOutput(batchOutputIndex);
    if (!batchOutput || !batchOutput.script || batchOutput.amount === undefined) {
        throw new VtxoVerificationError(
            `Commitment ${actualCommitmentTxid} output ${batchOutputIndex} is missing script or amount`,
            "MALFORMED_ANCHOR_OUTPUT",
            { commitmentTxid: actualCommitmentTxid, outputIndex: batchOutputIndex },
        );
    }

    anchoringLeaf.prevOutContext = {
        script: batchOutput.script,
        amount: batchOutput.amount,
    };

    const blockchainInfo = onchain.getBlockchainInfo ? await onchain.getBlockchainInfo() : null;

    // ── Steps 6-9: Validations ───────────────────────────────────────────────
    validateDAGChaining(anchoringLeaf, actualCommitmentTxid, diagnostics);
    const checkpointValidations = validateCheckpoints(
        allNodes,
        chainLookup,
        actualCommitmentTxid,
        diagnostics,
    );

    for (const node of allNodes.values()) verifyNodeTaproot(node);
    verifyDAGSignatures(anchoringLeaf);

    let timelocksSatisfied = false;
    if (blockchainInfo) {
        const chainState = {
            currentHeight: blockchainInfo.height,
            currentTime: blockchainInfo.medianTime,
            commitmentHeight: onchainStatus.confirmed ? onchainStatus.blockHeight : undefined,
            commitmentTime: onchainStatus.confirmed ? onchainStatus.blockTime : undefined,
        };
        timelocksSatisfied = verifyDAGTimelocks(anchoringLeaf, chainState, diagnostics);
    } else {
        diagnostics.push(
            "  ! Timelock maturity unverified (provider does not implement getBlockchainInfo)",
        );
    }

    verifyDAGHashPreimages(anchoringLeaf, witnessPreimages);

    const isValid = checkpointValidations.every((cv) => cv.expiryCoherent && cv.parentChainValid);
    const broadcastable = isValid && timelocksSatisfied;

    return {
        valid: isValid,
        timelocksSatisfied,
        broadcastable,
        vtxoRoot: vtxoRoot,
        anchoringLeaf: anchoringLeaf,
        commitmentTxid: actualCommitmentTxid,
        commitmentBlockHash,
        commitmentTxHex: commitmentRaw,
        batchOutputIndex: anchoringLeaf.ancestorOutputIndex ?? BATCH_OUTPUT_VTXO_INDEX,
        checkpointValidations,
        diagnostics,
    };
}

// ─── Internal: Fetch all virtual txs (with batching for large chains) ────────

async function fetchAllVirtualTxs(
    txids: string[],
    indexer: VerificationIndexerProvider,
    requiredTxids?: Set<string>,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const required = requiredTxids ?? new Set(txids);

    // Fetch every batch completely before checking requiredTxids so an indexer
    // cannot infer target membership in batch-scoped mode from an early abort.
    const BATCH_SIZE = 50;
    for (let i = 0; i < txids.length; i += BATCH_SIZE) {
        const batch = txids.slice(i, i + BATCH_SIZE);
        const { txs } = await indexer.getVirtualTxs(batch);

        if (!txs || txs.length !== batch.length) {
            throw new VtxoVerificationError(
                `Indexer returned ${txs?.length ?? 0} virtual transactions for batch of ${batch.length} requested txids`,
                "MISSING_VIRTUAL_TX",
            );
        }

        for (const rawPsbt of txs) {
            if (!rawPsbt) continue;
            try {
                const txBytes = typeof rawPsbt === "string" ? base64.decode(rawPsbt) : rawPsbt;
                const tx = Transaction.fromPSBT(txBytes, { allowUnknownOutputs: true });
                const computedId = computeTxid(tx);
                result.set(computedId, rawPsbt);
            } catch (e: any) {
                if (e instanceof VtxoVerificationError) throw e;
            }
        }
    }

    for (const requestedTxid of required) {
        if (!result.has(requestedTxid)) {
            throw Errors.MISSING_TX(requestedTxid);
        }
    }

    return result;
}

// ─── Internal: Recursively collect all reachable txids ───────────────────────

function collectReachable(node: DAGNode, reachable: Set<string>): void {
    const stack: DAGNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        reachable.add(current.txid);
        for (const child of current.children.values()) {
            stack.push(child);
        }
    }
}

// ─── Internal: Find the deepest anchoring leaf in the DAG ──────────────────

export function findLeafInDAG(node: DAGNode): DAGNode {
    const stack: DAGNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.children.size === 0) {
            return current;
        }
        for (const child of current.children.values()) {
            stack.push(child);
        }
    }
    return node;
}

// ─── Internal: Validate DAG Chaining & Conservation ─────────────────────────

/**
 * Validates the chaining and conservation invariants throughout the DAG:
 *   1. For the Anchoring Leaf: its input[0] must reference the commitment tx,
 *      and the sum of its outputs must equal the batch output amount.
 *   2. For every other node: its input[0] must reference an output on its ancestor,
 *      and the sum of its outputs must equal that ancestor output's amount.
 *   3. No virtual transaction introduces new value or leaks value (conservation).
 *
 * NOTE (Zero-Fee Invariant): Virtual transactions in an Ark DAG are off-chain presigned
 * transitions and pay zero miner fees directly. Sats are strictly conserved at every level of the
 * tree (sum of child outputs === ancestor output amount). Any on-chain fees required during a
 * sovereign unilateral exit are provided via anchor outputs / CPFP or dedicated fee inputs.
 *
 * Recursively validates that every child's input[0] correctly references
 * the parent's output at the expected index, and that the sum of child
 * outputs equals the parent's output amount.
 */
function validateDAGChaining(
    rootNode: DAGNode,
    commitmentTxid: string,
    diagnostics: string[],
): void {
    const stack: DAGNode[] = [rootNode];

    while (stack.length > 0) {
        const node = stack.pop()!;

        // 1. Validate anchoring leaf's anchor to the commitment tx ─────────────
        if (node.ancestor === null) {
            const input = node.tx.getInput(0);
            if (!input.txid) {
                throw Errors.INPUT_CHAIN_BREAK(node.txid, commitmentTxid, "(no input)");
            }

            const inputTxid = hex.encode(input.txid);
            if (inputTxid !== commitmentTxid) {
                throw Errors.INPUT_CHAIN_BREAK(node.txid, commitmentTxid, inputTxid);
            }

            diagnostics.push(
                `  ✓ Anchoring Leaf ${node.txid} correctly anchored to commitment ${commitmentTxid} at output[${input.index ?? 0}]`,
            );

            // Verify anchoring leaf amount against commitment
            const anchorPrevOut = node.prevOutContext;
            if (anchorPrevOut) {
                let anchorOutputsSum = 0n;
                for (let i = 0; i < node.tx.outputsLength; i++) {
                    const out = node.tx.getOutput(i);
                    if (out?.amount) anchorOutputsSum += out.amount;
                }

                if (anchorOutputsSum !== anchorPrevOut.amount) {
                    throw Errors.AMOUNT_MISMATCH(
                        commitmentTxid,
                        input.index ?? 0,
                        anchorPrevOut.amount,
                        anchorOutputsSum,
                    );
                }
                diagnostics.push(
                    `  ✓ Anchoring Leaf amount ${anchorOutputsSum} matches commitment batch output (conserved)`,
                );
            }
        }

        // 2. Validate each child (traveling from Anchor towards VTXO Root) ─────
        for (const [outputIndex, child] of node.children) {
            // (a) Verify child's input references the ancestor's output
            const childInput = child.tx.getInput(0);
            if (!childInput.txid) {
                throw Errors.INPUT_CHAIN_BREAK(child.txid, node.txid, "(no input txid)");
            }

            const childInputTxid = hex.encode(childInput.txid);
            const childInputIndex = childInput.index ?? 0;

            if (childInputTxid !== node.txid) {
                throw Errors.INPUT_CHAIN_BREAK(child.txid, node.txid, childInputTxid);
            }

            if (childInputIndex !== outputIndex) {
                throw new VtxoVerificationError(
                    `Child ${child.txid} input index ${childInputIndex} does not match expected output index ${outputIndex}`,
                    "INDEX_MISMATCH",
                    { childTxid: child.txid, expected: outputIndex, actual: childInputIndex },
                );
            }

            // (b) Verify amounts: sum(child outputs) == ancestor output[index]
            const ancestorOutput = node.tx.getOutput(outputIndex);
            if (!ancestorOutput || ancestorOutput.amount === undefined) {
                throw new VtxoVerificationError(
                    `Ancestor ${node.txid} has no output at index ${outputIndex}`,
                    "MISSING_OUTPUT",
                    { ancestorTxid: node.txid, outputIndex },
                );
            }

            let childOutputsSum = 0n;
            for (let i = 0; i < child.tx.outputsLength; i++) {
                const out = child.tx.getOutput(i);
                if (out?.amount) {
                    childOutputsSum += out.amount;
                }
            }

            // Protocol invariant (Finding 12 — Zero-Fee Internal Hops):
            // Every Ark virtual transaction (tree, checkpoint, and offchain ark tx) is a Bitcoin v3
            // (TRUC) transaction carrying a P2A ephemeral dust output. Under Bitcoin Core's ephemeral
            // dust policy, any tx with an ephemeral dust output must itself pay zero implicit miner
            // fee: sum(outputs) === sum(inputs). Both this SDK (TxTree.validate, validateVtxoTxGraph,
            // buildVirtualTx — which routes any protocol fee into the P2A output value) and arkd
            // (pkg/ark-lib/offchain/tx.go BuildTxsWithFee, pkg/ark-lib/tree/tx_tree.go) enforce
            // strict equality at every single-input internal hop; on-chain broadcast fees are paid
            // externally via 1P1C CPFP spending the P2A output.
            if (childOutputsSum !== ancestorOutput.amount) {
                throw Errors.AMOUNT_MISMATCH(
                    node.txid,
                    outputIndex,
                    ancestorOutput.amount,
                    childOutputsSum,
                );
            }

            diagnostics.push(
                `  ✓ ${child.txid} → ancestor ${node.txid}[${outputIndex}]: ${ancestorOutput.amount} sats (chain OK)`,
            );

            // (c) Add child to stack for iterative processing
            stack.push(child);
        }
    }
}

// ─── Internal: Validate Checkpoint Transactions ──────────────────────────────

/**
 * Validates checkpoint transactions in the DAG.
 *
 * Checkpoint transactions are intermediate states designed to protect the ASP
 * against griefing attacks. They are signed by both user and operator and
 * inserted between the batch output and the final VTXO.
 *
 * Validations performed:
 *   1. The checkpoint's input correctly references a parent in the DAG.
 *   2. The checkpoint's expiry (expiresAt) is coherent with the sweep delay:
 *      – It must not outlive its parent round / ancestor.
 *      – It must not outlive the batch root commitment expiry.
 *   3. The checkpoint has exactly 1 input (structural consistency).
 *   4. The checkpoint's outputs sum must equal its parent output amount.
 */
function validateCheckpoints(
    allNodes: Map<string, DAGNode>,
    chainLookup: Map<string, ChainTx>,
    commitmentTxid: string,
    diagnostics: string[],
): CheckpointValidation[] {
    const results: CheckpointValidation[] = [];

    for (const [txid, node] of allNodes) {
        if (node.chainTx.type !== ChainTxType.CHECKPOINT) {
            continue;
        }

        const notes: string[] = [];
        let expiryCoherent = true;
        let parentChainValid = true;

        // 1. Verify checkpoint has ancestors in the chain ─────────────────────
        if (node.chainTx.spends.length === 0) {
            notes.push("FAIL: Checkpoint has no ancestor references in chain data");
            parentChainValid = false;
            throw Errors.CHECKPOINT_PARENT_MISMATCH(
                txid,
                "Checkpoint has no ancestor references in chain data",
            );
        }

        // Verify input chaining (already done globally, but double-check)
        const input = node.tx.getInput(0);
        if (!input.txid) {
            notes.push("FAIL: Checkpoint has no input txid");
            parentChainValid = false;
            throw Errors.MALFORMED_VTXO_TREE(`Checkpoint ${txid} has no input txid`);
        } else {
            const ancestorTxid = hex.encode(input.txid);
            const ancestorInChain = chainLookup.get(ancestorTxid);

            if (!ancestorInChain) {
                notes.push(`FAIL: Checkpoint ancestor ${ancestorTxid} not found in chain metadata`);
                parentChainValid = false;
                throw Errors.CHECKPOINT_PARENT_MISMATCH(
                    txid,
                    `Checkpoint ancestor ${ancestorTxid} not found in chain metadata`,
                );
            } else {
                notes.push(`Ancestor in chain: ${ancestorTxid} (type: ${ancestorInChain.type})`);
            }
        }

        // 2. Validate expiry coherence ─────────────────────────────────────
        //
        // Protocol Invariant (Finding 10 — Checkpoint Expiry Ordering):
        // In arkd (internal/core/application/service.go SubmitTx & indexer.go walkVtxoChain),
        // an offchain tx inherits ExpiryTimestamp = min(spentVtxo.ExpiresAt) across its inputs and
        // stamps that expiry on both the ark tx and its checkpoints, while batch tree nodes and
        // the commitment carry the batch expiry. Thus expiresAt is monotonically non-increasing
        // from commitment -> tree -> checkpoint -> ark tx:
        //   – checkpoint.expiresAt <= ancestor.expiresAt
        //   – checkpoint.expiresAt <= batchRoot.expiresAt
        // Equality is valid (standard single-round chains); strictly greater (>) is rejected
        // because a checkpoint cannot outlive an ancestor the operator can sweep earlier on-chain.
        //
        const checkpointExpiry = parseExpiry(node.chainTx.expiresAt);

        if (node.ancestor) {
            const ancestorExpiry = parseExpiry(node.ancestor.chainTx.expiresAt);

            if (checkpointExpiry > 0 && ancestorExpiry > 0) {
                if (checkpointExpiry > ancestorExpiry) {
                    expiryCoherent = false;
                    notes.push(
                        `FAIL: Checkpoint expires at ${checkpointExpiry} but ancestor expires at ${ancestorExpiry} (checkpoint must not outlive ancestor)`,
                    );
                    throw Errors.CHECKPOINT_EXPIRY_INCOHERENT(
                        txid,
                        `expires at ${checkpointExpiry} but ancestor at ${ancestorExpiry}`,
                    );
                } else {
                    notes.push(
                        `Expiry OK: checkpoint=${checkpointExpiry}, ancestor=${ancestorExpiry}`,
                    );
                }
            } else {
                notes.push("INFO: Could not compare expiry times (one or both are 0/unparsed)");
            }
        }

        // ── 3. Compare against the batch root (commitment) expiry ────────────
        let batchRootExpiry = 0;
        const commitmentChainTx = chainLookup.get(commitmentTxid);
        if (commitmentChainTx) {
            batchRootExpiry = parseExpiry(commitmentChainTx.expiresAt);
        }

        if (checkpointExpiry > 0 && batchRootExpiry > 0 && checkpointExpiry > batchRootExpiry) {
            expiryCoherent = false;
            notes.push(
                `FAIL: Checkpoint expires at ${checkpointExpiry} but batch root (commitment) expires at ${batchRootExpiry}`,
            );
            throw Errors.CHECKPOINT_EXPIRY_INCOHERENT(
                txid,
                `expires at ${checkpointExpiry} but batch root at ${batchRootExpiry}`,
            );
        }

        // ── 4. Validate sweep delay coherence ────────────────────────────────
        if (input.txid) {
            const sequence = input.sequence;
            if (sequence !== undefined && sequence !== 0xffffffff) {
                notes.push(`Sweep delay present (nSequence=0x${sequence.toString(16)})`);
            } else {
                notes.push("WARNING: Checkpoint input does not have relative timelock set");
            }
        }

        // ── 5. Validate single input and amount conservation ────────────────
        if (node.tx.inputsLength !== 1) {
            notes.push(`FAIL: Checkpoint has ${node.tx.inputsLength} inputs (must be exactly 1)`);
            parentChainValid = false;
            throw Errors.MALFORMED_VTXO_TREE(
                `Checkpoint ${txid} has ${node.tx.inputsLength} inputs (must be exactly 1)`,
            );
        }

        const valid = expiryCoherent && parentChainValid;
        diagnostics.push(
            `  ${valid ? "✓" : "✗"} Checkpoint ${txid.slice(0, 12)}…: ${valid ? "coherent" : "INCOHERENT"}`,
        );

        results.push({
            txid,
            expiryCoherent,
            parentChainValid,
            notes,
        });
    }

    return results;
}

/**
 * Parses an expiry string (Unix timestamp in seconds) to a number.
 * Returns 0 if unparseable.
 */
function parseExpiry(expiresAt?: string): number {
    if (!expiresAt) return 0;
    const parsed = Number.parseInt(expiresAt, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

// ─── Internal: On-chain Anchoring Verification ───────────────────────────────

/**
 * Verifies that the commitment transaction is anchored on-chain with
 * sufficient confirmations and the expected output amount/script.
 *
 * @param commitmentTxid  Txid of the commitment transaction.
 * @param batchOutputIndex The batch output index (usually 0).
 * @param expectedVtxoAmount  The expected amount in satoshis.
 * @param expectedVtxoScript  The expected output script (Taproot).
 * @param onchain         OnchainProvider.
 * @param minConfirmations Minimum required confirmations.
 */
export async function verifyOnchainAnchoring(
    commitmentTxid: string,
    batchOutputIndex: number,
    expectedVtxoAmount: bigint,
    expectedVtxoScript: Uint8Array,
    onchain: VerificationOnchainProvider,
    minConfirmations: number = 1,
    commitmentBlockHash?: string,
    commitmentRawTxHex?: string,
): Promise<{ confirmed: boolean; blockHeight?: number; blockTime?: number; blockHash?: string }> {
    // 1. Check confirmation status
    const status = await onchain.getTxStatus(commitmentTxid, commitmentBlockHash);

    await checkCommitmentDepth(commitmentTxid, minConfirmations, status, onchain);

    // 2. Fetch raw transaction to verify output script and amount
    const statusBlockHash = status.confirmed ? status.blockHash : undefined;
    const blockHash = commitmentBlockHash ?? statusBlockHash;
    const rawTxHex =
        commitmentRawTxHex ?? (await onchain.getRawTransaction(commitmentTxid, blockHash));
    let onchainTx: Transaction;
    try {
        onchainTx = Transaction.fromRaw(hex.decode(rawTxHex), { allowUnknownOutputs: true });
    } catch (e: any) {
        throw new VtxoVerificationError(
            `Failed to parse on-chain commitment transaction ${commitmentTxid}: ${e.message}`,
            "INVALID_ONCHAIN_TX",
            { commitmentTxid, originalError: e.message },
        );
    }
    const actualTxid = computeTxid(onchainTx);
    if (actualTxid !== commitmentTxid) {
        throw Errors.TXID_MISMATCH(commitmentTxid, actualTxid);
    }

    // 3. Verify output index exists
    if (batchOutputIndex < 0 || batchOutputIndex >= onchainTx.outputsLength) {
        throw new VtxoVerificationError(
            `Commitment ${commitmentTxid} has no output at index ${batchOutputIndex} (total: ${onchainTx.outputsLength})`,
            "ANCHOR_OUTPUT_NOT_FOUND",
            { commitmentTxid, batchOutputIndex, totalOutputs: onchainTx.outputsLength },
        );
    }

    const output = onchainTx.getOutput(batchOutputIndex);

    // 4. Verify amount matches
    if (output.amount !== expectedVtxoAmount) {
        throw new VtxoVerificationError(
            `On-chain commitment output amount mismatch: expected ${expectedVtxoAmount}, found ${output.amount}`,
            "ANCHOR_AMOUNT_MISMATCH",
            {
                commitmentTxid,
                batchOutputIndex,
                expected: expectedVtxoAmount,
                actual: output.amount,
            },
        );
    }

    // 5. Verify scriptPubKey matches
    if (!output.script) {
        throw new VtxoVerificationError(
            `Commitment ${commitmentTxid} output ${batchOutputIndex} is missing scriptPubKey`,
            "MALFORMED_ANCHOR_OUTPUT",
            { commitmentTxid, batchOutputIndex },
        );
    }

    const actualScriptHex = hex.encode(output.script);
    const expectedScriptHex = hex.encode(expectedVtxoScript);
    if (actualScriptHex !== expectedScriptHex) {
        throw new VtxoVerificationError(
            `On-chain script mismatch for commitment ${commitmentTxid} at vout ${batchOutputIndex}`,
            "ANCHOR_SCRIPT_MISMATCH",
            {
                commitmentTxid,
                batchOutputIndex,
                expected: expectedScriptHex,
                actual: actualScriptHex,
            },
        );
    }

    return status;
}

// ─── Convenience: Full verification pipeline ─────────────────────────────────

const onchainLimiter = new ConcurrencyLimiter(10);

/**
 * Complete Tier 1 verification pipeline:
 *   1. Reconstruct + validate the DAG (this module).
 *   2. Verify the commitment tx is confirmed on-chain.
 *
 * @param vtxoOutpoint  The VTXO leaf to verify end-to-end.
 * @param indexer       VerificationIndexerProvider.
 * @param onchain       VerificationOnchainProvider.
 * @param minConfirmations  Minimum on-chain confirmations (default: 1).
 * @param witnessPreimages  Optional map of witness hashes to preimages for HTLC validation.
 * @param commitmentTxid    Optional commitment txid requesting fail-closed batch-scoped lookup via `getBatchVtxos`.
 * @returns The full validation result.
 */
export async function verifyVtxoComplete(
    vtxoOutpoint: Outpoint,
    indexer: VerificationIndexerProvider,
    onchain: VerificationOnchainProvider,
    minConfirmations: number = 1,
    witnessPreimages?: Map<string, Uint8Array>,
    commitmentTxid?: string,
): Promise<
    DAGValidationResult & {
        onchainStatus: { confirmed: boolean; blockHeight?: number; confirmations?: number };
    }
> {
    // Phase 1: DAG reconstruction + structural validation
    const dagResult = await reconstructAndValidateVtxoDAG(
        vtxoOutpoint,
        indexer,
        onchain,
        witnessPreimages,
        commitmentTxid,
    );

    if (!dagResult.valid) {
        throw new VtxoVerificationError(
            `VTXO DAG verification failed for ${vtxoOutpoint.txid}:${vtxoOutpoint.vout}: invalid checkpoint or structural validation`,
            "VERIFICATION_FAILED",
            { vtxoOutpoint, checkpointValidations: dagResult.checkpointValidations },
        );
    }

    // Phase 2: On-chain anchoring verification (throttled)
    // COMPLIANCE TASK 3.1: Live verification of depth, scripts, and amounts against on-chain data.
    const onchainStatus = await onchainLimiter.run(async () => {
        const anchor = dagResult.anchoringLeaf.prevOutContext;
        if (!anchor || anchor.amount === undefined || anchor.script === undefined) {
            // Fallback to confirmation check if structural data is missing
            const status = await onchain.getTxStatus(
                dagResult.commitmentTxid,
                dagResult.commitmentBlockHash,
            );
            await checkCommitmentDepth(dagResult.commitmentTxid, minConfirmations, status, onchain);
            return status;
        }

        return verifyOnchainAnchoring(
            dagResult.commitmentTxid,
            dagResult.batchOutputIndex,
            anchor.amount,
            anchor.script,
            onchain,
            minConfirmations,
            dagResult.commitmentBlockHash,
            dagResult.commitmentTxHex,
        );
    });

    const blockMsg =
        onchainStatus.confirmed && onchainStatus.blockHeight !== undefined
            ? ` at block ${onchainStatus.blockHeight}`
            : "";
    dagResult.diagnostics.push(`✓ Commitment tx ${dagResult.commitmentTxid} confirmed${blockMsg}`);

    return {
        ...dagResult,
        broadcastable: dagResult.broadcastable && onchainStatus.confirmed,
        onchainStatus,
    };
}

// ─── Shared helper: verify depth logic ────────

async function checkCommitmentDepth(
    commitmentTxid: string,
    minConfirmations: number,
    status: { confirmed: boolean; blockHeight?: number; confirmations?: number },
    onchain: VerificationOnchainProvider,
): Promise<void> {
    if (!status.confirmed) {
        throw new VtxoVerificationError(
            `Commitment transaction ${commitmentTxid} is not confirmed on-chain (min: ${minConfirmations})`,
            "COMMITMENT_NOT_CONFIRMED",
            { commitmentTxid, minConfirmations },
        );
    }

    let depth = status.confirmations;
    if (depth === undefined && status.blockHeight !== undefined && onchain.getBlockchainInfo) {
        const chainInfo = await onchain.getBlockchainInfo();
        depth = chainInfo.height - status.blockHeight + 1;
    }

    if (depth === undefined && status.confirmed && minConfirmations > 1) {
        throw new VtxoVerificationError(
            `Onchain provider returned confirmed without depth, but minConfirmations is ${minConfirmations}. Provider must implement confirmations or getBlockchainInfo.`,
            "PROVIDER_LACKS_DEPTH",
            { commitmentTxid, minConfirmations },
        );
    }
    const effectiveDepth = depth ?? (status.confirmed ? 1 : 0);

    if (effectiveDepth < minConfirmations) {
        throw new VtxoVerificationError(
            `Commitment transaction ${commitmentTxid} is confirmed at depth ${effectiveDepth}, which is less than requested minConfirmations ${minConfirmations}`,
            "COMMITMENT_NOT_CONFIRMED",
            { commitmentTxid, minConfirmations, depth: effectiveDepth },
        );
    }
}
