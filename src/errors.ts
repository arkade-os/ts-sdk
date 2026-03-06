import type { PendingSwap } from "./types";

interface ErrorOptions {
    message?: string;
    isClaimable?: boolean;
    isRefundable?: boolean;
    pendingSwap?: PendingSwap;
}

export class SwapError extends Error {
    public isClaimable: boolean;
    public isRefundable: boolean;
    public pendingSwap?: PendingSwap;

    constructor(options: ErrorOptions = {}) {
        super(options.message ?? "Error during swap.");
        this.name = "SwapError";
        this.isClaimable = options.isClaimable ?? false;
        this.isRefundable = options.isRefundable ?? false;
        this.pendingSwap = options.pendingSwap;
    }
}

export class InvoiceExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The invoice has expired.", ...options });
        this.name = "InvoiceExpiredError";
    }
}

export class InvoiceFailedToPayError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({
            message: "The provider failed to pay the invoice",
            ...options,
        });
        this.name = "InvoiceFailedToPayError";
    }
}

export class InsufficientFundsError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "Not enough funds available", ...options });
        this.name = "InsufficientFundsError";
    }
}

export class NetworkError extends Error {
    public statusCode?: number;
    public errorData?: any;

    constructor(message: string, statusCode?: number, errorData?: any) {
        super(message);
        this.name = "NetworkError";
        this.statusCode = statusCode;
        this.errorData = errorData;
    }
}

export class SchemaError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "Invalid API response", ...options });
        this.name = "SchemaError";
    }
}

export class SwapExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The swap has expired", ...options });
        this.name = "SwapExpiredError";
    }
}

export class TransactionFailedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The transaction has failed.", ...options });
        this.name = "TransactionFailedError";
    }
}

export class PreimageFetchError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({
            message: "The payment settled, but fetching the preimage failed.",
            ...options,
        });
        this.name = "PreimageFetchError";
    }
}

export class TransactionLockupFailedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The transaction lockup has failed.", ...options });
        this.name = "TransactionLockupFailedError";
    }
}

export class TransactionRefundedError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ message: "The transaction has been refunded.", ...options });
        this.name = "TransactionRefundedError";
    }
}
