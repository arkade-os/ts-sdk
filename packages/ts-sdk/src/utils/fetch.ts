import { version } from "../../package.json";

export const buildVersion = "0.9.9";

/** The SDK's own version string, sourced from package.json */
export const sdkVersion = `ts-sdk/${version}`;

/**
 * The version headers arkd's compatibility guard reads, as data ({@link fetch} sets exactly
 * these). Arkade server only: other origins reject them in the CORS preflight.
 */
export const ARKADE_VERSION_HEADERS: Readonly<Record<string, string>> = {
    "X-Build-Version": buildVersion,
    "X-SDK-VERSION": sdkVersion,
};

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
 * Deadline for a read that carries no `AbortSignal` of its own. `fetch` has no default timeout,
 * so a silently dropped connection stays pending, and every retry ladder, queue or mutex built on
 * top of it waits with it.
 */
export const READ_TIMEOUT_MS = 30_000;

let warnedNoTimeoutSupport = false;

/**
 * The signal bounding this request, or `undefined` to leave it unbounded. Only GET/HEAD: an
 * aborted write's outcome is unknown, not failed. A `Request` input is left alone — it always
 * carries a `signal`, so whether its author supplied one can't be read back off it.
 */
function readDeadline(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
    if (init?.signal || input instanceof Request) return undefined;
    const { method } = describeRequest(input, init);
    const verb = method.toUpperCase();
    if (verb !== "GET" && verb !== "HEAD") return undefined;
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(READ_TIMEOUT_MS);
    }

    // Some React Native runtimes lack `AbortSignal.timeout` but have `AbortController`.
    if (typeof AbortController === "function") {
        const controller = new AbortController();
        // Never cleared, so the bound covers the body read too (as natively); aborting a
        // settled request is a no-op, and `unref` keeps it from holding Node open.
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
 * Guarded passthrough to the platform `fetch` with no Arkade-specific headers. Use for any
 * service that is NOT the Ark server (delegate, Esplora, …): those origins reject unknown request
 * headers such as `X-Build-Version` in the CORS preflight. Transport-level rejections are
 * re-thrown as a {@link FetchError}; reads without a caller signal are bounded by
 * {@link READ_TIMEOUT_MS}.
 *
 * **A long-lived request opts out only by supplying its own signal.** On Expo, SSE lands here
 * whenever `expo/fetch` fails to import, and `sseStreamIterator` passing
 * `signal: fetchController.signal` is what prevents a 30-second truncation.
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
 * `fetch` for the Ark server only: adds {@link ARKADE_VERSION_HEADERS}. Do NOT use it for other
 * origins — they reject these custom headers in CORS preflight.
 */
export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(ARKADE_VERSION_HEADERS)) headers.set(name, value);
    return baseFetch(input, { ...init, headers });
}

/** `{ url, method }` of a request, across the `string | URL | Request` input shapes. */
function describeRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
): { url: string; method: string } {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method =
        init?.method !== undefined ? init.method : input instanceof Request ? input.method : "GET";
    return { url, method };
}
