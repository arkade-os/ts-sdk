import { hex, base64 } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import type { Outpoint, VirtualCoin } from "../wallet";
import type { IndexerProvider } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { RelativeTimelock } from "../script/tapscript";
import { CSVMultisigTapscript } from "../script/tapscript";
import {
    findInputIndexSpendingOutpoint,
    TxTree,
    TxTreeNode,
} from "../tree/txTree";
import { validateVtxoTxGraph } from "../tree/validation";
import { verifyOnchainAnchor } from "./onchainAnchorVerifier";
import {
    verifyTreeSignatures,
    verifyCosignerKeys,
    verifyInternalKeysUnspendable,
} from "./signatureVerifier";
import { verifyScriptSatisfaction } from "./scriptVerifier";
import { Transaction } from "../utils/transaction";
import { errorMessage } from "./utils";

export interface VtxoVerificationResult {
    valid: boolean;
    vtxoOutpoint: Outpoint;
    /** Primary commitment txid (first in chain). Use commitmentTxids for all. */
    commitmentTxid: string;
    /** All commitment txids found in the DAG (a VTXO can span multiple batches). */
    commitmentTxids: string[];
    confirmationDepth: number;
    chainLength: number;
    errors: string[];
    warnings: string[];
}

export interface VtxoVerificationOptions {
    minConfirmationDepth?: number;
    verifySignatures?: boolean;
}

const BATCH_OUTPUT_INDEX = 0;
const MAX_ERRORS = 100;

type PushError = (msg: string) => void;

function collectErrors<T extends { valid: boolean; error?: string }>(
    results: T[],
    format: (r: T) => string
): string[] {
    return results.filter((r) => !r.valid).map(format);
}

function getActualParentTxids(tx: Transaction): Set<string> {
    const parents = new Set<string>();
    for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
        const input = tx.getInput(inputIndex);
        if (input.txid) {
            parents.add(hex.encode(input.txid));
        }
    }
    return parents;
}

function validatePathTx(
    txid: string,
    tx: Transaction,
    pathTxs: Map<string, Transaction>,
    commitmentTxidSet: Set<string>,
    declaredParents: string[],
    pushError: PushError,
    warnings: string[]
): void {
    let totalInputAmount = 0n;
    let hasKnownInputAmount = false;
    let missingInputAmount = false;

    for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
        const input = tx.getInput(inputIndex);
        if (!input.txid) {
            pushError(`DAG tx ${txid} input ${inputIndex} has no txid`);
            continue;
        }

        const parentTxid = hex.encode(input.txid);
        if (!commitmentTxidSet.has(parentTxid) && !pathTxs.has(parentTxid)) {
            pushError(
                `DAG tx ${txid} input ${inputIndex} references unknown parent ${parentTxid}`
            );
        }

        let inputAmount = input.witnessUtxo?.amount;
        if (inputAmount === undefined) {
            const parentTx = pathTxs.get(parentTxid);
            if (parentTx) {
                const parentOutputIndex = input.index ?? 0;
                inputAmount = parentTx.getOutput(parentOutputIndex)?.amount;
            }
        }

        if (inputAmount !== undefined) {
            totalInputAmount += inputAmount;
            hasKnownInputAmount = true;
        } else {
            missingInputAmount = true;
        }
    }

    const actualParents = getActualParentTxids(tx);
    const declaredParentSet = new Set(declaredParents);
    const missingParents = [...actualParents].filter(
        (parentTxid) => !declaredParentSet.has(parentTxid)
    );
    const unexpectedParents = declaredParents.filter(
        (parentTxid) => !actualParents.has(parentTxid)
    );

    if (missingParents.length > 0) {
        pushError(
            `Chain metadata mismatch for tx ${txid}: missing parents ${missingParents.join(", ")}`
        );
    }
    if (unexpectedParents.length > 0) {
        pushError(
            `Chain metadata mismatch for tx ${txid}: unexpected parents ${unexpectedParents.join(", ")}`
        );
    }

    if (hasKnownInputAmount && !missingInputAmount) {
        let outputSum = 0n;
        for (
            let outputIndex = 0;
            outputIndex < tx.outputsLength;
            outputIndex++
        ) {
            const output = tx.getOutput(outputIndex);
            if (output?.amount) outputSum += output.amount;
        }
        if (outputSum > totalInputAmount) {
            pushError(
                `DAG tx ${txid} outputs (${outputSum}) exceed inputs (${totalInputAmount})`
            );
        }
        return;
    }

    warnings.push(
        `DAG tx ${txid}: could not determine all input amounts for conservation check`
    );
}

