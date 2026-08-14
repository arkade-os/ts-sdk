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
    kind: "lightning_send" | "lightning_receive" | "onchain_send";
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
