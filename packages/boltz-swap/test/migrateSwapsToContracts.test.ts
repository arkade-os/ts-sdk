import { describe, it, expect, vi } from "vitest";
import { migrateSwapsToContracts } from "../src/repositories/migrateSwapsToContracts";
import { InMemorySwapRepository } from "../src/repositories/inMemory/swap-repository";
import {
    makeArkInfoFixture,
    makeReverseSwapFixture,
    makeSubmarineSwapFixture,
} from "./fixtures/swaps";
import {
    isReverseFinalStatus,
    isSubmarineFinalStatus,
    isChainFinalStatus,
} from "../src/boltz-swap-provider";
import type { BoltzSwap } from "../src/types";
import type { IContractManager } from "@arkade-os/sdk";

// Mirror SwapManager.isFinalStatus — dispatch on type to the correct predicate.
const isTerminal = (swap: BoltzSwap): boolean => {
    if (swap.type === "reverse") return isReverseFinalStatus(swap.status);
    if (swap.type === "submarine") return isSubmarineFinalStatus(swap.status);
    if (swap.type === "chain") return isChainFinalStatus(swap.status);
    return false;
};

const makeFakeContractManager = (): {
    cm: IContractManager;
    calls: unknown[];
} => {
    const calls: unknown[] = [];
    const cm = {
        createContract: vi.fn(async (p: unknown) => {
            calls.push(p);
            return { ...((p as any) ?? {}), state: "active", createdAt: 0 };
        }),
    } as unknown as IContractManager;
    return { cm, calls };
};

describe("migrateSwapsToContracts", () => {
    it("registers non-terminal swaps and skips terminal ones", async () => {
        const arkInfo = makeArkInfoFixture();
        const repo = new InMemorySwapRepository();

        // Non-terminal (swap.created is active for both reverse and submarine)
        const reverseSwap = makeReverseSwapFixture(arkInfo);
        const submarineSwap = {
            ...makeSubmarineSwapFixture(arkInfo),
            id: "fixture-submarine-swap-id-2",
        };

        // Terminal: submarine swap that has settled
        const terminalSwap = {
            ...makeSubmarineSwapFixture(arkInfo),
            id: "fixture-submarine-terminal-id",
            status: "transaction.claimed" as const,
        };

        await repo.saveSwap(reverseSwap);
        await repo.saveSwap(submarineSwap);
        await repo.saveSwap(terminalSwap);

        const { cm, calls } = makeFakeContractManager();

        const result = await migrateSwapsToContracts({
            swapRepository: repo,
            contractManager: cm,
            arkInfo,
            isTerminal,
        });

        // Only the 2 non-terminal swaps should be registered
        expect(result.migrated).toBe(2);
        expect(result.failed).toBe(0);
        expect(calls).toHaveLength(2);
    });

    it("is idempotent: running twice still registers the non-terminal swaps both times", async () => {
        const arkInfo = makeArkInfoFixture();
        const repo = new InMemorySwapRepository();
        await repo.saveSwap(makeReverseSwapFixture(arkInfo));

        const { cm } = makeFakeContractManager();

        const r1 = await migrateSwapsToContracts({
            swapRepository: repo,
            contractManager: cm,
            arkInfo,
            isTerminal,
        });
        expect(r1.migrated).toBe(1);
        expect(r1.failed).toBe(0);

        // Second run — createContract deduplicates internally; count still increments
        const r2 = await migrateSwapsToContracts({
            swapRepository: repo,
            contractManager: cm,
            arkInfo,
            isTerminal,
        });
        expect(r2.migrated).toBe(1);
        expect(r2.failed).toBe(0);
    });

    it("continues after a per-swap error and counts it as failed", async () => {
        const arkInfo = makeArkInfoFixture();
        const repo = new InMemorySwapRepository();

        const goodSwap = makeReverseSwapFixture(arkInfo);
        // A swap with a bad id that will cause registerSwapContract to throw — we
        // simulate this by making createContract reject for that specific swap id.
        const badSwap = { ...makeSubmarineSwapFixture(arkInfo), id: "bad-swap-id" };

        await repo.saveSwap(goodSwap);
        await repo.saveSwap(badSwap);

        const calls: unknown[] = [];
        const cm = {
            createContract: vi.fn(async (p: any) => {
                calls.push(p);
                if (p?.metadata?.swapId === "bad-swap-id") {
                    throw new Error("simulated registration failure");
                }
                return { ...p, state: "active", createdAt: 0 };
            }),
        } as unknown as IContractManager;

        const result = await migrateSwapsToContracts({
            swapRepository: repo,
            contractManager: cm,
            arkInfo,
            isTerminal,
        });

        // One succeeded, one failed — but neither aborted the other
        expect(result.migrated).toBe(1);
        expect(result.failed).toBe(1);
        // createContract was called for both (the error only came from inside)
        expect(calls).toHaveLength(2);
    });
});
