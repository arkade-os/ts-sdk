import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, SimplePool, verifyEvent } from "nostr-tools";
import { AbstractRelay } from "nostr-tools/abstract-relay";
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

/** Opens on the next tick and records what the relay sends. */
class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;
    constructor() {
        setTimeout(() => {
            this.readyState = 1;
            this.onopen?.();
        });
    }
    send(message: string) {
        this.sent.push(message);
    }
    close() {
        this.readyState = 3;
    }
}

const IDLE_MS = 20;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real relay over a fake socket, with a short idle close, served by `pool.ensureRelay`. */
const relayBehind = async () => {
    const relay = new AbstractRelay("wss://relay.example", {
        verifyEvent,
        websocketImplementation: FakeSocket as never,
        idleTimeout: IDLE_MS,
    });
    await relay.connect();
    vi.spyOn(SimplePool.prototype, "ensureRelay").mockResolvedValue(relay);
    const socket = (relay as unknown as { ws: FakeSocket }).ws;
    return { relay, socket };
};

/**
 * nostr-tools decrements the relay's open-operation count on every
 * Subscription.close() and closes the socket at zero; on a shared pool a
 * miscount would drop every other transport's live subscription.
 */
describe("createNostrPool subscription close", () => {
    const filter = { kinds: [1] };

    it("keeps other subscriptions alive when one closes twice", async () => {
        const { relay } = await relayBehind();
        const pool = createNostrPool();
        const lost = vi.fn();
        const a = pool.subscribeMany([relay.url], filter, {});
        pool.subscribeMany([relay.url], filter, { onclose: lost });
        await settle();
        a.close();
        a.close();
        await settle(IDLE_MS * 3);
        expect(relay.ongoingOperations).toBe(1);
        expect(lost).not.toHaveBeenCalled();
    });

    it("keeps other subscriptions alive when a relay CLOSED is followed by our close", async () => {
        const { relay, socket } = await relayBehind();
        const pool = createNostrPool();
        const lost = vi.fn();
        const a = pool.subscribeMany([relay.url], filter, {});
        await settle();
        const [aId] = [...relay.openSubs.keys()];
        pool.subscribeMany([relay.url], filter, { onclose: lost });
        await settle();
        socket.onmessage?.({ data: JSON.stringify(["CLOSED", aId, "rate-limited: slow down"]) });
        a.close();
        await settle(IDLE_MS * 3);
        expect(relay.ongoingOperations).toBe(1);
        expect(lost).not.toHaveBeenCalled();
    });

    it("does not let the uncounted keep-alive REQ decrement on close", async () => {
        const { relay } = await relayBehind();
        await createNostrPool().ensureRelay(relay.url);
        relay.subscribe([{ ids: ["aa".repeat(32)], limit: 0 }], { label: "<forced-ping>" }).close();
        expect(relay.ongoingOperations).toBe(0);
    });
});
