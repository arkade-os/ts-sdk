/**
 * `cancel()`: the one value-moving call the client makes inside an awaited
 * method, not through the drive loop.
 *
 * The asymmetry is structural (§3.3): cancel is a 2-of-2 of user and server
 * against a `fulfill` constrained to pay the maker at least `wantAmount`, so
 * an unfilled offer's only exit needs no solver. Corridor swaps have phases
 * instead — they answer {@link NotCancellable} on the tag parse, no repository
 * read.
 *
 * **The fill race resolves by reading the spend.** v1's trap is that
 * `cancelOffer` throws "no spendable VTXO at the swap address" when the fill
 * won, and its own doc says in as many words that this means the swap
 * completed. Here the race is reconciled the way the watcher already does —
 * `spendTxidsOf(vtxo)`, checkpoint first, `getVirtualTxs`, then
 * `classifyDepositSpend` against the covenant's leaves — and the widened
 * answer is the record of it: `cancelled` | `filled` | `needs_recovery`.
 * `indeterminate` is the third answer: everything the classifier cannot name
 * is a failure to rebuild the covenant rather than a wrong spend, and throwing
 * contradicts §7 — value has already moved. `needs_recovery` is surfaced and
 * never silently retried; `client.recover` is what drives it.
 *
 * **The ordering is `cancelOffer`'s, but the record it writes is v2's.** v1
 * keys its local-record half on the v1 store by funding txid, so passed the v2
 * repository it finds nothing and submits with nothing written. This runs the
 * same ordering over the {@link OfferSwapRecord}: strict read, the `cancelling`
 * write gating the broadcast, the broadcast, best-effort `cancelled` plus
 * `spentTxid` and `completedAt`, and the retire only when the record persisted
 * — emitting through `onUpdate` at both edges, because between the gate and the
 * settlement the record has no `spentTxid` and a crash mid-call would otherwise
 * leave a permanent `cancelling` nobody hears about. Neither edge is permanent:
 * the drive keeps `cancelling` in its live set, so a landed spend is still
 * classified by the watcher, and a `cancelling` record with no spend and an
 * intact deposit is a cancel that never broadcast — a second `cancel()` resumes
 * it, the same idempotence-absorbing retry `accept()` already gives.
 */
import { base64, hex } from "@scure/base";
import { ArkAddress, Transaction, type IWallet } from "@arkade-os/sdk";
import { retireOfferContract } from "../coverage";
import {
    NoSpendableDepositError,
    OfferCovenantMismatchError,
    decodeOffer,
    prepareOfferCancel,
} from "../offer";
import { classifyDepositSpend, spendTxidsOf } from "../restore";
import { offerOutcome } from "./outcome";
import type { AssetSwapRepository } from "../repository";
import type { LockupSpendIndexer } from "../refund";
import type { SwapDrive } from "./drive";
import { offerFactsOf, splitRecords } from "./driveRecords";
import type { OfferSwapRecord } from "./record";

/** What `cancel()` did to the deposit. §3.3's widened return: the
 * `indeterminate` spend is `needs_recovery`, because value moved and the local
 * rebuild cannot name how. */
export type CancelOutcome = "cancelled" | "filled" | "needs_recovery";

/** Offer statuses a spend cannot move — the swap is already resolved, and a
 * cancel answers from the record rather than re-broadcasting. */
const OFFER_TERMINAL = (record: OfferSwapRecord): boolean =>
    record.status === "cancelled" || record.status === "fulfilled";

export interface CancelInput {
    readonly wallet: IWallet;
    readonly repository: AssetSwapRepository;
    /** The record to cancel, read by the caller after `drive.ready` — the one
     * read the call makes, and what the gate is written from. */
    readonly record: OfferSwapRecord;
    /** The delivery channel both edges emit through, armed or not. */
    readonly drive: SwapDrive;
    /** The Arkade observation seam — the wallet's own reader, as everywhere. */
    readonly indexer: LockupSpendIndexer;
    /** Unix seconds. Injected for tests. */
    readonly now?: () => number;
}

/**
 * Cancel one offer swap, reconciling the fill race and writing the v2 record.
 *
 * The caller has already made the strict read — a repository this call cannot
 * read must not read as "no record here" and send a cancel past its gate — and
 * refused the corridor tag and the missing record as `NotCancellable`.
 */
