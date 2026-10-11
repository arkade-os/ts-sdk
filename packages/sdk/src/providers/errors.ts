import { FetchError } from "../utils/fetch";

export class ArkError extends Error {
    constructor(
        readonly code: number,
        readonly message: string,
        readonly name: string,
        readonly metadata?: Record<string, string>,
    ) {
        super(message);
    }
}

/**
 * Structured arkd error `name`s the SDK branches on, centralized so call sites don't
 * hardcode string literals. Not an exhaustive mirror of the server's codes — only the
 * ones the SDK acts on.
 */
export const ArkErrorName = {
    DIGEST_MISMATCH: "DIGEST_MISMATCH",
    VTXO_ALREADY_SPENT: "VTXO_ALREADY_SPENT",
    INVALID_TX_FILTER: "INVALID_TX_FILTER",
    TX_FILTERS_LIMIT_EXCEEDED: "TX_FILTERS_LIMIT_EXCEEDED",
    /**
     * A CLTV closure was spent before its absolute locktime matured. `submitTx` only, with
     * metadata `{ locktime, current_locktime, type: "height" | "time" }`. Self-healing, so defer
     * and retry: the server matures a seconds-locktime against the **chain tip block's
     * timestamp**, not wall clock, so a prompt spend is rejected until a later block lands.
     */
    FORFEIT_CLOSURE_LOCKED: "FORFEIT_CLOSURE_LOCKED",
} as const;

export type ArkErrorName = (typeof ArkErrorName)[keyof typeof ArkErrorName];

/**
 * Type guard for a structured {@link ArkError}, optionally narrowing to a cataloged
 * {@link ArkErrorName}; for an uncataloged name, add it there or compare `err.name` after the
 * one-argument form.
 *
 * @example
 * if (isArkError(maybeArkError(err), ArkErrorName.DIGEST_MISMATCH)) { ... }
 */
export function isArkError(error: unknown, name?: ArkErrorName): error is ArkError {
    return error instanceof ArkError && (name === undefined || error.name === name);
}

/**
 * Which remote dependency an availability failure refers to; labels the
 * {@link ProviderUnavailableError} message and `ProviderConnectionState`. Deliberately *not* a
 * field on the error: structured clone across the service-worker `postMessage` boundary keeps
 * `message`, `stack` and `cause` but drops own-properties and normalizes a custom `name` to
 * `"Error"`.
 */
export type ProviderKind = "arkade" | "indexer";

/**
 * A remote provider (Arkade operator or its indexer) is temporarily unreachable: transport
 * failure, timeout, or a 5xx/429. Retryable, unlike terminal config/auth/schema errors, which
 * stay a plain `Error`/{@link ArkError}. The low-level error is kept as {@link Error.cause}.
 */
export class ProviderUnavailableError extends Error {
    /** Always `true`: this error type only ever wraps retryable conditions. */
    readonly retryable = true;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, { cause: options?.cause });
        this.name = "ProviderUnavailableError";
    }
}

/**
 * A response doesn't reconcile with what the SDK submitted or validated (a checkpoint txid not
 * among those submitted, a commitment tx differing from the one validated at tree signing).
 * Terminal: the two are equal by construction in a well-formed exchange. `retryable` and `name`
 * don't cross the SW boundary (see {@link ProviderKind}), so every distinguishing detail belongs
 * in `message`.
 */
export class ServerResponseMismatchError extends Error {
    readonly retryable = false;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, { cause: options?.cause });
        this.name = "ServerResponseMismatchError";
    }
}

/**
 * Throw a {@link ProviderUnavailableError} for a temporary HTTP response (429 or 5xx), else
 * return. Lives at each provider's non-2xx branch because `fetch()` resolves on HTTP errors.
 *
 * Status alone can't classify arkd: behind grpc-gateway, gRPC INTERNAL becomes HTTP 500, so a 500
 * whose `body` decodes to a structured arkd error (e.g. `INTERNAL_ERROR (0): ...already
 * registered by another intent`) is a terminal rejection that must reach the caller as an
 * {@link ArkError}, never be retried; such a body returns without throwing. NArk parity:
 * BuildVersionHandler branches on body content, not status.
 */
export function throwIfHttpUnavailable(
    response: Response,
    kind: ProviderKind,
    body?: string,
): void {
    if (body !== undefined && maybeArkError(new Error(body))) return;
    if (response.status === 429 || response.status >= 500) {
        throw new ProviderUnavailableError(
            `${kind} unavailable: ${response.status} ${response.statusText}`,
        );
    }
}

/**
 * Map a transport-level {@link FetchError} to a {@link ProviderUnavailableError} (original as
 * `cause`); other errors pass through. Returns rather than throws, for
 * `throw toProviderUnavailable(err, kind)`.
 */
export function toProviderUnavailable(err: unknown, kind: ProviderKind): unknown {
    if (err instanceof FetchError) {
        return new ProviderUnavailableError(`${kind} request failed`, { cause: err });
    }
    return err;
}

/**
 * Try to convert an error to an ArkError class, returning undefined if the error is not an ArkError
 * @param error - The error to parse
 * @returns The parsed ArkError, or undefined if the error is not an ArkError
 */
export function maybeArkError(error: any): ArkError | undefined {
    try {
        if (!(error instanceof Error)) return undefined;
        const decoded = JSON.parse(error.message);

        // Preferred: the structured ErrorDetails the server attaches in details[].
        if (Array.isArray(decoded.details)) {
            for (const details of decoded.details) {
                if (!("@type" in details)) continue;
                const type = details["@type"];
                if (type !== "type.googleapis.com/ark.v1.ErrorDetails") continue;

                if (!("code" in details)) continue;

                const code = details.code;

                if (!("message" in details)) continue;
                const message = details.message;

                if (!("name" in details)) continue;
                const name = details.name;

                let metadata: Record<string, string> | undefined;
                if ("metadata" in details && isMetadata(details.metadata)) {
                    metadata = details.metadata;
                }

                return new ArkError(code, message, name, metadata);
            }
        }

        // Fallback: arkd's guard interceptors (build-version, digest) bypass the error-detail
        // converter, so `details[]` is empty and the name appears only in the top-level message
        // as "NAME (code): human message" (no metadata on this path).
        if (typeof decoded.message === "string") {
            const m = decoded.message.match(/^([A-Z][A-Z0-9_]*) \((\d+)\): ([\s\S]*)$/);
            if (m) return new ArkError(Number(m[2]), m[3], m[1]);
        }

        return undefined;
    } catch (e) {
        return undefined;
    }
}

function isMetadata(value: any): value is Record<string, string> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
