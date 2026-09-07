import type { BoltzSwap } from "./types";

/** Options for constructing swap errors. */
interface ErrorOptions {
    /** Custom error message. `undefined` keeps the subclass default, so callers
     *  can forward an optional upstream reason without erasing it. */
    message?: string;
    /** Whether the swap's funds can still be claimed. */
    isClaimable?: boolean;
    /** Whether the swap's funds can be refunded. */
    isRefundable?: boolean;
    /** The associated pending swap, if available. */
    pendingSwap?: BoltzSwap;
    /**
     * Underlying cause. Preserved on the resulting `Error.cause`, so callers
     * that wrap a typed error (e.g. autopilot wrapping `QuoteRejectedError`)
     * can still recover the inner instance for programmatic branching.
     */
    cause?: unknown;
}

/**
 * Base error class for all swap-related errors.
 * Extends Error with swap-specific metadata (`isClaimable`, `isRefundable`, `pendingSwap`).
 */
export class SwapError extends Error {
    /** Whether the swap can still be claimed (default: false). */
    public isClaimable: boolean;
    /** Whether the swap can be refunded (default: false). */
    public isRefundable: boolean;
    /** The pending swap associated with this error, if available. */
    public pendingSwap?: BoltzSwap;

    constructor(options: ErrorOptions = {}) {
        super(
            options.message ?? "Error during swap.",
            options.cause !== undefined ? { cause: options.cause } : undefined,
        );
        this.name = "SwapError";
        this.isClaimable = options.isClaimable ?? false;
        this.isRefundable = options.isRefundable ?? false;
        this.pendingSwap = options.pendingSwap;
    }
}

/** Thrown when a Lightning invoice expires before being paid. The swap may be refundable. */
export class InvoiceExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "The invoice has expired." });
        this.name = "InvoiceExpiredError";
    }
}

/** Thrown when Boltz fails to route the Lightning payment to the destination. Typically refundable. */
export class InvoiceFailedToPayError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({
            ...options,
            message: options.message ?? "The provider failed to pay the invoice",
        });
        this.name = "InvoiceFailedToPayError";
    }
}

/** Thrown when the wallet does not have enough funds to complete the swap. */
export class InsufficientFundsError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "Not enough funds available" });
        this.name = "InsufficientFundsError";
    }
}

/**
 * Thrown for HTTP/network failures when communicating with the Boltz API.
 * Not a SwapError — does not carry swap metadata.
 */
export class NetworkError extends Error {
    /** HTTP status code from the failed request, if available. */
    public statusCode?: number;
    /** Raw error payload from the Boltz API, if available. */
    public errorData?: any;

    constructor(message: string, statusCode?: number, errorData?: any) {
        super(message);
        this.name = "NetworkError";
        this.statusCode = statusCode;
        this.errorData = errorData;
    }
}

/**
 * Thrown when Boltz responds to `GET /v2/swap/{id}` with HTTP 404 and a body
 * matching `{"error":"could not find swap with id: ..."}`. Signals that the
 * configured Boltz instance has no record of this swap — typically because
 * the swap was created against a different Boltz endpoint. Distinct from a
 * generic 404 (route change, proxy misconfig) so the polling loop can drive
 * a per-swap "unknown to provider" counter without conflating it with
 * transient network errors.
 */
export class SwapNotFoundError extends NetworkError {
    /** The swap ID Boltz did not recognise. */
    public readonly swapId: string;

    constructor(swapId: string, errorData?: any) {
        super(
            `Boltz returned 404 for swap '${swapId}': swap unknown to this Boltz instance`,
            404,
            errorData,
        );
        this.name = "SwapNotFoundError";
        this.swapId = swapId;
    }
}

/** Thrown when the Boltz API returns a response that doesn't match the expected schema. */
export class SchemaError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "Invalid API response" });
        this.name = "SchemaError";
    }
}

/** Thrown when a swap exceeds its time limit. May be refundable depending on swap type. */
export class SwapExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "The swap has expired" });
        this.name = "SwapExpiredError";
    }
}

/** Thrown when an on-chain or off-chain transaction fails. */
export class TransactionFailedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "The transaction has failed." });
        this.name = "TransactionFailedError";
    }
}

/**
 * Thrown when a submarine swap's Lightning payment settles but retrieving the
 * preimage from Boltz fails. The payment was made but proof-of-payment is unavailable.
 */
export class PreimageFetchError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({
            ...options,
            message: options.message ?? "The payment settled, but fetching the preimage failed.",
        });
        this.name = "PreimageFetchError";
    }
}

