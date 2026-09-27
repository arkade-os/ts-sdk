import { describe, expect, it } from "vitest";
import { RfqSwapManager, type RfqSwap } from "../src/swapManager";
import type { LockupSpendIndexer } from "../src/refund";

describe("RfqSwapManager polling at scale", () => {
    it("bounds full-sweep indexer requests without skipping live swaps", async () => {
        let active = 0;
        let peak = 0;
        let calls = 0;
        const indexer = {
            async getVtxos() {
                active++;
                calls++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active--;
                return { vtxos: [] };
            },
        } as unknown as LockupSpendIndexer;
        const swaps = Array.from({ length: 100 }, (_, i) => ({
            rfqId: i.toString(16).padStart(64, "0"),
            kind: "lightning_send",
            state: "pending",
            lockupPkScript: Uint8Array.of(i),
            paymentHash: "00".repeat(32),
            refundLocktime: 2_000_000_000,
            createdAt: 1,
            updatedAt: 1,
        })) as RfqSwap[];
        const manager = new RfqSwapManager({ indexer }, { now: () => 1_800_000_000 });

        await manager.start(swaps);
        await manager.stop();

        expect(calls).toBe(swaps.length);
        expect(peak).toBeLessThanOrEqual(16);
    });
});
