import { describe, expect, it } from "vitest";
import {
    ArkadeError,
    ArkadeErrorName,
    isArkadeError,
    maybeArkadeError,
} from "../src/providers/errors";

describe("maybeArkadeError", () => {
    it("parses a structured ark.v1.ErrorDetails in details[]", () => {
        const body = JSON.stringify({
            code: 9,
            message: "stale",
            details: [
                {
                    "@type": "type.googleapis.com/ark.v1.ErrorDetails",
                    code: 1101,
                    message: "digest mismatch",
                    name: "DIGEST_MISMATCH",
                    metadata: { expected: "abc" },
                },
            ],
        });
        const err = maybeArkadeError(new Error(body));
        expect(err).toBeInstanceOf(ArkadeError);
        expect(err?.name).toBe("DIGEST_MISMATCH");
        expect(err?.metadata).toEqual({ expected: "abc" });
    });

    // arkd's guard interceptors (build-version, digest) run outside the
    // error-detail converter, so their REST errors carry an EMPTY details[] and
    // the structured name only in the top-level message: "NAME (code): message".
    it("falls back to the message prefix when details[] is empty", () => {
        const body = JSON.stringify({
            code: 2,
            message: "BUILD_VERSION_TOO_OLD (48): server requires build version header >= 0.9.10",
            details: [],
        });
        const err = maybeArkadeError(new Error(body));
        expect(err).toBeInstanceOf(ArkadeError);
        expect(err?.name).toBe("BUILD_VERSION_TOO_OLD");
        expect(err?.code).toBe(48);
        expect(err?.message).toBe("server requires build version header >= 0.9.10");
    });

    it("falls back for DIGEST_MISMATCH stripped to the message too", () => {
        const body = JSON.stringify({
            code: 2,
            message: "DIGEST_MISMATCH (1101): server configuration changed",
            details: [],
        });
        expect(maybeArkadeError(new Error(body))?.name).toBe("DIGEST_MISMATCH");
    });

    it("returns undefined for an ordinary message with no NAME (code) prefix", () => {
        const body = JSON.stringify({ code: 2, message: "something went wrong", details: [] });
        expect(maybeArkadeError(new Error(body))).toBeUndefined();
    });

    it("returns undefined for non-JSON / non-Error input", () => {
        expect(maybeArkadeError(new Error("not json"))).toBeUndefined();
        expect(maybeArkadeError("nope" as unknown as Error)).toBeUndefined();
    });
});

describe("isArkadeError", () => {
    it("matches an ArkadeError, optionally narrowing by name", () => {
        const err = new ArkadeError(6, "already spent", ArkadeErrorName.VTXO_ALREADY_SPENT);
        expect(isArkadeError(err)).toBe(true);
        expect(isArkadeError(err, ArkadeErrorName.VTXO_ALREADY_SPENT)).toBe(true);
        expect(isArkadeError(err, ArkadeErrorName.DIGEST_MISMATCH)).toBe(false);
        expect(isArkadeError(new Error("plain"))).toBe(false);
        expect(isArkadeError(undefined)).toBe(false);
    });
});
