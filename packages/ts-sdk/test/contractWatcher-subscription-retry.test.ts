import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContractWatcher } from "../src/contracts/contractWatcher";
import { InMemoryWalletRepository } from "../src";
import type { Contract, ContractEvent } from "../src/contracts/types";
import type { IndexerProvider } from "../src/providers/indexer";

const contract = (script: string, watch: Contract["watch"] = "watched"): Contract => ({
    type: "default",
    params: {},
    script,
    address: `ark1q${script}`,
    createdAt: 0,
    state: "active",
    watch,
});

describe("subscription update recovery", () => {
    const watchers: ContractWatcher[] = [];

    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
        for (const watcher of watchers.splice(0)) await watcher.stopWatching();
        vi.useRealTimers();
    });

    async function setup(maxReconnectAttempts = 0) {
        const events: ContractEvent[] = [];
        const subscribe = vi.fn(async (_scripts: string[], _id?: string) => "sub-1");
        const unsubscribe = vi.fn(async (_id: string) => {});
        let disconnect!: () => void;
        const listen = vi.fn(async function* (_id: string, signal: AbortSignal) {
            await new Promise<void>((resolve) => {
                disconnect = resolve;
                if (signal.aborted) resolve();
                else signal.addEventListener("abort", () => resolve(), { once: true });
            });
        });
        const watcher = new ContractWatcher({
            indexerProvider: {
                subscribeForScripts: subscribe,
                unsubscribeForScripts: unsubscribe,
                getSubscription: listen,
                getVtxos: vi.fn(async () => ({ vtxos: [] })),
            } as unknown as IndexerProvider,
            walletRepository: new InMemoryWalletRepository(),
            failsafePollIntervalMs: 60_000,
            reconnectDelayMs: 10,
            maxReconnectDelayMs: 25,
            maxReconnectAttempts,
        });
        watchers.push(watcher);
        await watcher.addContract(contract("aa"));
        await watcher.addContract(contract("bb", "retained"));
        await watcher.startWatching((event) => events.push(event));
        subscribe.mockClear();
        return { watcher, subscribe, unsubscribe, listen, events, disconnect: () => disconnect() };
    }

    it("retries without another setter call and requests catch-up without duplicating the stream", async () => {
        const { watcher, subscribe, listen, events } = await setup();
        subscribe.mockRejectedValueOnce(new Error("POST failed"));
        await watcher.updateContract(contract("bb"));
        expect(subscribe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10);
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(subscribe).toHaveBeenLastCalledWith(["aa", "bb"], "sub-1", expect.any(AbortSignal));
        expect(listen).toHaveBeenCalledTimes(1);
        expect(events.filter((event) => event.type === "connection_reset")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(subscribe).toHaveBeenCalledTimes(2);
    });

    it("backs off repeated failures and caps the delay", async () => {
        const { watcher, subscribe } = await setup();
        subscribe
            .mockRejectedValueOnce(new Error("1"))
            .mockRejectedValueOnce(new Error("2"))
            .mockRejectedValueOnce(new Error("3"))
            .mockRejectedValueOnce(new Error("4"));
        await watcher.updateContract(contract("bb"));
        for (const [delay, calls] of [
            [10, 2],
            [20, 3],
            [25, 4],
            [25, 5],
        ]) {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(subscribe).toHaveBeenCalledTimes(calls - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(subscribe).toHaveBeenCalledTimes(calls);
        }
    });

    it("honors the configured retry limit", async () => {
        const { watcher, subscribe } = await setup(2);
        subscribe.mockRejectedValue(new Error("still unavailable"));
        await watcher.updateContract(contract("bb"));
        await vi.advanceTimersByTimeAsync(100);
        expect(subscribe).toHaveBeenCalledTimes(3); // Initial attempt and two retries.
    });

    it("defers a retry inside a batch and sends the latest desired scripts at the flush", async () => {
        const { watcher, subscribe } = await setup();
        subscribe.mockRejectedValueOnce(new Error("POST failed"));
        await watcher.updateContract(contract("bb"));
        await watcher.withCoalescedSubscription(async () => {
            await watcher.updateContract(contract("bb", "retained"));
            await watcher.addContract(contract("cc"));
            await vi.advanceTimersByTimeAsync(10);
            expect(subscribe).toHaveBeenCalledTimes(1);
        });
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(subscribe).toHaveBeenLastCalledWith(["aa", "cc"], "sub-1", expect.any(AbortSignal));
        await vi.advanceTimersByTimeAsync(100);
        expect(subscribe).toHaveBeenCalledTimes(2);
    });

    it("cancels the retry after an intervening successful update", async () => {
        const { watcher, subscribe, events } = await setup();
        subscribe.mockRejectedValueOnce(new Error("POST failed"));
        await watcher.updateContract(contract("bb"));
        await watcher.addContract(contract("cc"));
        await vi.advanceTimersByTimeAsync(100);
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(events.filter((event) => event.type === "connection_reset")).toHaveLength(1);
    });

    it("does not let a delayed retry overwrite a later desired state", async () => {
        const { watcher, subscribe } = await setup();
        let finish!: (id: string) => void;
        subscribe.mockRejectedValueOnce(new Error("POST failed")).mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        await watcher.updateContract(contract("bb"));
        await vi.advanceTimersByTimeAsync(10);
        const retirement = watcher.updateContract(contract("bb", "retained"));
        await vi.advanceTimersByTimeAsync(0);
        expect(subscribe).toHaveBeenCalledTimes(2);
        finish("sub-1");
        await retirement;
        expect(subscribe).toHaveBeenCalledTimes(3);
        expect(subscribe).toHaveBeenLastCalledWith(["aa"], "sub-1", expect.any(AbortSignal));
    });

    it("cancels pending retry work on stop", async () => {
        const { watcher, subscribe } = await setup();
        subscribe.mockRejectedValueOnce(new Error("POST failed"));
        await watcher.updateContract(contract("bb"));
        await watcher.stopWatching();
        await vi.advanceTimersByTimeAsync(100);
        expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it("starts a fresh session without waiting for a provider that ignores cancellation", async () => {
        const { watcher, subscribe } = await setup();
        let finish!: (id: string) => void;
        subscribe.mockImplementationOnce(
            () => new Promise<string>((resolve) => (finish = resolve)),
        );
        const oldUpdate = watcher.updateContract(contract("bb"));
        await vi.advanceTimersByTimeAsync(0);
        await watcher.stopWatching();
        let restarted = false;
        const restart = watcher.startWatching(() => {}).then(() => (restarted = true));
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(restarted).toBe(true);
            expect(watcher.getConnectionState()).toBe("connected");
        } finally {
            finish("old-subscription");
            await Promise.all([oldUpdate, restart]);
        }
    });

    it("does not start failsafe polling when stopped during the initial subscribe", async () => {
        const { watcher, subscribe } = await setup();
        await watcher.stopWatching();
        let finish!: (id: string) => void;
        subscribe.mockImplementationOnce(
            () => new Promise<string>((resolve) => (finish = resolve)),
        );
        const start = watcher.startWatching(() => {});
        await vi.advanceTimersByTimeAsync(0);
        await watcher.stopWatching();
        finish("late-subscription");
        await start;
        expect(watcher.isCurrentlyWatching()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the new session's failsafe polling when an old initial subscribe finishes late", async () => {
        const { watcher, subscribe } = await setup();
        await watcher.stopWatching();
        let finish!: (id: string) => void;
        subscribe.mockImplementationOnce(
            () => new Promise<string>((resolve) => (finish = resolve)),
        );
        const oldStart = watcher.startWatching(() => {});
        await vi.advanceTimersByTimeAsync(0);
        await watcher.stopWatching();
        await watcher.startWatching(() => {});
        expect(vi.getTimerCount()).toBe(1);
        finish("late-subscription");
        await oldStart;
        expect(watcher.isCurrentlyWatching()).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
    });

    it("does not clear a new session's subscription when an old unsubscribe finishes", async () => {
        const { watcher, subscribe, unsubscribe } = await setup();
        let finish!: () => void;
        unsubscribe.mockImplementationOnce(
            () => new Promise<void>((resolve) => (finish = resolve)),
        );
        const oldUpdate = watcher.updateContract(contract("aa", "retained"));
        await vi.advanceTimersByTimeAsync(0);
        await watcher.stopWatching();
        await watcher.updateContract(contract("aa"));
        subscribe.mockResolvedValue("new-subscription");
        await watcher.startWatching(() => {});
        finish();
        await oldUpdate;
        await watcher.updateContract(contract("bb"));
        expect(subscribe).toHaveBeenLastCalledWith(
            ["aa", "bb"],
            "new-subscription",
            expect.any(AbortSignal),
        );
    });

    it("cleans up an in-flight retry that completes after stop without resuming work", async () => {
        const { watcher, subscribe, unsubscribe, events } = await setup();
        let finish!: (id: string) => void;
        subscribe.mockRejectedValueOnce(new Error("POST failed")).mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        await watcher.updateContract(contract("bb"));
        await vi.advanceTimersByTimeAsync(10);
        await watcher.stopWatching();
        finish("sub-after-stop");
        await vi.advanceTimersByTimeAsync(100);
        expect(unsubscribe).toHaveBeenCalledWith("sub-after-stop");
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(events).toHaveLength(0);
        expect(watcher.getConnectionState()).toBe("disconnected");
    });

    it("lets stream reconnection satisfy a pending update retry", async () => {
        const { watcher, subscribe, listen, events, disconnect } = await setup();
        subscribe.mockRejectedValueOnce(new Error("POST failed"));
        await watcher.updateContract(contract("bb"));
        disconnect();
        await vi.advanceTimersByTimeAsync(100);
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(subscribe).toHaveBeenLastCalledWith(["aa", "bb"], "sub-1", expect.any(AbortSignal));
        expect(listen).toHaveBeenCalledTimes(2);
        expect(events.filter((event) => event.type === "connection_reset")).toHaveLength(1);
    });
});
