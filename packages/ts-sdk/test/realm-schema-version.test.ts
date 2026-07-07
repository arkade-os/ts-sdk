import { describe, it, expect } from "vitest";
import { ARK_REALM_SCHEMA_VERSION, ArkRealmSchemas } from "../src/repositories/realm/schemas";

describe("Realm schema version", () => {
    it("tracks the current version and registers the intent/virtual-tx schemas", () => {
        expect(ARK_REALM_SCHEMA_VERSION).toBe(4);
        const names = ArkRealmSchemas.map((s) => s.name);
        expect(names).toEqual(
            expect.arrayContaining(["ArkIntent", "ArkVirtualTx", "ArkVtxoBranch"]),
        );
    });
});
