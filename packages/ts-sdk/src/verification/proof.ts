import { base64, hex } from "@scure/base";
import { ChainTxType } from "../providers/indexer";
import { Transaction } from "../utils/transaction";
import type { Outpoint } from "../wallet";
import type { ParsedVtxoProof, VtxoProofSource } from "./types";

export class VtxoProofError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly kind: "invalid" | "unavailable",
    ) {
        super(message);
        this.name = "VtxoProofError";
    }
}

const VIRTUAL_TYPES = new Set<ChainTxType>([
    ChainTxType.ARK,
    ChainTxType.TREE,
    ChainTxType.CHECKPOINT,
]);

export async function parseVtxoProof(
    outpoint: Outpoint,
    source: VtxoProofSource,
): Promise<ParsedVtxoProof> {
    let chain;
    try {
        chain = await source.getVtxoChain(outpoint);
    } catch (error) {
        throw new VtxoProofError(
            "proof_chain_unavailable",
            `Could not fetch VTXO ancestry: ${errorMessage(error)}`,
            "unavailable",
        );
    }
    if (chain.length === 0) {
        throw new VtxoProofError(
            "proof_chain_empty",
            "The proof source returned an empty VTXO chain",
            "unavailable",
        );
    }

    const normalizedChain = chain.map((entry) => ({
        ...entry,
        txid: entry.txid.toLowerCase(),
        spends: entry.spends.map((txid) => txid.toLowerCase()),
    }));
    const entries = new Map<string, (typeof normalizedChain)[number]>();
    for (const entry of normalizedChain) {
        if (entries.has(entry.txid)) {
            throw new VtxoProofError(
                "proof_duplicate_txid",
                `The VTXO chain contains duplicate transaction ${entry.txid}`,
                "invalid",
            );
        }
        if (entry.type !== ChainTxType.COMMITMENT && !VIRTUAL_TYPES.has(entry.type)) {
            throw new VtxoProofError(
                "proof_unknown_type",
                `Transaction ${entry.txid} has unsupported chain type ${entry.type}`,
                "invalid",
            );
        }
        entries.set(entry.txid, entry);
    }

    const targetTxid = outpoint.txid.toLowerCase();
    if (!entries.has(targetTxid)) {
        throw new VtxoProofError(
            "proof_target_missing",
            `The VTXO chain does not contain requested transaction ${targetTxid}`,
            "invalid",
        );
    }

    const reachable = new Set<string>();
    const visiting = new Set<string>();
    const visit = (txid: string): void => {
        if (reachable.has(txid)) return;
        if (visiting.has(txid)) {
            throw new VtxoProofError(
                "proof_cycle",
                `The VTXO chain contains a cycle at transaction ${txid}`,
                "invalid",
            );
        }
        const entry = entries.get(txid);
        // Defer unknown-parent classification until after the PSBT's actual
        // parents are compared with metadata, so a contradiction is reported
        // as parent_mismatch rather than being masked by traversal order.
        if (!entry) return;
        visiting.add(txid);
        for (const parent of entry.spends) visit(parent);
        visiting.delete(txid);
        reachable.add(txid);
    };
    visit(targetTxid);

    const reachableEntries = new Map([...entries].filter(([txid]) => reachable.has(txid)));
    const virtualEntries = normalizedChain.filter(
        (entry) => reachable.has(entry.txid) && VIRTUAL_TYPES.has(entry.type),
    );
    let psbts: string[];
    try {
        psbts = await source.getVirtualTxs(virtualEntries.map((entry) => entry.txid));
    } catch (error) {
        throw new VtxoProofError(
            "proof_psbts_unavailable",
            `Could not fetch virtual transactions: ${errorMessage(error)}`,
            "unavailable",
        );
    }
    if (psbts.length < virtualEntries.length) {
        throw new VtxoProofError(
            "proof_psbt_missing",
            `Expected ${virtualEntries.length} virtual transactions, received ${psbts.length}`,
            "unavailable",
        );
    }

    const transactions = new Map<string, Transaction>();
    for (const encoded of psbts) {
        let tx: Transaction;
        try {
            tx = Transaction.fromPSBT(base64.decode(encoded));
        } catch (error) {
            throw new VtxoProofError(
                "proof_psbt_malformed",
                `Could not decode virtual transaction: ${errorMessage(error)}`,
                "invalid",
            );
        }
        const txid = tx.id.toLowerCase();
        if (!reachableEntries.has(txid) || !VIRTUAL_TYPES.has(reachableEntries.get(txid)!.type)) {
            throw new VtxoProofError(
                "proof_psbt_txid_mismatch",
                `Virtual transaction ${txid} was not declared by the chain metadata`,
                "invalid",
            );
        }
        if (transactions.has(txid)) {
            throw new VtxoProofError(
                "proof_duplicate_psbt",
                `The proof contains duplicate PSBT ${txid}`,
                "invalid",
            );
        }
        transactions.set(txid, tx);
    }

    for (const entry of virtualEntries) {
        const tx = transactions.get(entry.txid);
        if (!tx) {
            throw new VtxoProofError(
                "proof_psbt_missing",
                `Virtual transaction ${entry.txid} is missing`,
                "unavailable",
            );
        }
        const actualParents = new Set<string>();
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (!input.txid) {
                throw new VtxoProofError(
                    "proof_input_txid_missing",
                    `Transaction ${entry.txid} input ${inputIndex} has no parent txid`,
                    "invalid",
                );
            }
            actualParents.add(hex.encode(input.txid));
        }
        const declaredParents = new Set(entry.spends);
        if (
            actualParents.size !== declaredParents.size ||
            [...actualParents].some((parent) => !declaredParents.has(parent))
        ) {
            throw new VtxoProofError(
                "proof_parent_mismatch",
                `Transaction ${entry.txid} inputs do not match its declared parents`,
                "invalid",
            );
        }
        for (const parent of actualParents) {
            if (!reachableEntries.has(parent)) {
                throw new VtxoProofError(
                    "proof_parent_unknown",
                    `Transaction ${entry.txid} references unknown parent ${parent}`,
                    "invalid",
                );
            }
        }
    }

    const disconnectedTxid = [...entries.keys()].find((txid) => !reachable.has(txid));
    if (disconnectedTxid) {
        throw new VtxoProofError(
            "proof_disconnected_node",
            `Transaction ${disconnectedTxid} is disconnected from requested transaction ${targetTxid}`,
            "invalid",
        );
    }

    return {
        entries: reachableEntries,
        transactions,
        commitmentTxids: normalizedChain
            .filter((entry) => reachable.has(entry.txid) && entry.type === ChainTxType.COMMITMENT)
            .map((entry) => entry.txid),
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
