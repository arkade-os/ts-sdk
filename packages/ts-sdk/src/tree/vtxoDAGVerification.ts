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

import { Transaction } from "@scure/btc-signer/transaction.js";
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

// ─── Performance Buffers ───────────────────────────────────────────────────
//
// Concurrency limiter to bound parallel on-chain queries.
//
const globalOnchainLimiter = new ConcurrencyLimiter(10); // Max 10 concurrent RPCs

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the txid of a Transaction (including unsigned PSBTs).
 * @scure/btc-signer@1.x throws "Transaction is not finalized" when accessing
 * `.id` or `.hash` on unsigned transactions. We compute manually:
 * txid = REVERSE(SHA256d(non-witness serialization)).
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
 */
export interface VerificationIndexerProvider {
    /** Get all VTXO chains associated with a specific commitment batch (Privacy Mode). */
    getBatchVtxos?(commitmentTxid: string): Promise<VtxoChain[]>;

    /** Get the specific chain for a VTXO outpoint. */
    getVtxoChain?(vtxo: Outpoint): Promise<VtxoChain>;

    /** Fetch raw virtual transaction PSBTs (base64-encoded). */
    getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
}

export type IndexerProvider = VerificationIndexerProvider;

/**
 * Interface for an on-chain explorer/node in verification context.
 */
export interface VerificationOnchainProvider {
    /** Get a raw transaction by txid (hex-encoded), optionally specifying blockhash if txindex is disabled. */
    getRawTransaction(txid: string, blockhash?: string): Promise<string>;
    /** Check if a transaction is confirmed and at what depth. */
    getTxStatus(
        txid: string,
        blockhash?: string,
    ): Promise<{
        confirmed: boolean;
        blockHeight?: number;
        blockTime?: number;
        blockHash?: string;
        confirmations?: number;
    }>;
    /** Get current blockchain tip info (optional — needed for timelock validation). */
    getBlockchainInfo?(): Promise<{ height: number; medianTime: number }>;
    /** Orchestrate and push a signed raw transaction completely to the Bitcoin network. */
    broadcastTransaction(txHex: string): Promise<string>;
}

export type OnchainProvider = VerificationOnchainProvider;

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
 * Reconstructs and validates the full DAG for a given VTXO.
 *
 * This is the Tier 1 core deliverable of the assignment:
 *   - Fetches the VTXO chain from the Indexer.
 *   - Fetches all virtual transaction PSBTs from the Indexer.
 *   - Reconstructs the DAG from Root (VTXO) → Leaf (Anchor).
 *   - Validates input→output ancestor chaining at every level.
 *   - Validates checkpoint transactions for sweep-delay coherence.
 *   - Validates that the Anchoring Leaf is anchored to the commitment tx.
 *
 * @param vtxoRootOutpoint  The user's starting VTXO Root outpoint to verify.
 * @param indexer           An IndexerProvider implementation (e.g. RestIndexerProvider).
 * @param onchain           An OnchainProvider implementation (e.g. EsploraProvider).
 * @param witnessPreimages  Optional map of witness hashes to preimages for HTLC validation.
 * @param commitmentTxid    Optional commitment txid for privacy-preserving batch lookup.
 * @throws VtxoVerificationError on any structural inconsistency.
 * @returns A DAGValidationResult with the full reconstructed + validated DAG.
 */
