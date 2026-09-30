import type { ExtendedVirtualCoin, NormalizedExtendedVirtualCoin, VirtualCoin } from "../wallet";
import { normalizeVtxo } from "../wallet/vtxo";
import type { WalletRepository } from "../repositories/walletRepository";
import type { Contract } from "./types";

/**
 * Tier 1 helpers that enforce VTXO ownership at call sites that already know
 * the intended contract script. Address-keyed repositories may still hand back
 * legacy duplicate rows under the wrong bucket; these helpers gate reads and
 * writes so a wrong-script row never wins.
 *
 * `script` is the authoritative ownership key. Equality is strict: a missing
 * or empty `vtxo.script` never matches.
 */

export function vtxoOutpoint(vtxo: Pick<VirtualCoin, "txid" | "vout">): string {
    return `${vtxo.txid}:${vtxo.vout}`;
}

export function isVtxoForScript(vtxo: Pick<VirtualCoin, "script">, script: string): boolean {
    return !!vtxo.script && vtxo.script === script;
}

export function filterVtxosForScript<T extends Pick<VirtualCoin, "script">>(
    vtxos: T[],
    script: string,
): T[] {
    return vtxos.filter((v) => isVtxoForScript(v, script));
}

/**
 * Background/indexer sync flavour: drop wrong-script rows and log enough
 * context to identify each rejection. Returns only matching rows so the
 * caller can keep going.
 */
export function warnAndFilterVtxosForScript<
    T extends Pick<VirtualCoin, "txid" | "vout" | "script">,
>(vtxos: T[], script: string, context: string): T[] {
    const matches: T[] = [];
    const rejected: string[] = [];
    for (const v of vtxos) {
        if (isVtxoForScript(v, script)) {
            matches.push(v);
        } else {
            rejected.push(`${vtxoOutpoint(v)}(script=${v.script ?? ""})`);
        }
    }
    if (rejected.length > 0) {
        console.warn(
            `${context}: dropped ${rejected.length} wrong-script VTXO(s) for script ${script}: ${rejected.join(", ")}`,
        );
    }
    return matches;
}

/**
 * User-initiated transaction/signing flavour: throw before persisting or
 * signing inconsistent ownership state. Silently skipping here would hide a
 * serious bug in the wallet's spend path.
 */
export function validateVtxosForScript(
    vtxos: Array<Pick<VirtualCoin, "txid" | "vout" | "script">>,
    script: string,
    context: string,
): void {
    const mismatches = vtxos.filter((v) => !isVtxoForScript(v, script));
    if (mismatches.length === 0) return;
    const detail = mismatches.map((v) => `${vtxoOutpoint(v)}(script=${v.script ?? ""})`).join(", ");
    throw new Error(
        `${context}: refusing to persist ${mismatches.length} VTXO(s) whose script does not match ${script}: ${detail}`,
    );
}

/**
 * Tier 2 dispatch helpers: route to script-scoped repository methods when
 * available, falling back to Tier 1 address-based filtering otherwise.
 *
 * Also the repository normalization boundary: `WalletRepository` is a public interface, so rows may
 * arrive legacy-shaped from any backend — including consumer-implemented ones and `InMemory`, which
 * stores by reference and never runs a deserializer. Normalizing here rather than in each backend
 * is what makes the guarantee implementation-agnostic.
 */
export async function getVtxosForContract(
    repo: WalletRepository,
    contract: Pick<Contract, "script" | "address">,
): Promise<NormalizedExtendedVirtualCoin[]> {
    const vtxos = repo.getVtxosForScript
        ? await repo.getVtxosForScript(contract.script)
        : filterVtxosForScript(await repo.getVtxos(contract.address), contract.script);
    return vtxos.map(normalizeVtxo);
}

/** Provenance is required, so a bare `isSpent: true` records nothing and stays
 * correctable. Every local write sets `arkTxId` (send) or `settledBy` (settle). */
function hasRecordedSpend(
    vtxo: Pick<ExtendedVirtualCoin, "isSpent" | "spentBy" | "arkTxId" | "settledBy">,
) {
    return vtxo.isSpent === true && (!!vtxo.spentBy || !!vtxo.arkTxId || !!vtxo.settledBy);
}

/** Only a write THIS process made can be raced by its own read; arkd indexes a
 * spend just after `FinalizeTx` returns. Persisting this would instead make a
 * wrong spend permanent — nothing clears `isSpent` — so expiry is the way back. */
