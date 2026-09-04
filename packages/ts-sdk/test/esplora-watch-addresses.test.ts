import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EsploraProvider } from "../src";
import type { ExplorerTransaction } from "../src/providers/onchain";

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

type Listener = (ev?: any) => unknown;

/**
 * Minimal stand-in for the global `WebSocket` that `watchAddresses` news up.
 * `dispatch` returns the handlers' promise so a test can either await the
 * handler to completion, or hold a reference and interleave other work while
 * an async handler is suspended mid-await.
 */
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];

    readonly sent: string[] = [];
    closed = false;
    private readonly listeners = new Map<string, Listener[]>();

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, handler: Listener): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(handler);
        this.listeners.set(type, existing);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
    }

    dispatch(type: string, ev?: any): Promise<unknown[]> {
        const handlers = this.listeners.get(type) ?? [];
        return Promise.all(handlers.map((h) => h(ev)));
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const okJson = (data: unknown) => ({ ok: true, json: () => Promise.resolve(data) });

const confirmedTx = (txid: string): ExplorerTransaction =>
    ({
        txid,
        vout: [],
        status: { confirmed: true, block_height: 1, block_hash: "h", block_time: 1 },
    }) as unknown as ExplorerTransaction;

const wsMessage = (address: string, txs: ExplorerTransaction[]) => ({
    data: JSON.stringify({
        "multi-address-transactions": { [address]: { confirmed: txs } },
    }),
});

/** Let queued microtasks (and any awaited fetch continuations) drain. */
const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

const confirmedTxAt = (txid: string, blockHeight: number): ExplorerTransaction =>
    ({
        txid,
        vout: [],
        status: { confirmed: true, block_height: blockHeight, block_hash: "h", block_time: 1 },
    }) as unknown as ExplorerTransaction;

const unconfirmedTx = (txid: string): ExplorerTransaction =>
    ({ txid, vout: [], status: { confirmed: false } }) as unknown as ExplorerTransaction;

const blocksTip = (height: number) => okJson([{ id: "tip", height, mediantime: 1 }]);

/**
 * Route the mocked fetch by endpoint, so a test can fail address history while
 * leaving the (much smaller) chain-tip request working — which is the whole
 * situation the anchor exists for.
 */
const routeFetch = (routes: { txs?: () => unknown; blocks?: () => unknown }) => {
    mockFetch.mockImplementation((url: string) => {
        if (url.includes("/blocks")) {
            return routes.blocks
                ? Promise.resolve(routes.blocks())
                : Promise.reject(new Error("tip unavailable"));
        }
        if (url.includes("/txs")) {
            return routes.txs
                ? Promise.resolve(routes.txs())
                : Promise.reject(new Error("history unavailable"));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
};

/** `EsploraProvider`'s default HTTP poll interval. */
const POLL_INTERVAL_MS = 15_000;
/** First websocket reconnect delay; doubles per consecutive failure. */
const RECONNECT_DELAY_MS = 1_000;

describe("EsploraProvider.watchAddresses", () => {
    let originalWebSocket: unknown;
    let warn: ReturnType<typeof vi.spyOn>;
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockFetch.mockReset();
        FakeWebSocket.instances = [];
        // These tests deliberately drive the transport's failure paths, which
        // are expected to log. Capture rather than print, so a real unexpected
        // diagnostic still stands out in the suite output.
        warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        error = vi.spyOn(console, "error").mockImplementation(() => {});
        originalWebSocket = (globalThis as any).WebSocket;
        (globalThis as any).WebSocket = FakeWebSocket;
        // Only fake the timer functions under test: faking microtask queues
        // would deadlock the `await`s these tests rely on.
        vi.useFakeTimers({
            toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
        });
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        warn.mockRestore();
        error.mockRestore();
        (globalThis as any).WebSocket = originalWebSocket;
    });

    describe("teardown safety", () => {
        it("does not leave a poll interval when stop() races the websocket-error fallback", async () => {
            // The fallback poll awaits a full address-history fetch *before* it
            // assigns its interval handle. A caller that stops inside that
            // window must not end up with an interval nothing can clear.
            mockFetch.mockResolvedValueOnce(okJson([])); // creation-time baseline
            const provider = new EsploraProvider("http://localhost:3000");
            const stop = await provider.watchAddresses(["addr1"], () => {});

            // Now hold the fallback's own fetch open.
            const pending = deferred<ReturnType<typeof okJson>>();
            mockFetch.mockReturnValue(pending.promise);

            const errorHandled = FakeWebSocket.instances[0].dispatch("error");
            await flush(); // poll() is now suspended on the initial fetch

            stop();

            pending.resolve(okJson([]));
            await errorHandled;
            await flush();

            expect(vi.getTimerCount()).toBe(0);
        });

        it("starts at most one poll loop when the websocket errors repeatedly", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            const stop = await provider.watchAddresses(["addr1"], () => {});
            const ws = FakeWebSocket.instances[0];
            mockFetch.mockClear(); // discount the creation-time baseline

            await ws.dispatch("error");
            await ws.dispatch("error");
            await flush();

            // One fallback fetch, not one per error event.
            expect(mockFetch).toHaveBeenCalledTimes(1);

            // And one loop: a single interval yields a single fetch round, not
            // one per stacked timer.
            mockFetch.mockClear();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            expect(mockFetch).toHaveBeenCalledTimes(1);

            stop();
            expect(vi.getTimerCount()).toBe(0);
        });

        it("does not start polling when the websocket errors after stop()", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            const stop = await provider.watchAddresses(["addr1"], () => {});
            mockFetch.mockClear(); // discount the creation-time baseline

            stop();

            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(mockFetch).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });

        it("stops delivering callbacks after stop()", async () => {
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();

            const provider = new EsploraProvider("http://localhost:3000");
            const stop = await provider.watchAddresses(["addr1"], callback);
            const ws = FakeWebSocket.instances[0];

            stop();
            await ws.dispatch("message", wsMessage("addr1", [confirmedTx("aa")]));

            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe("baseline", () => {
        it("reports a deposit that landed while the socket was down", async () => {
            // The gap this closes: the fallback used to treat whatever history
            // it found on startup as "already known", so a deposit arriving
            // during the outage — after the socket died, before polling began —
            // was seeded as old and never reported at all.
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            mockFetch.mockResolvedValue(okJson([confirmedTx("during-outage")]));
            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toEqual([
                expect.objectContaining({ txid: "during-outage" }),
            ]);
        });

        it("does not report transactions that predate the watch", async () => {
            mockFetch.mockResolvedValue(okJson([confirmedTx("old")]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).not.toHaveBeenCalled();
        });

        it("does not re-report a transaction the socket already delivered", async () => {
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            await FakeWebSocket.instances[0].dispatch(
                "message",
                wsMessage("addr1", [confirmedTx("aa")]),
            );
            expect(callback).toHaveBeenCalledTimes(1);

            // The socket dies and the fallback sees the same tx in history.
            mockFetch.mockResolvedValue(okJson([confirmedTx("aa")]));
            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("reports a transaction touching two watched addresses only once", async () => {
            // `getAllTxs` fetches per address and flattens, so one transaction
            // paying two watched addresses comes back twice in a single batch.
            // Boarding makes that ordinary: the watch covers the current and
            // historical rotated addresses at once.
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000", {
                forcePolling: true,
            });
            await provider.watchAddresses(["addr1", "addr2"], callback);

            mockFetch.mockResolvedValue(okJson([confirmedTx("pays-both")]));
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toHaveLength(1);
        });

        it("reports a socket transaction listed under two addresses only once", async () => {
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1", "addr2"], callback);

            const tx = confirmedTx("pays-both");
            await FakeWebSocket.instances[0].dispatch("message", {
                data: JSON.stringify({
                    "multi-address-transactions": {
                        addr1: { confirmed: [tx] },
                        addr2: { confirmed: [tx] },
                    },
                }),
            });

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toHaveLength(1);
        });

        it("warns that deposits may be unreported when it adopts a late baseline", async () => {
            // With no creation-time baseline there is no reference point, so the
            // first successful history fetch has to be adopted as one — and
            // anything that arrived in between is indistinguishable from
            // pre-existing history. That case can't be fixed here, but it must
            // not be silent: a deposit going unreported is exactly the thing an
            // operator needs told.
            mockFetch.mockRejectedValueOnce(new Error("explorer down"));
            mockFetch.mockResolvedValue(okJson([confirmedTx("arrived-in-the-gap")]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).not.toHaveBeenCalled();
            expect(
                warn.mock.calls.some((c) => /may not have been reported/i.test(String(c[0]))),
            ).toBe(true);
        });

        it("keeps watching when the creation-time baseline fetch fails", async () => {
            mockFetch.mockRejectedValueOnce(new Error("explorer down"));
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");

            await provider.watchAddresses(["addr1"], callback);

            // The history baseline was attempted, and its failure was followed
            // by the chain-tip fallback that anchors a late baseline.
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // A failed baseline must degrade, not throw and not go deaf.
            await FakeWebSocket.instances[0].dispatch(
                "message",
                wsMessage("addr1", [confirmedTx("aa")]),
            );
            expect(callback).toHaveBeenCalledTimes(1);
        });
    });

    describe("late baseline anchor", () => {
        // When the creation-time history fetch fails, the chain tip is a second
        // chance at a reference point: it is a far smaller request, so it often
        // survives a timeout that a large address history does not.

        it("reports a transaction confirmed after the watch started", async () => {
            let history: unknown[] = [];
            routeFetch({
                blocks: () => blocksTip(100),
                txs: () => okJson(history),
            });
            // Fail only the creation-time history fetch.
            mockFetch.mockImplementationOnce((url: string) =>
                url.includes("/txs")
                    ? Promise.reject(new Error("history unavailable"))
                    : Promise.resolve(blocksTip(100)),
            );

            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            history = [confirmedTxAt("older", 90), confirmedTxAt("newer", 105)];
            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toEqual([expect.objectContaining({ txid: "newer" })]);
        });

        it("treats an unconfirmed transaction at late baseline as new", async () => {
            // A deposit landing during a short outage is typically still in the
            // mempool. Re-announcing a genuinely pre-existing mempool tx is a
            // duplicate notification for real funds; missing a deposit is not
            // recoverable the same way, so bias towards reporting.
            let history: unknown[] = [];
            routeFetch({ blocks: () => blocksTip(100), txs: () => okJson(history) });
            mockFetch.mockImplementationOnce((url: string) =>
                url.includes("/txs")
                    ? Promise.reject(new Error("history unavailable"))
                    : Promise.resolve(blocksTip(100)),
            );

            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            history = [unconfirmedTx("in-mempool")];
            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toEqual([
                expect.objectContaining({ txid: "in-mempool" }),
            ]);
        });

        it("adopts everything and warns when the chain tip is unavailable too", async () => {
            // Explorer fully down at creation: no history, no tip, no reference
            // point. Unchanged behaviour — adopt silently rather than announce a
            // whole address history, but say so.
            routeFetch({ txs: undefined, blocks: undefined });

            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            routeFetch({ txs: () => okJson([confirmedTxAt("unknowable", 105)]) });
            await FakeWebSocket.instances[0].dispatch("error");
            await flush();

            expect(callback).not.toHaveBeenCalled();
            expect(
                warn.mock.calls.some((c) => /may not have been reported/i.test(String(c[0]))),
            ).toBe(true);
        });
    });

    describe("websocket reconnect", () => {
        const watch = async () => {
            mockFetch.mockResolvedValue(okJson([]));
            const provider = new EsploraProvider("http://localhost:3000");
            const stop = await provider.watchAddresses(["addr1"], () => {});
            mockFetch.mockClear(); // discount the creation-time baseline
            return { stop, socket: () => FakeWebSocket.instances.at(-1)! };
        };

        it("keeps the watch alive when the socket closes without an error", async () => {
            // A clean close — server restart, idle timeout, load balancer
            // cycling — fires `close` and never `error`. Handling only `error`
            // leaves the watch silently dead: no fallback, no retry, no log.
            const { socket } = await watch();

            await socket().dispatch("close");
            await flush();

            expect(mockFetch).toHaveBeenCalledTimes(1); // fell back to polling

            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            expect(FakeWebSocket.instances).toHaveLength(2); // and retried
        });

        it("reconnects and resubscribes its addresses on the new socket", async () => {
            const { socket } = await watch();

            await socket().dispatch("error");
            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

            expect(FakeWebSocket.instances).toHaveLength(2);

            await socket().dispatch("open");
            expect(socket().sent).toHaveLength(1);
            expect(JSON.parse(socket().sent[0])).toEqual({ "track-addresses": ["addr1"] });
        });

        it("retires the HTTP fallback once the socket is back", async () => {
            const { socket } = await watch();

            await socket().dispatch("error");
            await flush();
            expect(mockFetch).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            await socket().dispatch("open");

            // Back on the cheap transport: the expensive full-history loop must
            // not keep running alongside it.
            mockFetch.mockClear();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("does not resurrect a poll loop when the socket returns mid-fetch", async () => {
            // The test above lets the poll cycle settle before reconnecting.
            // Here the socket comes back while a cycle is still suspended on its
            // fetch, so `stopPolling()` clears a timer that does not exist yet
            // and the resuming cycle re-arms itself behind the healthy socket.
            mockFetch.mockResolvedValueOnce(okJson([])); // creation-time baseline
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], () => {});

            const pending = deferred<ReturnType<typeof okJson>>();
            mockFetch.mockReturnValue(pending.promise);

            const errorHandled = FakeWebSocket.instances[0].dispatch("error");
            await flush(); // the poll cycle is now suspended on its fetch

            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            await FakeWebSocket.instances[1].dispatch("open");

            pending.resolve(okJson([]));
            await errorHandled;
            await flush();

            expect(vi.getTimerCount()).toBe(0);

            mockFetch.mockClear();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("does not run two poll loops when the socket fails again after returning", async () => {
            // `stopPolling()` clears `pollStarted`, so a failure arriving while an
            // earlier cycle is still suspended must not start a second loop.
            mockFetch.mockResolvedValueOnce(okJson([])); // creation-time baseline
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], () => {});

            const pending = deferred<ReturnType<typeof okJson>>();
            mockFetch.mockReturnValue(pending.promise);

            const errorHandled = FakeWebSocket.instances[0].dispatch("error");
            await flush();

            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            const reconnected = FakeWebSocket.instances[1];
            await reconnected.dispatch("open");
            await reconnected.dispatch("error"); // fails again straight away

            pending.resolve(okJson([]));
            await errorHandled;
            await flush();

            // One poll loop, so one fetch round per interval — not one per loop.
            // (Counting fetches rather than timers: a pending reconnect is a
            // legitimate timer too, so a raw count would conflate the two.)
            mockFetch.mockClear();
            mockFetch.mockResolvedValue(okJson([]));
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it("falls back to polling and retries when the WebSocket constructor throws", async () => {
            // A sandboxed context can make `new WebSocket(...)` throw outright
            // (SecurityError), which is a different entry point to the fallback
            // than an `error` event on a constructed socket.
            mockFetch.mockResolvedValue(okJson([]));
            let throwOnConstruct = true;
            (globalThis as any).WebSocket = class extends FakeWebSocket {
                constructor(url: string) {
                    super(url);
                    if (throwOnConstruct) throw new Error("SecurityError");
                }
            };

            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], () => {});

            // Covered by HTTP polling despite never getting a socket. Asserted
            // on a *cycle*, not on any fetch: the creation-time baseline would
            // satisfy a bare "was called" even with no polling at all.
            mockFetch.mockClear();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            expect(mockFetch).toHaveBeenCalledTimes(1);

            // And still reaching for the socket rather than settling for polling.
            expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
            throwOnConstruct = false;
        });

        it("delivers messages received on a reconnected socket", async () => {
            mockFetch.mockResolvedValue(okJson([]));
            const callback = vi.fn();
            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], callback);

            await FakeWebSocket.instances[0].dispatch("error");
            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            const reconnected = FakeWebSocket.instances[1];
            await reconnected.dispatch("open");

            await reconnected.dispatch("message", wsMessage("addr1", [confirmedTx("aa")]));

            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("opens only one replacement socket when error and close both fire", async () => {
            const { socket } = await watch();
            const failed = socket();

            await failed.dispatch("error");
            await failed.dispatch("close");
            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

            expect(FakeWebSocket.instances).toHaveLength(2);
        });

        it("backs off between consecutive reconnect attempts", async () => {
            const { socket } = await watch();

            await socket().dispatch("error");
            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            expect(FakeWebSocket.instances).toHaveLength(2);

            await socket().dispatch("error");
            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            expect(FakeWebSocket.instances).toHaveLength(2); // second wait is doubled

            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            expect(FakeWebSocket.instances).toHaveLength(3);
        });

        it("cancels a pending reconnect on stop()", async () => {
            const { stop, socket } = await watch();

            await socket().dispatch("error");
            stop();

            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);

            expect(FakeWebSocket.instances).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("ignores failure events from a socket it has already replaced", async () => {
            const { socket } = await watch();
            const stale = socket();

            await stale.dispatch("error");
            await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
            expect(FakeWebSocket.instances).toHaveLength(2);

            // The retired socket finishing its teardown must not drive another
            // reconnect on top of the live one.
            await stale.dispatch("close");
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);

            expect(FakeWebSocket.instances).toHaveLength(2);
        });
    });

    describe("http fallback", () => {
        const polling = () => new EsploraProvider("http://localhost:3000", { forcePolling: true });

        it("does not report transactions that already existed when polling began", async () => {
            mockFetch.mockResolvedValue(okJson([confirmedTx("old")]));
            const callback = vi.fn();

            await polling().watchAddresses(["addr1"], callback);
            await vi.advanceTimersByTimeAsync(15_000);

            expect(callback).not.toHaveBeenCalled();
        });

        it("reports a transaction that appears after the baseline pass", async () => {
            mockFetch.mockResolvedValue(okJson([confirmedTx("old")]));
            const callback = vi.fn();

            await polling().watchAddresses(["addr1"], callback);

            mockFetch.mockResolvedValue(okJson([confirmedTx("old"), confirmedTx("new")]));
            await vi.advanceTimersByTimeAsync(15_000);

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0]).toEqual([expect.objectContaining({ txid: "new" })]);
        });

        it("backs off and retries after a failed poll cycle, rather than going blind", async () => {
            mockFetch.mockResolvedValueOnce(okJson([])); // creation-time baseline
            mockFetch.mockRejectedValueOnce(new Error("explorer down")); // first cycle
            mockFetch.mockResolvedValue(okJson([]));

            await polling().watchAddresses(["addr1"], () => {});

            // A failed cycle must still leave a retry armed.
            expect(vi.getTimerCount()).toBe(1);
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // One failure doubles the delay, so the plain interval is too early.
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            expect(mockFetch).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        it("warns when it degrades from websocket to HTTP polling", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], () => {});
            await FakeWebSocket.instances[0].dispatch("error");

            // Silent degradation is what let an explorer blip become sustained
            // full-history polling without anyone noticing.
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toMatch(/websocket unavailable.*HTTP polling/i);
        });
    });

    describe("coalescing", () => {
        it("shares a single websocket between concurrent watchers on the same address set", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1", "addr2"], () => {});
            await provider.watchAddresses(["addr1", "addr2"], () => {});

            expect(FakeWebSocket.instances).toHaveLength(1);
        });

        it("fans websocket messages out to every subscriber", async () => {
            mockFetch.mockResolvedValue(okJson([]));
            const first = vi.fn();
            const second = vi.fn();

            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], first);
            await provider.watchAddresses(["addr1"], second);

            await FakeWebSocket.instances[0].dispatch(
                "message",
                wsMessage("addr1", [confirmedTx("aa")]),
            );

            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(1);
            expect(first.mock.calls[0][0]).toEqual([expect.objectContaining({ txid: "aa" })]);
        });

        it("keeps the shared watcher alive until the last subscriber stops", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            const stopFirst = await provider.watchAddresses(["addr1"], () => {});
            const stopSecond = await provider.watchAddresses(["addr1"], () => {});
            const ws = FakeWebSocket.instances[0];

            stopFirst();
            expect(ws.closed).toBe(false);

            stopSecond();
            expect(ws.closed).toBe(true);
        });

        it("ignores a repeated stop() from the same subscriber", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            const stopFirst = await provider.watchAddresses(["addr1"], () => {});
            await provider.watchAddresses(["addr1"], () => {});
            const ws = FakeWebSocket.instances[0];

            stopFirst();
            stopFirst();

            // The second subscriber is still live, so a double-stop from the
            // first must not drop the refcount to zero underneath it.
            expect(ws.closed).toBe(false);
        });

        it("opens a fresh watcher after the previous one was fully released", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            const stop = await provider.watchAddresses(["addr1"], () => {});
            stop();

            // A retired watch must not linger in the registry: handing a new
            // caller the closed transport would leave it silently unwatched.
            const callback = vi.fn();
            await provider.watchAddresses(["addr1"], callback);

            expect(FakeWebSocket.instances).toHaveLength(2);
            expect(FakeWebSocket.instances[1].closed).toBe(false);

            await FakeWebSocket.instances[1].dispatch(
                "message",
                wsMessage("addr1", [confirmedTx("aa")]),
            );
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("does not share between different address sets", async () => {
            mockFetch.mockResolvedValue(okJson([]));

            const provider = new EsploraProvider("http://localhost:3000");
            await provider.watchAddresses(["addr1"], () => {});
            await provider.watchAddresses(["addr2"], () => {});

            expect(FakeWebSocket.instances).toHaveLength(2);
        });
    });
});
