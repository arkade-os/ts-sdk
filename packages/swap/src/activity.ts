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
// Side-effecting: the handlers read below register themselves on import.
import "./rfqCorridors";
import { collectRfqSwaps, type AssetSwapRepository } from "./repository";
import { normalizeRfqSwapRecord, type RfqSwapRecord } from "./rfqRecord";

/**
 * One swap, flattened to what grouping needs: an identity, a corridor, an
 * outcome, and every Arkade transaction that belongs to it. Plain data, not a stored record, so
 * resolution is testable without a repository.
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
 * How a swap reads as an activity token: a projection of the client's {@link Outcome}, which
 * already distinguishes a send leg's refund (`refunded`) from a receive leg's lost payment
 * (`lapsed`, projected to `lostReceive`) — the raw state alone cannot.
 */
const outcomeToken = (kind: SwapActivityInput["kind"], state: RfqSwapState): string =>
    ACTIVITY_TOKEN[corridorOutcome(kind, state)];

/**
 * Group each RFQ swap's transactions into one activity carrying its outcome.
 *
 * Without this a failed swap renders as two unrelated rows (funding send, covenant refund). The
 * amount comes out right by netting signed amounts (`-funding + refund ≈ -fees`), not by
 * `buildActivities`'s same-txid change exclusion, since funding and refund are different txids.
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
                    outcome: outcomeToken(swap.kind, swap.state),
                    metadata: { rfqId: swap.rfqId, swapKind: swap.kind },
                },
            ];
        },
    };
}

/** @deprecated Read swap history with `client.swaps()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export interface RfqSwapActivityDeps {
    repository: Pick<AssetSwapRepository, "getRfqSwapsPage">;
    /**
     * Consulted only for what a record cannot answer: a record written before
     * `fundingTxid` existed, and the counterparty's spend on a swap that
     * ended without a refund of ours. Optional because stored fields are the primary, offline
     * source; an indexer that throws costs that record its extra txids and nothing else.
     */
    indexer?: LockupSpendIndexer;
}

/**
 * Every stored RFQ swap, flattened into what {@link swapActivityResolver}
 * groups on.
 *
 * Txids come from the record's `fundingTxid`/`refundTxid`, the corridor's `activityTxids`, the
 * manager's `lockupSpendTxids`, and only then one lockup VTXO read. A missing txid leaves that
 * transaction ungrouped, never misgrouped.
 */
export async function rfqSwapActivityInputs(
    deps: RfqSwapActivityDeps,
): Promise<SwapActivityInput[]> {
    const records = await collectRfqSwaps(deps.repository);
    const inputs: SwapActivityInput[] = [];
    // Bounded, so a long history does not fan out one indexer read per record at once.
    for (let i = 0; i < records.length; i += 16) {
        inputs.push(
            ...(await Promise.all(
                records.slice(i, i + 16).map((record) => activityInputOf(record, deps.indexer)),
            )),
        );
    }
    return inputs;
}

async function activityInputOf(
    stored: RfqSwapRecord,
    indexer?: LockupSpendIndexer,
): Promise<SwapActivityInput> {
    // Read straight off the repository, so pre-rename txid fields are normalized here.
    const record = normalizeRfqSwapRecord(stored);
    const txids = new Set<string>();
    if (record.fundingTxid) txids.add(record.fundingTxid);
    if (record.refundTxid) txids.add(record.refundTxid);
    const handler = rfqCorridorHandlers.getOrThrow(record.kind);
    for (const txid of handler.activityTxids?.(record.profile) ?? []) txids.add(txid);
    // Stamped by the manager so a terminal swap needn't cost a lockup read here.
    for (const txid of record.lockupSpendTxids ?? []) txids.add(txid);

    // The counterparty's spend (solver claim on send, solver reclaim on receive), unknown only
    // when neither our refund nor the manager's stamp names it.
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
 * the ark transactions that spent it. */
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
            if (wantFunding) out.push(vtxo.txid);
            // `spentBy` names the checkpoint; history carries the ark tx.
            if (vtxo.arkTxId) out.push(vtxo.arkTxId);
        }
        return out;
    } catch {
        // Offline-first: one record's failure must not sink every other record's activity.
        return [];
    }
}
