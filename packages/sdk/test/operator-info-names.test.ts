import { describe, expect, it } from "vitest";
import { networkFromArkadeInfo, networkFromOperatorInfo } from "../src";

describe("deprecated operator info names", () => {
    it("point at the new exports", () => {
        expect(networkFromArkadeInfo).toBe(networkFromOperatorInfo);
    });
});
