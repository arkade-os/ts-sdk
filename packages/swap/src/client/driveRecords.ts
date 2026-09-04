/**
 * The three seams between the v2 record store and v1's drive machinery.
 *
 * **The record bridge is the load-bearing one.** `RfqSwapManager` restores from
 * `getAllRfqSwaps()`, while `accept()` writes `saveSwapRecord` into a keyspace
 * `repository.ts` rules disjoint from it by design. So without this file the
 * manager's restore-read returns nothing for every v2-accepted swap, and the
 * whole drive — `ready`, arm-on-live-work, the outcome projections, recovery —
 * rests on an empty set.
 *
 * The bridge is cheap because M4 designed the record to admit it:
 * {@link CorridorSwapRecord} carries every {@link RfqSwapRecord} field but the
 * optional display `amount` the rebuild ignores, and `RfqSwapRecordStore` is a
 * four-method structural seam. Three rulings come with it.
 *
 * - **The store is wired as the manager's `repository` dep**, not left unwired.
 *   `restoreFromRepository` opens with `requireRepository`, so the unwired
 *   branch costs a hand-rolled restore rather than a storage-shape choice.
 * - **It carries an `rfqId -> QuoteId` index**, because the manager keys every
 *   callback on `rfqId` while the v2 store keys on `QuoteId`. Without it
 *   `arkadeRefunder` misses its record and throws
 *   `RefundNotLocallyPossibleError` — the one refusal the manager reads as
 *   PERMANENT — leaving every v2 send leg blocked for its whole refund window
 *   with the lockup funded.
 * - **`removeRfqSwap` is inert.** `restoreFromRepository` runs `dropRetired`
 *   before the rebuild, which would hard-delete v2 records under v1's
 *   thirty-day retention before `client.ready` resolves. v2 retention is M6's
 *   open question, and settling it here by side effect is not M5's to do. The
 *   manager still drops its in-memory copies, so an aged terminal record is not
 *   rebuilt; the record itself survives.
 */
import type { AssetSwapRepository } from "../repository";
import type { RfqSwapRecord } from "../rfqRecord";
import type { RfqSwapRecordStore } from "../swapManager";
import type { LockupSpendIndexer } from "../refund";
import type { AssetSwapStatus } from "../store";
import type { OfferSpendChanges, OfferSwapFacts, OfferSwapSource } from "../watch";
import type { IWallet } from "@arkade-os/sdk";
import type { QuoteId } from "./quote";
import type { CorridorSwapRecord, OfferSwapRecord, SwapRecord } from "./record";

/** Every stored corridor record, and every offer record, in one read. */
export const splitRecords = (
    records: readonly SwapRecord[],
): { corridor: CorridorSwapRecord[]; offer: OfferSwapRecord[] } => {
    const corridor: CorridorSwapRecord[] = [];
    const offer: OfferSwapRecord[] = [];
    for (const record of records) {
        if (record.family === "rfq") corridor.push(record);
        else offer.push(record);
    }
    return { corridor, offer };
};

/**
 * A v2 corridor record as the manager's own record type.
 *
 * Field for field, minus the display `amount` — `rebuildRfqSwap` reads none of
 * it, and inventing one would put a number on the record that no request result
 * produced.
 */
export const rfqRecordOf = (record: CorridorSwapRecord): RfqSwapRecord => ({
    kind: record.kind,
    lockupAddress: record.lockupAddress,
    profile: record.profile,
    ...(record.fundingTxid === undefined ? {} : { fundingTxid: record.fundingTxid }),
    rfqId: record.rfqId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.refundTxid === undefined ? {} : { refundTxid: record.refundTxid }),
    ...(record.lockupSpendTxids?.length ? { lockupSpendTxids: [...record.lockupSpendTxids] } : {}),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.claimFailure === undefined ? {} : { claimFailure: record.claimFailure }),
    ...(record.blockedReason === undefined ? {} : { blockedReason: record.blockedReason }),
});

/**
 * The manager's mutable half, written back onto the v2 record.
 *
 * REPLACED, not merged, exactly as `updateRfqSwapRecord` replaces it: the
 * manager clears `blockedReason` when a swap leaves `needs_counterparty` and
 * `claimFailure` when it becomes terminal, and a spread would only ever set
 * these fields, never clear them — leaving a stale refusal reading as a live
 * one. The origin half is carried through untouched, `fundingTxid` included:
 * the manager never learns it, so it can only be the accept path's.
 */
