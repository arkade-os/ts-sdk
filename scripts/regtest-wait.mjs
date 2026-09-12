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

export function printSetupBanner() {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  ✓ regtest setup completed successfully");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}
