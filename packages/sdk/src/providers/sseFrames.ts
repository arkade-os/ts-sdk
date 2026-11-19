export async function* readSseFrames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingCR = false;
    let event = "";
    let data: string[] = [];
    try {
        for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) return;
            const text = decoder.decode(chunk, { stream: true });
            if (!text) continue;
            const skipLF = pendingCR && text.startsWith("\n");
            pendingCR = text.endsWith("\r");
            buffer += (skipLF ? text.slice(1) : text).replace(/\r\n?/g, "\n");
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (line === "") {
                    const joined = data.join("\n");
                    if (joined) yield { event: event || "message", data: joined };
                    event = "";
                    data = [];
                    continue;
                }
                const colon = line.indexOf(":");
                const field = colon === -1 ? line : line.slice(0, colon);
                const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
                if (field === "event") event = value;
                else if (field === "data") data.push(value);
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}
