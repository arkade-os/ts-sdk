import { describe, expect, it } from "vitest";
import { liveArkadeInfo, liveOperatorInfo } from "../src/client/corridors/deps";

describe("deprecated operator info names", () => {
    it("point at the new exports", () => {
        expect(liveArkadeInfo).toBe(liveOperatorInfo);
    });
});
