import { execSync } from "child_process";
import {
    printSetupBanner,
    waitForArkServer,
    waitForBoltzPairs,
} from "../../../scripts/regtest-wait.mjs";

function initArkCli() {
    console.log("Initializing ark CLI client...");
    try {
        execSync(
            "docker exec arkd ark init --password secret --server-url localhost:7070 --explorer http://mempool_web/api",
            { stdio: "pipe", encoding: "utf8" },
        );
        console.log("  ✔ ark CLI initialized");
    } catch (e) {
        if (e.stderr && e.stderr.includes("already initialized")) {
            console.log("  ✔ ark CLI already initialized");
        } else {
            console.log("  ✔ ark CLI initialized (may have been already set up)");
        }
    }
}

async function setup() {
    try {
        await waitForArkServer();
        initArkCli();
        await waitForBoltzPairs();
        printSetupBanner();
    } catch (error) {
        console.error("\n✗ Setup failed:", error);
        process.exit(1);
    }
}

setup();
