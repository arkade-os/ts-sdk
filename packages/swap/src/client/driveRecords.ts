/**
 * The seams between the v2 record store and v1's drive machinery.
 *
 * **The record bridge is the load-bearing one.** `RfqSwapManager` restores from `getRfqSwapsPage()`,
 * while `accept()` writes `saveSwapRecord` into a disjoint keyspace, so without this file the
 * manager's restore returns nothing for every v2-accepted swap. {@link CorridorSwapRecord} carries
 * every {@link RfqSwapRecord} field but the ignored display `amount`, which keeps the bridge cheap.
 *
 * - **The store is wired as the manager's `repository` dep**: `restoreFromRepository` opens with
 *   `requireRepository`, so leaving it unwired would mean a hand-rolled restore.
 * - **It carries an `rfqId -> QuoteId` index**: manager callbacks key on `rfqId`. Without it
 *   `arkadeRefunder` misses its record and throws `RefundNotLocallyPossibleError` — which the
 *   manager reads as PERMANENT — blocking every v2 send leg for its refund window with funds locked.
 * - **`removeRfqSwap` is inert**: `restoreFromRepository` runs `dropRetired` first, which would
 *   hard-delete v2 records under v1's thirty-day retention before `client.ready` resolves. v2
 *   retention is still undecided. The manager still drops its in-memory copy; the record survives.
 */
import {
    assertRfqSwapPageFilter,
    collectSwapRecords,
    type AssetSwapRepository,
} from "../repository";
import type { RfqSwapRecord } from "../rfqRecord";
import type { RfqSwapRecordStore } from "../swapManager";
import type { LockupSpendIndexer } from "../refund";
import { BTC_ASSET_ID, type AssetSwap, type AssetSwapStatus } from "../store";
import type { OfferSpendChanges, OfferSwapFacts, OfferSwapSource } from "../watch";
import { asset, assertPageRequest, pageResult, type IWallet } from "@arkade-os/sdk";
import { toAtomicDecimal } from "./amount";
import { arkadeAsset, btcOn, type AssetId, type NetworkRef } from "./assetId";
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

/** A v2 corridor record as the manager's own record type, minus the display `amount`
 * (`rebuildRfqSwap` reads none, and inventing one would record a number no request produced). */
export const rfqRecordOf = (record: CorridorSwapRecord): RfqSwapRecord => ({
    kind: record.kind,
    lockupAddress: record.lockupAddress,
    profile: record.profile,
    ...(record.fundingTxid === undefined ? {} : { fundingTxid: record.fundingTxid }),
    rfqId: record.rfqId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...mutableHalfOf(record),
});

/** The six optional manager-state fields, each only when present. */
const mutableHalfOf = (
    from: Pick<
        CorridorSwapRecord,
        | "refundTxid"
        | "lockupSpendTxids"
        | "settlementPreimageHex"
        | "failure"
        | "claimFailure"
        | "blockedReason"
    >,
) => ({
    ...(from.refundTxid === undefined ? {} : { refundTxid: from.refundTxid }),
    ...(from.lockupSpendTxids?.length ? { lockupSpendTxids: [...from.lockupSpendTxids] } : {}),
    ...(from.settlementPreimageHex === undefined
        ? {}
        : { settlementPreimageHex: from.settlementPreimageHex }),
    ...(from.failure === undefined ? {} : { failure: from.failure }),
    ...(from.claimFailure === undefined ? {} : { claimFailure: from.claimFailure }),
    ...(from.blockedReason === undefined ? {} : { blockedReason: from.blockedReason }),
});

/**
 * The manager's mutable half, written back onto the v2 record. REPLACED, not merged (as
 * `updateRfqSwapRecord` does): the manager clears `blockedReason`/`claimFailure`, and a spread could
 * never clear them, leaving a stale refusal reading as live. The origin half, `fundingTxid`
 * included, is carried through untouched — the manager never learns it.
 */
