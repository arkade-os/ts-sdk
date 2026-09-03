import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForIncomingFunds } from "../src";
import type { IncomingFunds, Wallet } from "../src";

type Emit = (funds: IncomingFunds) => void;

/**
 * `waitForIncomingFunds` collaborates with the wallet solely through
 * `notifyIncomingFunds`, so a stand-in at that seam exercises the real helper
 * (its abort wiring, its filtering, its teardown) without standing up a
 * wallet, providers and an indexer.
 */
function fakeWallet(
    subscribe: (cb: Emit) => Promise<() => void> = async (cb) => {
        captured = cb;
        return stopSpy;
    },
) {
    const notifyIncomingFunds = vi.fn(subscribe);
    return {
        wallet: { notifyIncomingFunds } as unknown as Wallet,
        notifyIncomingFunds,
    };
}

let captured: Emit | undefined;
let stopSpy = vi.fn();

const emit = (funds: IncomingFunds) => captured!(funds);

const coin = {
    txid: "aa",
    vout: 0,
    value: 1000,
    status: { confirmed: true, block_height: 1, block_hash: "h", block_time: 1 },
};

const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
    captured = undefined;
    stopSpy = vi.fn();
    vi.useRealTimers();
});

describe("waitForIncomingFunds", () => {
    it("resolves with the funds and stops the subscription", async () => {
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet);
        await flush();
        emit({ type: "utxo", coins: [coin] } as IncomingFunds);

        await expect(pending).resolves.toMatchObject({ type: "utxo" });
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting through events that carry no incoming funds", async () => {
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet);
        await flush();

        // The spent half of a self-send: no incoming funds, must not settle.
        emit({ type: "vtxo", newVtxos: [], spentVtxos: [] } as unknown as IncomingFunds);
        await flush();

        let settled = false;
        void pending.then(
            () => (settled = true),
            () => (settled = true),
        );
        await flush();
        expect(settled).toBe(false);
        expect(stopSpy).not.toHaveBeenCalled();

        emit({ type: "utxo", coins: [coin] } as IncomingFunds);
        await expect(pending).resolves.toMatchObject({ type: "utxo" });
    });

    it("rejects with an AbortError when the signal aborts while waiting", async () => {
        const controller = new AbortController();
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet, { signal: controller.signal });
        await flush();

        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects without ever subscribing when handed an already-aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();
        const { wallet, notifyIncomingFunds } = fakeWallet();

        await expect(
            waitForIncomingFunds(wallet, { signal: controller.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });

        expect(notifyIncomingFunds).not.toHaveBeenCalled();
    });

    it("rejects with an AbortError once timeoutMs elapses, and stops the subscription", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet, { timeoutMs: 30_000 });
        await flush();

        await vi.advanceTimersByTimeAsync(30_000);

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("preserves a caller's abort reason", async () => {
        const controller = new AbortController();
        const reason = new Error("shutting down");
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet, { signal: controller.signal });
        await flush();

        controller.abort(reason);

        await expect(pending).rejects.toBe(reason);
    });

    it("rejects instead of hanging when the subscription itself fails", async () => {
        const { wallet } = fakeWallet(async () => {
            throw new Error("indexer unreachable");
        });

        await expect(waitForIncomingFunds(wallet)).rejects.toThrow("indexer unreachable");
    });

    it("ignores an abort that arrives after the funds already resolved", async () => {
        const controller = new AbortController();
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet, { signal: controller.signal });
        await flush();
        emit({ type: "utxo", coins: [coin] } as IncomingFunds);
        await expect(pending).resolves.toMatchObject({ type: "utxo" });

        controller.abort();
        await flush();

        // Teardown ran exactly once — on resolution, not again on abort.
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("does not leave a pending timeout timer once funds arrive", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { wallet } = fakeWallet();

        const pending = waitForIncomingFunds(wallet, { timeoutMs: 30_000 });
        await flush();
        emit({ type: "utxo", coins: [coin] } as IncomingFunds);
        await pending;

        expect(vi.getTimerCount()).toBe(0);
    });
});
