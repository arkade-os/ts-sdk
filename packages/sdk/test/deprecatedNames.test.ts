import { describe, expect, it } from "vitest";
import * as sdk from "../src";
import * as realm from "../src/repositories/realm";
import * as payment from "../src/payment";

// Each old name must be the same object as its replacement, so `instanceof` and identity checks keep working.
const pairs: [unknown, unknown][] = [
    [sdk.ArkAddress, sdk.ArkadeAddress],
    [sdk.RestArkProvider, sdk.RestArkadeProvider],
    [sdk.CachingArkProvider, sdk.CachingArkadeProvider],
    [sdk.ArkError, sdk.ArkadeError],
    [sdk.ArkErrorName, sdk.ArkadeErrorName],
    [sdk.ArkNote, sdk.ArkadeNote],
    [sdk.ArkPsbtFieldKey, sdk.ArkadePsbtFieldKey],
    [sdk.ArkPsbtFieldKeyType, sdk.ArkadePsbtFieldKeyType],
    [sdk.isArkError, sdk.isArkadeError],
    [sdk.maybeArkError, sdk.maybeArkadeError],
    [sdk.getArkPsbtFields, sdk.getArkadePsbtFields],
    [sdk.setArkPsbtField, sdk.setArkadePsbtField],
    [sdk.PrevArkTxField, sdk.PrevArkadeTxField],
    [sdk.attachPrevArkTxs, sdk.attachPrevArkadeTxs],
    [sdk.isValidArkAddress, sdk.isValidArkadeAddress],
    [sdk.decodeArkContract, sdk.decodeArkadeContract],
    [sdk.encodeArkContract, sdk.encodeArkadeContract],
    [sdk.isArkContract, sdk.isArkadeContract],
    [sdk.contractFromArkContract, sdk.contractFromArkadeContract],
    [sdk.contractFromArkContractWithAddress, sdk.contractFromArkadeContractWithAddress],
    [sdk.assertSubmittedArkTxid, sdk.assertSubmittedArkadeTxid],
    [payment.arkTarget, payment.arkadeTarget],
    [payment.arkRail, payment.arkadeRail],
    [payment.arkAssetRail, payment.arkadeAssetRail],
    [realm.ArkRealmSchemas, realm.ArkadeRealmSchemas],
    [realm.ArkExperimentalRealmSchemas, realm.ArkadeExperimentalRealmSchemas],
    [realm.ARK_REALM_SCHEMA_VERSION, realm.ARKADE_REALM_SCHEMA_VERSION],
    [realm.runArkRealmMigrations, realm.runArkadeRealmMigrations],
];

describe("deprecated names", () => {
    it.each(pairs.map((pair, i) => [i, ...pair]))(
        "pair %i is the same value",
        (_i, old, current) => {
            expect(old).toBeDefined();
            expect(old).toBe(current);
        },
    );

    it("keeps an old error class working with instanceof", () => {
        const error = new sdk.ArkadeError(1, "x", "y");
        expect(error).toBeInstanceOf(sdk.ArkError);
    });
});