/** Thrown when the lockup transaction fails (e.g. not confirmed or rejected). Typically refundable. */
export class TransactionLockupFailedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "The transaction lockup has failed." });
        this.name = "TransactionLockupFailedError";
    }
}

/** Thrown when a swap has already been refunded. Informational — no further action needed. */
export class TransactionRefundedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "The transaction has been refunded." });
        this.name = "TransactionRefundedError";
    }
}

/**
 * Thrown when no candidate server signer reproduces a swap's lockup address.
 *
 * Typed because callers that probe many keys (restore attribution) must tell an
 * expected mismatch — every key but the owning one — apart from a real failure
 * to rebuild the VHTLC, which would otherwise be swallowed as "not ours".
 */
export class VHTLCAddressMismatchError extends SwapError {
    public readonly swapId: string;
    public readonly lockupAddress: string;

    constructor(options: ErrorOptions & { swapId: string; lockupAddress: string; tried: number }) {
        super({
            ...options,
            message:
                options.message ??
                `Swap ${options.swapId}: VHTLC address mismatch. Expected ${options.lockupAddress}; ` +
                    `no current or deprecated server signer (${options.tried} candidate(s) tried) ` +
                    `reproduced it`,
        });
        this.name = "VHTLCAddressMismatchError";
        this.swapId = options.swapId;
        this.lockupAddress = options.lockupAddress;
    }
}

/**
 * Thrown when a cooperative claim co-signature is requested for a chain swap
 * whose claim side we have not claimed yet.
 *
 * Co-signing is a courtesy: the counterparty can always spend the claim leaf
 * once it holds the preimage, so declining until our own claim is recorded
 * costs it a larger transaction and nothing else. Non-fatal at every call
 * site — the request is re-evaluated while the swap stays claimable.
 *
 * Past the service-worker boundary only `message` survives, so the swap id
 * and the reason are carried there.
 */
export class CooperativeSignRefusedError extends SwapError {
    public readonly swapId: string;

    constructor(options: ErrorOptions & { swapId: string; reason: string }) {
        super({
            ...options,
            message:
                options.message ??
                `Swap ${options.swapId}: not co-signing the counterparty claim — ${options.reason}`,
        });
        this.name = "CooperativeSignRefusedError";
        this.swapId = options.swapId;
    }
}

/**
 * Thrown when a chain swap's claim-side lockup holds less than the agreed
 * amount. The claim is not performed, so the preimage is never disclosed and
 * the funded side stays recoverable through the regular refund paths.
 */
export class LockupAmountMismatchError extends SwapError {
    public readonly swapId: string;
    public readonly expectedAmount: number;
    public readonly lockedAmount: number;

    constructor(
        options: ErrorOptions & { swapId: string; expectedAmount: number; lockedAmount: number },
    ) {
        super({
            ...options,
            message:
                options.message ??
                `Swap ${options.swapId}: claim-side lockup holds ${options.lockedAmount} sats, ` +
                    `below the agreed ${options.expectedAmount} sats — not claiming`,
        });
        this.name = "LockupAmountMismatchError";
        this.swapId = options.swapId;
        this.expectedAmount = options.expectedAmount;
        this.lockedAmount = options.lockedAmount;
    }
}

/**
 * Thrown when a submarine swap's `expectedAmount` exceeds the invoice amount
 * plus the advertised submarine fee schedule. The response of a consistent
 * server always reconciles with its own advertised fees, so the swap is
 * rejected before it is persisted or funded.
 */
export class ExpectedAmountExceededError extends SwapError {
    public readonly swapId: string;
    public readonly expectedAmount: number;
    public readonly maxAcceptable: number;

    constructor(
        options: ErrorOptions & { swapId: string; expectedAmount: number; maxAcceptable: number },
    ) {
        super({
            ...options,
            message:
                options.message ??
                `Swap ${options.swapId}: expected funding amount ${options.expectedAmount} sats ` +
                    `exceeds the invoice amount plus advertised fees (${options.maxAcceptable} sats)`,
        });
        this.name = "ExpectedAmountExceededError";
        this.swapId = options.swapId;
        this.expectedAmount = options.expectedAmount;
        this.maxAcceptable = options.maxAcceptable;
    }
}

/** Reason a `quoteSwap` was rejected before being posted to Boltz. */
export type QuoteRejectionReason =
    | "below_floor"
    | "non_positive"
    | "non_safe_integer"
    | "no_baseline";

