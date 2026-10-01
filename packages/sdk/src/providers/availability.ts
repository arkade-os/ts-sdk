import { FetchError } from "../utils/fetch";
import { isFetchTimeoutError } from "./ark";
import { ProviderUnavailableError } from "./errors";

/**
 * Whether a provider error is a *retryable* availability failure (operator or
 * indexer temporarily unreachable) rather than a terminal one.
 *
 * Retryable:
 *  - {@link ProviderUnavailableError} — already-classified 5xx/429/unavailable
 *    (see e.g. {@link https | RestArkProvider.getInfo}'s non-2xx branch);
 *  - {@link FetchError} — transport-level `fetch` rejection (DNS failure,
 *    connection refused, TLS/CORS), which also carries undici timeouts as its
 *    `cause`;
 *  - {@link isFetchTimeoutError} — header/body timeouts that surface directly.
 *
 * Everything else (4xx, invalid JSON, schema violations, network mismatch,
 * unsupported network) is terminal and returns `false`.
 */
export function isRetryableProviderError(error: unknown): boolean {
    return (
        error instanceof ProviderUnavailableError ||
        error instanceof FetchError ||
        isFetchTimeoutError(error)
    );
}
