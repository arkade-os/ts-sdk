/**
 * The Node platform default: file-backed SQLite storage for swap records. A separate entry point
 * because it imports `node:*` modules that must stay out of browser bundles.
 *
 * ```ts
 * import { createSwapClient } from "@arkade-os/swap";
 * import { nodeSwapRepository } from "@arkade-os/swap/node";
 *
 * await using repository = nodeSwapRepository({ network: "mainnet" });
 * const client = createSwapClient({ wallet, repository });
 * ```
 *
 * There is no implicit fallback when a Node client passes no repository: accepting a swap without
 * durable storage risks silent loss, so `accept()` refuses instead.
 */
export { swapDatabasePath, configDir } from "./paths";
export {
    createNodeSqlExecutor,
    nodeSwapRepository,
    type NodeSqlExecutor,
    type NodeSwapRepositoryOptions,
} from "./executor";
