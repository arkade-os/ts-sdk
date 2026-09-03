import { describe, expect, it, vi } from "vitest";
import { Batch } from "../src/wallet/batch";
import { SettlementEventType, type SettlementEvent } from "../src/providers/ark";

async function* streamOf(...events: SettlementEvent[]): AsyncIterableIterator<SettlementEvent> {
    yield* events;
}

const handler = () => ({
    onBatchStarted: vi.fn().mockResolvedValue({ skip: false }),
    onTreeSigningStarted: vi.fn().mockResolvedValue({ skip: false }),
    onTreeNonces: vi.fn().mockResolvedValue({ fullySigned: true }),
    onBatchFinalization: vi.fn().mockResolvedValue(undefined),
    onBatchFinalized: vi.fn().mockResolvedValue(undefined),
    onBatchFailed: vi.fn().mockRejectedValue(new Error("selected batch failed")),
});

describe("Batch.join selected-batch isolation", () => {
    it("ignores interleaved lifecycle events from every other batch", async () => {
        const selected = "selected-batch";
        const foreign = "foreign-batch";
        const hooks = handler();

        await expect(
            Batch.join(
                streamOf(
                    {
                        type: SettlementEventType.BatchStarted,
                        id: selected,
                        intentIdHashes: ["ours"],
                        batchExpiry: 604_672n,
                    },
                    {
                        type: SettlementEventType.BatchStarted,
                        id: foreign,
                        intentIdHashes: ["ours"],
                        batchExpiry: 604_672n,
                    },
                    { type: SettlementEventType.BatchFailed, id: foreign, reason: "not ours" },
                    {
                        type: SettlementEventType.BatchFinalization,
                        id: foreign,
                        commitmentTx: "foreign-psbt",
                    },
                    {
                        type: SettlementEventType.BatchFinalization,
                        id: selected,
                        commitmentTx: "selected-psbt",
                    },
                    {
                        type: SettlementEventType.BatchFinalized,
                        id: foreign,
                        commitmentTxid: "11".repeat(32),
                    },
                    {
                        type: SettlementEventType.BatchFinalized,
                        id: selected,
                        commitmentTxid: "22".repeat(32),
                    },
                ),
                hooks,
                { skipVtxoTreeSigning: true },
            ),
        ).resolves.toBe("22".repeat(32));

        expect(hooks.onBatchStarted).toHaveBeenCalledTimes(1);
        expect(hooks.onBatchFailed).not.toHaveBeenCalled();
        expect(hooks.onBatchFinalization).toHaveBeenCalledOnce();
        expect(hooks.onBatchFinalization).toHaveBeenCalledWith(
            expect.objectContaining({ id: selected }),
            undefined,
            undefined,
        );
        expect(hooks.onBatchFinalized).toHaveBeenCalledOnce();
    });

    it("does not construct a tree for a foreign signing event", async () => {
        const hooks = handler();

        await expect(
            Batch.join(
                streamOf(
                    {
                        type: SettlementEventType.BatchStarted,
                        id: "selected-batch",
                        intentIdHashes: ["ours"],
                        batchExpiry: 604_672n,
                    },
                    {
                        type: SettlementEventType.TreeSigningStarted,
                        id: "foreign-batch",
                        cosignersPublicKeys: [],
                        unsignedCommitmentTx: "",
                    },
                ),
                hooks,
            ),
        ).rejects.toThrow("event stream closed");

        expect(hooks.onTreeSigningStarted).not.toHaveBeenCalled();
    });

    it("does not construct an empty tree when a reconnect misses selected tree chunks", async () => {
        const hooks = handler();

        await expect(
            Batch.join(
                streamOf(
                    {
                        type: SettlementEventType.BatchStarted,
                        id: "selected-batch",
                        intentIdHashes: ["ours"],
                        batchExpiry: 604_672n,
                    },
                    {
                        type: SettlementEventType.TreeSigningStarted,
                        id: "selected-batch",
                        cosignersPublicKeys: [],
                        unsignedCommitmentTx: "",
                    },
                    {
                        type: SettlementEventType.BatchFailed,
                        id: "selected-batch",
                        reason: "expired",
                    },
                ),
                hooks,
            ),
        ).rejects.toThrow("selected batch failed");

        expect(hooks.onTreeSigningStarted).not.toHaveBeenCalled();
        expect(hooks.onBatchFailed).toHaveBeenCalledOnce();
    });
});
