import { hex } from "@scure/base";
import { sequenceToTimelock } from "../../utils/timelock";
import { Contract, DiscoveredContract, PathContext } from "../types";
import type { Discoverable, DiscoveryDeps } from "../types";
import { isDescriptor, extractPubKey, normalizeToDescriptor } from "../../identity/descriptor";
import type { IndexerProvider } from "../../providers/indexer";
import { getNormalizedVtxos } from "../../wallet/vtxo";
import { DefaultVtxo } from "../../script/default";
import type { RelativeTimelock } from "../../script/tapscript";
import { WALLET_RECEIVE_SOURCE } from "../metadata";
import { DEFAULT_PAGE_SIZE, SCRIPT_QUERY_CHUNK_SIZE } from "../constants";

/**
 * Extract raw hex pubkey from a value that may be a descriptor or raw hex.
 * Returns undefined for HD descriptors or unparseable values so role
 * resolution stays best-effort and never throws.
 */
function extractRawPubKey(value: string): string | undefined {
    if (!isDescriptor(value)) {
        return value.toLowerCase();
    }
    try {
        return extractPubKey(value).toLowerCase();
    } catch {
        return undefined;
    }
}

/**
 * Resolve wallet's role from explicit role or by matching descriptor/pubkey.
 */
export function resolveRole(
    contract: Contract,
    context: PathContext,
): "sender" | "receiver" | undefined {
    // Explicit role takes precedence
    if (context.role === "sender" || context.role === "receiver") {
        return context.role;
    }

    const senderKey = contract.params.sender ? extractRawPubKey(contract.params.sender) : undefined;
    const receiverKey = contract.params.receiver
        ? extractRawPubKey(contract.params.receiver)
        : undefined;

    const matchRole = (rawWalletKey: string | undefined): "sender" | "receiver" | undefined => {
        if (!rawWalletKey) return undefined;
        if (senderKey && rawWalletKey === senderKey) {
            return "sender";
        }
        if (receiverKey && rawWalletKey === receiverKey) {
            return "receiver";
        }
        return undefined;
    };

    // Try the preferred descriptor first. If it cannot be resolved
    // (for example an HD descriptor without derivation support), fall back
    // to walletPubKey for backward compatibility.
    if (context.walletDescriptor) {
        const walletDescriptorKey = extractRawPubKey(context.walletDescriptor);
        const matchedRole = matchRole(walletDescriptorKey);
        if (matchedRole) {
            return matchedRole;
        }

        if (!walletDescriptorKey && context.walletPubKey) {
            return matchRole(extractRawPubKey(context.walletPubKey));
        }
        return undefined;
    }

    if (context.walletPubKey) {
        return matchRole(extractRawPubKey(context.walletPubKey));
    }

    return undefined;
}

/**
 * Extract pubkey bytes from a persisted param that may hold either a
 * descriptor or a raw hex key.
 *
 * Shared by every descriptor-capable handler (`default` / `delegate` /
 * `boarding` — see `DESCRIPTOR_CAPABLE_CONTRACT_TYPES`) so a rotated row whose
 * key param was persisted in descriptor form deserializes identically
 * whichever handler owns it.
 */
export function extractPubKeyBytes(value: string): Uint8Array {
    return hex.decode(extractPubKey(normalizeToDescriptor(value)));
}

/**
 * Decode a persisted `csvTimelock` param, restoring the default when absent.
 *
 * The param may be missing or empty on legacy/minimal rows (e.g. hex pubkeys
 * written with no timelock). The script classes no longer apply their own
 * fallback, and an unguarded decode does *not* fail loudly: `Number("")` /
 * `Number(undefined)` is `NaN`, and `bip68.decode(NaN)` returns
 * `{ blocks: 0 }`, so `sequenceToTimelock` silently yields a zero timelock —
 * an exit path that reads as immediately spendable. Restore the documented
 * default instead of decoding a NaN.
 */
export function deserializeCsvTimelock(value: string | undefined): RelativeTimelock {
    return value !== undefined && value !== ""
        ? sequenceToTimelock(Number(value))
        : DefaultVtxo.Script.DEFAULT_TIMELOCK;
}

/**
 * BIP65 threshold: locktime values below this are interpreted as block heights,
 * values at or above are interpreted as Unix timestamps (seconds).
 */
const CLTV_HEIGHT_THRESHOLD = 500_000_000n;

/**
 * Check if an absolute (CLTV) locktime is currently satisfied.
 *
 * Following the BIP65 convention:
 * - locktime < 500_000_000  → interpreted as a block height; compared against `context.blockHeight`
 * - locktime >= 500_000_000 → interpreted as a Unix timestamp (seconds); compared against `context.currentTime`
 *
 * Returns false if the relevant context field is missing.
 */
export function isCltvSatisfied(context: PathContext, locktime: bigint): boolean {
    if (locktime < CLTV_HEIGHT_THRESHOLD) {
        if (context.blockHeight === undefined) return false;
        return BigInt(context.blockHeight) >= locktime;
    }
    const currentTimeSec = BigInt(Math.floor(context.currentTime / 1000));
    return currentTimeSec >= locktime;
}

/**
 * Check if a CSV timelock is currently satisfied for the given context/virtual output.
 */
export function isCsvSpendable(context: PathContext, sequence?: number): boolean {
    if (sequence === undefined) return true;
    if (!context.vtxo) return false;
    const timelock = sequenceToTimelock(sequence);

    if (timelock.type === "blocks") {
        if (context.blockHeight === undefined || context.vtxo.status.block_height === undefined) {
            return false;
        }
        return context.blockHeight - context.vtxo.status.block_height >= Number(timelock.value);
    }

    if (timelock.type === "seconds") {
        const blockTime = context.vtxo.status.block_time;
        if (blockTime === undefined) return false;
        return context.currentTime / 1000 - blockTime >= Number(timelock.value);
    }

    return false;
}

