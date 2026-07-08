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
 * Guarded passthrough to the platform `fetch` with no Arkade-specific headers.
 * Use for any service that is NOT the Ark server (delegate, Esplora, …): those
 * origins reject unknown request headers such as `X-Build-Version` in the CORS
 * preflight.
 *
 * Transport-level rejections are re-thrown as a {@link FetchError}.
 */
export function baseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof globalThis.fetch !== "function") {
        throw new Error("Fetch API is not available in this environment.");
    }
    return globalThis.fetch(input, init).catch((cause) => {
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
