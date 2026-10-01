/**
 * Where the SDK gets its `EventSource`. Node exposes the global only behind
 * `--experimental-eventsource` (24.x), so it must be injectable.
 *
 * Resolution order, per call: per-provider factory, then {@link configureEventSource}, then the
 * global. When none answers, {@link resolveEventSource} throws {@link EventSourceUnavailableError}
 * so callers can tell "no SSE in this environment" (don't reconnect) from "connection dropped".
 */

/**
 * The slice of `EventSource` this SDK actually uses. Structural rather than the DOM type because
 * Node's `eventsource` package and React Native polyfills are not DOM `EventSource`s.
 */
export interface EventSourceLike {
    addEventListener(type: "message" | "error", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message" | "error", listener: (event: MessageEvent) => void): void;
    close(): void;
}

/** Opens an SSE connection to `url`. `new EventSource(url)`, as a value. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/** Options shared by every provider that opens an SSE stream. */
export interface EventSourceCapable {
    /**
     * Per-provider `EventSource`, overriding {@link configureEventSource} and the global. Only
     * needed when one process wants different transports per connection.
     */
    eventSource?: EventSourceFactory;
}

const GUIDANCE =
    "Pass one with configureEventSource(url => new EventSource(url)) — in Node, from the " +
    "`eventsource` package or by running with --experimental-eventsource. In React Native, " +
    "use ExpoArkProvider / ExpoIndexerProvider instead.";

/**
 * No `EventSource` could be resolved, so no SSE stream can be opened. An environment property, so
 * retrying cannot fix it: {@link ContractWatcher} reports it once and stops reconnecting.
 */
export class EventSourceUnavailableError extends Error {
    constructor() {
        super(`no EventSource is available, so server-sent events cannot be opened. ${GUIDANCE}`);
        this.name = "EventSourceUnavailableError";
    }
}

/**
 * Type guard for {@link EventSourceUnavailableError}. Falls back to `name` because custom errors
 * cross the service-worker `postMessage` boundary as plain `Error`s.
 */
export function isEventSourceUnavailableError(error: unknown): error is Error {
    return (
        error instanceof EventSourceUnavailableError ||
        (error instanceof Error && error.name === "EventSourceUnavailableError")
    );
}

let configured: EventSourceFactory | undefined;

/**
 * Set the `EventSource` every provider uses by default. Call once at startup,
 * before opening a wallet; pass `undefined` to go back to the global.
 *
 * @example
 * ```typescript
 * import { EventSource } from "eventsource";
 * configureEventSource((url) => new EventSource(url));
 * ```
 */
export function configureEventSource(factory?: EventSourceFactory): void {
    configured = factory;
}

/** What {@link configureEventSource} last set, if anything. */
export function getConfiguredEventSource(): EventSourceFactory | undefined {
    return configured;
}

/**
 * Resolve the factory to open a stream with, or throw {@link EventSourceUnavailableError}. The
 * global is read per call so a polyfill assigned after import is still seen.
 */
export function resolveEventSource(override?: EventSourceFactory): EventSourceFactory {
    const factory =
        override ??
        configured ??
        (typeof EventSource === "undefined" ? undefined : (url: string) => new EventSource(url));
    if (!factory) throw new EventSourceUnavailableError();
    return factory;
}