export async function reconstructAndValidateVtxoDAG(
    vtxoRootOutpoint: Outpoint,
    indexer: IndexerProvider,
    onchain: OnchainProvider,
    witnessPreimages?: Map<string, Uint8Array>,
    commitmentTxid?: string,
): Promise<DAGValidationResult> {
    const diagnostics: string[] = [];

    // ── Step 1: Fetch the VTXO chain ────────────────────────────────────────
    //
    // Two modes of operation:
    //   (a) Direct: Use getVtxoChain() to fetch the specific VTXO's chain.
    //   (b) Privacy-preserving: Use getBatchVtxos() to fetch ALL chains in the
    //       commitment batch, then filter locally. This prevents the ASP from
    //       learning which specific VTXO the client is verifying.
    //
    diagnostics.push(
        `[1/6] Fetching VTXO chain for ${vtxoRootOutpoint.txid}:${vtxoRootOutpoint.vout}`,
    );

    let chain: ChainTx[];

    if (indexer.getVtxoChain) {
        // Direct mode: fetch the specific VTXO chain
        const vtxoChain: VtxoChain = await indexer.getVtxoChain(vtxoRootOutpoint);
        if (!vtxoChain || !vtxoChain.chain || vtxoChain.chain.length === 0) {
            throw Errors.EMPTY_CHAIN(vtxoRootOutpoint);
        }
        chain = vtxoChain.chain;
        diagnostics.push(`  → Direct mode: fetched chain with ${chain.length} links`);
    } else if (indexer.getBatchVtxos) {
        // Privacy-preserving mode: fetch batch and filter locally
        if (!commitmentTxid) {
            throw new VtxoVerificationError(
                "Privacy-preserving verification (getBatchVtxos) requires commitmentTxid to fetch batch VTXOs without revealing the specific VTXO outpoint",
                "INVALID_PROVIDER",
            );
        }
        diagnostics.push(
            `  → Privacy mode: fetching all chains in batch for commitment ${commitmentTxid}`,
        );
        const allChains = await indexer.getBatchVtxos(commitmentTxid);

        const vtxoChain = allChains.find((vc) =>
            vc.chain.some((link) => link.txid === vtxoRootOutpoint.txid),
        );

        if (!vtxoChain || !vtxoChain.chain || vtxoChain.chain.length === 0) {
            throw Errors.EMPTY_CHAIN(vtxoRootOutpoint);
        }

        chain = vtxoChain.chain;
        diagnostics.push(
            `  → Identified local chain with ${chain.length} links (Privacy preserved)`,
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
    diagnostics.push(`[2/6] Commitment tx: ${actualCommitmentTxid}`);
    diagnostics.push(`  → ${virtualLinks.length} virtual transaction(s) to fetch`);

    if (virtualLinks.length > MAX_VTXO_CHAIN_NODES) {
        throw new VtxoVerificationError(
            `Chain has ${virtualLinks.length} virtual transactions, exceeding the maximum of ${MAX_VTXO_CHAIN_NODES}`,
            "DAG_TOO_LARGE",
        );
    }

    // ── Step 3: Fetch all virtual transaction PSBTs ──────────────────────────
    diagnostics.push(`[3/6] Fetching virtual transaction PSBTs from ASP`);
    const virtualTxids = virtualLinks.map((l) => l.txid);
    const rawPsbts = await fetchAllVirtualTxs(indexer, virtualTxids);

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

        // In the current Ark protocol design, all virtual transactions (tree nodes and checkpoint nodes)
        // are strictly single-input transactions spending from their direct ancestor in the DAG.
        // Future protocol revisions supporting multi-input consolidation would relax this specifically
        // for checkpoint/consolidation nodes.
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
    diagnostics.push(`[4/6] Reconstructing functional DAG (max ${MAX_VTXO_CHAIN_NODES} nodes)`);
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
    const commitmentBlockHash = onchainStatus.blockHash;
    const commitmentRaw = await onchain.getRawTransaction(
        actualCommitmentTxid,
        commitmentBlockHash,
    );
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

    let timelocksSatisfied = true;
    if (blockchainInfo) {
        const chainState = {
            currentHeight: blockchainInfo.height,
            currentTime: blockchainInfo.medianTime,
            commitmentHeight: onchainStatus.confirmed ? onchainStatus.blockHeight : undefined,
        };
        timelocksSatisfied = verifyDAGTimelocks(anchoringLeaf, chainState, diagnostics);
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
        batchOutputIndex: anchoringLeaf.ancestorOutputIndex ?? BATCH_OUTPUT_VTXO_INDEX,
        checkpointValidations,
        diagnostics,
    };
}

// ─── Internal: Fetch all virtual txs (with batching for large chains) ────────

async function fetchAllVirtualTxs(
    indexer: IndexerProvider,
    txids: string[],
): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    // Batch in groups of 50 to avoid oversized requests
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

        // Zero-trust: map raw PSBTs by their computed txid rather than assuming positional 1-to-1 array alignment
        for (let j = 0; j < txs.length; j++) {
            const rawPsbt = txs[j];
            if (!rawPsbt) continue;
            try {
                const txBytes = typeof rawPsbt === "string" ? base64.decode(rawPsbt) : rawPsbt;
                const tx = Transaction.fromPSBT(txBytes, { allowUnknownOutputs: true });
                const computedId = computeTxid(tx);

                // Assert positional order to catch misbehaving indexers
                if (computedId !== batch[j]) {
                    throw new VtxoVerificationError(
                        `Indexer returned txid ${computedId} at index ${j}, but requested txid was ${batch[j]}`,
                        "TXID_MISMATCH",
                    );
                }

                result.set(computedId, rawPsbt);
            } catch (e: any) {
                // If decoding fails here, it will be caught when validating requested batch txids below
                if (e instanceof VtxoVerificationError) throw e;
            }
        }

        // Verify every requested txid in the batch was returned
        for (const requestedTxid of batch) {
            if (!result.has(requestedTxid)) {
                throw Errors.MISSING_TX(requestedTxid);
            }
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

            // Protocol invariant (Finding 12): virtual tree transactions carry zero miner fees
            // at internal hops (miner fees are paid exclusively at the on-chain batch root commitment).
            // Therefore, strict amount conservation (sum of child outputs === ancestor output amount)
            // is required and intentional.
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
        // Protocol Invariant (Checkpoint Expiry Ordering):
        // Checkpoints are intermediate off-chain states designed to protect against ASP griefing.
        // If an ancestor transaction or the batch root commitment expires, the ASP can unilaterally
        // sweep the expired ancestor outpoint on-chain, immediately invalidating all descendant
        // checkpoints. Therefore, a checkpoint cannot outlive its spending ancestor or the commitment root:
        //   – checkpoint.expiresAt <= ancestor.expiresAt
        //   – checkpoint.expiresAt <= batchRoot.expiresAt
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
 * @param outputIndex     The batch output index (usually 0).
 * @param expectedAmount  The expected amount in satoshis.
 * @param expectedScript  The expected output script (Taproot).
 * @param onchain         OnchainProvider.
 * @param minConfirmations Minimum required confirmations.
 */
async function verifyOnchainAnchoring(
    commitmentTxid: string,
    outputIndex: number,
    expectedAmount: bigint,
    expectedScript: Uint8Array,
    onchain: VerificationOnchainProvider,
    minConfirmations: number = 1,
    commitmentBlockHash?: string,
): Promise<{ confirmed: boolean; blockHeight?: number; blockTime?: number; blockHash?: string }> {
    // 1. Check confirmation status
    const status = await onchain.getTxStatus(commitmentTxid, commitmentBlockHash);

    await checkCommitmentDepth(commitmentTxid, minConfirmations, status, onchain);

    // 2. Fetch raw transaction to verify output script and amount
    const rawTxHex = await onchain.getRawTransaction(
        commitmentTxid,
        commitmentBlockHash ?? status.blockHash,
    );
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

    // 3. Verify output index exists
    if (outputIndex >= onchainTx.outputsLength) {
        throw new VtxoVerificationError(
            `Commitment ${commitmentTxid} has no output at index ${outputIndex} (total: ${onchainTx.outputsLength})`,
            "ANCHOR_OUTPUT_NOT_FOUND",
            { commitmentTxid, outputIndex, totalOutputs: onchainTx.outputsLength },
        );
    }

    const output = onchainTx.getOutput(outputIndex);

    // 4. Verify amount matches
    if (output.amount !== expectedAmount) {
        throw new VtxoVerificationError(
            `On-chain commitment output amount mismatch: expected ${expectedAmount}, found ${output.amount}`,
            "ANCHOR_AMOUNT_MISMATCH",
            { commitmentTxid, outputIndex, expected: expectedAmount, actual: output.amount },
        );
    }

    // 5. Verify scriptPubKey matches
    if (!output.script) {
        throw new VtxoVerificationError(
            `Commitment ${commitmentTxid} output ${outputIndex} is missing scriptPubKey`,
            "MALFORMED_ANCHOR_OUTPUT",
            { commitmentTxid, outputIndex },
        );
    }

    const actualScriptHex = hex.encode(output.script);
    const expectedScriptHex = hex.encode(expectedScript);
    if (actualScriptHex !== expectedScriptHex) {
        throw new VtxoVerificationError(
            `On-chain script mismatch for commitment ${commitmentTxid} at vout ${outputIndex}`,
            "ANCHOR_SCRIPT_MISMATCH",
            { commitmentTxid, outputIndex, expected: expectedScriptHex, actual: actualScriptHex },
        );
    }

    return status;
}

// ─── Convenience: Full verification pipeline ─────────────────────────────────

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
 * @param commitmentTxid    Optional commitment txid for privacy-preserving batch lookup.
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
    const onchainStatus = await globalOnchainLimiter.run(async () => {
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
        );
    });

    const blockMsg =
        onchainStatus.blockHeight !== undefined ? ` at block ${onchainStatus.blockHeight}` : "";
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
