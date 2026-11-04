import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchEventSource, type EventSourceLike } from "../../src/providers/eventSource";

const sseResponse = (
    chunks: string[],
    {
        open = false,
        status = 200,
        signal,
    }: { open?: boolean; status?: number; signal?: AbortSignal } = {},
) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            if (!open) controller.close();
            signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
            );
        },
    });
    return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
};

const stubFetch = (respond: (signal?: AbortSignal) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond(init.signal ?? undefined);
    });
    return calls;
};

const collect = (source: EventSourceLike, type: "message" | "error" | "failure") => {
    const events: MessageEvent[] = [];
    source.addEventListener(type, (event) => events.push(event));
    return events;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => vi.unstubAllGlobals());

describe("FetchEventSource", () => {
    it("dispatches each message, also when a chunk splits one", async () => {
        stubFetch((signal) =>
            sseResponse(['data: {"a":1}\n\nda', 'ta: {"b":2}\n\n'], { open: true, signal }),
        );
        const source = new FetchEventSource("http://ark/v1/txs");
        const messages = collect(source, "message");

        await settle();
        expect(messages.map((event) => event.data)).toEqual(['{"a":1}', '{"b":2}']);
        source.close();
    });

    it("dispatches a named event under its own type", async () => {
        stubFetch((signal) =>
            sseResponse(['id: 7\nevent: failure\ndata: {"code":3}\n\n'], { open: true, signal }),
        );
        const source = new FetchEventSource("http://ark/v1/txs");
        const messages = collect(source, "message");
        const failures = collect(source, "failure");

        await settle();
        expect(failures.map((event) => event.data)).toEqual(['{"code":3}']);
        expect(messages).toEqual([]);
        source.close();
    });

    it("sends the given headers and asks for an event stream", async () => {
        const calls = stubFetch((signal) => sseResponse([], { open: true, signal }));
        const source = new FetchEventSource("http://ark/v1/txs", { "X-Build-Version": "1.2.3" });

        await settle();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("http://ark/v1/txs");
        expect(calls[0].init.headers).toEqual({
            Accept: "text/event-stream",
            "X-Build-Version": "1.2.3",
        });
        source.close();
    });

    it("fires one error when the server refuses the stream", async () => {
        stubFetch(() => sseResponse([], { status: 503 }));
        const source = new FetchEventSource("http://ark/v1/txs");
        const errors = collect(source, "error");

        await settle();
        expect(errors).toHaveLength(1);
    });

    it("fires one error when the stream ends", async () => {
        stubFetch(() => sseResponse(['data: {"a":1}\n\n']));
        const source = new FetchEventSource("http://ark/v1/txs");
        const messages = collect(source, "message");
        const errors = collect(source, "error");

        await settle();
        expect(messages).toHaveLength(1);
        expect(errors).toHaveLength(1);
    });

    it("close() aborts the request and fires no error", async () => {
        const calls = stubFetch((signal) => sseResponse([], { open: true, signal }));
        const source = new FetchEventSource("http://ark/v1/txs");
        const errors = collect(source, "error");

        await settle();
        source.close();
        await settle();
        expect(calls[0].init.signal?.aborted).toBe(true);
        expect(errors).toEqual([]);
    });
});
