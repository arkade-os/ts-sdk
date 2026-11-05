import { describe, expect, it } from "vitest";
import {
    BATCH_REGISTRATION_TERMINAL_STATES,
    collectBatchRegistrations,
    collectIntents,
    InMemoryBatchRegistrationRepository,
    InMemoryIntentRepository,
    IndexedDBBatchRegistrationRepository,
    IndexedDBIntentRepository,
    INTENT_TERMINAL_STATES,
    isTerminalBatchRegistrationState,
    isTerminalIntentState,
} from "../src";
import {
    ArkExperimentalRealmSchemas,
    RealmBatchRegistrationRepository,
    RealmIntentRepository,
} from "../src/repositories/realm";
import {
    SQLiteBatchRegistrationRepository,
    SQLiteIntentRepository,
} from "../src/repositories/sqlite";

describe("deprecated batch registration repository names", () => {
    it("point at the new exports", () => {
        expect(InMemoryIntentRepository).toBe(InMemoryBatchRegistrationRepository);
        expect(IndexedDBIntentRepository).toBe(IndexedDBBatchRegistrationRepository);
        expect(RealmIntentRepository).toBe(RealmBatchRegistrationRepository);
        expect(SQLiteIntentRepository).toBe(SQLiteBatchRegistrationRepository);
        expect(collectIntents).toBe(collectBatchRegistrations);
        expect(isTerminalIntentState).toBe(isTerminalBatchRegistrationState);
        expect(INTENT_TERMINAL_STATES).toBe(BATCH_REGISTRATION_TERMINAL_STATES);
    });

    it("leave the stored Realm object name unchanged", () => {
        expect(ArkExperimentalRealmSchemas.map((s) => s.name)).toContain("ArkIntent");
    });
});
