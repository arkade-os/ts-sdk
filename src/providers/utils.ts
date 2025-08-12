export async function* eventSourceIterator(
    eventSource: EventSource
): AsyncGenerator<MessageEvent, void, unknown> {
    const messageQueue: MessageEvent[] = [];
    const errorQueue: Error[] = [];
    let messageResolve: ((value: MessageEvent) => void) | null = null;
    let errorResolve: ((error: Error) => void) | null = null;
    let isClosed = false;

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

    const closeHandler = () => {
        isClosed = true;
        // Resolve any pending promises to unblock the loop
        if (messageResolve) {
            messageResolve(new MessageEvent("close"));
            messageResolve = null;
        }
        if (errorResolve) {
            errorResolve(new Error("EventSource closed"));
            errorResolve = null;
        }
    };

    eventSource.addEventListener("message", messageHandler);
    eventSource.addEventListener("error", errorHandler);
    eventSource.addEventListener("close", closeHandler);

    // Check if EventSource is already closed
    if (eventSource.readyState === EventSource.CLOSED) {
        isClosed = true;
    }

    try {
        while (!isClosed) {
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

            // Check if EventSource is closed before waiting
            if (eventSource.readyState === EventSource.CLOSED) {
                isClosed = true;
                break;
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

            yield result;
        }
    } finally {
        // clean up
        eventSource.removeEventListener("message", messageHandler);
        eventSource.removeEventListener("error", errorHandler);
        eventSource.removeEventListener("close", closeHandler);
    }
}