function buildPathTreeNodes(
    pathTxids: string[],
    txs: string[],
    pathTxs: Map<string, Transaction>,
    pushError: PushError
): TxTreeNode[] {
    const childrenByParent = new Map<string, Record<number, string>>();
    for (const txid of pathTxids) {
        childrenByParent.set(txid, {});
    }

    for (const [childTxid, tx] of pathTxs) {
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (!input.txid) continue;

            const parentTxid = hex.encode(input.txid);
            if (!pathTxs.has(parentTxid)) continue;

            const outputIndex = input.index ?? 0;
            const parentChildren = childrenByParent.get(parentTxid)!;
            const existingChild = parentChildren[outputIndex];
            if (existingChild && existingChild !== childTxid) {
                pushError(
                    `Multiple child txs reference parent ${parentTxid} output ${outputIndex}: ${existingChild}, ${childTxid}`
                );
                continue;
            }
            parentChildren[outputIndex] = childTxid;
        }
    }

    return pathTxids.map((txid, index) => ({
        txid,
        tx: txs[index],
        children: childrenByParent.get(txid) ?? {},
    }));
}

function findRootCommitmentInput(
    rootTx: Transaction,
    commitmentTxids: string[]
): { txid: string; inputIndex: number } | null {
    for (const commitmentTxid of commitmentTxids) {
        const inputIndex = findInputIndexSpendingOutpoint(
            rootTx,
            commitmentTxid,
            BATCH_OUTPUT_INDEX
        );
        if (inputIndex !== null) {
            return { txid: commitmentTxid, inputIndex };
        }
    }

    return null;
}

/**
 * Verifies a single VTXO by traversing the DAG from the VTXO (root)
 * backward to the batch output commitment transactions (leaves).
 *
 * The VTXO is the most recent transaction. Going backward in the
 * virtual mempool, we trace through intermediate virtual transactions
 * until we find all the batch outputs (commitment txs) anchored onchain.
 *
 * A VTXO can be linked to multiple commitment txs when it results from
 * an Ark transaction whose inputs came from different batches. All
 * commitment txs are independently verified onchain.
 */
