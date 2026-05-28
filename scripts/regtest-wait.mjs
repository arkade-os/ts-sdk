import { promisify } from "util";
import { setTimeout } from "timers";
import { execSync } from "child_process";

export const sleep = promisify(setTimeout);

/**
 * Poll the ark server until `signerPubkey` is set, then return the parsed
 * `/v1/info` response. Throws after `maxRetries` failed attempts.
 */
export async function waitForArkServer({
    url = "http://localhost:7070/v1/info",
    maxRetries = 30,
    retryDelay = 2000,
} = {}) {
    console.log("Waiting for ark server to be ready...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = execSync(`curl -sf ${url}`, {
                stdio: "pipe",
                encoding: "utf8",
            });
            const info = JSON.parse(response);
            if (info.signerPubkey) {
                console.log("  ✔ Server ready");
                return info;
            }
        } catch {
            // Ignore and retry
        }

        if (i < maxRetries - 1) {
            console.log(`  Waiting... (${i + 1}/${maxRetries})`);
            await sleep(retryDelay);
        }
    }
    throw new Error("ark server failed to be ready after maximum retries");
}

/**
 * Poll the emulator until `signerPubkey` is set, then return the parsed
 * `/v1/info` response. Throws after `maxRetries` failed attempts.
 */
export async function waitForEmulator({
    url = "http://localhost:7073/v1/info",
    maxRetries = 30,
    retryDelay = 2000,
} = {}) {
    console.log("Waiting for emulator to be ready...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = execSync(`curl -sf ${url}`, {
                stdio: "pipe",
                encoding: "utf8",
            });
            const info = JSON.parse(response);
            if (info.signerPubkey) {
                console.log("  ✔ Emulator ready");
                return info;
            }
        } catch {
            // Ignore and retry
        }

        if (i < maxRetries - 1) {
            console.log(`  Waiting... (${i + 1}/${maxRetries})`);
            await sleep(retryDelay);
        }
    }
    throw new Error("emulator failed to be ready after maximum retries");
}

/**
 * Poll Boltz until the ARK/BTC submarine pair appears in the API response.
 */
export async function waitForBoltzPairs({
    url = "http://localhost:9069/v2/swap/submarine",
    maxRetries = 30,
    retryDelay = 2000,
} = {}) {
    console.log("Waiting for Boltz ARK/BTC pairs...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = execSync(`curl -s ${url}`, {
                encoding: "utf8",
                stdio: "pipe",
            });
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

export function printSetupBanner() {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  ✓ regtest setup completed successfully");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}
