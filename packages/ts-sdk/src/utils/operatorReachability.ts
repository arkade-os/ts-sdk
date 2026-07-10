import { FetchError } from "./fetch";
import { ArkError } from "../providers/errors";

/**
 * gRPC status codes that mean "the operator is up but not servicing the
 * request right now" — treated as unreachable so the wallet can serve cached
 * state instead of throwing.
 */
const UNAVAILABLE = 14;
const DEADLINE_EXCEEDED = 4;

/**
 * Classify an error as a network-level operator failure (degrade to cached
 * state) vs. a logic/malformed error (propagate).
 *
 * Returns `true` only for signals that definitively mean "could not reach /
 * be serviced by the operator":
 *   - {@link FetchError} — a transport-level reject (DNS failure, connection
 *     refused, TLS/CORS error, timeout) from the base-fetch layer.
 *   - {@link ArkError} with a grpc `UNAVAILABLE` (14) or `DEADLINE_EXCEEDED`
 *     (4) code — the server explicitly reported unavailability.
 *
 * Everything else — a well-formed logic `ArkError` (e.g. `DIGEST_MISMATCH`,
 * bad request), a parse/validation `Error`, or a non-`ArkError` 5xx that
 * arrived as a plain `Error` (its status code is not recoverable) — returns
 * `false` and MUST propagate, so a corrupt response is never silently masked
 * as stale cache.
 */
export function isOperatorUnreachable(err: unknown): boolean {
    if (err instanceof FetchError) {
        return true;
    }
    if (err instanceof ArkError) {
        return err.code === UNAVAILABLE || err.code === DEADLINE_EXCEEDED;
    }
    return false;
}
