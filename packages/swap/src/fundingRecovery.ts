import { base64, hex } from "@scure/base";
import { Extension, Transaction } from "@arkade-os/sdk";
import { OFFER_PACKET_TYPE } from "./offer";
import type { AssetSwapRepository } from "./repository";
import type { RestoreIndexer } from "./restore";
import type { AssetSwap, FundingIntentInput } from "./store";

export interface FundingRecoveryResult {
    changes: { previous: AssetSwap; current: AssetSwap }[];
    candidateTxids: Set<string>;
}

const TXID = /^[0-9a-f]{64}$/;
const TXS_PER_REQUEST = 50;
const OUTPOINTS_PER_REQUEST = 64;

const outpointKey = (input: FundingIntentInput): string => `${input.txid}:${input.vout}`;

const inputSetKey = (swap: AssetSwap): string =>
    swap.fundingIntent!.inputs.map(outpointKey).sort().join("|");

const inputAt = (tx: Transaction, index: number): FundingIntentInput | undefined => {
    const input = tx.getInput(index);
    if (!input.txid || input.index === undefined) return undefined;
    return { txid: hex.encode(input.txid), vout: input.index };
};

const fetchTransactions = async (
    indexer: RestoreIndexer,
    txids: Set<string>,
): Promise<Map<string, Transaction>> => {
    const parsed = new Map<string, Transaction>();
    if (txids.size === 0) return parsed;
    const values = [...txids];
    for (let offset = 0; offset < values.length; offset += TXS_PER_REQUEST) {
        let raws: string[];
        try {
            raws = (await indexer.getVirtualTxs(values.slice(offset, offset + TXS_PER_REQUEST)))
                .txs;
        } catch {
            continue;
        }
        for (const raw of raws) {
            try {
                const tx = Transaction.fromPSBT(base64.decode(raw));
                if (txids.has(tx.id)) parsed.set(tx.id, tx);
            } catch {
                continue;
            }
        }
    }
    return parsed;
};

const exactCheckpoint = (
    checkpoint: Transaction | undefined,
    source: FundingIntentInput,
): boolean => {
    if (!checkpoint || checkpoint.inputsLength !== 1) return false;
    const input = inputAt(checkpoint, 0);
    return input !== undefined && input.txid === source.txid && input.vout === source.vout;
};

const exactFinalInputs = (final: Transaction, checkpointTxids: string[]): boolean => {
    if (final.inputsLength !== checkpointTxids.length) return false;
    const actual = new Set<string>();
    for (let index = 0; index < final.inputsLength; index++) {
        const input = inputAt(final, index);
        if (!input || input.vout !== 0) return false;
        actual.add(input.txid);
    }
    return actual.size === checkpointTxids.length && checkpointTxids.every((id) => actual.has(id));
};

const exactFundingOutput = (final: Transaction, swap: AssetSwap): boolean => {
    const intent = swap.fundingIntent!;
    const output = final.getOutput(0);
    if (
        !output?.script ||
        hex.encode(output.script) !== intent.output.script ||
        output.amount !== BigInt(intent.output.value)
    ) {
        return false;
    }
    let extension: Extension;
    try {
        extension = Extension.fromTx(final);
    } catch {
        return false;
    }
    const offer = extension.getPacketByType(OFFER_PACKET_TYPE);
    if (!offer || hex.encode(offer.serialize()) !== swap.offerHex) return false;

    const atFundingOutput = (extension.getAssetPacket()?.groups ?? []).flatMap((group) =>
        group.outputs
            .filter((assetOutput) => assetOutput.vout === 0)
            .map((assetOutput) => ({
                assetId: group.assetId?.toString(),
                amount: assetOutput.amount,
            })),
    );
    if (intent.output.assetId === undefined) return atFundingOutput.length === 0;
    return (
        atFundingOutput.length === 1 &&
        atFundingOutput[0].assetId === intent.output.assetId &&
        atFundingOutput[0].amount === BigInt(intent.output.assetAmount!)
    );
};

