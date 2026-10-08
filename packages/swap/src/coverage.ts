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

/** Structural so v1 and v2 offer records both fit. `createdAt` is unix **milliseconds**, the unit
 * issuance is marked in; seconds would leave every issued script outstanding forever. */
export interface CoveredSwap {
    readonly swapPkScript: string;
    readonly status: AssetSwapStatus;
    readonly createdAt: number;
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

/** Scripts whose address has been handed out, by issuance time. Cleared by the first record showing
 * the deposit landed; a stale mark would pin the script watched for the life of the process. */
const issuedAt = new Map<string, number>();

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
function addressOutstanding(swaps: readonly CoveredSwap[], script: string): boolean {
    const issued = issuedAt.get(script);
    if (issued === undefined) return false;
    if (swaps.some((s) => s.swapPkScript === script && s.createdAt >= issued)) {
        issuedAt.delete(script);
        return false;
    }
    return true;
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
): Promise<void> {
    await serialize(script, async () => {
        await manager.setContractWatchState(script, "watched");
        // after the write: a failed promotion hands out no address
        issuedAt.set(script, issued);
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
    swaps: readonly CoveredSwap[],
    script: string,
): Promise<void> {
    // both reads inside the queue, so a concurrent promotion is seen rather than overwritten
    await serialize(script, async () => {
        // NOT `!TERMINAL.includes(...)`: `recoverable` is terminal for a spend
        // and not retirable, so reading liveness off TERMINAL unwatches swept
        // funds.
        if (swaps.some((s) => s.swapPkScript === script && !RETIRABLE.includes(s.status))) return;
        if (addressOutstanding(swaps, script)) return;
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
): Promise<void> {
    const settled = new Set(
        swaps.filter((s) => RETIRABLE.includes(s.status)).map((s) => s.swapPkScript),
    );
    for (const script of settled) await retireOfferContract(manager, swaps, script);
}