const RECORDED_SPEND_TTL_MS = 60_000;

interface RecordedSpend {
    at: number;
    spentBy?: string;
    arkTxId?: string;
    settledBy?: string;
}

/** Keyed by repository so records die with the storage they describe. */
const recordedSpends = new WeakMap<WalletRepository, Map<string, RecordedSpend>>();

function registryFor(repo: WalletRepository): Map<string, RecordedSpend> {
    const existing = recordedSpends.get(repo);
    if (existing) return existing;
    const created = new Map<string, RecordedSpend>();
    recordedSpends.set(repo, created);
    return created;
}

/** @internal Test-only: simulates the restart that drops these records. */
export function resetRecordedSpends(repo: WalletRepository): void {
    recordedSpends.delete(repo);
}

/**
 * One write chain per repository: the read-modify-write half of the guard.
 *
 * {@link applyRecordedSpends} consults the registry and then hands the result
 * to an async write, so a spend registered in between is invisible to the rows
 * that write commits — a poll's batch, read before a send registered, can still
 * land after it and undo the spend. Both writers are in this thread and both
 * write through {@link inVtxoWriteOrder}, so ordering the section that guards
 * and writes is enough: whichever section runs second reads the first's
 * registrations.
 *
 * Keyed by repository, so this bounds nothing across processes or across a
 * second wallet holding the same storage — like the registry, those have no
 * record to clobber.
 */
const writeChains = new WeakMap<WalletRepository, Promise<unknown>>();

/**
 * Run `fn` after every write already queued for `repo`, and let the next one
 * queue behind it. `fn` must not call this again for the same repository: it
 * would wait on the chain it is part of.
 */
export function inVtxoWriteOrder<T>(repo: WalletRepository, fn: () => Promise<T>): Promise<T> {
    const prev = writeChains.get(repo) ?? Promise.resolve();
    // No await between get and set, so the enqueue is atomic.
    const run = prev.then(fn, fn);
    // Kept alive regardless of this run's outcome, so one failed write cannot
    // wedge every later one.
    writeChains.set(
        repo,
        run.catch(() => {}),
    );
    return run;
}

export function applyRecordedSpends(
    repo: WalletRepository,
    vtxos: ExtendedVirtualCoin[],
): ExtendedVirtualCoin[] {
    const registry = registryFor(repo);
    const now = Date.now();
    for (const [key, spend] of registry) {
        if (now - spend.at >= RECORDED_SPEND_TTL_MS) registry.delete(key);
    }
    for (const incoming of vtxos) {
        const key = vtxoOutpoint(incoming);
        if (!hasRecordedSpend(incoming) || registry.has(key)) continue;
        // `at` is first sighting, so re-reporting a spend cannot extend the pin.
        registry.set(key, {
            at: now,
            spentBy: incoming.spentBy,
            arkTxId: incoming.arkTxId,
            settledBy: incoming.settledBy,
        });
    }
    if (registry.size === 0) return vtxos;

    return vtxos.map((incoming) => {
        if (hasRecordedSpend(incoming)) return incoming;
        const spent = registry.get(vtxoOutpoint(incoming));
        if (!spent) return incoming;
        // Fresher incoming provenance wins; the record only fills what is missing.
        const spentBy = incoming.spentBy || spent.spentBy;
        const arkTxId = incoming.arkTxId || spent.arkTxId;
        const settledBy = incoming.settledBy || spent.settledBy;
        return {
            ...incoming,
            isSpent: true,
            ...(spentBy ? { spentBy } : {}),
            ...(arkTxId ? { arkTxId } : {}),
            ...(settledBy ? { settledBy } : {}),
        };
    });
}

export async function saveVtxosForContract(
    repo: WalletRepository,
    contract: Pick<Contract, "script" | "address">,
    vtxos: ExtendedVirtualCoin[],
): Promise<void> {
    return inVtxoWriteOrder(repo, async () => {
        // Inside the ordered section: a spend registered by the write this one
        // is queued behind is already in the registry when the guard reads it.
        const rows = applyRecordedSpends(repo, vtxos);
        if (repo.saveVtxosForScript) {
            return repo.saveVtxosForScript(
                { script: contract.script, address: contract.address },
                rows,
            );
        }
        validateVtxosForScript(rows, contract.script, "saveVtxosForContract");
        return repo.saveVtxos(contract.address, rows);
    });
}
