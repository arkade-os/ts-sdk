/**
 * Coverage: whether an offer's script is in the wallet's watched set. `createOffer` promotes; the
 * watcher and restore consumer retire. Identical offers share one script, so a late demotion would
 * unwatch an address the user was just told to fund. Guards: per-script serialization (the watch
 * state is a read-modify-write), and an issuance mark for created-but-unfunded offers, which have no
 * record yet. The mark is per process; the restore scan backstops other contexts and restarts.
 */
import type { IContractManager } from "@arkade-os/sdk";
import type { RfqSwapState } from "./rfqSwapState";
import type { AssetSwapStatus } from "./store";

/** Native issuance matches `id`; legacy issuance compares unix milliseconds in `createdAt`. */
export interface CoveredSwap {
    readonly swapPkScript: string;
    readonly status: AssetSwapStatus;
    readonly createdAt: number;
    readonly id?: string;
}

/**
 * Statuses after which the covenant no longer holds funds, so its contract can
 * leave the watched set. NOT `recoverable`: a swept deposit is still the
 * user's money at that script, and unwatching it is how it goes missing.
 */
export const RETIRABLE: readonly AssetSwapStatus[] = ["fulfilled", "cancelled"];

/** The one contract-manager capability changing coverage needs. */
export type OfferContractRetirer = Pick<IContractManager, "setContractWatchState">;

/** Corridor states after which the LOCKUP no longer holds funds: both mean it
 *  WAS SPENT. `failed` is terminal too and excluded on purpose — an action that
 *  missed its window says nothing about a covenant that can still be funded. */
export const LOCKUP_RETIRABLE: readonly RfqSwapState[] = ["settled", "refunded"];

export interface CoverageRegistrationOptions {
    readonly coverageId?: string;
    /** Use the wallet object: a worker can return a fresh manager proxy on every call. */
    readonly scope?: object;
}

const legacyScope = {};
type OutstandingIssuance = { issuedAt?: number; ids: Set<string> };
const issuedByScope = new WeakMap<object, Map<string, OutstandingIssuance>>();

function markIssued(script: string, issued: number, options: CoverageRegistrationOptions): void {
    const scope = options.scope ?? legacyScope;
    const issuedAt = issuedByScope.get(scope) ?? new Map<string, OutstandingIssuance>();
    const outstanding = issuedAt.get(script) ?? { issuedAt: undefined, ids: new Set<string>() };
    const id = options.coverageId;
    if (id === undefined) outstanding.issuedAt = issued;
    else outstanding.ids.add(id);
    issuedAt.set(script, outstanding);
    issuedByScope.set(scope, issuedAt);
}

/** Per-script tail of in-flight coverage changes; holds only what is running. */
const inFlight = new Map<string, Promise<void>>();

/** Run `task` after every coverage change already queued for `script`. */
async function serialize<T>(script: string, task: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(script) ?? Promise.resolve();
    // `.then(task, task)`: a failed predecessor must not cancel its successors —
    // the queue is for ordering, never for propagating outcomes
    const result = previous.then(task, task);
    const settled = result.then(
        () => {},
        () => {},
    );
    inFlight.set(script, settled);
    void settled.then(() => {
        if (inFlight.get(script) === settled) inFlight.delete(script);
    });
    return result;
}

/**
 * Whether an address issued at `script` is still waiting for its deposit. A record at the script
 * created since the issuance *is* that deposit (`createdAt` is the funding time); an older record
 * belongs to an earlier offer.
 */
function addressOutstanding(swaps: readonly CoveredSwap[], script: string, scope: object): boolean {
    const issuedAt = issuedByScope.get(scope);
    if (issuedAt === undefined) return false;
    const issued = issuedAt.get(script);
    if (issued === undefined) return false;
    for (const swap of swaps) {
        if (swap.swapPkScript !== script) continue;
        if (swap.id !== undefined) issued.ids.delete(swap.id);
        if (issued.issuedAt !== undefined && swap.createdAt >= issued.issuedAt) {
            issued.issuedAt = undefined;
        }
    }
    if (issued.ids.size > 0 || issued.issuedAt !== undefined) return true;
    issuedAt.delete(script);
    return false;
}

/**
 * Put `script` in the watched set and mark its address outstanding. Unconditional, since identical
 * offers share a script and `createContract` is first-writer-wins. Throws, unlike retiring: an
 * address handed out without coverage is the failure this prevents, and nothing is at stake yet.
 */
export async function promoteOfferContract(
    manager: OfferContractRetirer,
    script: string,
    /** When the address went out. A restore passes the record's funding time, since a mark dated
     * after every record at the script would pin it watched forever. */
    issued: number = Date.now(),
    options: CoverageRegistrationOptions & { restore?: boolean } = {},
): Promise<void> {
    await serialize(script, async () => {
        await manager.setContractWatchState(script, "watched");
        // after the write: a failed promotion hands out no address
        // A restored native record is already durable, so it issues no new address.
        if (options.restore && options.coverageId !== undefined) return;
        markIssued(script, issued, options);
    });
}

/**
 * Drop `script` from the watched set unless something there still needs it. `retained`, not
 * deleted: the row keeps history readable but leaves the subscription and failsafe poll. A
 * `recoverable` record pins its script watched for good (accepted: the cost is polling).
 * Best-effort: a failed retire costs polling, not correctness.
 */
export async function retireOfferContract(
    manager: OfferContractRetirer,
    swaps: readonly CoveredSwap[] | (() => Promise<readonly CoveredSwap[]>),
    script: string,
    options: CoverageRegistrationOptions = {},
): Promise<void> {
    // both reads inside the queue, so a concurrent promotion is seen rather than overwritten
    await serialize(script, async () => {
        const records = typeof swaps === "function" ? await swaps() : swaps;
        // NOT `!TERMINAL.includes(...)`: `recoverable` is terminal for a spend
        // and not retirable, so reading liveness off TERMINAL unwatches swept
        // funds.
        const outstanding = addressOutstanding(records, script, options.scope ?? legacyScope);
        if (records.some((s) => s.swapPkScript === script && !RETIRABLE.includes(s.status))) return;
        if (outstanding) return;
        try {
            await manager.setContractWatchState(script, "retained");
        } catch (err) {
            console.warn(`[swap] could not retire offer contract ${script}`, err);
        }
    });
}

/**
 * Retire every offer script in `swaps` that no live record still holds — the batch form of the
 * watcher's per-spend retire, for consumers applying {@link restoreAssetSwaps} results without it.
 * Pass the full record list: a partial one could retire a script another record still holds.
 */
export async function retireSettledOfferContracts(
    manager: OfferContractRetirer,
    swaps: readonly CoveredSwap[],
    options: CoverageRegistrationOptions = {},
): Promise<void> {
    const settled = new Set(
        swaps.filter((s) => RETIRABLE.includes(s.status)).map((s) => s.swapPkScript),
    );
    for (const script of settled) await retireOfferContract(manager, swaps, script, options);
}

export const registerContractCoverage = async <T>(
    script: string,
    register: () => Promise<T>,
    options: CoverageRegistrationOptions = {},
): Promise<T> =>
    serialize(script, async () => {
        const row = await register();
        markIssued(script, Date.now(), options);
        return row;
    });
