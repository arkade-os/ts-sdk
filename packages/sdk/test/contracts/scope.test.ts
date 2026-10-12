import { describe, expect, it } from "vitest";
import { isOnchainScoped, scopeOf } from "../../src/contracts/scope";
import type { Contract } from "../../src/contracts/types";

const base = { params: {}, script: "51", address: "a", state: "active", createdAt: 0 } as const;

describe("contract scope", () => {
    it("defaults from the handler", () => {
        expect(scopeOf({ ...base, type: "boarding" } as Contract)).toBe("onchain");
        expect(scopeOf({ ...base, type: "default" } as Contract)).toBe("offchain");
        expect(scopeOf({ ...base, type: "unknown-type" } as Contract)).toBe("offchain");
    });

    it("explicit scope wins", () => {
        expect(scopeOf({ ...base, type: "vhtlc", scope: "both" } as Contract)).toBe("both");
    });

    it("isOnchainScoped", () => {
        expect(isOnchainScoped({ ...base, type: "boarding" } as Contract)).toBe(true);
        expect(isOnchainScoped({ ...base, type: "default", scope: "both" } as Contract)).toBe(true);
        expect(isOnchainScoped({ ...base, type: "default" } as Contract)).toBe(false);
    });
});
