import {
    printSetupBanner,
    waitForArkServer,
    waitForBoltzPairs,
} from "../../../../scripts/regtest-wait.mjs";

async function setup() {
    try {
        await waitForArkServer();
        await waitForBoltzPairs();
        printSetupBanner();
    } catch (error) {
        console.error("\n✗ Setup failed:", error);
        process.exit(1);
    }
}

setup();
