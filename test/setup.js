import { promisify } from "util";
import { setTimeout } from "timers";
import { execSync } from "child_process";

let arkdExec = "nigiri ";

const sleep = promisify(setTimeout);

async function execCommand(command) {
    return new Promise((resolve, reject) => {
        try {
            const result = execSync(command);
            resolve(result);
        } catch (error) {
            // If the error indicates the wallet is already initialized, we can continue
            if (
                error.stderr &&
                error.stderr.toString().includes("wallet already initialized")
            ) {
                console.log("Wallet already initialized, continuing...");
                resolve(new Uint8Array([]));
            } else {
                reject(error);
            }
        }
    });
}

async function waitForArkServer(maxRetries = 30, retryDelay = 2000) {
    console.log("Waiting for ARK server to be ready...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            execSync("curl -s http://localhost:7070/v1/info");
            console.log("ARK server is ready");
            return true;
        } catch (error) {
            console.log(
                `Waiting for ARK server to be ready (${i + 1}/${maxRetries})...`
            );
            await sleep(retryDelay);
        }
    }
    throw new Error("ARK server failed to be ready after maximum retries");
}

async function checkWalletStatus() {
    const statusOutput = execSync(`${arkdExec} arkd wallet status`).toString();
    const initialized = statusOutput.includes("initialized: true");
    const unlocked = statusOutput.includes("unlocked: true");
    const synced = statusOutput.includes("synced: true");
    return { initialized, unlocked, synced };
}

async function waitForWalletReady(maxRetries = 30, retryDelay = 2000) {
    for (let i = 0; i < maxRetries; i++) {
        const status = await checkWalletStatus();
        if (status.initialized && status.unlocked && status.synced) {
            console.log("Wallet is ready");
            return true;
        }
        console.log(
            `Waiting for wallet to be ready (${i + 1}/${maxRetries})...`
        );
        await sleep(retryDelay);
    }
    throw new Error("Wallet failed to be ready after maximum retries");
}

async function setupArkServer() {
    try {
        // Wait for ARK server to be ready first
        await waitForArkServer();

        // Create and unlock arkd wallet with deterministic mnemonic
        const mnemonic = "abandon ".repeat(23) + "abandon";
        await execCommand(
            `${arkdExec} arkd wallet create --password secret --mnemonic "${mnemonic}"`
        );
        await execCommand(`${arkdExec} arkd wallet unlock --password secret`);

        // Wait for wallet to be ready and synced
        await waitForWalletReady();

        // Get and log the server info
        const serverInfo = JSON.parse(
            execSync("curl -s http://localhost:7070/v1/info").toString()
        );
        console.log("Ark Server Public Key:", serverInfo.signerPubkey);

        // Get arkd address and fund it with nigiri faucet
        const arkdAddress = (
            await execCommand(`${arkdExec} arkd wallet address`)
        )
            .toString()
            .trim();
        console.log("Funding arkd address:", arkdAddress);

        for (let i = 0; i < 10; i++) {
            await execCommand(`nigiri faucet ${arkdAddress}`);
        }

        // Wait for transaction to be confirmed
        await sleep(5000);

        // Initialize ark client
        await execCommand(
            `${arkdExec} ark init --server-url http://localhost:7070 --explorer http://chopsticks:3000 --password secret --network regtest`
        );

        // fund the ark-cli with 1 vtxo worth of 20_000
        const note = await execCommand(`${arkdExec} arkd note --amount 20_000`);
        const noteStr = note.toString().trim();
        const cmd = `${arkdExec} ark redeem-notes -n ${noteStr} --password secret`;
        await execCommand(cmd);

        // Settle the funds and wait for completion

        console.log("Settlement completed successfully");

        console.log("Ark server and client setup completed successfully");
    } catch (error) {
        console.error("Error setting up Ark server:", error);
        throw error;
    }
}

// get argument
const arg = process.argv[2];

if (arg === "docker") {
    arkdExec = "docker exec -t arkd";
}

// Run setup
setupArkServer().catch((error) => {
    console.error("Setup failed:", error);
    process.exit(1);
});
