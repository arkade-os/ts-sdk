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

    if (eventSource.readyState === EventSource.CLOSED) {
        throw new Error("EventSource is closed");
    }

    try {
        while (eventSource.readyState !== EventSource.CLOSED) {
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
