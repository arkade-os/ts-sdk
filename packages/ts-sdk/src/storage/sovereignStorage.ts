import { hex, base64 } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import type {
    DAGNode,
    DAGValidationResult,
    Outpoint,
    VerificationStorageProvider,
    VerificationIndexerProvider,
    VerificationOnchainProvider,
} from "../tree/vtxoDAGVerification.js";
import { reconstructAndValidateVtxoDAG, computeTxid } from "../tree/vtxoDAGVerification.js";
import { StorageCrypto } from "../utils/cryptoUtils.js";

export interface SovereignExitData {
    /** The specific VTXO root (the user's outpoint) being protected. */
    vtxoRootTxid: string;
    /** The Anchor commitment transaction ID. */
    commitmentTxid: string;
    /** The batch output index on the commitment transaction. */
    batchOutputIndex: number;
    /** Ordered array of hex-encoded transactions to broadcast (Anchor -> ... -> VTXO Root). */
    broadcastSequence: string[];
    /** Timestamp when this data was secured. */
    securedAt: number;
}

// ─── Extraction & Orchestration ─────────────────────────────────────────────

/**
 * Traverses a validated DAG from the Anchoring Leaf to find the specific path
 * descending to the target VTXO Root, returning the ordered hex transactions.
 * Order: [AnchorTx (spends commitment), ..., IntermediateTx, ... , VTXO Root Tx]
 *
 * This sequence is exactly the order required for on-chain
 * transaction broadcasting to satisfy topological consensus checks.
 *
 * Fully iterative stack traversal to be 100% stack-overflow immune on deep chains.
 *
 * @param anchoringLeaf The leaf of the DAG (directly spending the commitment).
 * @param vtxoRootTxid The ultimate VTXO target txid.
 * @returns Array of hex-encoded, broadcast-ready transactions.
 */
export function extractExitSequence(anchoringLeaf: DAGNode, vtxoRootTxid: string): string[] {
    if (anchoringLeaf.txid === vtxoRootTxid) {
        return [hex.encode(anchoringLeaf.tx.toBytes())];
    }

    type StackFrame = {
        node: DAGNode;
        childrenIterator: Iterator<DAGNode>;
    };

    const path: DAGNode[] = [anchoringLeaf];
    const stack: StackFrame[] = [
        {
            node: anchoringLeaf,
            childrenIterator: anchoringLeaf.children.values(),
        },
    ];

    let found = false;

    while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const next = top.childrenIterator.next();

        if (next.done) {
            stack.pop();
            path.pop();
        } else {
            const child = next.value;
            path.push(child);

            if (child.txid === vtxoRootTxid) {
                found = true;
                break;
            }

            stack.push({
                node: child,
                childrenIterator: child.children.values(),
            });
        }
    }

    if (!found) {
        throw new Error(
            `Critical: VTXO Root ${vtxoRootTxid} not reachable from Anchoring Leaf ${anchoringLeaf.txid}`,
        );
    }

    return path.map((node) => hex.encode(node.tx.toBytes()));
}

// ─── Storage Persistence ───────────────────────────────────────────────────

function getStorageKey(vtxoRootTxid: string): string {
    return `arkade_exit_data_${vtxoRootTxid}`;
}

/**
 * Extracts and persists the exit data directly to the SDK local storage.
 *
 * @param result The successfully validated pipeline result.
 * @param storage The sovereign storage adapter instance.
 * @param masterKey Wallet-owned master encryption key.
 */
export async function persistVtxoForExit(
    result: DAGValidationResult,
    storage: VerificationStorageProvider,
    masterKey: Uint8Array,
): Promise<void> {
    if (!masterKey || masterKey.length === 0) {
        throw new Error("Security Error: Storage Master Key is required for persistence.");
    }
    const broadcastSequence = extractExitSequence(result.anchoringLeaf, result.vtxoRoot.txid);

    const exitData: SovereignExitData = {
        vtxoRootTxid: result.vtxoRoot.txid,
        commitmentTxid: result.commitmentTxid,
        batchOutputIndex: result.batchOutputIndex,
        broadcastSequence,
        securedAt: Date.now(),
    };

    const payload = JSON.stringify(exitData);
    const encrypted = await StorageCrypto.encrypt(payload, masterKey);

    await storage.setItem(getStorageKey(exitData.vtxoRootTxid), base64.encode(encrypted));
}

/**
 * Recovers the strict top-down broadcast sequence for unilateral exit execution.
 * Fails loudly if the data was not autonomously secured prior to network drop.
 *
 * @param vtxoRootTxid Target VTXO Root ID.
 * @param storage Storage provider.
 * @param masterKey Wallet-owned master encryption key.
 */
