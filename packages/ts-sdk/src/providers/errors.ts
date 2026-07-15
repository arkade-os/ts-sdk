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
} as const;

export type ArkErrorName = (typeof ArkErrorName)[keyof typeof ArkErrorName];

/**
 * Type guard for a structured {@link ArkError}, optionally narrowing to a specific
 * `name`. Prefer it over comparing `err.name` literals.
 *
 * `name` accepts only cataloged {@link ArkErrorName} values; to branch on a name the
 * catalog does not cover, either add it there or compare `err.name` after guarding
 * with the one-argument form.
 *
 * @example
 * if (isArkError(maybeArkError(err), ArkErrorName.DIGEST_MISMATCH)) { ... }
 */
export function isArkError(error: unknown, name?: ArkErrorName): error is ArkError {
    return error instanceof ArkError && (name === undefined || error.name === name);
}

/**
 * Which remote dependency an availability failure refers to. Used to label the
 * {@link ProviderUnavailableError} message and the wallet's
 * `ProviderConnectionState`; it is deliberately *not* carried as a structured
 * field on the error, since custom `Error` own-properties do not survive the
 * service-worker `postMessage` boundary (only `name`/`message`/`cause` do).
 */
export type ProviderKind = "arkade" | "indexer";

/**
 * A remote provider (Arkade operator or its indexer) is temporarily
 * unreachable. This is a *retryable* condition — transport failure, request
 * timeout, or a 5xx/429-style temporary HTTP response — as opposed to a
 * terminal configuration/authorization/schema error, which stays a plain
 * `Error`/{@link ArkError}. The original low-level error is preserved as
 * {@link Error.cause}.
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
 * Throw a typed {@link ProviderUnavailableError} for a temporary HTTP response
 * (429 rate-limit or any 5xx), otherwise return. `fetch()` resolves — rather
 * than rejects — on HTTP error status, so status-code classification has to live
 * at each provider's non-2xx branch, not in the transport wrapper. 4xx and other
 * responses are left to the caller to treat as terminal.
 *
 * Status alone is not enough to classify an arkd response, though: arkd sits
 * behind grpc-gateway, which maps application-level gRPC errors onto HTTP status
 * codes across the whole range — gRPC INTERNAL becomes HTTP 500, for instance. So
 * a 5xx does not by itself mean the operator is unavailable: a 500 whose body
 * carries a structured arkd error (e.g. `INTERNAL_ERROR (0): ...already registered
 * by another intent`) is a deliberate, terminal rejection that must reach the
 * caller as an {@link ArkError}, never be retried. When `body` is provided and
 * decodes to a structured arkd error, this returns without throwing; classify by
 * status only for a bodyless call or a non-structured body (a bare proxy/gateway
 * failure). Mirrors NArk's BuildVersionHandler, which branches on body content,
 * not status.
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
 * Map a transport-level {@link FetchError} (server unreachable) to a typed
 * {@link ProviderUnavailableError}, preserving the original as `cause`; return
 * any other error unchanged. Returns the error to `throw` rather than throwing,
 * so a `catch` block can `throw toProviderUnavailable(err, kind)`.
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

        // Fallback: arkd's guard interceptors (build-version, digest) run outside
        // the error-detail converter, so their REST errors arrive with an empty
        // `details[]` and the structured name only in the top-level message, as
        // "NAME (code): human message". Recover the name and code so callers can
        // still branch on the error name (metadata is unavailable on this path).
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
