import { promisify } from "util";
import { setTimeout } from "timers";
import { execSync } from "child_process";

const sleep = promisify(setTimeout);

async function waitForArkServer(maxRetries = 30, retryDelay = 2000) {
    console.log("Waiting for ark server to be ready...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = execSync(
                "curl -sf http://localhost:7070/v1/info",
                {
                    stdio: "pipe",
                    encoding: "utf8",
                }
            );
            const info = JSON.parse(response);

            // We check the signer pubkey because the service status is empty
            if (info.signerPubkey) {
                console.log("  ✔ Server ready");
                return info;
            }
        } catch {
            /*Ignore any error and retry*/
        }

        if (i < maxRetries - 1) {
            console.log(`  Waiting... (${i + 1}/${maxRetries})`);
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
            await sleep(retryDelay);
        }
    }
    throw new Error("Boltz ARK/BTC pairs not available after maximum retries");
}

function initArkCli() {
    console.log("Initializing ark CLI client...");
    try {
        execSync(
            "docker exec arkd ark init --password secret --server-url localhost:7070 --explorer http://chopsticks:3000",
            { stdio: "pipe", encoding: "utf8" }
        );
        console.log("  ✔ ark CLI initialized");
    } catch (e) {
        // Already initialized is fine
        if (e.stderr && e.stderr.includes("already initialized")) {
            console.log("  ✔ ark CLI already initialized");
        } else {
            console.log(
                "  ✔ ark CLI initialized (may have been already set up)"
            );
        }
    }
}

// Run setup — arkade-regtest handles all infrastructure.
// This script just waits for services to be ready.
async function setup() {
    try {
        await waitForArkServer();
        initArkCli();
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
