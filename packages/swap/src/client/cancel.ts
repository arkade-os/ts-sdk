/**
 * `cancel()`: the one value-moving call the client makes inside an awaited
 * method, not through the drive loop.
 *
 * Cancel is a 2-of-2 of user and server (§3.3), so an unfilled offer's exit needs no solver.
 * Corridor swaps have phases instead and answer {@link NotCancellable} on the tag parse.
 *
 * **The fill race resolves by reading the spend.** When the fill won, `cancelOffer` throws "no
 * spendable VTXO"; this reconciles as the watcher does (`spendTxidsOf`, `getVirtualTxs`,
 * `classifyDepositSpend`) and answers `cancelled` | `filled` | `needs_recovery`. An indeterminate
 * spend is `needs_recovery`, not a throw: value has already moved (§7).
 *
 * **Ordering:** strict read, `cancelling` write gating the broadcast, broadcast, best-effort
 * `cancelled` + `spentTxid`, retire only if that persisted; `onUpdate` fires at both edges so a
 * mid-call crash can't leave a silent `cancelling`. The drive keeps `cancelling` live, and a
 * `cancelling` record with an intact deposit is resumed by a second `cancel()`.
 * ponytail(arkade-os/ts-sdk#930): construction restore writes that unspent deposit as `pending`
 * (chain fate, not the gate); `cancel()` retries from pending the same way. Arkade txs land in
 * <500ms, so the in-between is not a durable status.
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
import { collectSwapRecords, type AssetSwapRepository } from "../repository";
import type { LockupSpendIndexer } from "../refund";
import type { SwapDrive } from "./drive";
import { offerFactsOf, splitRecords } from "./driveRecords";
import type { OfferSwapRecord } from "./record";

/** What `cancel()` did to the deposit. An `indeterminate` spend is `needs_recovery`: value moved
 * and the local rebuild cannot name how. */
export type CancelOutcome = "cancelled" | "filled" | "needs_recovery";

export interface CancelInput {
    readonly wallet: IWallet;
    readonly repository: AssetSwapRepository;
    /** The record to cancel, read by the caller after `drive.ready` — the one
     * read the call makes, and what the gate is written from. */
    readonly record: OfferSwapRecord;
    /** The delivery channel both edges emit through, armed or not. */
    readonly drive: SwapDrive;
    readonly indexer: LockupSpendIndexer;
    /** Unix seconds. Injected for tests. */
    readonly now?: () => number;
}

/**
 * Cancel one offer swap, reconciling the fill race and writing the v2 record.
 *
 * The caller has already made the strict read (an unreadable repository must not read as "no
 * record" and send a cancel past its gate) and refused corridor tags and missing records as
 * `NotCancellable`.
 */
export const cancelSwap = async (input: CancelInput): Promise<{ outcome: CancelOutcome }> => {
    const { wallet, repository, record, drive, indexer } = input;
    const now = input.now ?? (() => Math.floor(Date.now() / 1000));

    // Already terminal: answer from the record, never re-broadcast. `needs_recovery` left the
    // covenant by a route no offchain spend can reach; `client.recover` drives it.
    const outcome = offerOutcome(record.status);
    if (outcome === "cancelled" || outcome === "filled" || outcome === "needs_recovery") {
        return { outcome };
    }

    // The gate, written BEFORE the broadcast, and allowed to throw: a failed write must not be
    // broadcast past. On a resumed `cancelling` record this rewrites an identical marker.
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
            // Pre-broadcast and non-retryable (rotated operator key, wrong swapAddress, corrupt
            // record): roll the gate back rather than strand a `cancelling` no retry can pass.
            // Best-effort, so a lost rollback can't mask the mismatch.
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
        if (error instanceof NoSpendableDepositError) {
            // The fill won the race: reconcile the spend rather than throw.
            const reconciled = await reconcileDepositSpend(record, indexer);
            if (reconciled === undefined) {
                // No terminal write on a guess: stays `cancelling`, for `client.recover`.
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

    const txid = await prepared.send();

    // Past the point of no return: a lost write must not fail the caller; the watcher and the
    // restore scan re-derive the outcome.
    const settled = withStatus(gated, "cancelled", now(), { spentTxid: txid });
    const { persisted } = await persistBestEffort(repository, settled);
    drive.ingest(settled);
    if (persisted) {
        // Only on a persisted write: a record that still reads `cancelling` must stay watched.
        await retireOfferScripts(wallet, repository, settled);
    }
    return { outcome: "cancelled" };
};

/** The deposit's spend, classified the way the watcher classifies it, against the covenant's own
 * leaves. `undefined` is indeterminate (deposit invisible, or spend took neither leaf) and must
 * never be written down as terminal. */
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
    // As the watcher chooses: the ark tx when the indexer gave one, else the checkpoint.
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
    // Pinned off the record's funded address — never the client's current operator key.
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
 * A lost write leaves the drive settled and the store `cancelling`. In `auto`/`manual` the watcher
 * rewrites it from chain; in `readonly` the gap lasts until the next restore. No fund loss either
 * way, but a `readonly` UI restarts on the stale status. */
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

/** Retire this record's offer script once nothing at it still needs coverage (the watcher's
 * liveness check over all v2 records). Best-effort: a script left watched is recovered by the next
 * restore scan. */
const retireOfferScripts = async (
    wallet: IWallet,
    repository: AssetSwapRepository,
    record: OfferSwapRecord,
): Promise<void> => {
    try {
        const { offer } = splitRecords(await collectSwapRecords(repository));
        await retireOfferContract(
            await wallet.getContractManager(),
            offer.map(offerFactsOf),
            record.swapPkScript,
        );
    } catch (error) {
        console.warn(`[swap] could not retire offer script for ${record.id}`, error);
    }
};
