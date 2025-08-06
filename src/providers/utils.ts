export function eventSourceIterator(
    eventSource: EventSource
): AsyncIterableIterator<MessageEvent> {
    const messageQueue: MessageEvent[] = [];
    const errorQueue: Error[] = [];
    let messageResolve: ((value: IteratorResult<MessageEvent>) => void) | null =
        null;
    let errorResolve: ((value: IteratorResult<MessageEvent>) => void) | null =
        null;

    const messageHandler = (event: MessageEvent) => {
        if (messageResolve) {
            messageResolve({ value: event, done: false });
            messageResolve = null;
        } else {
            messageQueue.push(event);
        }
    };

    const errorHandler = () => {
        const error = new Error("EventSource error");

        if (errorResolve) {
            errorResolve({ value: error as any, done: false });
            errorResolve = null;
        } else {
            errorQueue.push(error);
        }
    };

    eventSource.addEventListener("message", messageHandler);
    eventSource.addEventListener("error", errorHandler);

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        async next(): Promise<IteratorResult<MessageEvent>> {
            // if we have queued messages, return the first one, remove it from the queue
            if (messageQueue.length > 0) {
                const event = messageQueue.shift()!;
                return { value: event, done: false };
            }

            // if we have queued errors, throw the first one, remove it from the queue
            if (errorQueue.length > 0) {
                const error = errorQueue.shift()!;
                throw error;
            }

            // wait for the next message or error
            return new Promise((resolve, reject) => {
                messageResolve = resolve;
                errorResolve = reject;
            }).finally(() => {
                messageResolve = null;
                errorResolve = null;
            }) as Promise<IteratorResult<MessageEvent>>;
        },
        return() {
            // clean up
            eventSource.removeEventListener("message", messageHandler);
            eventSource.removeEventListener("error", errorHandler);
            return Promise.resolve({ value: undefined, done: true });
        },
    };
}
