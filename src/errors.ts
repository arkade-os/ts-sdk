import type { BoltzSwap } from "./types";

/** Options for constructing swap errors. */
interface ErrorOptions {
    /** Custom error message (overrides the default). */
    message?: string;
    /** Whether the swap's funds can still be claimed. */
    isClaimable?: boolean;
    /** Whether the swap's funds can be refunded. */
    isRefundable?: boolean;
    /** The associated pending swap, if available. */
    pendingSwap?: BoltzSwap;
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
        super(options.message ?? "Error during swap.");
        this.name = "SwapError";
        this.isClaimable = options.isClaimable ?? false;
        this.isRefundable = options.isRefundable ?? false;
        this.pendingSwap = options.pendingSwap;
    }
}

/** Thrown when a Lightning invoice expires before being paid. The swap may be refundable. */
export class InvoiceExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The invoice has expired.", ...options });
        this.name = "InvoiceExpiredError";
    }
}

/** Thrown when Boltz fails to route the Lightning payment to the destination. Typically refundable. */
export class InvoiceFailedToPayError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({
            message: "The provider failed to pay the invoice",
            ...options,
        });
        this.name = "InvoiceFailedToPayError";
    }
}

/** Thrown when the wallet does not have enough funds to complete the swap. */
export class InsufficientFundsError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "Not enough funds available", ...options });
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
            errorData
        );
        this.name = "SwapNotFoundError";
        this.swapId = swapId;
    }
}

/** Thrown when the Boltz API returns a response that doesn't match the expected schema. */
export class SchemaError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "Invalid API response", ...options });
        this.name = "SchemaError";
    }
}

/** Thrown when a swap exceeds its time limit. May be refundable depending on swap type. */
export class SwapExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The swap has expired", ...options });
        this.name = "SwapExpiredError";
    }
}

/** Thrown when an on-chain or off-chain transaction fails. */
export class TransactionFailedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The transaction has failed.", ...options });
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
            message: "The payment settled, but fetching the preimage failed.",
            ...options,
        });
        this.name = "PreimageFetchError";
    }
}

/** Thrown when the lockup transaction fails (e.g. not confirmed or rejected). Typically refundable. */
export class TransactionLockupFailedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The transaction lockup has failed.", ...options });
        this.name = "TransactionLockupFailedError";
    }
}

/** Thrown when a swap has already been refunded. Informational — no further action needed. */
export class TransactionRefundedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The transaction has been refunded.", ...options });
        this.name = "TransactionRefundedError";
    }
}

/** Reason a `quoteSwap` was rejected before being posted to Boltz. */
export type QuoteRejectionReason =
    | "below_floor"
    | "non_positive"
    | "no_baseline";

// Discriminated by `reason` so each rejection mode statically requires its own
// metadata: below_floor demands both `quotedAmount` and `floor`, non_positive
// demands `quotedAmount`, no_baseline carries neither.
type QuoteRejectedOptions = ErrorOptions &
    (
        | { reason: "below_floor"; quotedAmount: number; floor: number }
        | { reason: "non_positive"; quotedAmount: number }
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
            message:
                options.message ??
                QuoteRejectedError.defaultMessage(options),
            ...options,
        });
        this.name = "QuoteRejectedError";
        this.reason = options.reason;
        this.quotedAmount =
            "quotedAmount" in options ? options.quotedAmount : undefined;
        this.floor = "floor" in options ? options.floor : undefined;
    }

    private static defaultMessage(options: QuoteRejectedOptions): string {
        switch (options.reason) {
            case "below_floor":
                return `Boltz quote ${options.quotedAmount} is below acceptable floor ${options.floor}`;
            case "non_positive":
                return `Boltz quote ${options.quotedAmount} is not positive`;
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
                })
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
        const payload = error.message.slice(
            QUOTE_REJECTION_TRANSPORT_PREFIX.length
        );
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
        const message =
            typeof data.message === "string" ? data.message : undefined;
        const reason = data.reason as QuoteRejectionReason;
        const quotedAmount =
            typeof data.quotedAmount === "number" ? data.quotedAmount : null;
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
    "no_baseline",
]);

/**
 * Thrown when the Boltz API rejects a refund request
 * (e.g. outpoint mismatch after an Ark round).
 */
export class BoltzRefundError extends Error {
    constructor(
        message: string,
        public override readonly cause?: unknown
    ) {
        super(message);
        this.name = "BoltzRefundError";
    }
}
