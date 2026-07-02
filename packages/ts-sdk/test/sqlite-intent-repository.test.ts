import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { SQLiteIntentRepository } from "../src/repositories/sqlite/intentRepository";
import { createMockSQLExecutor } from "./helpers/mockSqlExecutor";

intentRepositoryConformance(
    "sqlite",
    async () => new SQLiteIntentRepository(createMockSQLExecutor()),
);
