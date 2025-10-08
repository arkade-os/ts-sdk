export async function* eventSourceIterator(
    eventSource: EventSource
): AsyncGenerator<MessageEvent, void, unknown> {
    const messageQueue: MessageEvent[] = [];
    const errorQueue: Error[] = [];
    let messageResolve: ((value: MessageEvent) => void) | null = null;
    let errorResolve: ((error: Error) => void) | null = null;

    const messageHandler = (event: MessageEvent) => {
        if (messageResolve) {
            messageResolve(event);
            messageResolve = null;
        } else {
            messageQueue.push(event);
        }
    };

    const errorHandler = () => {
        const error = new Error("EventSource error");

        if (errorResolve) {
            errorResolve(error);
            errorResolve = null;
        } else {
            errorQueue.push(error);
        }
    };

    eventSource.addEventListener("message", messageHandler);
    eventSource.addEventListener("error", errorHandler);

    try {
        while (true) {
            // if we have queued messages, yield the first one, remove it from the queue
            if (messageQueue.length > 0) {
                yield messageQueue.shift()!;
                continue;
            }

            // if we have queued errors, throw the first one, remove it from the queue
            if (errorQueue.length > 0) {
                const error = errorQueue.shift()!;
                throw error;
            }

            // wait for the next message or error
            const result = await new Promise<MessageEvent>(
                (resolve, reject) => {
                    messageResolve = resolve;
                    errorResolve = reject;
                }
            ).finally(() => {
                messageResolve = null;
                errorResolve = null;
            });

            if (result) {
                yield result;
            }
        }
    } finally {
        // clean up
        eventSource.removeEventListener("message", messageHandler);
        eventSource.removeEventListener("error", errorHandler);
    }
}

/**
 * Dynamically imports expo/fetch with fallback to standard fetch.
 * @returns A fetch function suitable for SSE streaming
 */
export async function getExpoFetch(options?: {
    requireExpo?: boolean;
}): Promise<typeof fetch> {
    const requireExpo = options?.requireExpo ?? false;

    try {
        const expoFetchModule = await import("expo/fetch");
        console.debug("Using expo/fetch for streaming");
        return expoFetchModule.fetch as unknown as typeof fetch;
    } catch (error) {
        if (requireExpo) {
            throw new Error(
                "expo/fetch is unavailable in this environment. " +
                    "Please ensure expo/fetch is installed and properly configured."
            );
        }

        console.warn(
            "Using standard fetch instead of expo/fetch. " +
                "Streaming may not be fully supported in some environments.",
            error
        );
        return fetch;
    }
}

/**
 * Generic SSE stream processor using fetch API with ReadableStream.
 * Handles SSE format parsing, buffer management, and abort signals.
 *
 * @param url - The SSE endpoint URL
 * @param abortSignal - Signal to abort the stream
 * @param fetchFn - Fetch function to use (defaults to standard fetch)
 * @param headers - Additional headers to send
 * @param parseData - Function to parse and yield data from SSE events
 */
export async function* sseStreamIterator<T>(
    url: string,
    abortSignal: AbortSignal,
    fetchFn: typeof fetch,
    headers: Record<string, string>,
    parseData: (data: any) => T | null
): AsyncGenerator<T, void, unknown> {
    const fetchController = new AbortController();
    const cleanup = () => fetchController.abort();
    abortSignal?.addEventListener("abort", cleanup, { once: true });

    try {
        const response = await fetchFn(url, {
            headers: {
                Accept: "text/event-stream",
                ...headers,
            },
            signal: fetchController.signal,
        });

        if (!response.ok) {
            throw new Error(
                `Unexpected status ${response.status} when fetching SSE stream`
            );
        }

        if (!response.body) {
            throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!abortSignal?.aborted) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");

            for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                if (line.startsWith("data:")) {
                    const jsonStr = line.substring(5).trim();
                    if (!jsonStr) continue;

                    try {
                        const data = JSON.parse(jsonStr);
                        const parsed = parseData(data);
                        if (parsed !== null) {
                            yield parsed;
                        }
                    } catch (parseError) {
                        console.error("Failed to parse SSE data:", parseError);
                        throw parseError;
                    }
                }
            }

            buffer = lines[lines.length - 1];
        }
    } finally {
        abortSignal?.removeEventListener("abort", cleanup);
    }
}
