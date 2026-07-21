import { hex } from "@scure/base";
import { sequenceToTimelock } from "../../utils/timelock";
import { Contract, DiscoveredContract, PathContext, PathSelection } from "../types";
import type { Discoverable, DiscoveryDeps } from "../types";
import {
    isDescriptor,
    extractPubKey,
    normalizeToDescriptor,
    deriveDescriptorLeafPubKey,
} from "../../identity/descriptor";
import type { IndexerProvider } from "../../providers/indexer";
import { getNormalizedVtxos } from "../../wallet/vtxo";
import { DefaultVtxo } from "../../script/default";
import type { TapLeafScript } from "../../script/base";
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
 * The tapleaf surface shared by `DefaultVtxo.Script` and
 * `DelegateVtxo.Script`. Structural rather than nominal: the two classes are
 * siblings (delegate wraps a default rather than extending it), so a shared
 * interface is what lets both feed the forfeit/exit path helpers below.
 */
export interface ForfeitExitScript {
    forfeit(): TapLeafScript;
    exit(): TapLeafScript;
}

/**
 * BIP68 sequence for a contract's exit path, or `undefined` when the contract
 * carries no `csvTimelock` param (an exit with no relative timelock).
 */
export function exitSequence(contract: Contract): number | undefined {
    return contract.params.csvTimelock ? Number(contract.params.csvTimelock) : undefined;
}

/**
 * The `forfeit`-or-`exit` selection every forfeit/exit contract shares:
 * collaborative spending takes the forfeit path, otherwise the exit path once
 * its CSV has matured. Returns null when neither is available.
 */
export function selectForfeitOrExitPath(
    script: ForfeitExitScript,
    contract: Contract,
    context: PathContext,
): PathSelection | null {
    if (context.collaborative) {
        return { leaf: script.forfeit() };
    }

    const sequence = exitSequence(contract);
    if (!isCsvSpendable(context, sequence)) {
        return null;
    }
    return { leaf: script.exit(), sequence };
}

/**
 * Every forfeit/exit path that exists at all: forfeit when the server
 * cooperates, plus exit unconditionally (its CSV is checked at tx build time,
 * not here).
 */
export function forfeitExitAllPaths(
    script: ForfeitExitScript,
    contract: Contract,
    context: PathContext,
): PathSelection[] {
    const paths: PathSelection[] = [];

    if (context.collaborative) {
        paths.push({ leaf: script.forfeit() });
    }

    const exitPath: PathSelection = { leaf: script.exit() };
    const sequence = exitSequence(contract);
    if (sequence !== undefined) {
        exitPath.sequence = sequence;
    }
    paths.push(exitPath);

    return paths;
}

/**
 * The subset of {@link forfeitExitAllPaths} spendable *right now* — the exit
 * path is dropped until its CSV has matured.
 */
export function forfeitExitSpendablePaths(
    script: ForfeitExitScript,
    contract: Contract,
    context: PathContext,
): PathSelection[] {
    const paths: PathSelection[] = [];

    if (context.collaborative) {
        paths.push({ leaf: script.forfeit() });
    }

    const sequence = exitSequence(contract);
    if (isCsvSpendable(context, sequence)) {
        const exitPath: PathSelection = { leaf: script.exit() };
        if (sequence !== undefined) {
            exitPath.sequence = sequence;
        }
        paths.push(exitPath);
    }

    return paths;
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
 * One probe candidate: a built script plus the (signer, timelock) pair that
 * produced it, so the matched signer can be threaded into the emitted
 * contract's params and address.
 */
export interface SignerCandidate<S> {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
    script: S;
    scriptHex: string;
}

/**
 * Candidate scripts for one wallet index: the current signer first, then any
 * deprecated signers (so a VTXO minted under a now-rotated server key is still
 * discovered), each crossed with the CSV-timelock matrix.
 *
 * Dedup by scriptHex — a deprecated signer that produced no rotation yields
 * the same scripts as the current key, so it must neither be probed nor
 * emitted twice; the current signer wins the attribution by being first.
 *
 * `makeScript` is the only per-contract-type part, which is what lets
 * `default` and `delegate` share one cross-product.
 */
export function buildSignerTimelockCandidates<S extends { pkScript: Uint8Array }>(
    descriptor: string,
    deps: DiscoveryDeps,
    makeScript: (opts: {
        pubKey: Uint8Array;
        serverPubKey: Uint8Array;
        csvTimelock: RelativeTimelock;
    }) => S,
): SignerCandidate<S>[] {
    const pubKey = deriveDescriptorLeafPubKey(descriptor);
    const signers = [deps.serverPubKey, ...(deps.deprecatedSignerPubKeys ?? [])];
    const seen = new Set<string>();
    const candidates: SignerCandidate<S>[] = [];
    for (const serverPubKey of signers) {
        for (const csvTimelock of deps.csvTimelocks) {
            const script = makeScript({ pubKey, serverPubKey, csvTimelock });
            const scriptHex = hex.encode(script.pkScript);
            if (seen.has(scriptHex)) continue;
            seen.add(scriptHex);
            candidates.push({ pubKey, serverPubKey, csvTimelock, script, scriptHex });
        }
    }
    return candidates;
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
