import type { SwapClient, SwapUpdate } from "@arkade-os/swap";
import { describe, expect, it, vi } from "vitest";

import { followReceive } from "../src/ArkadeWalletProvider";

/** A client whose `onUpdate` replays `past` synchronously, as the swap client's does. */
function clientWith(past: SwapUpdate[] = []) {
    const listeners = new Set<(update: SwapUpdate) => void>();
    const client = {
        onUpdate(fn: (update: SwapUpdate) => void) {
            listeners.add(fn);
            for (const update of past) fn(update);
            return () => listeners.delete(fn);
        },
    } as unknown as SwapClient;
    const emit = (update: SwapUpdate) => {
        for (const fn of [...listeners]) fn(update);
    };
    return { client, emit, listeners };
}

const update = (id: string, outcome: string) =>
    ({ swap: { id }, outcome }) as unknown as SwapUpdate;

describe("followReceive", () => {
    it("refreshes the balance once the receive is claimed", async () => {
        const { client, emit, listeners } = clientWith([update("other", "claimed")]);
        const onClaimed = vi.fn();
        const onFailed = vi.fn();

        const done = followReceive(client, "rfq:1", () => true, onClaimed, onFailed);
        emit(update("rfq:1", "open"));
        emit(update("rfq:1", "claimed"));
        await done;

        expect(onClaimed).toHaveBeenCalledOnce();
        expect(onFailed).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
    });

    it("reports a receive that lapsed", async () => {
        const { client } = clientWith([update("rfq:1", "lapsed")]);
        const onFailed = vi.fn();

        await followReceive(client, "rfq:1", () => true, vi.fn(), onFailed);

        expect(onFailed).toHaveBeenCalledWith("Lightning receive lapsed");
    });

    it("stays silent once the session that issued it has closed", async () => {
        const { client, emit } = clientWith();
        let live = true;
        const onClaimed = vi.fn();
        const onFailed = vi.fn();

        const done = followReceive(client, "rfq:1", () => live, onClaimed, onFailed);
        live = false;
        emit(update("rfq:1", "claimed"));
        await done;

        expect(onClaimed).not.toHaveBeenCalled();
        expect(onFailed).not.toHaveBeenCalled();
    });

    it("reports a balance refresh that fails", async () => {
        const { client } = clientWith([update("rfq:1", "claimed")]);
        const onFailed = vi.fn();

        await followReceive(
            client,
            "rfq:1",
            () => true,
            async () => {
                throw new Error("indexer down");
            },
            onFailed,
        );

        expect(onFailed).toHaveBeenCalledWith("indexer down");
    });
});
