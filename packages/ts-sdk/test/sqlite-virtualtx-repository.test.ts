import { virtualTxRepositoryConformance } from "./conformance/virtualTxRepository.conformance";
import { SQLiteVirtualTxRepository } from "../src/repositories/sqlite/virtualTxRepository";
import { createNodeSQLExecutor } from "./helpers/nodeSqlExecutor";

// Real in-memory SQLite (node:sqlite) so the set-based JOIN / `IN` / `NOT
// EXISTS` queries are exercised with true SQL semantics.
virtualTxRepositoryConformance(
    "sqlite",
    async () => new SQLiteVirtualTxRepository(createNodeSQLExecutor()),
);
