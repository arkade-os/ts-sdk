import { describe, it, expect } from "vitest";
import { ContractWatcher } from "../src/contracts/contractWatcher";
import { InMemoryWalletRepository } from "../src";
import type { Contract } from "../src/contracts/types";
import type { IndexerProvider } from "../src/providers/indexer";

function makeWatcher() {
    const subscribeCalls: string[][] = [];
    const indexerProvider = {
        async getVtxos() {
            return { vtxos: [] };
        },
        async subscribeForScripts(scripts: string[]) {
            subscribeCalls.push(scripts);
            return "sub-1";
        },
        async unsubscribeForScripts() {},
        // Idle stream: resolves only when the watcher aborts.
        async *getSubscription(_id: string, abortSignal: AbortSignal) {
            await new Promise<void>((resolve) => {
                if (abortSignal.aborted) return resolve();
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
        },
    } as unknown as IndexerProvider;

    const watcher = new ContractWatcher({
        indexerProvider,
        walletRepository: new InMemoryWalletRepository(),
        failsafePollIntervalMs: 60_000,
    });
    return { watcher, subscribeCalls };
}

const contractAt = (script: string): Contract => ({
    type: "default",
    params: { script },
    script,
    address: `ark1q${script}`,
    createdAt: Date.now(),
    state: "active",
});

describe("ContractWatcher.withCoalescedSubscription", () => {
    it("issues one subscribe for a batch of adds, carrying the full set", async () => {
        const { watcher, subscribeCalls } = makeWatcher();
        const stop = await watcher.startWatching(() => {});
        try {
            subscribeCalls.length = 0;
            await watcher.withCoalescedSubscription(async () => {
                for (const s of ["aa", "bb", "cc"]) await watcher.addContract(contractAt(s));
                // Deferred, not merely reordered: nothing goes out mid-batch.
                expect(subscribeCalls).toHaveLength(0);
            });
            expect(subscribeCalls).toEqual([["aa", "bb", "cc"]]);
        } finally {
            stop();
        }
    });

    it("flushes on the error path too", async () => {
        // A scan that aborts mid-way still registered contracts with the
        // watcher; leaving them unsubscribed would silently stop streaming
        // their events until the next unrelated update.
        const { watcher, subscribeCalls } = makeWatcher();
        const stop = await watcher.startWatching(() => {});
        try {
            subscribeCalls.length = 0;
            await expect(
                watcher.withCoalescedSubscription(async () => {
                    await watcher.addContract(contractAt("aa"));
                    throw new Error("scan aborted");
                }),
            ).rejects.toThrow("scan aborted");
            expect(subscribeCalls).toEqual([["aa"]]);
        } finally {
            stop();
        }
    });

    it("does not defer updates made outside the scope", async () => {
        const { watcher, subscribeCalls } = makeWatcher();
        const stop = await watcher.startWatching(() => {});
        try {
            subscribeCalls.length = 0;
            await watcher.addContract(contractAt("aa"));
            expect(subscribeCalls).toEqual([["aa"]]);
        } finally {
            stop();
        }
    });
});
