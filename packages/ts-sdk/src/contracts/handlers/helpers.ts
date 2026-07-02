import { sequenceToTimelock } from "../../utils/timelock";
import { Contract, PathContext } from "../types";
import { isDescriptor, extractPubKey } from "../../identity/descriptor";
import type { IndexerProvider } from "../../providers/indexer";
import { DEFAULT_PAGE_SIZE } from "../constants";

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
 * Batched discovery probe for a single wallet index: given the candidate
 * pkScripts a `discoverAt` built (the signer × CSV-timelock cross-product,
 * already deduped), return the subset the indexer has at least one VTXO for —
 * in any state, since restore counts a spent-but-used script as activity.
 *
 * Collapses what used to be one `getVtxos` call per candidate script into a
 * single call per page, the same batching shape as
 * {@link ContractManager.fetchContractVtxosBulk}: the indexer reports each
 * returned VTXO's `script`, which is matched back to the candidate set. It
 * pages only as far as needed to observe every candidate (stopping early once
 * all are seen), and otherwise to the end of history, so the discovered set is
 * identical to the prior per-script path — a heavily-reused candidate cannot
 * starve another candidate off the first page.
 */
export async function detectUsedScripts(
    indexerProvider: IndexerProvider,
    scriptHexes: string[],
): Promise<Set<string>> {
    const used = new Set<string>();
    if (scriptHexes.length === 0) return used;

    // `scripts` stays the full candidate set across pages so the indexer's
    // pagination is consistent; `remaining` only drives the early stop.
    const remaining = new Set(scriptHexes);
    let pageIndex = 0;
    let hasMore = true;
    while (hasMore && remaining.size > 0) {
        const { vtxos, page } = await indexerProvider.getVtxos({
            scripts: scriptHexes,
            pageIndex,
            pageSize: DEFAULT_PAGE_SIZE,
        });
        for (const vtxo of vtxos) {
            if (remaining.delete(vtxo.script)) used.add(vtxo.script);
        }
        // Same end-of-history heuristic as fetchContractVtxosBulk: a short page
        // (or absent page metadata) means there is nothing left to fetch.
        hasMore = page ? vtxos.length === DEFAULT_PAGE_SIZE : false;
        pageIndex++;
    }
    return used;
}
