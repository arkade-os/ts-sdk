/** Raised only while a timed send can still prove `submitTx` was not invoked. */
export class SendDeadlineExceededError extends Error {
    constructor(validUntil: number) {
        super(`Send deadline ${validUntil} expired before provider submission`);
        this.name = "SendDeadlineExceededError";
    }
}

export function captureSendDeadline(value: unknown, required = false): number | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError("validUntil must be a positive safe integer UNIX timestamp in seconds");
    }
    return value;
}

export function assertSendDeadline(validUntil?: number): void {
    if (validUntil !== undefined && Date.now() / 1000 >= validUntil) {
        throw new SendDeadlineExceededError(validUntil);
    }
}
