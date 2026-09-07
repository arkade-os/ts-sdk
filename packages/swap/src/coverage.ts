/**
 * Coverage: whether an offer's script is in the wallet's watched set.
 *
 * Both edges live here because they are one decision seen from two sides.
 * `createOffer` promotes a script the moment it hands the user an address to
 * fund ({@link promoteOfferContract}); the watcher and the restore consumer
 * retire it once nothing at that script holds funds any more
 * ({@link retireSettledOfferContracts}). Identical offers derive one script, so
 * those two can name the same row — and a demotion that lands after a promotion
 * recreates exactly the failure the promotion exists to prevent: an address the
 * user was told to fund, out of the subscription, the poll and every sync.
 *
 * Two things keep them apart:
 *
 * - **Per-script serialization.** `setContractWatchState` is a read-modify-write
 *   over the contract row, so promotion and demotion are ordered here rather
 *   than left to interleave inside the manager.
 * - **The issuance mark.** A swap record is keyed by its funding txid, so an
 *   offer that has been created but not yet funded has no record at all — it is
 *   invisible to a liveness check over records, for as long as the user takes
 *   to send. {@link promoteOfferContract} therefore records the issuance
 *   itself, and a script with an address still waiting for its deposit is never
 *   retired.
 *
 * The mark is per process: a second wallet context (another tab, a service
 * worker) issuing an offer while this one retires the same script is not
 * covered, and neither is an address issued before a restart and funded after
 * it. Both leave a funded-but-unwatched row that the restore scan still finds —
 * the same backstop every other best-effort step here relies on.
 */
import type { IContractManager } from "@arkade-os/sdk";
import type { AssetSwap, AssetSwapStatus } from "./store";

/**
 * Statuses after which the covenant no longer holds funds, so its contract can
 * leave the watched set. NOT `recoverable`: a swept deposit is still the
 * user's money at that script, and unwatching it is how it goes missing.
 */
export const RETIRABLE: readonly AssetSwapStatus[] = ["fulfilled", "cancelled"];

/** The one contract-manager capability changing coverage needs. */
export type OfferContractRetirer = Pick<IContractManager, "setContractWatchState">;

/**
 * Scripts whose address has been handed out, by the time it was handed out.
 * Cleared by the first record that shows the deposit landed — from there the
 * records answer liveness, and a mark left behind would pin the script watched
 * for the life of the process.
 */
const issuedAt = new Map<string, number>();

/**
 * Per-script tail of in-flight coverage changes. A script is dropped from the
 * map once its own chain settles, so this holds only what is running.
 */
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
 * Whether an address issued at `script` is still waiting for its deposit.
 *
 * A record at the script created since the issuance *is* that deposit landing:
 * `createdAt` is the funding time (`restoreAssetSwaps` reads it off the funding
 * transaction), so a record older than the mark belongs to an earlier offer and
 * says nothing about this one.
 */
function addressOutstanding(swaps: AssetSwap[], script: string): boolean {
    const issued = issuedAt.get(script);
    if (issued === undefined) return false;
    if (swaps.some((s) => s.swapPkScript === script && s.createdAt >= issued)) {
        issuedAt.delete(script);
        return false;
    }
    return true;
}

/**
 * Put `script` in the watched set and record that its address is outstanding.
 *
 * Unconditional, not conditional on a fresh contract row: identical offers share
 * one script and `createContract` is first-writer-wins, so re-offering a script
 * an earlier settlement retired would otherwise leave the row `retained`.
 *
 * Throws, unlike retiring: an address returned without coverage is the failure
 * this exists to prevent, and nothing is at stake yet, so the caller can retry.
 */
export async function promoteOfferContract(
    manager: OfferContractRetirer,
    script: string,
): Promise<void> {
    await serialize(script, async () => {
        await manager.setContractWatchState(script, "watched");
        // after the write: a promotion that failed hands out no address, so
        // there is nothing outstanding to protect
        issuedAt.set(script, Date.now());
    });
}

/**
 * Drop `script` from the watched set unless something there still needs it.
 * Identical offers share one script, so the check is per script, not per record.
 *
 * `retained`, not deleted: the row is what keeps the deposit's VTXOs
 * annotatable and its history readable, while `retained` is what drops it from
 * the subscription, the failsafe poll and every sync. A user who has made
 * hundreds of offers otherwise re-subscribes to hundreds of dead scripts on
 * every wallet start.
 *
 * A `recoverable` record blocks its script for good — nothing moves a record
 * off that status — so a script that once held a swept deposit stays watched
 * for the life of the wallet. Accepted: the cost is polling, and the
 * alternative (tracking when recovery completed) buys less than it costs.
 *
 * Best-effort, exactly as core's own demotion is: a failed retire costs
 * polling, never correctness.
 */
export async function retireOfferContract(
    manager: OfferContractRetirer,
    swaps: AssetSwap[],
    script: string,
): Promise<void> {
    // both reads happen inside the queue, so a promotion that arrives while an
    // earlier retire was being decided is seen here rather than overwritten
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
 * Retire every offer script in `swaps` that no live record still holds — the
 * batch form of what the watcher does per spend event, for a consumer that
 * applies {@link restoreAssetSwaps} results without running the watcher.
 *
 * Takes the caller's full record list: liveness is a property of all records at
 * a script, so a partial list would retire a script another record still holds.
 */
export async function retireSettledOfferContracts(
    manager: OfferContractRetirer,
    swaps: AssetSwap[],
): Promise<void> {
    const settled = new Set(
        swaps.filter((s) => RETIRABLE.includes(s.status)).map((s) => s.swapPkScript),
    );
    for (const script of settled) await retireOfferContract(manager, swaps, script);
}
