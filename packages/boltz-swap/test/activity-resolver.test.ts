import { describe, it, expect } from "vitest";
import { swapActivityResolver } from "../src/activity-resolver";
import { InMemorySwapRepository } from "../src/repositories/inMemory/swap-repository";
import type { BoltzChainSwap, BoltzReverseSwap } from "../src/types";
import type { ArkTransaction } from "@arkade-os/sdk";

function chainSwap(id: string, claimTxid?: string): BoltzChainSwap {
    return {
        id,
        type: "chain",
        preimage: "p",
        createdAt: 1,
        ephemeralKey: "e",
        feeSatsPerByte: 1,
        status: "transaction.claimed" as BoltzChainSwap["status"],
        request: {} as BoltzChainSwap["request"],
        response: {} as BoltzChainSwap["response"],
        amount: 1000,
        claimTxid,
    };
}

function tx(arkTxid: string): ArkTransaction {
    return {
        key: { arkTxid, commitmentTxid: "", boardingTxid: "" },
        type: "RECEIVED" as ArkTransaction["type"],
        amount: 1,
        settled: true,
        createdAt: 1,
    };
}

describe("swapActivityResolver", () => {
    it("labels a tx whose arkTxid matches a swap's claimTxid; ignores the rest", async () => {
        const repo = new InMemorySwapRepository();
        await repo.saveSwap(chainSwap("s1", "txA"));
        await repo.saveSwap(chainSwap("s2")); // no claimTxid -> not indexed
        const r = swapActivityResolver(repo);
        await r.prepare!();

        expect(r.resolve(tx("txA"))).toEqual([
            {
                groupId: "boltz:swap:s1",
                label: "Chain swap",
                kind: "swap",
                metadata: { swapType: "chain", swapId: "s1", status: "transaction.claimed" },
            },
        ]);
        expect(r.resolve(tx("txZ"))).toBeUndefined();
    });

    it("labels reverse/submarine swaps as 'Lightning swap'", async () => {
        const repo = new InMemorySwapRepository();
        const reverse: BoltzReverseSwap = {
            id: "r1",
            type: "reverse",
            createdAt: 1,
            preimage: "p",
            status: "invoice.settled" as BoltzReverseSwap["status"],
            request: {} as BoltzReverseSwap["request"],
            response: {} as BoltzReverseSwap["response"],
            claimTxid: "txR",
        };
        await repo.saveSwap(reverse);
        const r = swapActivityResolver(repo);
        await r.prepare!();
        expect(r.resolve(tx("txR"))?.[0].label).toBe("Lightning swap");
    });
});
