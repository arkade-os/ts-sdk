/**
 * Where the SDK gets its `EventSource`.
 *
 * Every server-sent-events stream this SDK opens — settlement events, the tx
 * feed, the indexer script subscription — needs one, and until now each site
 * reached for the global. That works in browsers and, via
 * {@link ExpoArkProvider}/{@link ExpoIndexerProvider}, in React Native. It does
 * NOT work in Node, which exposes `EventSource` only behind
 * `--experimental-eventsource` (24.x) — so a CLI, a server-side wallet or a
 * background worker got a `ReferenceError` out of the stream and everything
 * event-driven degraded to whatever polling happened to be running.
 *
 * Resolution order, per call: an explicit per-provider factory, then whatever
 * {@link configureEventSource} was given, then the global. When none answers,
 * {@link resolveEventSource} throws {@link EventSourceUnavailableError} rather
 * than a bare `ReferenceError`, so callers can tell "this environment has no
 * SSE" from "the connection dropped" — a distinction that matters, because the
 * first is not worth reconnecting for and the second is.
 */

/** Opens an SSE connection to `url`. `new EventSource(url)`, as a value. */
export type EventSourceFactory = (url: string) => EventSource;

/** Options shared by every provider that opens an SSE stream. */
export interface EventSourceCapable {
    /**
     * Where this provider gets its `EventSource`, overriding
     * {@link configureEventSource} and the global. Use it when one process
     * needs different transports per connection; otherwise configure once.
     */
    eventSource?: EventSourceFactory;
}

const GUIDANCE =
    "Pass one with configureEventSource(url => new EventSource(url)) — in Node, from the " +
    "`eventsource` package or by running with --experimental-eventsource. In React Native, " +
    "use ExpoArkProvider / ExpoIndexerProvider instead.";

/**
 * No `EventSource` could be resolved, so no SSE stream can be opened.
 *
 * A property of the environment, not of the connection: retrying cannot fix it,
 * which is why {@link ContractWatcher} reports it once and stops reconnecting
 * instead of looping on it.
 */
export class EventSourceUnavailableError extends Error {
    constructor() {
        super(`no EventSource is available, so server-sent events cannot be opened. ${GUIDANCE}`);
        this.name = "EventSourceUnavailableError";
    }
}

/**
 * Type guard for {@link EventSourceUnavailableError}.
 *
 * Falls back to the `name` because a custom error crossing the service-worker
 * `postMessage` boundary arrives as a plain `Error` — the same reason
 * `ProviderUnavailableError` keeps its state in the message.
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
 * This exists because the provider-level option cannot reach providers the SDK
 * builds for you — `Wallet.create({ arkServerUrl })` constructs both itself.
 *
 * @example
 * ```typescript
 * import { EventSource } from "eventsource";
 * configureEventSource((url) => new EventSource(url) as unknown as EventSource);
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
 * Resolve the factory to open a stream with, or throw
 * {@link EventSourceUnavailableError}.
 *
 * The global is read on every call rather than captured at module load: a test
 * (or a polyfill) that assigns `globalThis.EventSource` after import must still
 * be seen.
 */
export function resolveEventSource(override?: EventSourceFactory): EventSourceFactory {
    const factory =
        override ??
        configured ??
        (typeof EventSource === "undefined" ? undefined : (url: string) => new EventSource(url));
    if (!factory) throw new EventSourceUnavailableError();
    return factory;
}
