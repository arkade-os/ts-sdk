/**
 * Creates an async iterator over EventSource messages that attaches listeners
 * eagerly (at call time) rather than lazily (at first .next() call).
 * This ensures events are buffered immediately, preventing race conditions
 * where events arrive before iteration begins.
 */
export function eventSourceIterator(
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
        error.name = "EventSourceError";
        if (errorResolve) {
            errorResolve(error);
            errorResolve = null;
        } else {
            errorQueue.push(error);
        }
    };

    // Attach listeners immediately so events are buffered
    // even before the caller starts iterating
    eventSource.addEventListener("message", messageHandler);
    eventSource.addEventListener("error", errorHandler);

    return (async function* () {
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
    })();
}
