import { describe, expect, it } from "vitest";
import { readSseFrames } from "../../src/providers/sseFrames";

const bodyOf = (chunks: string[], { open = false, onCancel = () => {} } = {}) => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            if (!open) controller.close();
        },
        cancel: onCancel,
    });
};

const framesOf = async (chunks: string[]) => {
    const frames: { event: string; data: string }[] = [];
    for await (const frame of readSseFrames(bodyOf(chunks))) frames.push(frame);
    return frames;
};

describe("readSseFrames", () => {
    it("yields each frame, also when a chunk splits one", async () => {
        expect(await framesOf(['data: {"a":1}\n\nda', 'ta: {"b":2}\n\n'])).toEqual([
            { event: "message", data: '{"a":1}' },
            { event: "message", data: '{"b":2}' },
        ]);
    });

    it("names a frame by its event field and ignores id, retry and comment lines", async () => {
        expect(
            await framesOf([': hi\nid: 7\nretry: 10\nevent: failure\ndata: {"code":3}\n\n']),
        ).toEqual([{ event: "failure", data: '{"code":3}' }]);
    });

    it("names a frame with an empty event field message", async () => {
        expect(await framesOf(["event:\ndata: a\n\n"])).toEqual([{ event: "message", data: "a" }]);
    });

    it("resets the event name on a bare event line", async () => {
        expect(await framesOf(["event: failure\nevent\ndata: a\n\n"])).toEqual([
            { event: "message", data: "a" },
        ]);
    });

    it("adds an empty data line for a bare data line", async () => {
        expect(await framesOf(["data: a\ndata\n\n"])).toEqual([{ event: "message", data: "a\n" }]);
    });

    it("strips only the first space from an event name", async () => {
        expect(await framesOf(["event:  failure \ndata: a\n\n"])).toEqual([
            { event: " failure ", data: "a" },
        ]);
    });

    it.each([
        ["LF line endings", ["data: a\ndata: b\n\n"]],
        ["CR line endings", ["data: a\rdata: b\r\r"]],
        ["CRLF line endings", ["data: a\r\ndata: b\r\n\r\n"]],
        ["a CRLF split across chunks", ["data: a\r", "\ndata: b\r\n\r\n"]],
        ["a CRLF split by an empty chunk", ["data: a\r", "", "\ndata: b\r\n\r\n"]],
    ])("joins a frame's data lines with %s", async (_, chunks) => {
        expect(await framesOf(chunks)).toEqual([{ event: "message", data: "a\nb" }]);
    });

    it("skips a frame with empty data, such as arkd's end-of-stream frame", async () => {
        expect(await framesOf(["id: EOS\nevent: EOS\ndata: \n\ndata: a\n\n"])).toEqual([
            { event: "message", data: "a" },
        ]);
    });

    it("cancels the body when the consumer stops early", async () => {
        let cancelled = false;
        const body = bodyOf(["data: a\n\ndata: b\n\n"], {
            open: true,
            onCancel: () => {
                cancelled = true;
            },
        });
        for await (const frame of readSseFrames(body)) {
            expect(frame.data).toBe("a");
            break;
        }
        expect(cancelled).toBe(true);
    });
});