export const cancelSwap = async (input: CancelInput): Promise<{ outcome: CancelOutcome }> => {
    const { wallet, repository, record, drive, indexer } = input;
    const now = input.now ?? (() => Math.floor(Date.now() / 1000));

    // A swap whose outcome is already terminal answers from the record rather
    // than re-broadcasting — whichever call noticed it, the answer is one
    // condition, not two.
    if (OFFER_TERMINAL(record)) {
        return { outcome: record.status === "cancelled" ? "cancelled" : "filled" };
    }
    if (offerOutcome(record.status) === "needs_recovery") {
        // A swept deposit, or one of the onchain-corridor phases: the value
        // left the covenant by a route no offchain spend can reach, so
        // `client.recover` is what drives it. Nothing here to cancel.
        return { outcome: "needs_recovery" };
    }

    // `cancelling` with no recorded spend is a cancel that never broadcast —
    // the gate's write landed and the call died before `send()`. Resuming is
    // the same idempotence-absorbing retry `accept()` gives; the `cancelling`
    // write below is a rewrite of an identical marker. The one exception is a
    // pre-broadcast rebuild refusal (`OfferCovenantMismatchError`): retrying
    // cannot help, so the catch rolls the gate back instead of leaving it.

    // The gate, written BEFORE the broadcast: it is what keeps a crash between
    // submit and record from leaving a swap that still looks pending. It
    // throws, deliberately — a failed write must not be broadcast past.
    const gated = withStatus(record, "cancelling", now());
    await repository.saveSwapRecord(gated);
    drive.ingest(gated);

    let prepared;
    try {
        prepared = await prepareOfferCancel(wallet, record.offerHex, {
            swapAddress: record.swapAddress,
            ...(record.fundingTxid === undefined ? {} : { fundingTxid: record.fundingTxid }),
        });
    } catch (error) {
        if (error instanceof OfferCovenantMismatchError) {
            // Pre-broadcast and non-retryable: the rebuild disagrees with the
            // funded covenant (rotated operator key, wrong swapAddress, corrupt
            // record), so a second cancel would fail the same way. Roll the
            // gate back to the pre-gate status rather than leaving a
            // `cancelling` no retry can move past — `recover()` is for funds
            // that moved, and nothing moved here. Best-effort: a lost rollback
            // write must not mask the mismatch the caller has to act on.
            const rolledBack = withStatus(record, record.status, now());
            try {
                await repository.saveSwapRecord(rolledBack);
            } catch (rollbackError) {
                console.warn(
                    `[swap] could not roll back cancel gate for ${record.id}`,
                    rollbackError,
                );
            }
            drive.ingest(rolledBack);
            throw error;
        }
        if (isMissingVtxo(error)) {
            // The fill won the race: the deposit is already spent. Reconcile
            // the spend rather than throwing — v1's documented throw here meant
            // the swap completed.
            const reconciled = await reconcileDepositSpend(record, indexer);
            if (reconciled === undefined) {
                // No terminal write on a guess: the record stays `cancelling`
                // and the deposit's fate is what `client.recover` drives.
                return { outcome: "needs_recovery" };
            }
            const { kind, spentTxid } = reconciled;
            const settled = withStatus(gated, kind, now(), {
                spentTxid,
                // Mirrors the watcher: a completion time is a fill's, not a
                // cancel's.
                ...(kind === "fulfilled" ? { completedAt: now() } : {}),
            });
            const { persisted } = await persistBestEffort(repository, settled);
            drive.ingest(settled);
            if (persisted) await retireOfferScripts(wallet, repository, settled);
            return { outcome: kind === "cancelled" ? "cancelled" : "filled" };
        }
        throw error;
    }

    // The broadcast. The gate landed above, so a crash between the two leaves
    // the `cancelling` marker rather than a pending-looking swap.
    const txid = await prepared.send();

    // Past the point of no return: the cancel is broadcast, so a lost write
    // must not fail the caller. The watcher classifies by covenant leaf and the
    // restore scan re-derives the outcome.
    const settled = withStatus(gated, "cancelled", now(), { spentTxid: txid });
    const { persisted } = await persistBestEffort(repository, settled);
    drive.ingest(settled);
    if (persisted) {
        // Retiring belongs beside the settlement write for the same reason the
        // status does: recording its own outcome is what leaves the watcher
        // nothing to do. Only on a persisted write — a record that still reads
        // `cancelling` to the next restore must stay watched.
        await retireOfferScripts(wallet, repository, settled);
    }
    return { outcome: "cancelled" };
};

