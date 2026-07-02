import { virtualTxRepositoryConformance } from "./conformance/virtualTxRepository.conformance";
import { SQLiteVirtualTxRepository } from "../src/repositories/sqlite/virtualTxRepository";
import { createMockSQLExecutor } from "./helpers/mockSqlExecutor";

virtualTxRepositoryConformance(
    "sqlite",
    async () => new SQLiteVirtualTxRepository(createMockSQLExecutor()),
);
