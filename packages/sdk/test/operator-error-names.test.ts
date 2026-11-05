import { describe, expect, it } from "vitest";
import {
    ArkError,
    ArkErrorName,
    isArkError,
    isOperatorError,
    maybeArkError,
    maybeOperatorError,
    OperatorError,
    OperatorErrorName,
} from "../src";

describe("deprecated operator error names", () => {
    it("point at the new exports", () => {
        expect(ArkError).toBe(OperatorError);
        expect(ArkErrorName).toBe(OperatorErrorName);
        expect(isArkError).toBe(isOperatorError);
        expect(maybeArkError).toBe(maybeOperatorError);
    });

    it("keep the operator's error names", () => {
        expect(OperatorErrorName.DIGEST_MISMATCH).toBe("DIGEST_MISMATCH");
        expect(OperatorErrorName.INVALID_INTENT_PROOF).toBe("INVALID_INTENT_PROOF");
    });
});
