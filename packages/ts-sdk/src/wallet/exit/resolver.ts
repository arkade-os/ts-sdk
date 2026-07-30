import { ChainTx, IndexerProvider } from "../../providers/indexer";
import {
    ChainedTxType,
    VirtualTx,
    VirtualTxRepository,
} from "../../repositories/virtualTxRepository";
import { Outpoint } from "../index";
import { IndexerExitDataSource } from "./indexerSource";
import { RepositoryExitDataSource } from "./repositorySource";

/**
 * A source of unilateral-exit chain data for a set of VTXOs. Sources are tried
 * in order by the resolver; a source returns `null` (chain) or omits keys (psbts)
 * for data it cannot supply — a "miss" — and the resolver falls through.
 */
export interface ExitDataSource {
    readonly name: string;
    /** Full ancestry chain for a vtxo (all pages merged), or null on a miss. */
    getVtxoChain(vtxo: Outpoint): Promise<ChainTx[] | null>;
    /** Base64 PSBTs this source has, keyed by (unsigned) txid. Absent key = miss. */
    getVirtualTxs(txids: string[]): Promise<Map<string, string>>;
}

/** Reads exit chain data through an ordered chain of sources. */
export interface ExitChainResolver {
    getVtxoChain(vtxo: Outpoint): Promise<ChainTx[]>;
    getVirtualTxs(txids: string[]): Promise<string[]>;
}

/**
 * Tries sources in order (local repo → [provider] → indexer). PSBT hits from a
 * non-first source are persisted back to `persist` best-effort so the local
 * store self-heals — never throwing from that write, per the exit-correctness
 * rule (mirrors `Unroll.Session.resolveVirtualTxBase64`).
 */
export class OrderedExitChainResolver implements ExitChainResolver {
    constructor(
        private readonly sources: ExitDataSource[],
        private readonly persist?: VirtualTxRepository,
    ) {}

    async getVtxoChain(vtxo: Outpoint): Promise<ChainTx[]> {
        let lastErr: unknown;
        for (const source of this.sources) {
            try {
                const chain = await source.getVtxoChain(vtxo);
                if (chain) return chain;
            } catch (e) {
                lastErr = e;
            }
        }
        if (lastErr) throw lastErr;
        throw new Error(`no exit-data source resolved the chain for ${vtxo.txid}:${vtxo.vout}`);
    }

    async getVirtualTxs(txids: string[]): Promise<string[]> {
        const found = new Map<string, string>();
        let remaining = txids;
        for (const [i, source] of this.sources.entries()) {
            if (remaining.length === 0) break;
            let got: Map<string, string>;
            try {
                got = await source.getVirtualTxs(remaining);
            } catch {
                continue; // miss; try the next source
            }
            const fresh: VirtualTx[] = [];
            for (const [txid, psbt] of got) {
                if (found.has(txid)) continue;
                found.set(txid, psbt);
                fresh.push({ txid, psbt, expiresAt: null, type: ChainedTxType.Unspecified });
            }
            // Read-through persist: only for non-local sources (i > 0). An
            // Unspecified type never downgrades a stored type (mergeChainedTxType).
            if (i > 0 && this.persist && fresh.length > 0) {
                try {
                    await this.persist.upsertVirtualTxs(fresh);
                } catch {
                    // best-effort cache only
                }
            }
            remaining = txids.filter((t) => !found.has(t));
        }
        return [...found.values()];
    }
}

/**
 * Assemble the standard exit-data resolver: local repo (if configured) → any
 * extra sources (e.g. a future provider) → indexer. Read-through persists to the
 * repository. With no repository this is exactly the indexer path (a no-op seam).
 */
export function createExitChainResolver(params: {
    indexer: IndexerProvider;
    repository?: VirtualTxRepository;
    extraSources?: ExitDataSource[];
}): ExitChainResolver {
    const sources: ExitDataSource[] = [];
    if (params.repository) sources.push(new RepositoryExitDataSource(params.repository));
    if (params.extraSources) sources.push(...params.extraSources);
    sources.push(new IndexerExitDataSource(params.indexer));
    return new OrderedExitChainResolver(sources, params.repository);
}
