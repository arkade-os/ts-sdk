export async function* readSseFrames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingCR = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            const text = decoder.decode(value, { stream: true });
            if (!text) continue;
            const skipLF = pendingCR && text.startsWith("\n");
            pendingCR = text.endsWith("\r");
            buffer += (skipLF ? text.slice(1) : text).replace(/\r\n?/g, "\n");
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
                let event = "message";
                const data: string[] = [];
                for (const line of block.split("\n")) {
                    if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
                    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
                }
                const joined = data.join("\n");
                if (joined) yield { event: event || "message", data: joined };
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}
