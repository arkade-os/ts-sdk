import { hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import type { Outpoint, VirtualCoin } from "../wallet";
import type { IndexerProvider, ChainTxType } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { RelativeTimelock } from "../script/tapscript";
import { CSVMultisigTapscript } from "../script/tapscript";
import { TxTree, TxTreeNode } from "../tree/txTree";
import { validateVtxoTxGraph } from "../tree/validation";
import { verifyOnchainAnchor } from "./onchainAnchorVerifier";
import { verifyTreeSignatures, verifyCosignerKeys } from "./signatureVerifier";
import { verifyScriptSatisfaction } from "./scriptVerifier";
import { Transaction } from "../utils/transaction";

export interface VtxoVerificationResult {
    valid: boolean;
    vtxoOutpoint: Outpoint;
    commitmentTxid: string;
    confirmationDepth: number;
    chainLength: number;
    errors: string[];
    warnings: string[];
}

export interface VtxoVerificationOptions {
    minConfirmationDepth?: number;
    verifySignatures?: boolean;
    verifyScripts?: boolean;
}

const BATCH_OUTPUT_INDEX = 0;

/**
 * Verifies a single VTXO's full chain from leaf to onchain commitment.
 *
 * Performs:
 * 1. Fetches the VTXO chain and virtual tx data from the indexer
 * 2. Reconstructs the TxTree DAG
 * 3. Validates DAG structure (amounts, parent-child references, cosigner keys)
 * 4. Verifies all Schnorr signatures in the tree
 * 5. Verifies the onchain commitment tx (confirmed, outputs match, not double-spent)
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
    const shouldVerifyScripts = options?.verifyScripts ?? false;
    const errors: string[] = [];
    const warnings: string[] = [];
    const outpoint: Outpoint = { txid: vtxo.txid, vout: vtxo.vout };

    // Preconfirmed VTXOs don't have a commitment tx yet
    if (vtxo.virtualStatus?.state === "preconfirmed") {
        return {
            valid: false,
            vtxoOutpoint: outpoint,
            commitmentTxid: "",
            confirmationDepth: 0,
            chainLength: 0,
            errors: [
                "VTXO is preconfirmed and has no commitment transaction yet",
            ],
            warnings,
        };
    }

    // Step 1: Get VTXO chain from indexer
    let commitmentTxid = "";
    try {
        const chain = await indexer.getVtxoChain(outpoint);
        if (!chain.chain || chain.chain.length === 0) {
            errors.push("Empty VTXO chain returned from indexer");
            return makeResult(outpoint, commitmentTxid, 0, 0, errors, warnings);
        }

        // Find the commitment tx (type === COMMITMENT)
        const commitmentEntry = chain.chain.find(
            (c) =>
                c.type === ("INDEXER_CHAINED_TX_TYPE_COMMITMENT" as ChainTxType)
        );
        if (commitmentEntry) {
            commitmentTxid = commitmentEntry.txid;
        }
    } catch (err) {
        errors.push(
            `Failed to fetch VTXO chain: ${err instanceof Error ? err.message : String(err)}`
        );
        return makeResult(outpoint, commitmentTxid, 0, 0, errors, warnings);
    }

    if (!commitmentTxid) {
        errors.push("No commitment transaction found in VTXO chain");
        return makeResult(outpoint, commitmentTxid, 0, 0, errors, warnings);
    }

    // Step 2: Fetch the virtual transaction data
    let tree: TxTree;
    try {
        // Get the batch outpoint from the VTXO's commitment tx
        const commitmentTxIds = vtxo.virtualStatus?.commitmentTxIds ?? [];
        if (commitmentTxIds.length === 0) {
            errors.push("VTXO has no commitment tx IDs");
            return makeResult(outpoint, commitmentTxid, 0, 0, errors, warnings);
        }

        // Get the VTXO tree for this batch
        const batchOutpoint: Outpoint = {
            txid: commitmentTxIds[0],
            vout: BATCH_OUTPUT_INDEX,
        };

        // Fetch tree in pages
        const allTreeNodes: TxTreeNode[] = [];
        let pageIndex = 0;
        let hasMore = true;
        while (hasMore) {
            const { vtxoTree, page } = await indexer.getVtxoTree(
                batchOutpoint,
                { pageIndex, pageSize: 100 }
            );
            // Map the indexer Tx[] to TxTreeNode[] by fetching the actual tx data
            // The indexer returns txid + children, we need the actual PSBT data
            for (const node of vtxoTree) {
                allTreeNodes.push({
                    txid: node.txid,
                    tx: "", // placeholder, filled below
                    children: node.children,
                });
            }
            if (!page || page.next <= page.current) {
                hasMore = false;
            } else {
                pageIndex = page.next;
            }
        }

        if (allTreeNodes.length === 0) {
            errors.push("Empty VTXO tree returned from indexer");
            return makeResult(outpoint, commitmentTxid, 0, 0, errors, warnings);
        }

        // Fetch the actual virtual tx PSBTs and map by txid for safe lookup
        const txids = allTreeNodes.map((n) => n.txid);
        const { txs } = await indexer.getVirtualTxs(txids);

        if (txs.length !== txids.length) {
            errors.push(
                `Virtual tx count mismatch: expected ${txids.length}, got ${txs.length}`
            );
            return makeResult(
                outpoint,
                commitmentTxid,
                0,
                allTreeNodes.length,
                errors,
                warnings
            );
        }

        // Build txid->tx map for safe lookup (avoids index alignment assumption)
        const txByTxid = new Map<string, string>();
        for (let i = 0; i < txids.length; i++) {
            txByTxid.set(txids[i], txs[i]);
        }

        // Fill in the tx data using txid-keyed lookup
        for (const node of allTreeNodes) {
            const txData = txByTxid.get(node.txid);
            if (!txData) {
                errors.push(`Missing virtual tx data for ${node.txid}`);
                return makeResult(
                    outpoint,
                    commitmentTxid,
                    0,
                    allTreeNodes.length,
                    errors,
                    warnings
                );
            }
            node.tx = txData;
        }

        tree = TxTree.create(allTreeNodes);
    } catch (err) {
        errors.push(
            `Failed to reconstruct VTXO tree: ${err instanceof Error ? err.message : String(err)}`
        );
        return makeResult(outpoint, commitmentTxid, 0, 0, errors, warnings);
    }

    const chainLength = tree.nbOfNodes();

    // Step 3: Validate tree structure
    try {
        // Compute sweep tap tree root for cosigner key verification
        const sweepScript = CSVMultisigTapscript.encode({
            timelock: serverInfo.sweepInterval,
            pubkeys: [serverInfo.pubkey],
        }).script;
        const sweepTapTreeRoot = tapLeafHash(sweepScript);

        // Fetch the commitment tx to get batch output
        const commitmentTxHex = await onchain.getTxHex(commitmentTxid);
        const commitmentTx = Transaction.fromRaw(hex.decode(commitmentTxHex));

        validateVtxoTxGraph(tree, commitmentTx, sweepTapTreeRoot);

        // Step 3b: Verify cosigner keys
        const cosignerResults = verifyCosignerKeys(tree, sweepTapTreeRoot);
        for (const result of cosignerResults) {
            if (!result.valid) {
                errors.push(
                    `Cosigner key verification failed for tx ${result.txid} child ${result.childIndex}: ${result.error}`
                );
            }
        }
    } catch (err) {
        errors.push(
            `Tree structure validation failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    // Step 4: Verify signatures
    if (shouldVerifySigs) {
        try {
            const sigResults = verifyTreeSignatures(tree);
            for (const result of sigResults) {
                if (!result.valid) {
                    errors.push(
                        `Signature verification failed for tx ${result.txid} input ${result.inputIndex}: ${result.error}`
                    );
                }
            }
        } catch (err) {
            errors.push(
                `Signature verification error: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    // Step 4b: Verify script satisfaction (Tier 2, opt-in)
    if (shouldVerifyScripts) {
        try {
            const chainTip = await onchain.getChainTip();
            for (const subtree of tree.iterator()) {
                const tx = subtree.root;
                for (let i = 0; i < tx.inputsLength; i++) {
                    const input = tx.getInput(i);
                    if (
                        !input.tapLeafScript ||
                        input.tapLeafScript.length === 0
                    ) {
                        continue;
                    }
                    const scriptResult = verifyScriptSatisfaction(tx, i, {
                        height: chainTip.height,
                        time: chainTip.time,
                    });
                    for (const err of scriptResult.errors) {
                        errors.push(
                            `Script verification (tx ${tx.id} input ${i}): ${err}`
                        );
                    }
                }
            }
        } catch (err) {
            errors.push(
                `Script verification error: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    // Step 5: Verify onchain anchoring
    // Use the tree root INPUT's witnessUtxo (the commitment tx batch output being spent),
    // NOT the tree root's own outputs (which distribute funds to children).
    let confirmationDepth = 0;
    try {
        const rootInput = tree.root.getInput(0);
        if (!rootInput.txid) {
            errors.push("Tree root input has no txid");
        } else {
            const witnessUtxo = rootInput.witnessUtxo;
            if (!witnessUtxo?.amount || !witnessUtxo?.script) {
                errors.push(
                    "Tree root input missing witnessUtxo for anchor verification"
                );
            } else {
                const anchorTxid = hex.encode(rootInput.txid);
                const anchorResult = await verifyOnchainAnchor(
                    anchorTxid,
                    rootInput.index ?? BATCH_OUTPUT_INDEX,
                    witnessUtxo.amount,
                    witnessUtxo.script,
                    onchain,
                    minDepth
                );

                confirmationDepth = anchorResult.confirmationDepth;
                errors.push(...anchorResult.errors);
                warnings.push(...anchorResult.warnings);
            }
        }
    } catch (err) {
        errors.push(
            `Onchain anchor verification error: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    return makeResult(
        outpoint,
        commitmentTxid,
        confirmationDepth,
        chainLength,
        errors,
        warnings
    );
}

function makeResult(
    vtxoOutpoint: Outpoint,
    commitmentTxid: string,
    confirmationDepth: number,
    chainLength: number,
    errors: string[],
    warnings: string[]
): VtxoVerificationResult {
    return {
        valid: errors.length === 0,
        vtxoOutpoint,
        commitmentTxid,
        confirmationDepth,
        chainLength,
        errors,
        warnings,
    };
}
