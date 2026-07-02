import { describe, it, expect } from "vitest";
import { ARK_REALM_SCHEMA_VERSION, ArkRealmSchemas } from "../src/repositories/realm/schemas";

describe("Realm schema v3", () => {
    it("bumps version and registers the new schemas", () => {
        expect(ARK_REALM_SCHEMA_VERSION).toBe(3);
        const names = ArkRealmSchemas.map((s) => s.name);
        expect(names).toEqual(
            expect.arrayContaining(["ArkIntent", "ArkVirtualTx", "ArkVtxoBranch"]),
        );
    });
});