export const withRfqState = (
    record: CorridorSwapRecord,
    state: RfqSwapRecord,
): CorridorSwapRecord => {
    const {
        refundTxid: _refundTxid,
        lockupSpendTxids: _lockupSpendTxids,
        failure: _failure,
        claimFailure: _claimFailure,
        blockedReason: _blockedReason,
        ...origin
    } = record;
    return {
        ...origin,
        state: state.state,
        profile: state.profile,
        updatedAt: state.updatedAt,
        ...(state.refundTxid === undefined ? {} : { refundTxid: state.refundTxid }),
        ...(state.lockupSpendTxids?.length
            ? { lockupSpendTxids: [...state.lockupSpendTxids] }
            : {}),
        ...(state.failure === undefined ? {} : { failure: state.failure }),
        ...(state.claimFailure === undefined ? {} : { claimFailure: state.claimFailure }),
        ...(state.blockedReason === undefined ? {} : { blockedReason: state.blockedReason }),
    };
};

/** What a bridge or source hands back to the drive after a write. */
export type RecordSink = (record: SwapRecord) => void;

export interface CorridorRecordStore extends RfqSwapRecordStore {
    /** Remember which quote id an `rfqId` belongs to, so a callback keyed on
     * the manager's id can find the v2 record. Called at restore and at admit. */
    index(record: CorridorSwapRecord): void;
    /** The quote id for a manager-side `rfqId`, if this store has seen it. */
    quoteIdOf(rfqId: string): QuoteId | undefined;
}

/**
 * The v2 record store, as the manager's `repository` dep.
 *
 * Every read goes to the repository rather than to a cache: the store is the
 * system of record, and the manager's own read-then-write per pass exists so a
 * consumer's edit is not overwritten by a copy taken at boot. The index is the
 * only thing held in memory, and it is a pure lookup — a miss costs one full
 * scan and never a wrong answer.
 */
export const corridorRecordStore = (
    repository: AssetSwapRepository,
    onRecord: RecordSink = () => {},
    /**
     * Which stored records the restore may hand to the manager.
     *
     * The filter exists for two cases. An `arkade -> onchain` record on a client
     * whose chain source was refused: `restoreFromRepository` restores
     * everything it reads, and the manager fails an onchain-send swap
     * TERMINALLY on its first pass without a `ChainSource` — a deliberate
     * refusal to watch that corridor blind. Excluding the record here leaves it
     * durable, undriven and reporting off itself, which is the honest answer to
     * "this client cannot drive this swap".
     *
     * And a record in a terminal state, which the drive excludes: the manager
     * would rebuild it only to file it in `finished`, so handing it over pays
     * a covenant derivation and a contract row lookup per record for nothing.
     * The record itself stays readable — it is still in the drive's registry
     * and still answers off its own stored state.
     */
    admits: (record: CorridorSwapRecord) => boolean = () => true,
): CorridorRecordStore => {
    const byRfqId = new Map<string, QuoteId>();

    const index = (record: CorridorSwapRecord): void => {
        byRfqId.set(record.rfqId, record.id);
    };

    /** The v2 record behind a manager-side `rfqId`, index miss included. */
    const recordFor = async (rfqId: string): Promise<CorridorSwapRecord | undefined> => {
        const known = byRfqId.get(rfqId);
        if (known !== undefined) {
            const record = await repository.getSwapRecord(known);
            if (record?.family === "rfq") return record;
        }
        // The index is process-local and the manager can be handed a swap this
        // process never restored or admitted — a consumer calling `addSwap`
        // directly, or a record written by another client on the same store.
        // One scan is the honest answer; a miss here is what would make
        // `arkadeRefunder` report a permanent refusal on a refundable swap.
        const { corridor } = splitRecords(await repository.getAllSwapRecords());
        for (const record of corridor) index(record);
        const found = byRfqId.get(rfqId);
        return found === undefined ? undefined : corridor.find((r) => r.id === found);
    };

    return {
        index,
        quoteIdOf: (rfqId) => byRfqId.get(rfqId),

        async getAllRfqSwaps() {
            const { corridor } = splitRecords(await repository.getAllSwapRecords());
            // Indexed before the filter: an excluded record still has to be
            // findable by `rfqId`, because a consumer may hand its swap to the
            // manager directly.
            for (const record of corridor) index(record);
            return corridor.filter(admits).map(rfqRecordOf);
        },

        async getRfqSwap(rfqId) {
            const record = await recordFor(rfqId);
            return record === undefined ? undefined : rfqRecordOf(record);
        },

        async saveRfqSwap(state) {
            const record = await recordFor(state.rfqId);
            if (record === undefined) {
                // Refused rather than invented. The v2 record carries the route,
                // the market and the obligations, none of which the manager's
                // record has — so there is nothing to create one from, and a
                // synthesised record would be a swap with no terms.
                throw new Error(
                    `no v2 swap record for rfq ${state.rfqId}; the drive cannot write its state`,
                );
            }
            const updated = withRfqState(record, state);
            await repository.saveSwapRecord(updated);
            onRecord(updated);
        },

        async removeRfqSwap() {
            // Inert by ruling — see the module doc. The manager's own in-memory
            // drop still happens, so an aged terminal record stops being
            // rebuilt; what does not happen is a v1 retention window deleting a
            // v2 record before `client.ready` resolves.
        },
    };
};

