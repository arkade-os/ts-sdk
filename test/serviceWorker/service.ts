import { Worker } from "../../src/wallet/serviceWorker/worker";

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

new Worker().start();