export async function getBroadcastSequence(
    vtxoRootTxid: string,
    storage: VerificationStorageProvider,
    masterKey: Uint8Array,
): Promise<string[]> {
    if (!masterKey || masterKey.length === 0) {
        throw new Error("Security Error: Storage Master Key is required for decryption.");
    }
    const encryptedB64 = await storage.getItem(getStorageKey(vtxoRootTxid));
    if (!encryptedB64) {
        throw new Error(
            `Sovereign Exit Failed: No local data secured for VTXO Root ${vtxoRootTxid}. ASP connection required!`,
        );
    }

    const encrypted = base64.decode(encryptedB64);
    const decrypted = await StorageCrypto.decrypt(encrypted, masterKey);

    const data: SovereignExitData = JSON.parse(decrypted);
    return data.broadcastSequence;
}

// ─── Automated Webhook Integrations ─────────────────────────────────────────

/**
 * Automates the pipeline. Triggers the full Tier 2 Tier 1 verification structure,
 * and if authentic, isolates the metadata and saves it for a future sovereign exit.
 *
 * To be called natively whenever a new VTXO is detected or swapped.
 */
export async function onReceiveVtxo(
    outpoint: Outpoint,
    indexer: VerificationIndexerProvider,
    onchain: VerificationOnchainProvider,
    storage: VerificationStorageProvider,
    masterKey: Uint8Array,
): Promise<{ success: boolean; diagnostics: string[]; error?: string }> {
    try {
        // 1. Run rigorous multi-layered verification (DAG, Sigs, Taproot, Timelocks, HTLCs)
        const verificationResult = await reconstructAndValidateVtxoDAG(outpoint, indexer, onchain);

        // 2. Persist Sovereign Exit Data locally, cutting ASP ties for exiting
        await persistVtxoForExit(verificationResult, storage, masterKey);

        return {
            success: true,
            diagnostics: [
                ...verificationResult.diagnostics,
                ` Local sovereign exit data secured for ${outpoint.txid}`,
            ],
        };
    } catch (error: any) {
        return {
            success: false,
            diagnostics: ["Verification Pipeline Terminated"],
            error: error.message,
        };
    }
}

/**
 * Consumes natively stored data (requiring NO ASP connection) and attempts to
 * push the exact pre-computed topological sequence to the Bitcoin network.
 * This effectively executes the Unilateral Sovereign Exit.
 */
export async function executeSovereignExit(
    vtxoRootTxid: string,
    storage: VerificationStorageProvider,
    onchain: VerificationOnchainProvider,
    masterKey: Uint8Array,
): Promise<{ success: boolean; broadcastedTxids: string[]; error?: string }> {
    const broadcastedTxids: string[] = [];

    try {
        const broadcastSequence = await getBroadcastSequence(vtxoRootTxid, storage, masterKey);

        // Sequence is correctly ordered top-down relative to the DAG structure
        for (const txHex of broadcastSequence) {
            try {
                const txid = await onchain.broadcastTransaction(txHex);
                broadcastedTxids.push(txid);
            } catch (err: any) {
                const msg = String(err?.message ?? err);
                const code = err?.code;
                // If the transaction is already accepted in mempool or confirmed in chain,
                // consider it successfully broadcasted and proceed to descendants.
                //
                // Protocol Security Invariant (Finding A):
                // Errors such as 'bad-txns-inputs-spent' (or code -25 without 'already in mempool')
                // MUST NOT be treated as success. An input-spent error indicates that an ancestor/input
                // was spent by a conflicting transaction (e.g. ASP forfeit sweep or alternative exit path).
                // Counting it as success would silently report a successful exit while user funds are gone.
                // Such errors fall through to the else branch and abort the unilateral exit immediately.
                if (
                    msg.includes("txn-already-in-mempool") ||
                    msg.includes("txn-already-known") ||
                    msg.includes("RPC_TRANSACTION_ALREADY_IN_CHAIN") ||
                    msg.includes("Transaction already in block chain") ||
                    code === -27 ||
                    (code === -25 && msg.includes("already in mempool"))
                ) {
                    const tx = Transaction.fromRaw(hex.decode(txHex), {
                        allowUnknownOutputs: true,
                    });
                    const txid = computeTxid(tx);
                    broadcastedTxids.push(txid);
                } else {
                    throw err;
                }
            }
        }

        return { success: true, broadcastedTxids };
    } catch (error: any) {
        return { success: false, broadcastedTxids, error: error.message };
    }
}
