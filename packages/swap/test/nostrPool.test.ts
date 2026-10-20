import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, SimplePool } from "nostr-tools";
import {
    closeSharedNostrPool,
    createNostrPool,
    nostrCardFetcher,
    sharedNostrPool,
} from "../src/nostr";
import { createNostrTransportFactory } from "../src/client/transport";
import { IDLE_CLOSE_MS } from "../src/nostrPool";

/** A relay socket that opens on the next tick, ends every REQ and accepts every EVENT. */
const { FakeSocket } = vi.hoisted(() => {
    class FakeSocket {
        static readonly OPEN = 1;
        static readonly opened: FakeSocket[] = [];
        readyState = 0;
        /** How the relay answers an EVENT: accept, refuse, or never (half-open), after a delay. */
        ack: "ok" | "refuse" | "silent" = "ok";
        ackDelayMs = 0;
        onopen?: () => void;
        onmessage?: (ev: { data: string }) => void;
        onerror?: () => void;
        onclose?: () => void;
        constructor() {
            FakeSocket.opened.push(this);
            setTimeout(() => {
                if (this.readyState !== 0) return; // closed while connecting
                this.readyState = 1;
                this.onopen?.();
            });
        }
        send(message: string) {
            const [verb, body] = JSON.parse(message) as [string, { id?: string } | string];
            if (verb === "REQ") setTimeout(() => this.receive(["EOSE", body]));
            if (verb === "EVENT" && this.ack !== "silent") {
                const id = (body as { id: string }).id;
                const ok = this.ack === "ok";
                setTimeout(
                    () => this.receive(["OK", id, ok, ok ? "" : "blocked: no"]),
                    this.ackDelayMs,
                );
            }
        }
        receive(frame: unknown[]) {
            this.onmessage?.({ data: JSON.stringify(frame) });
        }
        close() {
            this.readyState = 3;
        }
    }
    return { FakeSocket };
});
vi.mock("../src/closeOnceWebSocket", () => ({ CloseOnceWebSocket: FakeSocket }));

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    FakeSocket.opened.length = 0;
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

    it("does not coalesce the same solvers asked over different relays", async () => {
        const asked: string[][] = [];
        const pool = {
            subscribeMany: (
                relays: string[],
                _filter: unknown,
                params: { oneose?: () => void },
            ) => {
                asked.push(relays);
                queueMicrotask(() => params.oneose?.());
                return { close: () => {} };
            },
        };
        const fetcher = nostrCardFetcher({ pool: pool as never });
        const over = (relay: string) =>
            [
                {
                    name: "solver",
                    discovery_pubkey: "11".repeat(32),
                    transports: { nostr: { relays: [relay] } },
                },
            ] as never;
        await Promise.all([
            fetcher.fetch(over("wss://a.example"), "mutinynet"),
            fetcher.fetch(over("wss://b.example"), "mutinynet"),
        ]);
        expect(asked).toEqual([["wss://a.example"], ["wss://b.example"]]);
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

const RELAY = "wss://relay.example";
const filter = { kinds: [1] };
const anEvent = () =>
    finalizeEvent({ kind: 1, created_at: 0, tags: [], content: "" }, generateSecretKey());

/** A real pool over a fake socket, under fake timers; `connected` reads the pool's view. */
const fakeRelayPool = async () => {
    vi.useFakeTimers();
    const pool = createNostrPool();
    const connected = () => pool.listConnectionStatus().get(`${RELAY}/`) === true;
    const socket = () => FakeSocket.opened.at(-1)!;
    return { pool, connected, socket };
};

/**
 * nostr-tools' own idle close trusts a count every Subscription.close() decrements,
 * a repeated one included, so it is off; the pool counts its own users instead.
 */
describe("createNostrPool socket lifetime", () => {
    it("keeps other subscriptions alive when one closes twice", async () => {
        const { pool, connected } = await fakeRelayPool();
        const lost = vi.fn();
        const a = pool.subscribeMany([RELAY], filter, {});
        pool.subscribeMany([RELAY], filter, { onclose: lost });
        await vi.advanceTimersByTimeAsync(10);
        a.close();
        a.close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 3);
        expect(lost).not.toHaveBeenCalled();
        expect(connected()).toBe(true);
    });

    it("keeps other subscriptions alive when a relay CLOSED is followed by our close", async () => {
        const { pool, connected, socket } = await fakeRelayPool();
        const lost = vi.fn();
        const a = pool.subscribeMany([RELAY], filter, { id: "a" });
        pool.subscribeMany([RELAY], filter, { onclose: lost });
        await vi.advanceTimersByTimeAsync(10);
        socket().receive(["CLOSED", "a", "rate-limited: slow down"]);
        a.close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 3);
        expect(lost).not.toHaveBeenCalled();
        expect(connected()).toBe(true);
    });

    it("closes the socket once its last subscription has been gone for the idle window", async () => {
        const { pool, connected, socket } = await fakeRelayPool();
        const a = pool.subscribeMany([RELAY], filter, {});
        const b = pool.subscribeMany([RELAY], filter, {});
        await vi.advanceTimersByTimeAsync(10);
        a.close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 2);
        expect(connected()).toBe(true);
        b.close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1_000);
        expect(connected()).toBe(true);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(connected()).toBe(false);
        expect(socket().readyState).toBe(3);
    });

    it("cancels the idle close when the relay is used again", async () => {
        const { pool, connected } = await fakeRelayPool();
        pool.subscribeMany([RELAY], filter, {}).close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1_000);
        const again = pool.subscribeMany([RELAY], filter, {});
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 2);
        expect(connected()).toBe(true);
        again.close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS + 1_000);
        expect(connected()).toBe(false);
    });

    it("counts a publish as a user until it settles", async () => {
        const { pool, connected, socket } = await fakeRelayPool();
        pool.subscribeMany([RELAY], filter, {}).close();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1_000);
        socket().ackDelayMs = 3_000;
        const sent = Promise.all(pool.publish([RELAY], anEvent()));
        await vi.advanceTimersByTimeAsync(4_000);
        await sent;
        // The window restarts at the OK, not at the publish: released early, it would be closed.
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 3_000);
        expect(connected()).toBe(true);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(connected()).toBe(false);
    });

    it("evicts a relay that never acknowledges a publish, so the next use reconnects", async () => {
        const { pool, connected, socket } = await fakeRelayPool();
        const lost = vi.fn();
        pool.subscribeMany([RELAY], filter, { onclose: lost });
        await vi.advanceTimersByTimeAsync(10);
        const halfOpen = socket();
        halfOpen.ack = "silent";
        const sent = Promise.allSettled(pool.publish([RELAY], anEvent()));
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await sent)[0]!.status).toBe("rejected");
        expect(connected()).toBe(false);
        // Its co-tenants learn now, rather than waiting on a socket nothing answers.
        expect(lost).toHaveBeenCalledOnce();
        pool.subscribeMany([RELAY], filter, {});
        await vi.advanceTimersByTimeAsync(10);
        expect(socket()).not.toBe(halfOpen);
        expect(connected()).toBe(true);
    });

    it("keeps a relay that answers, even with a refusal", async () => {
        const { pool, connected, socket } = await fakeRelayPool();
        pool.subscribeMany([RELAY], filter, {});
        await vi.advanceTimersByTimeAsync(10);
        socket().ack = "refuse";
        const sent = Promise.allSettled(pool.publish([RELAY], anEvent()));
        await vi.advanceTimersByTimeAsync(10);
        expect((await sent)[0]!.status).toBe("rejected");
        expect(connected()).toBe(true);
    });

    it("releases the relay when every relay dropped the subscription", async () => {
        const { pool, connected, socket } = await fakeRelayPool();
        const closed = vi.fn();
        pool.subscribeMany([RELAY], filter, { id: "a", onclose: closed });
        await vi.advanceTimersByTimeAsync(10);
        socket().receive(["CLOSED", "a", "error: shutting down"]);
        expect(closed).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS + 1_000);
        expect(connected()).toBe(false);
    });

    // The accounting overrides subscribeMap alone; a nostr-tools release that routes any of
    // these around it would leave their sockets uncounted, so pin it.
    it("counts every subscribe and query entry point", async () => {
        const { pool } = await fakeRelayPool();
        const counted = vi.spyOn(pool, "subscribeMap");
        pool.subscribe([RELAY], filter, {}).close();
        pool.subscribeMany([RELAY], filter, {}).close();
        pool.subscribeEose([RELAY], filter, {}).close();
        const query = pool.querySync([RELAY], filter);
        await vi.advanceTimersByTimeAsync(10);
        await query;
        expect(counted).toHaveBeenCalledTimes(4);
    });

    it("reconnects nothing once destroyed, failing late users instead", async () => {
        const { pool } = await fakeRelayPool();
        pool.destroy();
        const lost = vi.fn();
        pool.subscribeMany([RELAY], filter, { onclose: lost });
        const sent = Promise.all(pool.publish([RELAY], anEvent()));
        await vi.advanceTimersByTimeAsync(10);
        expect(lost).toHaveBeenCalledOnce();
        expect(await sent).toEqual([expect.stringMatching(/^connection failure: .*destroyed/)]);
        expect(FakeSocket.opened).toHaveLength(0);
    });

    it("closes a relay still connecting when destroyed", async () => {
        const { pool } = await fakeRelayPool();
        const lost = vi.fn();
        pool.subscribeMany([RELAY], filter, { onclose: lost });
        pool.destroy(); // the socket is still opening
        // nostr-tools reports the abandoned connect at its 3s connection timeout.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(FakeSocket.opened).toHaveLength(1);
        expect(FakeSocket.opened[0]!.readyState).toBe(3);
        expect(lost).toHaveBeenCalledOnce();
    });

    it("does not hold a Node process open while idle", async () => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const realSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
            const timer = realSetTimeout(fn, ms);
            if (ms === IDLE_CLOSE_MS) timers.push(timer);
            return timer;
        }) as typeof setTimeout);
        const pool = createNostrPool();
        pool.subscribeMany([RELAY], filter, {}).close();
        expect(timers).toHaveLength(1);
        expect(timers[0]!.hasRef()).toBe(false);
        pool.destroy();
    });
});
