import { describe, expect, it } from "vitest";
import { isOperatorUnreachable } from "../src/utils/operatorReachability";
import { FetchError } from "../src/utils/fetch";
import { ArkError } from "../src/providers/errors";

describe("isOperatorUnreachable", () => {
    it("returns true for a transport-level FetchError", () => {
        const err = new FetchError("Network request failed: GET http://op/v1/info", {
            url: "http://op/v1/info",
            method: "GET",
            cause: new TypeError("fetch failed"),
        });
        expect(isOperatorUnreachable(err)).toBe(true);
    });

    it("returns true for an UNAVAILABLE ArkError (grpc code 14)", () => {
        expect(isOperatorUnreachable(new ArkError(14, "unavailable", "UNAVAILABLE"))).toBe(true);
    });

    it("returns true for a DEADLINE_EXCEEDED ArkError (grpc code 4)", () => {
        expect(isOperatorUnreachable(new ArkError(4, "deadline", "DEADLINE_EXCEEDED"))).toBe(true);
    });

    it("returns false for a logic ArkError (e.g. DIGEST_MISMATCH)", () => {
        expect(
            isOperatorUnreachable(new ArkError(1101, "digest mismatch", "DIGEST_MISMATCH")),
        ).toBe(false);
    });

    it("returns false for a plain Error (propagates)", () => {
        expect(isOperatorUnreachable(new Error("Invalid checkpointTapscript from server"))).toBe(
            false,
        );
    });

    it("returns false for non-Error values", () => {
        expect(isOperatorUnreachable(undefined)).toBe(false);
        expect(isOperatorUnreachable("offline")).toBe(false);
        expect(isOperatorUnreachable(null)).toBe(false);
    });
});
