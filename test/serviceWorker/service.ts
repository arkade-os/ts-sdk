import { ArkSW } from "../../src/wallet/serviceWorker/worker";
import { WalletUpdater } from "../../src/wallet/serviceWorker/wallet";

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

const sw = new ArkSW({ updaters: [new WalletUpdater()] });
sw.start();
