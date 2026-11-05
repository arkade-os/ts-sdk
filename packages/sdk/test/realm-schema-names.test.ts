import { describe, expect, it } from "vitest";
import {
    ARK_REALM_SCHEMA_VERSION,
    ARKADE_REALM_SCHEMA_VERSION,
    ArkadeExperimentalRealmSchemas,
    ArkadeRealmSchemas,
    ArkExperimentalRealmSchemas,
    ArkRealmSchemas,
    runArkadeRealmMigrations,
    runArkRealmMigrations,
} from "../src/repositories/realm";

describe("deprecated Realm schema names", () => {
    it("point at the new exports", () => {
        expect(ArkRealmSchemas).toBe(ArkadeRealmSchemas);
        expect(ArkExperimentalRealmSchemas).toBe(ArkadeExperimentalRealmSchemas);
        expect(ARK_REALM_SCHEMA_VERSION).toBe(ARKADE_REALM_SCHEMA_VERSION);
        expect(runArkRealmMigrations).toBe(runArkadeRealmMigrations);
    });

    it("leave the stored object names unchanged", () => {
        expect(ArkadeRealmSchemas.map((s) => s.name)).toEqual([
            "ArkVtxo",
            "ArkUtxo",
            "ArkTransaction",
            "ArkWalletState",
            "ArkContract",
        ]);
        expect(ArkadeExperimentalRealmSchemas.map((s) => s.name)).toEqual([
            "ArkIntent",
            "ArkVirtualTx",
            "ArkVtxoBranch",
        ]);
    });
});
