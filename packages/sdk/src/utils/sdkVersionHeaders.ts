import { version } from "../../package.json";

/** The SDK's own version string, sourced from package.json */
export const sdkVersion = `ts-sdk/${version}`;

/**
 * `X-SDK-VERSION` for an origin other than arkd (the indexer), so it can tell its callers apart.
 * Empty in a runtime with a page or worker origin: there a cross-origin custom header needs a CORS
 * preflight the indexer may refuse, and the browser's own `Origin` already identifies the caller.
 */
export function sdkVersionHeaders(): Record<string, string> {
    const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
    return typeof origin === "string" ? {} : { "X-SDK-VERSION": sdkVersion };
}