export async function verifyVtxo(
    vtxo: VirtualCoin,
    indexer: IndexerProvider,
    onchain: OnchainProvider,
    serverInfo: {
        pubkey: Uint8Array;
        sweepInterval: RelativeTimelock;
    },
    options?: VtxoVerificationOptions
): Promise<VtxoVerificationResult> {
    const minDepth = options?.minConfirmationDepth ?? 6;
    const shouldVerifySigs = options?.verifySignatures ?? true;
    const errors: string[] = [];
    const warnings: string[] = [];
    const outpoint: Outpoint = { txid: vtxo.txid, vout: vtxo.vout };

    const pushError = (msg: string) => {
        if (errors.length < MAX_ERRORS) errors.push(msg);
        else if (errors.length === MAX_ERRORS)
            errors.push(`... truncated (>${MAX_ERRORS} errors)`);
    };

    if (vtxo.virtualStatus?.state === "preconfirmed") {
        return makeResult(
            outpoint,
            [],
            0,
            0,
            ["VTXO is preconfirmed and has no commitment transaction yet"],
            warnings
        );
    }

    // Step 1: Get the DAG from the VTXO (root) back to commitment txs (leaves)
    let vtxoChain: Awaited<ReturnType<IndexerProvider["getVtxoChain"]>> | null =
        null;
    try {
        vtxoChain = await indexer.getVtxoChain(outpoint);
        if (!vtxoChain.chain || vtxoChain.chain.length === 0) {
            pushError("Empty VTXO chain returned from indexer");
            return makeResult(outpoint, [], 0, 0, errors, warnings);
        }
    } catch (err) {
        pushError(`Failed to fetch VTXO chain: ${errorMessage(err)}`);
        return makeResult(outpoint, [], 0, 0, errors, warnings);
    }

    // Find ALL commitment txs in the DAG (a VTXO can span multiple batches)
    const allCommitmentTxids = vtxoChain.chain
        .filter((c) => c.type === ChainTxType.COMMITMENT)
        .map((c) => c.txid);

    if (allCommitmentTxids.length === 0) {
        pushError("No commitment transaction found in VTXO chain");
        return makeResult(outpoint, [], 0, 0, errors, warnings);
    }

    const commitmentTxidSet = new Set(allCommitmentTxids);

    // Validate commitment txid consistency with virtualStatus
    const statusCommitmentTxIds = vtxo.virtualStatus?.commitmentTxIds ?? [];
    if (statusCommitmentTxIds.length > 0) {
        for (const statusId of statusCommitmentTxIds) {
            if (!commitmentTxidSet.has(statusId)) {
                pushError(
                    `Commitment tx ${statusId} from virtualStatus not found in chain`
                );
            }
        }
    }

    // Step 2: Fetch only the virtual txs in the DAG (non-commitment entries)
    let tree: TxTree;
    let chainLength: number;
    let pathTxs = new Map<string, Transaction>();
    try {
        const chainEntryByTxid = new Map(
            vtxoChain.chain.map((entry) => [entry.txid, entry] as const)
        );
        const pathTxids = vtxoChain.chain
            .filter(
                (c) => c.type === ChainTxType.TREE || c.type === ChainTxType.ARK
            )
            .map((c) => c.txid);

        if (pathTxids.length === 0) {
            pushError("No virtual transactions in VTXO chain");
            return makeResult(
                outpoint,
                allCommitmentTxids,
                0,
                0,
                errors,
                warnings
            );
        }

        const { txs } = await indexer.getVirtualTxs(pathTxids);
        if (txs.length !== pathTxids.length) {
            pushError(
                `Virtual tx count mismatch: expected ${pathTxids.length}, got ${txs.length}`
            );
            return makeResult(
                outpoint,
                allCommitmentTxids,
                0,
                pathTxids.length,
                errors,
                warnings
            );
        }

        // Parse each PSBT
        pathTxs = new Map<string, Transaction>();
        for (let i = 0; i < pathTxids.length; i++) {
            pathTxs.set(
                pathTxids[i],
                Transaction.fromPSBT(base64.decode(txs[i]))
            );
        }

        for (const [txid, tx] of pathTxs) {
            const chainEntry = chainEntryByTxid.get(txid);
            validatePathTx(
                txid,
                tx,
                pathTxs,
                commitmentTxidSet,
                chainEntry?.spends ?? [],
                pushError,
                warnings
            );
        }

        const pathNodes = buildPathTreeNodes(
            pathTxids,
            txs,
            pathTxs,
            pushError
        );

        tree = TxTree.create(pathNodes);
        chainLength = pathTxids.length;
    } catch (err) {
        pushError(`Failed to verify VTXO DAG: ${errorMessage(err)}`);
        return makeResult(outpoint, allCommitmentTxids, 0, 0, errors, warnings);
    }

    // Step 3: Validate structure + cosigner keys
    // Fetch and cache ALL commitment txs for anchor verification
    const cachedCommitmentTxs = new Map<string, Transaction>();
    try {
        const sweepScript = CSVMultisigTapscript.encode({
            timelock: serverInfo.sweepInterval,
            pubkeys: [serverInfo.pubkey],
        }).script;
        const sweepTapTreeRoot = tapLeafHash(sweepScript);

        // Determine the primary commitment tx from tree root's actual input
        const rootCommitmentInput = findRootCommitmentInput(
            tree.root,
            allCommitmentTxids
        );
        const primaryCommitTxid =
            rootCommitmentInput?.txid ?? allCommitmentTxids[0];

        // Fetch the primary commitment tx for validateVtxoTxGraph
        const primaryTxHex = await onchain.getTxHex(primaryCommitTxid);
        const primaryTx = Transaction.fromRaw(hex.decode(primaryTxHex));
        cachedCommitmentTxs.set(primaryCommitTxid, primaryTx);

        validateVtxoTxGraph(tree, primaryTx, sweepTapTreeRoot);

        collectErrors(
            verifyCosignerKeys(tree, sweepTapTreeRoot),
            (r) =>
                `Cosigner key verification failed for tx ${r.txid} child ${r.childIndex}: ${r.error}`
        ).forEach(pushError);

        // Fetch remaining commitment txs (if multiple batches)
        for (const commitTxid of allCommitmentTxids) {
            if (cachedCommitmentTxs.has(commitTxid)) continue;
            try {
                const txHex = await onchain.getTxHex(commitTxid);
                cachedCommitmentTxs.set(
                    commitTxid,
                    Transaction.fromRaw(hex.decode(txHex))
                );
            } catch (err) {
                pushError(
                    `Failed to fetch commitment tx ${commitTxid}: ${errorMessage(err)}`
                );
            }
        }
    } catch (err) {
        pushError(`Tree structure validation failed: ${errorMessage(err)}`);
    }

    // Step 3b: Verify internal keys use unspendable NUMS point
    try {
        collectErrors(
            verifyInternalKeysUnspendable(tree),
            (r) =>
                `Unspendable key check failed for tx ${r.txid} input ${r.inputIndex}: ${r.error}`
        ).forEach(pushError);
    } catch (err) {
        pushError(`Internal key verification error: ${errorMessage(err)}`);
    }

    // Step 3c: Verify checkpoint transactions in the chain
    if (vtxoChain) {
        const checkpointEntries = vtxoChain.chain.filter(
            (c) => c.type === ChainTxType.CHECKPOINT
        );
        for (const cp of checkpointEntries) {
            if (!cp.spends || cp.spends.length === 0) {
                pushError(`Checkpoint tx ${cp.txid} has no parent references`);
            }
            if (cp.expiresAt) {
                const expiresAt = new Date(cp.expiresAt).getTime();
                if (expiresAt > 0 && expiresAt < Date.now()) {
                    warnings.push(
                        `Checkpoint tx ${cp.txid} has expired at ${cp.expiresAt}`
                    );
                }
            }
        }
    }

    // Step 3d: Verify VTXO exists in the DAG
    try {
        const leafTx = tree.find(vtxo.txid);
        if (!leafTx) {
            pushError(`VTXO ${vtxo.txid}:${vtxo.vout} not found in DAG`);
        } else if (leafTx.root.outputsLength <= vtxo.vout) {
            pushError(
                `VTXO output index ${vtxo.vout} out of bounds in tx ${vtxo.txid}`
            );
        }
    } catch (err) {
        pushError(`VTXO lookup error: ${errorMessage(err)}`);
    }

    // Step 3e: Verify tapscript satisfaction for every tapscript input.
    // This wires Tier 2 into the end-to-end verifier so CSV/CLTV/hash
    // condition failures make the VTXO invalid instead of being checked only
    // by standalone helper tests.
    try {
        const chainTip = await onchain.getChainTip();
        for (const [txid, tx] of pathTxs) {
            for (
                let inputIndex = 0;
                inputIndex < tx.inputsLength;
                inputIndex++
            ) {
                const input = tx.getInput(inputIndex);
                if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
                    continue;
                }

                let parentConfirmation:
                    | { blockHeight: number; blockTime: number }
                    | undefined;

                if (input.txid) {
                    const parentTxid = hex.encode(input.txid);
                    if (commitmentTxidSet.has(parentTxid)) {
                        try {
                            const status =
                                await onchain.getTxStatus(parentTxid);
                            if (status.confirmed) {
                                parentConfirmation = {
                                    blockHeight: status.blockHeight,
                                    blockTime: status.blockTime,
                                };
                            }
                        } catch {
                            // Structural checks still run without confirmation metadata.
                        }
                    }
                }

                const scriptResult = verifyScriptSatisfaction(
                    tx,
                    inputIndex,
                    chainTip,
                    parentConfirmation
                );
                for (const error of scriptResult.errors) {
                    pushError(
                        `Script verification failed for tx ${txid} input ${inputIndex}: ${error}`
                    );
                }
            }
        }
    } catch (err) {
        pushError(`Script verification error: ${errorMessage(err)}`);
    }

    // Step 4: Verify signatures
    if (shouldVerifySigs) {
        try {
            collectErrors(
                verifyTreeSignatures(tree),
                (r) =>
                    `Signature verification failed for tx ${r.txid} input ${r.inputIndex}: ${r.error}`
            ).forEach(pushError);
        } catch (err) {
            pushError(`Signature verification error: ${errorMessage(err)}`);
        }
    }

    // Step 5: Verify onchain anchoring for ALL commitment txs
    // Build a map from commitment txid to the output index actually spent by
    // the child virtual tx that references it. This handles multi-batch VTXOs
    // where different commitment txs may be spent at different output indices.
    const commitOutputIndexMap = new Map<string, number>();
    for (const [, tx] of pathTxs) {
        for (let idx = 0; idx < tx.inputsLength; idx++) {
            const input = tx.getInput(idx);
            if (!input.txid) continue;
            const parentTxid = hex.encode(input.txid);
            if (commitmentTxidSet.has(parentTxid)) {
                commitOutputIndexMap.set(
                    parentTxid,
                    input.index ?? BATCH_OUTPUT_INDEX
                );
            }
        }
    }

    let minConfirmationDepth = Infinity;
    for (const commitTxid of allCommitmentTxids) {
        try {
            // Use the output index from the child tx that actually spends this commitment
            const outputIndex =
                commitOutputIndexMap.get(commitTxid) ?? BATCH_OUTPUT_INDEX;

            // Derive witnessUtxo from cached commitment tx
            let witnessAmount: bigint | undefined;
            let witnessScript: Uint8Array | undefined;

            const cached = cachedCommitmentTxs.get(commitTxid);
            if (cached) {
                const output = cached.getOutput(outputIndex);
                if (output?.amount !== undefined && output?.script) {
                    witnessAmount = output.amount;
                    witnessScript = output.script;
                }
            }

            if (witnessAmount === undefined || !witnessScript) {
                pushError(
                    `Could not determine expected output for commitment tx ${commitTxid}`
                );
                continue;
            }

            const anchorResult = await verifyOnchainAnchor(
                commitTxid,
                outputIndex,
                witnessAmount,
                witnessScript,
                onchain,
                minDepth
            );

            if (anchorResult.confirmationDepth < minConfirmationDepth) {
                minConfirmationDepth = anchorResult.confirmationDepth;
            }
            anchorResult.errors.forEach(pushError);
            warnings.push(...anchorResult.warnings);
        } catch (err) {
            pushError(
                `Onchain anchor verification error for ${commitTxid}: ${errorMessage(err)}`
            );
        }
    }

    const confirmationDepth =
        minConfirmationDepth === Infinity ? 0 : minConfirmationDepth;

    return makeResult(
        outpoint,
        allCommitmentTxids,
        confirmationDepth,
        chainLength,
        errors,
        warnings
    );
}

