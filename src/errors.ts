import type { PendingSwap } from "./types";

/** Options for constructing swap errors. */
interface ErrorOptions {
    /** Custom error message (overrides the default). */
    message?: string;
    /** Whether the swap's funds can still be claimed. */
    isClaimable?: boolean;
    /** Whether the swap's funds can be refunded. */
    isRefundable?: boolean;
    /** The associated pending swap, if available. */
    pendingSwap?: PendingSwap;
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
    public pendingSwap?: PendingSwap;

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
