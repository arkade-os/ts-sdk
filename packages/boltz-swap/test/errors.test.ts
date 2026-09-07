import { describe, it, expect } from "vitest";
import {
    InvoiceExpiredError,
    QuoteRejectedError,
    SwapError,
    TransactionFailedError,
} from "../src/errors";

describe("swap errors", () => {
    // Callers forward an optional upstream reason (`data.failureReason`), so an
    // explicit `undefined` must not fall through to SwapError's generic default.
    it.each([
        [() => new TransactionFailedError({ message: undefined }), "The transaction has failed."],
        [() => new InvoiceExpiredError({ message: undefined }), "The invoice has expired."],
        [
            () => new QuoteRejectedError({ reason: "no_baseline", message: undefined }),
            "Cannot accept quote: no minAcceptableAmount and no stored pending swap",
        ],
    ])("keeps the subclass default when message is undefined", (build, expected) => {
        expect(build().message).toBe(expected);
    });

    it("still honours an explicit message and the base default", () => {
        expect(new TransactionFailedError({ message: "boltz said no" }).message).toBe(
            "boltz said no",
        );
        expect(new SwapError().message).toBe("Error during swap.");
    });

    it("preserves swap metadata alongside the defaulted message", () => {
        const err = new TransactionFailedError({ message: undefined, isRefundable: true });
        expect(err.message).toBe("The transaction has failed.");
        expect(err.isRefundable).toBe(true);
    });
});