export async function recoverPreparedOfferFunding(
    indexer: RestoreIndexer,
    repository: AssetSwapRepository,
    swaps: AssetSwap[],
): Promise<FundingRecoveryResult> {
    const pending = swaps.filter(
        (swap) =>
            swap.fundingIntent?.state === "prepared" || swap.fundingIntent?.state === "submitted",
    );
    const result: FundingRecoveryResult = { changes: [], candidateTxids: new Set() };
    if (pending.length === 0) return result;

    const pendingByInputs = new Map<string, number>();
    for (const swap of pending) {
        const key = inputSetKey(swap);
        pendingByInputs.set(key, (pendingByInputs.get(key) ?? 0) + 1);
    }

    const wanted = new Map<string, FundingIntentInput>();
    for (const swap of pending) {
        for (const input of swap.fundingIntent!.inputs) wanted.set(outpointKey(input), input);
    }
    const sourceRows: Awaited<ReturnType<RestoreIndexer["getVtxos"]>>["vtxos"] = [];
    const wantedInputs = [...wanted.values()];
    for (let offset = 0; offset < wantedInputs.length; offset += OUTPOINTS_PER_REQUEST) {
        const outpoints = wantedInputs.slice(offset, offset + OUTPOINTS_PER_REQUEST);
        try {
            sourceRows.push(
                ...(
                    await indexer.getVtxos({
                        outpoints,
                        pageSize: outpoints.length,
                    })
                ).vtxos,
            );
        } catch {
            continue;
        }
    }
    const byOutpoint = new Map<string, (typeof sourceRows)[number] | undefined>();
    const requested = new Set<string>();
    for (const row of sourceRows) {
        const key = `${row.txid}:${row.vout}`;
        if (
            wanted.has(key) &&
            row.spentBy &&
            row.arkTxId &&
            TXID.test(row.spentBy) &&
            TXID.test(row.arkTxId)
        ) {
            requested.add(row.spentBy);
            requested.add(row.arkTxId);
            result.candidateTxids.add(row.arkTxId);
        }
        byOutpoint.set(key, byOutpoint.has(key) ? undefined : row);
    }
    const parsed = await fetchTransactions(indexer, requested);

    for (const initial of pending) {
        if (pendingByInputs.get(inputSetKey(initial)) !== 1) continue;
        const rows = initial.fundingIntent!.inputs.map((input) =>
            byOutpoint.get(outpointKey(input)),
        );
        type SpentRow = NonNullable<(typeof rows)[number]> & {
            spentBy: string;
            arkTxId: string;
        };
        const evidence = rows.filter(
            (row): row is SpentRow =>
                !!row?.spentBy && !!row.arkTxId && TXID.test(row.spentBy) && TXID.test(row.arkTxId),
        );
        if (evidence.length !== rows.length) continue;
        const checkpointTxids = evidence.map((row) => row.spentBy);
        const finalTxids = new Set(evidence.map((row) => row.arkTxId));
        if (new Set(checkpointTxids).size !== checkpointTxids.length || finalTxids.size !== 1) {
            continue;
        }
        if (
            !initial.fundingIntent!.inputs.every((source, index) =>
                exactCheckpoint(parsed.get(checkpointTxids[index]), source),
            )
        ) {
            continue;
        }
        const finalTxid = [...finalTxids][0];
        const final = parsed.get(finalTxid);
        if (
            !final ||
            !exactFinalInputs(final, checkpointTxids) ||
            !exactFundingOutput(final, initial)
        ) {
            continue;
        }

        let current = await repository.getSwap(initial.id);
        if (!current?.fundingIntent) continue;
        if (current.fundingIntent.state === "bound") continue;
        if (current.fundingIntent.state === "prepared") {
            if (
                !(await repository.advanceFundingState(initial.id, "prepared", {
                    state: "submitted",
                }))
            ) {
                continue;
            }
            current = await repository.getSwap(initial.id);
        }
        if (current?.fundingIntent?.state !== "submitted") continue;
        if (
            !(await repository.advanceFundingState(initial.id, "submitted", {
                state: "bound",
                fundingTxid: finalTxid,
            }))
        ) {
            continue;
        }
        const bound = await repository.getSwap(initial.id);
        if (bound) result.changes.push({ previous: initial, current: bound });
    }
    return result;
}
