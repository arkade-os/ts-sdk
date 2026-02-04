import { Worker } from "../../src/serviceWorker/worker";
import { WalletUpdater } from "../../src/wallet/serviceWorker/wallet-updater";

// ensure crypto is available in the service worker context
if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    Object.defineProperty(self, "crypto", {
        value: {
            getRandomValues: Crypto.prototype.getRandomValues,
        },
        writable: false,
        configurable: false,
    });
}

const sw = new Worker({ updaters: [new WalletUpdater()] });
sw.start();
