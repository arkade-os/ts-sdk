import { version } from "../../package.json";

export const buildVersion = "0.9.9";

/**
 * The SDK's own version string, sent to arkd as `X-SDK-VERSION` so the operator
 * can distinguish client builds. Formatted `ts-sdk/{version}` to namespace it by
 * client. The version is sourced from package.json so it stays in sync with every
 * release bump — unlike {@link buildVersion}, which tracks arkd's compatibility
 * guard rather than this package's version.
 */
export const sdkVersion = `ts-sdk/${version}`;

/**
 * Guarded passthrough to the platform `fetch` with no Arkade-specific headers.
 * Use for any service that is NOT the Ark server (delegate, Esplora, …): those
 * origins reject unknown request headers such as `X-Build-Version` in the CORS
 * preflight.
 */
export function baseFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    if (typeof globalThis.fetch !== "function") {
        throw new Error("Fetch API is not available in this environment.");
    }
    return globalThis.fetch(input, init);
}

/**
 * `fetch` for the Ark server only: adds the `X-Build-Version` compatibility
 * header that arkd's version guard reads, plus the `X-SDK-VERSION` header
 * carrying this package's own version. Do NOT use it for other origins — they
 * reject these custom headers in CORS preflight.
 */
export function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("X-Build-Version", buildVersion);
    headers.set("X-SDK-VERSION", sdkVersion);
    return baseFetch(input, { ...init, headers });
}
