import type { EventSourceLike } from "./eventSource";

export type ManagedEventSourceIterator = AsyncGenerator<MessageEvent, void, unknown> & {
    close(): void;
};

function createAbortError(): Error {
    const error = new Error("EventSource closed");
    error.name = "AbortError";
    return error;
}

/**
 * Creates a close-aware EventSource async iterator.
 *
 * Listeners attach eagerly so events are buffered before the first next() call.
 * close() closes the EventSource, removes listeners, and wakes any pending
 * next() even when the browser does not emit an error from EventSource.close().
 */
export function eventSourceIterator(eventSource: EventSourceLike): ManagedEventSourceIterator {
    const messageQueue: MessageEvent[] = [];
    const errorQueue: Error[] = [];
    let messageResolve: ((value: MessageEvent) => void) | null = null;
    let errorResolve: ((error: Error) => void) | null = null;
    let closed = false;
    let cleanedUp = false;

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        eventSource.removeEventListener("message", messageHandler);
        eventSource.removeEventListener("error", errorHandler);
        eventSource.removeEventListener("failure", failureHandler);
    };

    const close = () => {
        if (closed) return;
        closed = true;
        messageQueue.length = 0;
        errorQueue.length = 0;
        eventSource.close();
        cleanup();

        if (errorResolve) {
            const reject = errorResolve;
            messageResolve = null;
            errorResolve = null;
            reject(createAbortError());
        }
    };

    const messageHandler = (event: MessageEvent) => {
        if (closed) return;
        if (messageResolve) {
            const resolve = messageResolve;
            messageResolve = null;
            errorResolve = null;
            resolve(event);
        } else {
            messageQueue.push(event);
        }
    };

    const rejectWith = (error: Error) => {
        if (closed) return;
        if (errorResolve) {
            const reject = errorResolve;
            messageResolve = null;
            errorResolve = null;
            reject(error);
        } else {
            errorQueue.push(error);
        }
    };

    const errorHandler = () => rejectWith(eventSourceError("EventSource error"));

    // arkd sends a refused stream's status (a filter it cannot compile, say) as a
    // named `failure` event before closing; the bare `error` after it says nothing.
    const failureHandler = (event: MessageEvent) => rejectWith(streamFailureError(event.data));

    // Attach listeners immediately so events are buffered
    // even before the caller starts iterating
    eventSource.addEventListener("message", messageHandler);
    eventSource.addEventListener("error", errorHandler);
    eventSource.addEventListener("failure", failureHandler);

    const gen = (async function* () {
        try {
            while (!closed) {
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
                const result = await new Promise<MessageEvent>((resolve, reject) => {
                    messageResolve = resolve;
                    errorResolve = reject;
                }).finally(() => {
                    messageResolve = null;
                    errorResolve = null;
                });

                if (!closed && result) {
                    yield result;
                }
            }
        } finally {
            closed = true;
            cleanup();
            eventSource.close();
        }
    })();

    const origReturn = gen.return.bind(gen);
    const managed = gen as ManagedEventSourceIterator;
    managed.close = close;
    managed.return = (value?: void | PromiseLike<void>) => {
        close();
        return origReturn(value);
    };

    return managed;
}

function eventSourceError(message: string): Error {
    const error = new Error(message);
    error.name = "EventSourceError";
    return error;
}

/** An arkd stream status (`{ code, message }`, or anything unparsed) as an {@link isEventSourceError}. */
export function streamFailureError(data: unknown): Error {
    let message = String(data);
    try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        if (typeof parsed?.message === "string") message = parsed.message;
    } catch {}
    return eventSourceError(`EventSource failure: ${message}`);
}

export function isEventSourceError(error: unknown): error is Error {
    return error instanceof Error && error.name === "EventSourceError";
}