export const withRfqState = (
    record: CorridorSwapRecord,
    state: RfqSwapRecord,
): CorridorSwapRecord => {
    const {
        refundTxid: _refundTxid,
        lockupSpendTxids: _lockupSpendTxids,
        settlementPreimageHex: _settlementPreimageHex,
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
        ...mutableHalfOf(state),
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
 * The v2 record store, as the manager's `repository` dep. Every read goes to the repository (the
 * system of record), so a consumer's edit is never overwritten by a boot-time copy. Only the index
 * is in memory; a miss costs one scan, never a wrong answer.
 */
export const corridorRecordStore = (
    repository: AssetSwapRepository,
    onRecord: RecordSink = () => {},
    /**
     * Which stored records the restore may hand to the manager. Two cases:
     * - an `arkade -> onchain` record on a client whose chain source was refused — the manager would
     *   fail it TERMINALLY on its first pass; excluded, it stays durable, undriven and self-reporting;
     * - a terminal record, which the manager would rebuild only to file as finished (a covenant
     *   derivation and row lookup for nothing). It stays readable in the drive's registry.
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
        // The index is process-local: a swap handed to the manager directly, or written by another
        // client on the same store, needs the scan — a miss would make `arkadeRefunder` report a
        // permanent refusal on a refundable swap.
        const { corridor } = splitRecords(await collectSwapRecords(repository));
        for (const record of corridor) index(record);
        const found = byRfqId.get(rfqId);
        return found === undefined ? undefined : corridor.find((r) => r.id === found);
    };

    return {
        index,
        quoteIdOf: (rfqId) => byRfqId.get(rfqId),

        async getRfqSwapsPage(filter, page) {
            assertPageRequest(page);
            assertRfqSwapPageFilter(filter);
            const { corridor } = splitRecords(await collectSwapRecords(repository));
            // indexed before the filter: an excluded record must stay findable by `rfqId`
            for (const record of corridor) index(record);
            const rows = corridor
                .filter(admits)
                .map(rfqRecordOf)
                .filter(
                    (record) =>
                        (filter.state === undefined || record.state === filter.state) &&
                        (filter.since === undefined || record.updatedAt >= filter.since) &&
                        (!page.after ||
                            record.updatedAt > page.after.updatedAt ||
                            (record.updatedAt === page.after.updatedAt &&
                                record.rfqId > page.after.rfqId)),
                )
                .sort(
                    (a, b) =>
                        a.updatedAt - b.updatedAt ||
                        (a.rfqId < b.rfqId ? -1 : a.rfqId > b.rfqId ? 1 : 0),
                )
                .slice(0, page.limit + 1);
            return pageResult(rows, page.limit, (record) => ({
                updatedAt: record.updatedAt,
                rfqId: record.rfqId,
            }));
        },

        async getRfqSwap(rfqId) {
            const record = await recordFor(rfqId);
            return record === undefined ? undefined : rfqRecordOf(record);
        },

        async saveRfqSwap(state) {
            const record = await recordFor(state.rfqId);
            if (record === undefined) {
                // refused rather than invented: the manager's record has no route, market or
                // obligations, so a synthesised record would be a swap with no terms
                throw new Error(
                    `no v2 swap record for rfq ${state.rfqId}; the drive cannot write its state`,
                );
            }
            const updated = withRfqState(record, state);
            await repository.saveSwapRecord(updated);
            onRecord(updated);
        },

        async removeRfqSwap() {
            // Inert by design — see the module doc.
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
    // milliseconds: `coverage.ts` compares against `Date.now()`, and seconds would leave every
    // issued script outstanding for the life of the process
    createdAt: record.createdAt * 1000,
});

/** The v2 offer half of the record store, as the watcher's source. */
export const offerRecordSource = (
    repository: AssetSwapRepository,
    onRecord: RecordSink = () => {},
    now: () => number = () => Math.floor(Date.now() / 1000),
): OfferSwapSource<OfferSwapFacts & { id: QuoteId }> => {
    const list = async () => {
        const { offer } = splitRecords(await collectSwapRecords(repository));
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
                // patched rather than re-read: the retirement liveness check must see the NEW
                // status, and a re-read would race the write
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
    // event timestamps are milliseconds; this record's are unix seconds
    ...(changes.completedAt === undefined
        ? {}
        : { completedAt: Math.floor(changes.completedAt / 1000) }),
    updatedAt: now,
});

/** What the restore scan learned about one deposit. */
export interface DepositFate {
    readonly status: AssetSwapStatus;
    readonly spentTxid?: string;
    /** Unix milliseconds, as `AssetSwap` carries it. */
    readonly completedAt?: number;
}

/** A deposit's fate written onto its record. The spend too: the watcher only
 * writes a spend it saw, and it sees nothing between two clients. */
export const withDepositFate = (
    record: OfferSwapRecord,
    fate: DepositFate,
    now: number,
): OfferSwapRecord => ({
    ...record,
    status: fate.status,
    ...(fate.spentTxid === undefined ? {} : { spentTxid: fate.spentTxid }),
    ...(fate.completedAt === undefined ? {} : { completedAt: Math.floor(fate.completedAt / 1000) }),
    updatedAt: now,
});

/** Whether the fate says anything the record does not; the write it gates re-emits the swap. */
export const fateMoved = (record: OfferSwapRecord, fate: DepositFate): boolean =>
    record.status !== fate.status ||
    (fate.spentTxid !== undefined && record.spentTxid !== fate.spentTxid) ||
    (fate.completedAt !== undefined && record.completedAt !== Math.floor(fate.completedAt / 1000));

/**
 * An offer record for a deposit the restore scan found and no record claims. Keyed on the funding
 * txid so a re-scan updates rather than duplicates. The chain lacks the market, solver, spread and
 * deadline, hence `market.kind: "restored"` and a zero fee.
 */
export const restoredOfferRecord = (
    swap: AssetSwap,
    network: NetworkRef,
    now: number,
): OfferSwapRecord => {
    const give = restoredAssetId(network, swap.fromAsset);
    const take = restoredAssetId(network, swap.toAsset);
    const createdAt = Math.floor(swap.createdAt / 1000);
    return withDepositFate(
        {
            id: swap.fundingTxid,
            family: "offer",
            route: {
                give: { corridor: "arkade", asset: give, instrument: { kind: "wallet" } },
                take: { corridor: "arkade", asset: take, instrument: { kind: "wallet" } },
            },
            give: { asset: give, amount: toAtomicDecimal(BigInt(swap.fromAmount)) },
            take: { asset: take, amount: toAtomicDecimal(BigInt(swap.toAmount)) },
            fee: { asset: take, amount: toAtomicDecimal(0n) },
            market: { kind: "restored", backend: "feed" },
            expiresAt: createdAt,
            status: swap.status,
            offerHex: swap.offerHex,
            swapAddress: swap.swapAddress,
            swapPkScript: swap.swapPkScript,
            fundingTxid: swap.fundingTxid,
            createdAt,
            updatedAt: now,
        },
        swap,
        now,
    );
};

/** v1's asset spelling — `btc`, or the 68-hex identity — as an arkade id. */
const restoredAssetId = (network: NetworkRef, id: string): AssetId<"arkade"> =>
    id === BTC_ASSET_ID
        ? btcOn("arkade", network)
        : arkadeAsset(network, asset.AssetId.fromString(id));

/**
 * The wallet's own reader, as the manager's required observation seam. The reader reads NAMED
 * foreign scripts and has no "own wallet" default, so a call with neither scripts nor outpoints is a
 * caller bug. Built from the wallet (the client takes no server URL or provider); the drive still
 * takes it as an input so unit tests can double it.
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
