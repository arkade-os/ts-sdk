import { promisify } from "util";
import { setTimeout } from "timers";
import { execSync } from "child_process";

const sleep = promisify(setTimeout);

async function waitForArkServer(maxRetries = 30, retryDelay = 2000) {
    console.log("Waiting for ark server to be ready...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            execSync("curl -s http://localhost:7070/v1/info", {
                stdio: "pipe",
            });
            console.log("  ✔ Server ready");
            return true;
        } catch {
            if (i < maxRetries - 1) {
                console.log(`  Waiting... (${i + 1}/${maxRetries})`);
            }
            await sleep(retryDelay);
        }
    }
    throw new Error("ark server failed to be ready after maximum retries");
}

async function waitForBoltzPairs(maxRetries = 30, retryDelay = 2000) {
    console.log("Waiting for Boltz ARK/BTC pairs...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = execSync(
                "curl -s http://localhost:9069/v2/swap/submarine",
                { encoding: "utf8", stdio: "pipe" }
            );
            if (response.includes('"ARK"')) {
                console.log("  ✔ Boltz pairs ready");
                return true;
            }
        } catch {
            // Continue retrying
        }
        if (i < maxRetries - 1) {
            console.log(`  Waiting... (${i + 1}/${maxRetries})`);
        }
        await sleep(retryDelay);
    }
    throw new Error("Boltz ARK/BTC pairs not available after maximum retries");
}

// Run setup — arkade-regtest handles all infrastructure.
// This script just waits for services to be ready.
async function setup() {
    try {
        await waitForArkServer();
        await waitForBoltzPairs();
        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("  ✓ regtest setup completed successfully");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    } catch (error) {
        console.error("\n✗ Setup failed:", error);
        process.exit(1);
    }
}

setup();
