export const buildVersion = "0.9.9";

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
 * header that arkd's version guard reads. Do NOT use it for other origins —
 * they reject the header in CORS preflight.
 */
export function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("X-Build-Version", buildVersion);
    return baseFetch(input, { ...init, headers });
}