/**
 * Batched discovery probe: given candidate pkScripts a discovery pass built
 * (the signer × CSV-timelock cross-product, possibly across several wallet
 * indices), return the subset the indexer has at least one VTXO for — in any
 * state, since restore counts a spent-but-used script as activity.
 *
 * Collapses what used to be one `getVtxos` call per candidate script into a
 * single call per page, the same batching shape as
 * {@link ContractManager.fetchContractVtxosBulk}: the indexer reports each
 * returned VTXO's `script`, which is matched back to the candidate set. It
 * pages only as far as needed to observe every candidate (stopping early once
 * all are seen), and otherwise to the end of history, so the discovered set is
 * identical to the prior per-script path — a heavily-reused candidate cannot
 * starve another candidate off the first page.
 *
 * Scripts beyond {@link SCRIPT_QUERY_CHUNK_SIZE} are split into sequential
 * chunks (a URL-length budget, see the constant). Chunks are issued serially,
 * not concurrently: pacing the indexer is the point of batching here. A chunk
 * rejecting rejects the whole call — callers treat a partial answer as
 * indeterminate, so there is no partial-result channel to leak into.
 */
export async function detectUsedScripts(
    indexerProvider: IndexerProvider,
    scriptHexes: string[],
): Promise<Set<string>> {
    const used = new Set<string>();
    // Distinct indices can derive the same script (e.g. an unrotated signer),
    // and a duplicate would only pad the query string.
    const unique = [...new Set(scriptHexes)];

    for (let offset = 0; offset < unique.length; offset += SCRIPT_QUERY_CHUNK_SIZE) {
        const scripts = unique.slice(offset, offset + SCRIPT_QUERY_CHUNK_SIZE);
        // `scripts` stays the full chunk across pages so the indexer's
        // pagination is consistent; `remaining` only drives the early stop.
        const remaining = new Set(scripts);
        let pageIndex = 0;
        let hasMore = true;
        while (hasMore && remaining.size > 0) {
            const { vtxos, page } = await getNormalizedVtxos(indexerProvider, {
                scripts,
                pageIndex,
                pageSize: DEFAULT_PAGE_SIZE,
            });
            for (const vtxo of vtxos) {
                if (remaining.delete(vtxo.script)) used.add(vtxo.script);
            }
            // Same end-of-history heuristic as fetchContractVtxosBulk: a short
            // page (or absent page metadata) means there is nothing left to
            // fetch.
            hasMore = page ? vtxos.length === DEFAULT_PAGE_SIZE : false;
            pageIndex++;
        }
    }
    return used;
}

/**
 * Shared body of an indexer-backed handler's `discoverAt` / `discoverRange`.
 *
 * Both verbs are this one function — per-index discovery is just a range of
 * one — so the two paths cannot drift into reporting different contracts for
 * the same wallet state. Every I/O the pass needs is the single
 * {@link detectUsedScripts} call over the union of all indices' candidates,
 * which is what turns a 10-index window's ~20 concurrent 2-script requests
 * into 1-2 sequential batched ones.
 *
 * The returned map covers **every** requested index (empty array when nothing
 * hit), satisfying the `discoverRange` coverage contract the scanner enforces.
 */
export async function discoverIndexerCandidates<C extends { scriptHex: string }>(
    indexerProvider: IndexerProvider,
    entries: readonly { index: number; descriptor: string }[],
    buildCandidates: (index: number, descriptor: string) => C[],
    emit: (candidate: C, index: number, descriptor: string) => DiscoveredContract,
): Promise<Map<number, DiscoveredContract[]>> {
    const perIndex = entries.map((entry) => ({
        ...entry,
        candidates: buildCandidates(entry.index, entry.descriptor),
    }));

    const used = await detectUsedScripts(
        indexerProvider,
        perIndex.flatMap((e) => e.candidates.map((c) => c.scriptHex)),
    );

    const out = new Map<number, DiscoveredContract[]>();
    for (const { index, descriptor, candidates } of perIndex) {
        out.set(
            index,
            candidates.filter((c) => used.has(c.scriptHex)).map((c) => emit(c, index, descriptor)),
        );
    }
    return out;
}

/**
 * Metadata tagging a discovered contract as one of the wallet's own rotating
 * receive addresses — spread into a {@link DiscoveredContract} literal.
 *
 * Only *rotated* rows (index > 0) are tagged, so boot resolution can find the
 * newest address and descriptor-aware signing can recover the per-index key.
 * The index-0 baseline stays untagged across every handler.
 */
export function rotatedReceiveMetadata(
    index: number,
    descriptor: string,
): Pick<DiscoveredContract, "metadata"> {
    return index > 0
        ? { metadata: { source: WALLET_RECEIVE_SOURCE, signingDescriptor: descriptor } }
        : {};
}

/**
 * Derive a handler's {@link Discoverable.discoverAt} from its
 * {@link Discoverable.discoverRange}: per-index discovery is just a range of
 * one, so the two verbs cannot drift into reporting different contracts for
 * the same wallet state.
 *
 * The `?? []` mirrors `discoverRange`'s coverage contract from the caller's
 * side — a range that omitted the requested index reports a miss here rather
 * than `undefined`.
 */
export function discoverAtViaRange(
    discoverRange: NonNullable<Discoverable["discoverRange"]>,
): Discoverable["discoverAt"] {
    return async (index: number, descriptor: string, deps: DiscoveryDeps) =>
        (await discoverRange([{ index, descriptor }], deps)).get(index) ?? [];
}
