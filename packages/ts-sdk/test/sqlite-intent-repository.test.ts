import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { SQLiteIntentRepository } from "../src/repositories/sqlite/intentRepository";
import { createNodeSQLExecutor } from "./helpers/nodeSqlExecutor";

// Real node:sqlite (not the regex mock): the intent upsert uses
// `ON CONFLICT ... DO UPDATE` and a partial unique index on intent_id, which
// only a real engine parses and enforces.
intentRepositoryConformance(
    "sqlite",
    async () => new SQLiteIntentRepository(createNodeSQLExecutor()),
);