// Discriminated by `reason` so each rejection mode statically requires its own
// metadata: below_floor demands both `quotedAmount` and `floor`, non_positive
// and non_safe_integer demand `quotedAmount`, no_baseline carries neither.
type QuoteRejectedOptions = ErrorOptions &
    (
        | { reason: "below_floor"; quotedAmount: number; floor: number }
        | { reason: "non_positive"; quotedAmount: number }
        | { reason: "non_safe_integer"; quotedAmount: number }
        | { reason: "no_baseline" }
    );

/**
 * Thrown when a Boltz-returned chain-swap quote fails local validation
 * (below the acceptable floor, non-positive, or missing a baseline to
 * compare against). The acceptance is never posted on failure.
 */
export class QuoteRejectedError extends SwapError {
    public readonly reason: QuoteRejectionReason;
    public readonly quotedAmount?: number;
    public readonly floor?: number;

    constructor(options: QuoteRejectedOptions) {
        super({
            ...options,
            message: options.message ?? QuoteRejectedError.defaultMessage(options),
        });
        this.name = "QuoteRejectedError";
        this.reason = options.reason;
        this.quotedAmount = "quotedAmount" in options ? options.quotedAmount : undefined;
        this.floor = "floor" in options ? options.floor : undefined;
    }

    private static defaultMessage(options: QuoteRejectedOptions): string {
        switch (options.reason) {
            case "below_floor":
                return `Boltz quote ${options.quotedAmount} is below acceptable floor ${options.floor}`;
            case "non_positive":
                return `Boltz quote ${options.quotedAmount} is not positive`;
            case "non_safe_integer":
                return `Boltz quote ${options.quotedAmount} is not a safe positive satoshi integer`;
            case "no_baseline":
                return "Cannot accept quote: no minAcceptableAmount and no stored pending swap";
        }
    }

    /**
     * Serialize into a plain `Error` whose `.message` carries the full
     * rejection payload as JSON behind a marker prefix. Structured clone
     * (used by `postMessage` between page and service worker) preserves
     * `Error.message` reliably but strips custom `.name` and own properties,
     * so we move the typed data into the message field for transport.
     */
    toTransportError(): Error {
        return new Error(
            QUOTE_REJECTION_TRANSPORT_PREFIX +
                JSON.stringify({
                    reason: this.reason,
                    message: this.message,
                    quotedAmount: this.quotedAmount,
                    floor: this.floor,
                }),
        );
    }

    /**
     * Inverse of `toTransportError`. Returns a real `QuoteRejectedError` if
     * `error` carries the transport prefix, else `null`.
     */
    static fromTransportError(error: unknown): QuoteRejectedError | null {
        if (
            !(error instanceof Error) ||
            !error.message.startsWith(QUOTE_REJECTION_TRANSPORT_PREFIX)
        ) {
            return null;
        }
        const payload = error.message.slice(QUOTE_REJECTION_TRANSPORT_PREFIX.length);
        let data: {
            reason?: unknown;
            message?: unknown;
            quotedAmount?: unknown;
            floor?: unknown;
        };
        try {
            data = JSON.parse(payload);
        } catch {
            return null;
        }
        if (
            typeof data.reason !== "string" ||
            !QUOTE_REJECTION_REASONS.has(data.reason as QuoteRejectionReason)
        ) {
            return null;
        }
        const message = typeof data.message === "string" ? data.message : undefined;
        const reason = data.reason as QuoteRejectionReason;
        const quotedAmount = typeof data.quotedAmount === "number" ? data.quotedAmount : null;
        const floor = typeof data.floor === "number" ? data.floor : null;
        switch (reason) {
            case "below_floor":
                if (quotedAmount === null || floor === null) return null;
                return new QuoteRejectedError({
                    reason,
                    quotedAmount,
                    floor,
                    message,
                });
            case "non_positive":
            case "non_safe_integer":
                if (quotedAmount === null) return null;
                return new QuoteRejectedError({
                    reason,
                    quotedAmount,
                    message,
                });
            case "no_baseline":
                return new QuoteRejectedError({ reason, message });
        }
    }
}

const QUOTE_REJECTION_TRANSPORT_PREFIX = "QUOTE_REJECTED::";

const QUOTE_REJECTION_REASONS: ReadonlySet<QuoteRejectionReason> = new Set([
    "below_floor",
    "non_positive",
    "non_safe_integer",
    "no_baseline",
]);

/**
 * Thrown when the Boltz API rejects a refund request
 * (e.g. outpoint mismatch after an Ark round).
 */
export class BoltzRefundError extends Error {
    constructor(
        message: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = "BoltzRefundError";
    }
}
