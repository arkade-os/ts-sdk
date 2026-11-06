import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchEventSource, type EventSourceLike } from "../../src/providers/eventSource";

const sseResponse = (
    chunks: string[],
    {
        open = false,
        status = 200,
        signal,
        type = "text/event-stream",
        onCancel,
    }: {
        open?: boolean;
        status?: number;
        signal?: AbortSignal;
        type?: string;
        onCancel?: () => void;
    } = {},
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
        cancel: onCancel,
    });
    return new Response(body, { status, headers: { "Content-Type": type } });
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

    it.each([
        ["CR line endings", ["data: a\rdata: b\r\r"]],
        ["CRLF line endings", ["data: a\r\ndata: b\r\n\r\n"]],
        ["a CRLF split across chunks", ["data: a\r", "\ndata: b\r\n\r\n"]],
        ["a CRLF split by an empty chunk", ["data: a\r", "", "\ndata: b\r\n\r\n"]],
    ])("dispatches one message with %s", async (_, chunks) => {
        stubFetch((signal) => sseResponse(chunks, { open: true, signal }));
        const source = new FetchEventSource("http://ark/v1/txs");
        const messages = collect(source, "message");

        await settle();
        expect(messages.map((event) => event.data)).toEqual(["a\nb"]);
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

    it.each([
        ["a Content-Type other than text/event-stream", { status: 200, type: "text/html" }],
        ["a status other than 200", { status: 201, type: "text/event-stream" }],
    ])("fires one error and cancels the body for %s", async (_, { status, type }) => {
        let cancelled = false;
        stubFetch((signal) =>
            sseResponse(["data: a\n\n"], {
                open: true,
                status,
                signal,
                type,
                onCancel: () => {
                    cancelled = true;
                },
            }),
        );
        const source = new FetchEventSource("http://ark/v1/txs");
        const messages = collect(source, "message");
        const errors = collect(source, "error");

        await settle();
        expect(messages).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(cancelled).toBe(true);
        source.close();
    });

    it("accepts a text/event-stream Content-Type with parameters", async () => {
        stubFetch((signal) =>
            sseResponse(["data: a\n\n"], {
                open: true,
                signal,
                type: "text/event-stream; charset=utf-8",
            }),
        );
        const source = new FetchEventSource("http://ark/v1/txs");
        const messages = collect(source, "message");

        await settle();
        expect(messages.map((event) => event.data)).toEqual(["a"]);
        source.close();
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
