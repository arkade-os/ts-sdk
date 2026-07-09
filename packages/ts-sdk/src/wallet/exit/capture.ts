import { base64 } from "@scure/base";
import { ChainTx, ChainTxType } from "../../providers/indexer";
import {
    ChainedTxType,
    VirtualTx,
    VirtualTxRepository,
    VtxoBranch,
} from "../../repositories/virtualTxRepository";
import { Transaction } from "../../utils/transaction";
import { Outpoint } from "../index";
import { topoSortByDeps } from "./chain";
import { ExitChainResolver } from "./resolver";

export type ExitCaptureMode = "lite" | "full";

/** BTC-value floor for capture; below it, exit fees would exceed the VTXO (NArk parity). */
export const DEFAULT_MIN_EXIT_WORTH_SATS = 1000;

/** ChainTxType (indexer string enum) → ChainedTxType (repo numeric enum).
 *  Duplicated from unroll.ts:27 to keep the exit path free of a cross-module dep. */
function chainTxTypeToChainedExit(t: ChainTxType): ChainedTxType {
    switch (t) {
        case ChainTxType.COMMITMENT:
            return ChainedTxType.Commitment;
        case ChainTxType.ARK:
            return ChainedTxType.Ark;
        case ChainTxType.TREE:
            return ChainedTxType.Tree;
        case ChainTxType.CHECKPOINT:
            return ChainedTxType.Checkpoint;
        default:
            return ChainedTxType.Unspecified;
    }
}

/** Order a chain ancestors-first so position 0 is the root/commitment. */
function orderAncestryFirst(chain: ChainTx[]): ChainTx[] {
    const ids = new Set(chain.map((c) => c.txid));
    return topoSortByDeps(
        chain,
        (c) => c.txid,
        (c) => c.spends.filter((s) => ids.has(s)),
    );
}

/**
 * Fetch and persist a received VTXO's unilateral-exit branch. Idempotent (skips
 * if a branch is already stored) and dust-gated. Full mode stores PSBTs so the
 * exit needs no indexer; Lite stores structure only. Throws on failure — callers
 * wrap best-effort so capture never blocks receive.
 */
export async function captureExitBranch(params: {
    resolver: ExitChainResolver;
    repository: VirtualTxRepository;
    vtxo: Outpoint;
    value: number;
    mode: ExitCaptureMode;
    minExitWorthSats: number;
}): Promise<void> {
    const { resolver, repository, vtxo, value, mode, minExitWorthSats } = params;
    if (value < minExitWorthSats) return;
    if (await repository.hasBranch(vtxo)) return;

    const ordered = orderAncestryFirst(await resolver.getVtxoChain(vtxo));

    const psbtByTxid = new Map<string, string>();
    if (mode === "full") {
        const nonCommitment = ordered
            .filter((c) => chainTxTypeToChainedExit(c.type) !== ChainedTxType.Commitment)
            .map((c) => c.txid);
        if (nonCommitment.length > 0) {
            for (const psbt of await resolver.getVirtualTxs(nonCommitment)) {
                psbtByTxid.set(Transaction.fromPSBT(base64.decode(psbt)).id, psbt);
            }
        }
    }

    const virtualTxs: VirtualTx[] = ordered.map((c) => {
        const expires = Number(c.expiresAt);
        return {
            txid: c.txid,
            psbt: psbtByTxid.get(c.txid) ?? null,
            expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null,
            type: chainTxTypeToChainedExit(c.type),
        };
    });
    const branch: VtxoBranch[] = ordered.map((c, i) => ({
        vtxoTxid: vtxo.txid,
        vtxoVout: vtxo.vout,
        virtualTxid: c.txid,
        position: i,
    }));

    await repository.upsertVirtualTxs(virtualTxs);
    await repository.setBranch(vtxo, branch);
}

/** Prune stored exit data for spent VTXOs (the repo ref-counts shared ancestors).
 *  Best-effort per outpoint — one failure never blocks the others. */
export async function pruneExitBranches(
    repository: VirtualTxRepository,
    outpoints: Outpoint[],
): Promise<void> {
    for (const outpoint of outpoints) {
        try {
            await repository.pruneForSpentVtxo(outpoint);
        } catch {
            // best-effort: a prune failure must not block the spend path
        }
    }
}