/** A v2 offer record as the watcher and coverage read one. */
export const offerFactsOf = (record: OfferSwapRecord): OfferSwapFacts & { id: QuoteId } => ({
    id: record.id,
    status: record.status,
    offerHex: record.offerHex,
    swapPkScript: record.swapPkScript,
    ...(record.fundingTxid === undefined ? {} : { fundingTxid: record.fundingTxid }),
    ...(record.spentTxid === undefined ? {} : { spentTxid: record.spentTxid }),
    // Milliseconds: `coverage.ts` marks issuance with `Date.now()`, and a
    // seconds value compared against it leaves every issued script outstanding
    // for the life of the process.
    createdAt: record.createdAt * 1000,
});

/** The v2 offer half of the record store, as the watcher's source. */
export const offerRecordSource = (
    repository: AssetSwapRepository,
    onRecord: RecordSink = () => {},
    now: () => number = () => Math.floor(Date.now() / 1000),
): OfferSwapSource<OfferSwapFacts & { id: QuoteId }> => {
    const list = async () => {
        const { offer } = splitRecords(await repository.getAllSwapRecords());
        return offer.map(offerFactsOf);
    };
    return {
        list,
        async apply(swap, changes) {
            const stored = await repository.getSwapRecord(swap.id);
            if (stored === undefined || stored.family !== "offer") {
                return { persisted: false, swaps: await list() };
            }
            const updated = applyOfferSpend(stored, changes, now());
            try {
                await repository.saveSwapRecord(updated);
                onRecord(updated);
                // The post-update view, without a third read: the liveness
                // check that decides retirement has to see this record's NEW
                // status, and re-reading would race the write it just made.
                const swaps = (await list()).map((s) =>
                    s.id === updated.id ? offerFactsOf(updated) : s,
                );
                return { persisted: true, swaps };
            } catch (error) {
                console.warn(`[swap] failed to persist offer spend for ${swap.id}`, error);
                return { persisted: false, swaps: await list() };
            }
        },
    };
};

/** One classified spend, written onto a v2 offer record. */
export const applyOfferSpend = (
    record: OfferSwapRecord,
    changes: OfferSpendChanges,
    now: number,
): OfferSwapRecord => ({
    ...record,
    status: changes.status,
    spentTxid: changes.spentTxid,
    // The watcher's `completedAt` comes off a contract event's timestamp, in
    // milliseconds; this record's timestamps are unix seconds.
    ...(changes.completedAt === undefined
        ? {}
        : { completedAt: Math.floor(changes.completedAt / 1000) }),
    updatedAt: now,
});

/** A restored deposit's status, written onto a v2 offer record. */
export const withOfferStatus = (
    record: OfferSwapRecord,
    status: AssetSwapStatus,
    now: number,
): OfferSwapRecord => ({ ...record, status, updatedAt: now });

/**
 * The wallet's own reader, as the manager's one required observation seam.
 *
 * Lifted from the v1 facade unchanged, guard included: the reader reads for
 * NAMED foreign scripts and has no "the wallet's own" default, so a call with
 * neither scripts nor outpoints is a caller bug rather than a query. Built from
 * the wallet rather than injected on `SwapClientConfig`, because the wallet is
 * where every other connection in this client comes from — a client takes no
 * server URL and no provider. The drive layer still takes it as an input, which
 * is what lets a unit test double one without a wallet behind it.
 */
export const walletLockupIndexer = (wallet: IWallet): LockupSpendIndexer => {
    let reader: Promise<Awaited<ReturnType<IWallet["getArkadeReader"]>>> | undefined;
    const reading = () => (reader ??= wallet.getArkadeReader());
    return {
        getVtxos: async (opts) => {
            if (!opts) {
                throw new Error("getVtxos on the swap indexer requires scripts or outpoints");
            }
            return (await reading()).getVtxos(opts);
        },
        getVirtualTxs: async (...args) => (await reading()).getVirtualTxs(...args),
    };
};
