import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RestArkProvider } from "../src/providers/ark";
import { MockEventSource } from "./mocks/eventSource";

describe("RestArkProvider.getEventStream", () => {
    beforeEach(() => {
        MockEventSource.reset();
        vi.stubGlobal("EventSource", MockEventSource);
        // Keep test output focused if a failure path logs while unwinding.
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("does not open an EventSource until the first iteration", () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        provider.getEventStream(ac.signal, []);
        expect(MockEventSource.instances).toHaveLength(0);
    });

    it("does not leak an EventSource when the iterator is abandoned before iteration", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, []);

        // Mirror the _settleImpl finally path: abort, then force generator cleanup.
        ac.abort();
        await stream.return?.();

        expect(MockEventSource.instances).toHaveLength(0);
    });

    it("closes the EventSource when return() is called during iteration", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, []);

        const pending = stream.next();
        // Yield to let the generator body construct the EventSource and
        // suspend inside the for-await.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].closed).toBe(false);

        await stream.return?.();
        expect(MockEventSource.instances[0].closed).toBe(true);

        // Prevent an unhandled promise warning if the generator rejected.
        await pending.catch(() => {});
    });

    it("closes the EventSource when the signal is aborted during iteration", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, []);

        const pending = stream.next();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].closed).toBe(false);

        ac.abort();
        expect(MockEventSource.instances[0].closed).toBe(true);

        // Drain the generator so the test does not leave a dangling promise;
        // return() unwinds the for-await and resolves the pending next().
        await stream.return?.();
        await pending.catch(() => {});
    });

    it("leaves native EventSource reconnecting on the same settlement stream", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, ["topic-1"]);

        const pending = stream.next();
        await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
        MockEventSource.instances[0].emitError(0);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].closed).toBe(false);
        MockEventSource.instances[0].emitMessage(
            JSON.stringify({ streamStarted: { id: "stream-2" } }),
        );

        await expect(pending).resolves.toEqual({
            done: false,
            value: { type: "stream_started", id: "stream-2" },
        });

        ac.abort();
        await stream.return?.();
        expect(MockEventSource.instances[0].closed).toBe(true);
    });
});

describe("RestArkProvider.getTransactionsStream", () => {
    beforeEach(() => {
        MockEventSource.reset();
        vi.stubGlobal("EventSource", MockEventSource);
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const vtxo = (txid: string) => ({
        outpoint: { txid, vout: 0 },
        amount: "1000",
        script: "51200000",
        createdAt: "1700000000",
        expiresAt: null,
        commitmentTxids: [],
        isPreconfirmed: false,
        isSwept: false,
        isUnrolled: false,
        isSpent: false,
        spentBy: "",
    });

    /** Drive one frame through the stream and return whatever it yielded. */
    const yieldFrame = async (frame: unknown) => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getTransactionsStream(ac.signal);
        const next = stream.next();
        await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
        MockEventSource.instances[0].emitMessage(JSON.stringify(frame));
        const result = await next;
        ac.abort();
        await stream.return?.(undefined);
        return result.value;
    };

    it("yields a sweep_tx frame with the outpoints it swept", async () => {
        const value = await yieldFrame({
            sweepTx: {
                txid: "ab".repeat(32),
                tx: "0200",
                spentVtxos: [vtxo("cd".repeat(32))],
                spendableVtxos: [],
                sweptVtxos: [{ txid: "ef".repeat(32), vout: 1 }],
            },
        });

        expect(value).toEqual({
            sweepTx: expect.objectContaining({
                txid: "ab".repeat(32),
                sweptVtxos: [{ txid: "ef".repeat(32), vout: 1 }],
            }),
        });
        expect(value.sweepTx.spentVtxos[0].outpoint.txid).toBe("cd".repeat(32));
    });

    // proto3 omits an empty repeated field: a sweep that took none of our
    // outputs still has to answer `sweptVtxos`, or every consumer narrows.
    it("gives a sweep_tx frame that swept nothing an empty sweptVtxos", async () => {
        const value = await yieldFrame({
            sweepTx: {
                txid: "ab".repeat(32),
                tx: "0200",
                spentVtxos: [],
                spendableVtxos: [],
            },
        });

        expect(value.sweepTx.sweptVtxos).toEqual([]);
    });

    // The two pre-existing arms now run through the same mapper as sweepTx:
    // assert the whole frame, so a change to the shared mapping cannot quietly
    // reshape them. `sweptVtxos` is off their type; this guards the runtime.
    it.each(["commitmentTx", "arkTx"] as const)(
        "maps a %s frame unchanged, with no sweptVtxos to carry",
        async (arm) => {
            const checkpointTxs = { ["12".repeat(32)]: { txid: "12".repeat(32), tx: "0201" } };
            const value = await yieldFrame({
                [arm]: {
                    txid: "ab".repeat(32),
                    tx: "0200",
                    spentVtxos: [vtxo("cd".repeat(32))],
                    spendableVtxos: [vtxo("ef".repeat(32))],
                    checkpointTxs,
                },
            });

            expect(Object.keys(value)).toEqual([arm]);
            expect(value[arm]).toEqual({
                txid: "ab".repeat(32),
                tx: "0200",
                spentVtxos: [
                    expect.objectContaining({ outpoint: { txid: "cd".repeat(32), vout: 0 } }),
                ],
                spendableVtxos: [
                    expect.objectContaining({ outpoint: { txid: "ef".repeat(32), vout: 0 } }),
                ],
                checkpointTxs,
            });
            expect(value[arm]).not.toHaveProperty("sweptVtxos");
        },
    );
});

describe("RestArkProvider.getInfo transaction limits", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const infoResponse = (body: Record<string, unknown>) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, json: async () => body })),
        );
        return new RestArkProvider("http://ark.test").getInfo();
    };

    it("reads maxTxWeight and maxOpReturnOutputs off the wire", async () => {
        const info = await infoResponse({ maxTxWeight: "40000", maxOpReturnOutputs: "3" });
        expect(info.maxTxWeight).toBe(40_000n);
        expect(info.maxOpReturnOutputs).toBe(3n);
    });

    it("leaves them undefined when the operator advertises neither", async () => {
        // 0n would read as a weight budget of nothing and OP_RETURN forbidden,
        // which an older arkd is not saying.
        const info = await infoResponse({});
        expect(info.maxTxWeight).toBeUndefined();
        expect(info.maxOpReturnOutputs).toBeUndefined();
    });

    it("reads a server-emitted zero as unadvertised, not as a limit of nothing", async () => {
        // Both fields are non-optional int64 on GetInfoResponse and the gateway
        // marshals with EmitUnpopulated, so an arkd that carries them without
        // configuring them sends "0" rather than omitting them. That is the same
        // statement as omitting them, and must not surface as 0n.
        const info = await infoResponse({ maxTxWeight: "0", maxOpReturnOutputs: "0" });
        expect(info.maxTxWeight).toBeUndefined();
        expect(info.maxOpReturnOutputs).toBeUndefined();
    });
});
