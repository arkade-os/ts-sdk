import { version } from "../../package.json";

export const buildVersion = "0.9.9";

/**
 * The SDK's own version string, sourced from package.json
 */
export const sdkVersion = `ts-sdk/${version}`;

/**
 * Wraps a transport-level `fetch` rejection (DNS failure, connection refused,
 * TLS or CORS error) with the request method and URL, preserving the original
 * as {@link Error.cause}.
 */
export class FetchError extends Error {
    /** The request URL that failed, when derivable from the `fetch` input. */
    readonly url?: string;
    /** The HTTP method of the failed request (defaults to `"GET"`). */
    readonly method?: string;

    constructor(message: string, options: { url?: string; method?: string; cause?: unknown }) {
        super(message, { cause: options.cause });
        this.name = "FetchError";
        this.url = options.url;
        this.method = options.method;
    }
}

/**
 * Deadline applied to a read that carries no `AbortSignal` of its own.
 *
 * `fetch` has no default timeout, so a connection the network dropped silently
 * stays pending until the runtime gives up — and every bound built on top of it
 * waits with it. A retry ladder, a bounded queue or a mutex only work if the
 * call underneath them terminates.
 */
export const READ_TIMEOUT_MS = 30_000;

let warnedNoTimeoutSupport = false;

/**
 * The signal bounding this request, or `undefined` to leave it unbounded.
 *
 * Only GET and HEAD get one. A write that is aborted has not necessarily failed
 * — its outcome is unknown — so bounding one converts a stall into a state
 * question its caller may have no way to answer.
 *
 * A `Request` input is always left alone. Every `Request` carries a `signal`
 * whether or not its author supplied one, so "did the caller bring a signal?"
 * cannot be read back off it, and guessing wrong would cancel someone's
 * lifetime for them.
 */
function readDeadline(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
    if (init?.signal || input instanceof Request) return undefined;
    const { method } = describeRequest(input, init);
    const verb = method.toUpperCase();
    if (verb !== "GET" && verb !== "HEAD") return undefined;
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(READ_TIMEOUT_MS);
    }

    // `AbortSignal.timeout` is absent on some React Native runtimes while
    // `AbortController` is not, so fall back rather than silently leaving the
    // read unbounded — which is the exact state this exists to prevent.
    if (typeof AbortController === "function") {
        const controller = new AbortController();
        // Deliberately never cleared, so the bound covers the body read and not
        // just the headers, matching the native path. Aborting an already
        // settled request is a no-op; `unref` keeps it from holding Node open.
        const timer: unknown = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
        (timer as { unref?: () => void })?.unref?.();
        return controller.signal;
    }

    if (!warnedNoTimeoutSupport) {
        warnedNoTimeoutSupport = true;
        console.warn(
            "Neither AbortSignal.timeout nor AbortController is available in this runtime: " +
                "provider reads are UNBOUNDED and READ_TIMEOUT_MS is not being applied.",
        );
    }
    return undefined;
}

/**
 * Guarded passthrough to the platform `fetch` with no Arkade-specific headers.
 * Use for any service that is NOT the Ark server (delegate, Esplora, …): those
 * origins reject unknown request headers such as `X-Build-Version` in the CORS
 * preflight.
 *
 * Reads without a caller-supplied signal are bounded by {@link READ_TIMEOUT_MS}.
 *
 * **A long-lived request opts out by supplying its own signal — that is the only
 * thing keeping this deadline off a stream.** On web, SSE happens to use
 * `EventSource` and never arrives here at all; on Expo it does arrive here
 * whenever `expo/fetch` fails to import and `getExpoFetch` falls back to this
 * module, and `sseStreamIterator` passing `signal: fetchController.signal` is
 * what prevents a 30-second truncation. That signal is load-bearing, not
 * incidental: a streaming caller that omits one gets cut off here.
 *
 * Transport-level rejections are re-thrown as a {@link FetchError}.
 */
export function baseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof globalThis.fetch !== "function") {
        throw new Error("Fetch API is not available in this environment.");
    }
    const signal = readDeadline(input, init);
    return globalThis.fetch(input, signal ? { ...init, signal } : init).catch((cause) => {
        const { url, method } = describeRequest(input, init);
        throw new FetchError(`Network request failed: ${method} ${url}`, { url, method, cause });
    });
}

/**
 * `fetch` for the Ark server only: adds the `X-Build-Version` compatibility
 * header that arkd's version guard reads, plus the `X-SDK-VERSION` header
 * carrying this package's own version. Do NOT use it for other origins — they
 * reject these custom headers in CORS preflight.
 */
export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("X-Build-Version", buildVersion);
    headers.set("X-SDK-VERSION", sdkVersion);
    return baseFetch(input, { ...init, headers });
}

/**
 * Derive a human-readable `{ url, method }` for a failed request from the
 * `fetch` arguments, handling the `string | URL | Request` input shapes. The
 * `init.method` wins, then a `Request`'s own method, defaulting to `"GET"`.
 */
function describeRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
): { url: string; method: string } {
    let url: string;
    if (typeof input === "string") {
        url = input;
    } else if (input instanceof URL) {
        url = input.href;
    } else {
        url = input.url;
    }

    let method: string;
    if (init?.method !== undefined) {
        method = init.method;
    } else if (input instanceof Request) {
        method = input.method;
    } else {
        method = "GET";
    }

    return { url, method };
}