export async function verifyAllVtxos(
    vtxos: VirtualCoin[],
    indexer: IndexerProvider,
    onchain: OnchainProvider,
    serverInfo: {
        pubkey: Uint8Array;
        sweepInterval: RelativeTimelock;
    },
    options?: VtxoVerificationOptions
): Promise<Map<string, VtxoVerificationResult>> {
    const results = new Map<string, VtxoVerificationResult>();
    if (vtxos.length === 0) return results;

    const CONCURRENCY = 5;
    for (let i = 0; i < vtxos.length; i += CONCURRENCY) {
        const batch = vtxos.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map((v) =>
                verifyVtxo(v, indexer, onchain, serverInfo, options)
            )
        );

        for (let j = 0; j < batch.length; j++) {
            const vtxo = batch[j];
            results.set(`${vtxo.txid}:${vtxo.vout}`, batchResults[j]);
        }
    }

    return results;
}

function makeResult(
    vtxoOutpoint: Outpoint,
    commitmentTxids: string[],
    confirmationDepth: number,
    chainLength: number,
    errors: string[],
    warnings: string[]
): VtxoVerificationResult {
    return {
        valid: errors.length === 0,
        vtxoOutpoint,
        commitmentTxid: commitmentTxids[0] ?? "",
        commitmentTxids,
        confirmationDepth,
        chainLength,
        errors,
        warnings,
    };
}
