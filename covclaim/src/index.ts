/**
 * covclaim — Covenant claim watcher daemon
 *
 * Watches for on-chain UTXOs at registered CovVHTLC taproot addresses
 * and automatically claims them via the covenant path when they appear.
 */

import type { Config } from "./types.js";
import { createServer } from "./server.js";
import { startWatcher } from "./watcher.js";

function loadConfig(): Config {
    return {
        esploraUrl: process.env.ESPLORA_URL ?? "http://localhost:3000",
        introspectorUrl:
            process.env.INTROSPECTOR_URL ?? "http://localhost:7073",
        port: parseInt(process.env.PORT ?? "1234", 10),
        pollIntervalMs: parseInt(
            process.env.POLL_INTERVAL_MS ?? "5000",
            10
        ),
        network: (process.env.NETWORK as Config["network"]) ?? "regtest",
    };
}

function main(): void {
    const config = loadConfig();

    console.log("[covclaim] starting with config:", {
        ...config,
        // Don't log full URLs in production
        esploraUrl: config.esploraUrl,
        introspectorUrl: config.introspectorUrl,
    });

    const app = createServer(config);

    startWatcher(config);

    app.listen(config.port, () => {
        console.log(`[covclaim] listening on port ${config.port}`);
    });
}

main();
