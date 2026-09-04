import {
    ArkAddress,
    type ActivityResolver,
    type ArkTransaction,
    type GroupMembership,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { isRfqSwapTerminal, type RfqSwapState } from "./swapManager";
import { ACTIVITY_TOKEN, corridorOutcome } from "./client/outcome";
import type { LockupSpendIndexer } from "./refund";
import { rfqCorridorHandlers } from "./rfqCorridor";
// Side-effecting, as in `rfqRecord.ts`: the handlers this reads register
// themselves on import, and nothing here should rely on another module having
// pulled them in first.
import "./rfqCorridors";
import type { AssetSwapRepository } from "./repository";
import { normalizeRfqSwapRecord, type RfqSwapRecord } from "./rfqRecord";

/**
 * One swap, flattened to what grouping needs: an identity, a corridor, an
 * outcome, and every Arkade transaction that belongs to it.
 *
 * Deliberately not a stored swap record itself — resolution should stay
 * testable with plain data rather than a repository. {@link rfqSwapActivityInputs}
 * derives these from the record store and, where a record cannot answer, the
 * funding lockup's VTXOs.
 */
export interface SwapActivityInput {
    rfqId: string;
    kind: RfqSwapRecord["kind"];
    state: RfqSwapState;
    /** Funding, claim and refund txids, in whatever order. */
    txids: readonly string[];
}

/** Corridor labels, keyed so a new kind is a compile error rather than a blank row. */
const LABELS: Record<SwapActivityInput["kind"], string> = {
    lightning_send: "Lightning send",
    lightning_receive: "Lightning receive",
    onchain_send: "Onchain send",
};

/**
 * How a swap reads as an activity token — a PROJECTION of the client's
 * {@link Outcome}, not a second table.
 *
 * This file used to key a `Record<RfqSwapState, string>` off the raw state and
 * handle `lightning_receive` + `refunded` beside it, by hand, because the raw
 * state alone cannot tell a send leg's refund (the money coming back) from a
 * receive leg's (the incoming payment never arriving). The client's outcome
 * vocabulary already draws that line — `refunded` against `lapsed` — and
 * already keys on the corridor kind, so the special case disappears rather than
 * being restated: `lostReceive` is what `lapsed` projects to.
 *
 * Exhaustiveness is stronger than before, and in both directions: the
 * translation is total over `RfqSwapState` × lockup owner, and
 * {@link ACTIVITY_TOKEN} is total over `Outcome`, so a new protocol state or a
 * new outcome is a compile error rather than a blank row.
 */
const outcomeToken = (kind: SwapActivityInput["kind"], state: RfqSwapState): string =>
    ACTIVITY_TOKEN[corridorOutcome(kind, state)];

/**
 * Group each RFQ swap's transactions into one activity carrying its outcome.
 *
 * Without this a failed swap renders as two unrelated rows: the send that
 * funded the lockup, and the receive when the covenant refunds. Grouping by
 * `rfqId` collapses them into one activity, and the amount comes out correct
 * by netting, not by `buildActivities`'s same-key change exclusion — that
 * rule only fires when one txid is both sent and received, and funding and
 * refund are different txids. Summing the signed amounts
 * (`-funding + refund ≈ -fees`) is what does the work here.
 *
 * `prepare` loads once and `resolve` stays pure and synchronous, as the SDK's
 * `ActivityResolver` contract requires.
 */
export function swapActivityResolver(deps: {
    listSwaps(): Promise<readonly SwapActivityInput[]>;
}): ActivityResolver {
    let byTxid = new Map<string, SwapActivityInput>();

    return {
        id: "arkade:swap",
        async prepare() {
            const swaps = await deps.listSwaps();
            const index = new Map<string, SwapActivityInput>();
            for (const swap of swaps) {
                for (const txid of swap.txids) {
                    if (txid) index.set(txid, swap);
                }
            }
            byTxid = index;
        },
        resolve(tx: ArkTransaction): GroupMembership[] | undefined {
            const key = tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid;
            const swap = key ? byTxid.get(key) : undefined;
            if (!swap) return undefined;
            return [
                {
                    groupId: `swap:${swap.rfqId}`,
                    label: LABELS[swap.kind],
                    kind: "swap",
                    // `"lost"` for a receive leg that ended `refunded` comes out
                    // of the translation rather than out of a branch here: that
                    // leg has no trader-side refund, every non-claim leaf of its
                    // covenant is the solver's, and the client's `lapsed` is
                    // that fact.
                    outcome: outcomeToken(swap.kind, swap.state),
                    metadata: { rfqId: swap.rfqId, swapKind: swap.kind },
                },
            ];
        },
    };
}

export interface RfqSwapActivityDeps {
    repository: Pick<AssetSwapRepository, "getAllRfqSwaps">;
    /**
     * Consulted only for what a record cannot answer: a record written before
     * `fundingTxid` existed, and the counterparty's spend on a swap that
     * ended without a refund of ours.
     *
     * Optional because the stored fields are the primary source — cheaper, and
     * they work offline, which is the resolver's whole posture. An indexer that
     * throws costs that record its extra txids and nothing else.
     */
    indexer?: LockupSpendIndexer;
}

/**
 * Every stored RFQ swap, flattened into what {@link swapActivityResolver}
 * groups on.
 *
 * The txids come from four places, in order of preference: the record's own
 * `fundingTxid` and `refundTxid`, the corridor's `activityTxids` (the
 * receive leg's Arkade claim, the onchain leg's L1 one), and — only when the
 * first two cannot answer — one read of the lockup's VTXOs.
 *
 * A missing txid costs an activity a row, never a wrong one: a swap that
 * contributes fewer txids simply leaves those transactions ungrouped, which is
 * what they already are.
 */
export async function rfqSwapActivityInputs(
    deps: RfqSwapActivityDeps,
): Promise<SwapActivityInput[]> {
    const records = await deps.repository.getAllRfqSwaps();
    return Promise.all(records.map((record) => activityInputOf(record, deps.indexer)));
}

async function activityInputOf(
    stored: RfqSwapRecord,
    indexer?: LockupSpendIndexer,
): Promise<SwapActivityInput> {
    // Reads straight off the repository, so a record written before the txid
    // fields were renamed reaches this untouched by the manager.
    const record = normalizeRfqSwapRecord(stored);
    const txids = new Set<string>();
    if (record.fundingTxid) txids.add(record.fundingTxid);
    if (record.refundTxid) txids.add(record.refundTxid);
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    for (const txid of handler.activityTxids?.(record.profile) ?? []) txids.add(txid);
    // The manager stamps these from the chain read that ended the swap, which
    // is why this field exists at all: without it the counterparty's spend
    // costs a lockup read per terminal swap, on the path least able to afford
    // one. Drained before the fallback below, so a record that already knows
    // never reaches the network.
    for (const txid of record.lockupSpendTxids ?? []) txids.add(txid);

    // The counterparty's spend is what ended a swap the trader did not refund
    // itself — a solver claim on a send leg, a solver reclaim on a receive one.
    // Unknown only when neither the trader's own refund nor the manager's stamp
    // names it.
    const spendUnknown =
        isRfqSwapTerminal(record.state) && !record.refundTxid && !record.lockupSpendTxids?.length;
    if (indexer && (!record.fundingTxid || spendUnknown)) {
        for (const txid of await lockupTxids(indexer, record, !record.fundingTxid)) {
            txids.add(txid);
        }
    }

    return { rfqId: record.rfqId, kind: record.kind, state: record.state, txids: [...txids] };
}

/** One read of everything at the lockup: the transactions that funded it, and
 * the ark transactions that spent it. Ask-the-indexer, don't-trust-local-state
 * — the same posture `readLockupFate` establishes, and the same seam. */
async function lockupTxids(
    indexer: LockupSpendIndexer,
    record: RfqSwapRecord,
    wantFunding: boolean,
): Promise<string[]> {
    let script: string;
    try {
        script = hex.encode(ArkAddress.decode(record.lockupAddress).pkScript);
    } catch {
        return []; // an address that will not decode names no lockup to read
    }
    try {
        const { vtxos } = await indexer.getVtxos({ scripts: [script] });
        const out: string[] = [];
        for (const vtxo of vtxos ?? []) {
            // The transaction that CREATED the output is the funding.
            if (wantFunding) out.push(vtxo.txid);
            // `spentBy` names the checkpoint; `arkTxId` names the ark
            // transaction, which is the one history carries.
            if (vtxo.arkTxId) out.push(vtxo.arkTxId);
        }
        return out;
    } catch {
        // Offline-first: fewer txids, never a throw that sinks every other
        // record's activity along with this one's.
        return [];
    }
}
