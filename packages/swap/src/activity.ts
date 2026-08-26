import {
    ArkAddress,
    type ActivityResolver,
    type ArkTransaction,
    type GroupMembership,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { isRfqSwapTerminal, type RfqSwapState } from "./swapManager";
import type { LockupSpendIndexer } from "./refund";
import { rfqCorridorHandlers } from "./rfqCorridor";
// Side-effecting, as in `rfqRecord.ts`: the type-only import below erases, so
// nothing else here would register the handlers this reads.
import "./rfqCorridors";
import type { AssetSwapRepository } from "./repository";
import type { RfqSwapRecord } from "./rfqRecord";

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
 * How a swap state reads as an outcome token, keyed exhaustively off
 * `RfqSwapState` so a state added upstream is a compile error here rather
 * than silently rendering as something misleading. Opaque lowercase machine
 * tokens, not display text — see `ActivityIntent.outcome`.
 *
 * `lightning_receive` + `refunded` is handled separately in `resolve`: it
 * does not read off this table.
 */
const OUTCOME: Record<RfqSwapState, string> = {
    pending: "pending",
    // `claimable` and `claimed` are both in-progress states with no
    // user-visible phase distinct from "pending". `needs_counterparty` is
    // different in kind — the swap is BLOCKED, not merely in flight, since no
    // unilateral trader move exists (see `RfqSwapState`). Collapsing it into
    // `pending` here is a deliberate choice the opaque-token design permits —
    // apps map tokens themselves — but a future reader weighing a `"blocked"`
    // or `"stuck"` token should know this was already considered.
    claimable: "pending",
    claimed: "pending",
    needs_counterparty: "pending",
    settled: "settled",
    refunded: "refunded",
    failed: "failed",
};

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
            // A `lightning_receive` that ends `refunded` is a LOSS, not money
            // returned: that leg has no trader-side refund, every non-claim leaf
            // of the covenant is the solver's, and a swap ending here is one
            // whose incoming payment never arrived (see `RfqSwapState`'s
            // `refunded` case in swapManager.ts). A send leg's `refunded` is the
            // opposite — the lockup coming back — so the two need distinct
            // tokens; `lostReceive` is this package's own name for the case (see
            // the `lostReceive` local in `outcomeOf`, swapManager.ts).
            const lostReceive = swap.kind === "lightning_receive" && swap.state === "refunded";
            return [
                {
                    groupId: `swap:${swap.rfqId}`,
                    label: LABELS[swap.kind],
                    kind: "swap",
                    outcome: lostReceive ? "lost" : OUTCOME[swap.state],
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
    record: RfqSwapRecord,
    indexer?: LockupSpendIndexer,
): Promise<SwapActivityInput> {
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
        isRfqSwapTerminal(record.state) &&
        !record.refundTxid &&
        !record.lockupSpendTxids?.length;
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
