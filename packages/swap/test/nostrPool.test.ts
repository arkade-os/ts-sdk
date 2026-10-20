import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, SimplePool } from "nostr-tools";
import {
    closeSharedNostrPool,
    createNostrPool,
    nostrCardFetcher,
    sharedNostrPool,
} from "../src/nostr";
import { createNostrTransportFactory } from "../src/client/transport";

afterEach(() => {
    vi.restoreAllMocks();
    closeSharedNostrPool();
});

describe("sharedNostrPool", () => {
    it("returns one process-wide pool", () => {
        expect(sharedNostrPool()).toBe(sharedNostrPool());
    });

    it("resets after closeSharedNostrPool", () => {
        const first = sharedNostrPool();
        closeSharedNostrPool();
        expect(sharedNostrPool()).not.toBe(first);
    });

    it("creates isolated pools on demand", () => {
        expect(createNostrPool()).not.toBe(sharedNostrPool());
        expect(createNostrPool()).not.toBe(createNostrPool());
    });
});

describe("pool sharing", () => {
    it("binds a lent pool to every transport the factory builds", async () => {
        const seen: unknown[] = [];
        const pool = {
            subscribeMany: (...args: unknown[]) => {
                seen.push(args);
                return { close: () => {} };
            },
            publish: () => [],
            close: vi.fn(),
        };
        const solverPubkey = getPublicKey(generateSecretKey());
        const factory = createNostrTransportFactory(pool as never);
        const transport = await factory({
            card: {} as never,
            solverPubkey,
            relays: ["wss://relay.example"],
        });
        // The pool mock cannot complete a negotiation; close() must still only end the subscription.
        await transport.close().catch(() => {});
        expect(seen).toHaveLength(1);
        expect(pool.close).not.toHaveBeenCalled();
    });

    it("coalesces concurrent card fetches for the same solvers", async () => {
        let subscriptions = 0;
        const subClose = vi.fn();
        const pool = {
            subscribeMany: (
                _relays: string[],
                _filter: unknown,
                params: { oneose?: () => void },
            ) => {
                subscriptions += 1;
                queueMicrotask(() => params.oneose?.());
                return { close: subClose };
            },
            close: vi.fn(),
        };
        const fetcher = nostrCardFetcher({ pool: pool as never });
        const solvers = [
            {
                name: "solver",
                discovery_pubkey: "11".repeat(32),
                transports: { nostr: { relays: ["wss://relay.example"] } },
            },
        ] as never;
        const [a, b] = await Promise.all([
            fetcher.fetch(solvers, "mutinynet"),
            fetcher.fetch(solvers, "mutinynet"),
        ]);
        expect(a).toEqual(b);
        expect(subscriptions).toBe(1);
        expect(pool.close).not.toHaveBeenCalled();
    });

    it("leaves SimplePool ownership to the caller", () => {
        const subscribeMany = vi
            .spyOn(SimplePool.prototype, "subscribeMany")
            .mockReturnValue({ close: () => {} } as never);
        try {
            expect(sharedNostrPool()).toBeInstanceOf(SimplePool);
            expect(subscribeMany).not.toHaveBeenCalled();
        } finally {
            subscribeMany.mockRestore();
        }
    });
});
