import { describe, expect, it } from "vitest";
import { sseStreamIterator } from "../../src/providers/expoUtils";

const fetchOf = (chunks: string[]) =>
    (async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

const read = async (chunks: string[], parse = (data: any) => data) => {
    const values: unknown[] = [];
    const stream = sseStreamIterator(
        "http://ark/v1/txs",
        new AbortController().signal,
        fetchOf(chunks),
        {},
        parse,
    );
    for await (const value of stream) values.push(value);
    return values;
};

describe("sseStreamIterator", () => {
    it("parses message frames as JSON and skips null results", async () => {
        const values = await read(['data: {"heartbeat":{}}\n\ndata: {"a":1}\n\n'], (data) =>
            data.heartbeat ? null : data,
        );
        expect(values).toEqual([{ a: 1 }]);
    });

    it("throws arkd's failure event as a stream failure", async () => {
        await expect(
            read(['event: failure\ndata: {"code":3,"message":"refused"}\n\n']),
        ).rejects.toThrow("EventSource failure: refused");
    });

    it("ignores other named events", async () => {
        expect(await read(['event: other\ndata: {"x":1}\n\ndata: {"a":1}\n\n'])).toEqual([
            { a: 1 },
        ]);
    });

    it("parses a frame's data lines as one message", async () => {
        expect(await read(['data: {"a":\ndata: 1}\n\n'])).toEqual([{ a: 1 }]);
    });
});
