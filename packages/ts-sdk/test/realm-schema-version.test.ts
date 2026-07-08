import { describe, it, expect } from "vitest";
import {
    ARK_REALM_SCHEMA_VERSION,
    ArkRealmSchemas,
    ArkExperimentalRealmSchemas,
} from "../src/repositories/realm/schemas";

describe("Realm schema version", () => {
    it("advertises the inert v2 default set, excluding the intent/virtual-tx schemas", () => {
        // Pinned at v2 so upgrading the SDK never migrates a consumer's Realm.
        expect(ARK_REALM_SCHEMA_VERSION).toBe(2);
        const names = ArkRealmSchemas.map((s) => s.name);
        expect(names).not.toContain("ArkIntent");
        expect(names).not.toContain("ArkVirtualTx");
        expect(names).not.toContain("ArkVtxoBranch");
    });

    it("keeps the intent/virtual-tx schemas in the opt-in experimental set", () => {
        const names = ArkExperimentalRealmSchemas.map((s) => s.name);
        expect(names).toEqual(
            expect.arrayContaining(["ArkIntent", "ArkVirtualTx", "ArkVtxoBranch"]),
        );
    });
});
