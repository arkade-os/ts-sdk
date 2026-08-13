import type { ActivityResolver, ArkTransaction, GroupMembership } from "@arkade-os/sdk";
import type { RfqSwapState } from "./swapManager";

/**
 * One swap, flattened to what grouping needs: an identity, a corridor, an
 * outcome, and every Arkade transaction that belongs to it.
 *
 * Deliberately not a stored swap record itself — resolution should stay
 * testable with plain data rather than a repository. A correlation helper
 * that derives these from the record store and the funding lockup's VTXOs
 * lands separately.
 */
export interface SwapActivityInput {
    rfqId: string;
    /**
     * Literal union rather than `RfqSwapRecord["kind"]` — `RfqSwapRecord` lives
     * only on the unmerged rfq-persistence branch, not on master. Reconcile
     * with `RfqSwapRecord["kind"]` once that branch lands.
     */
    kind: "lightning_send" | "lightning_receive";
    state: RfqSwapState;
    /** Funding, claim and refund txids, in whatever order. */
    txids: readonly string[];
}

/** Corridor labels, keyed so a new kind is a compile error rather than a blank row. */
const LABELS: Record<SwapActivityInput["kind"], string> = {
    lightning_send: "Lightning send",
    lightning_receive: "Lightning receive",
};

/**
 * How a swap state reads to a user. Keyed exhaustively off `RfqSwapState`, so a
 * state added upstream is a compile error here rather than silently rendering
 * as something misleading.
 */
const STATUS: Record<RfqSwapState, string> = {
    pending: "Pending",
    claimable: "Pending",
    claimed: "Pending",
    needs_counterparty: "Pending",
    settled: "Settled",
    refunded: "Refunded",
    failed: "Failed",
};

/**
 * Group each RFQ swap's transactions into one activity carrying its outcome.
 *
 * Without this a failed swap renders as two unrelated rows: the send that
 * funded the lockup, and the receive when the covenant refunds. Grouping by
 * `rfqId` collapses them, and `buildActivities` already excludes a same-key
 * receive paired with a sent row as change, so the activity amount needs no
 * special handling.
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
                    status: STATUS[swap.state],
                    metadata: { rfqId: swap.rfqId, swapKind: swap.kind },
                },
            ];
        },
    };
}