/** The deposit's spend, classified the way the watcher classifies it —
 * checkpoint first, then the ark tx, against the covenant's own leaves.
 * `undefined` is the indeterminate answer, and it covers a deposit this reader
 * cannot see at all as well as one whose spend took neither leaf: both are a
 * failure to name what happened rather than evidence of what did, and neither
 * may be written down as terminal. */
const reconcileDepositSpend = async (
    record: OfferSwapRecord,
    indexer: LockupSpendIndexer,
): Promise<{ kind: "cancelled" | "fulfilled"; spentTxid: string } | undefined> => {
    const offer = decodeOffer(hex.decode(record.offerHex));
    const { vtxos } = await indexer.getVtxos({ scripts: [record.swapPkScript] });
    const all = vtxos ?? [];
    const deposit =
        record.fundingTxid === undefined
            ? all.length === 1
                ? all[0]
                : undefined
            : all.find((vtxo) => vtxo.txid === record.fundingTxid);
    if (deposit === undefined) return undefined;
    const candidates = spendTxidsOf(deposit);
    if (candidates.length === 0) return undefined;
    // The id the record and history name, chosen as the watcher chooses it: the
    // ark tx when the indexer gave one, else the checkpoint.
    const spentTxid = deposit.arkTxId || deposit.spentBy;
    if (!spentTxid) return undefined;
    const { txs } = await indexer.getVirtualTxs(candidates);
    const parsed = txs
        .map((psbt) => {
            try {
                return Transaction.fromPSBT(base64.decode(psbt));
            } catch {
                return undefined;
            }
        })
        .filter((tx): tx is Transaction => tx !== undefined);
    // The operator key the covenant was built with, pinned off the record's
    // funded address — never the client's current one.
    const operatorPubkey = ArkAddress.decode(record.swapAddress).serverPubKey;
    const kind = classifyDepositSpend(offer, operatorPubkey, parsed, {
        txid: deposit.txid,
        vout: deposit.vout,
    });
    if (kind === "indeterminate") return undefined;
    return { kind, spentTxid };
};

const withStatus = (
    record: OfferSwapRecord,
    status: OfferSwapRecord["status"],
    now: number,
    extra: { spentTxid?: string; completedAt?: number } = {},
): OfferSwapRecord => ({
    ...record,
    status,
    ...(extra.spentTxid === undefined ? {} : { spentTxid: extra.spentTxid }),
    ...(extra.completedAt === undefined ? {} : { completedAt: extra.completedAt }),
    updatedAt: now,
});

/** A write the caller must not be failed by: the money has already moved.
 *
 * The drive ingests the settlement even when this write is lost, so a lost
 * write diverges the two: the drive reads settled while the store still reads
 * `cancelling`. In `auto`/`manual` mode the watcher classifies the landed
 * spend from chain and writes the terminal record, rectifying the gap in the
 * background; in `readonly` mode nothing re-reads the chain, so the gap lasts
 * until a new client instance restores. No fund loss either way — the
 * broadcast already happened — but a `readonly` UI restarts on the stale
 * status. */
const persistBestEffort = async (
    repository: AssetSwapRepository,
    record: OfferSwapRecord,
): Promise<{ persisted: boolean }> => {
    try {
        await repository.saveSwapRecord(record);
        return { persisted: true };
    } catch (error) {
        console.warn(`[swap] could not persist cancel for ${record.id}`, error);
        return { persisted: false };
    }
};

/** Retire this record's offer script once nothing at it still needs coverage —
 * the same liveness check the watcher applies, over the whole v2 record set.
 * Best-effort: the cancel is broadcast and recorded by the time this runs, so
 * a store read failure or a retire failure must not fail the caller — a script
 * left watched is recovered by the next restore scan. */
const retireOfferScripts = async (
    wallet: IWallet,
    repository: AssetSwapRepository,
    record: OfferSwapRecord,
): Promise<void> => {
    try {
        const { offer } = splitRecords(await repository.getAllSwapRecords());
        await retireOfferContract(
            await wallet.getContractManager(),
            offer.map(offerFactsOf),
            record.swapPkScript,
        );
    } catch (error) {
        console.warn(`[swap] could not retire offer script for ${record.id}`, error);
    }
};

const isMissingVtxo = (error: unknown): boolean => error instanceof NoSpendableDepositError;
