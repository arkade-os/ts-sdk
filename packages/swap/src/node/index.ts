/**
 * The Node platform default: file-backed SQLite storage for swap records.
 *
 * A separate entry point because it imports `node:sqlite`, `node:fs`,
 * `node:os` and `node:path` — none of which belong in a browser bundle, and
 * none of which the main entry touches. Importing this path is how a Node
 * consumer asks for the storage default §3 describes:
 *
 * ```ts
 * import { createSwapClient } from "@arkade-os/swap";
 * import { nodeSwapRepository } from "@arkade-os/swap/node";
 *
 * await using repository = nodeSwapRepository({ network: "mainnet" });
 * const client = createSwapClient({ wallet, repository });
 * ```
 *
 * There is no implicit fallback for a Node client that passes no repository:
 * accepting a swap without durable storage is the silent-loss default the
 * storage rule exists to forbid, so `accept()` refuses instead.
 */
export { swapDatabasePath, configDir } from "./paths";
export {
    createNodeSqlExecutor,
    nodeSwapRepository,
    type NodeSqlExecutor,
    type NodeSwapRepositoryOptions,
} from "./executor";
