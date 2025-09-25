import { ExtendedVirtualCoin, VirtualCoin, Wallet } from "../..";

/**
 * setupServiceWorker sets up the service worker.
 * @param path - the path to the service worker script
 * @example
 * ```typescript
 * const serviceWorker = await setupServiceWorker("/service-worker.js");
 * ```
 */
export async function setupServiceWorker(path: string): Promise<ServiceWorker> {
    // check if service workers are supported
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }

    // register service worker
    const registration = await navigator.serviceWorker.register(path);

    // force update to ensure the service worker is active
    await registration.update();

    const serviceWorker =
        registration.active || registration.waiting || registration.installing;
    if (!serviceWorker) {
        throw new Error("Failed to get service worker instance");
    }
    // wait for the service worker to be ready
    return new Promise<ServiceWorker>((resolve, reject) => {
        if (serviceWorker.state === "activated") return resolve(serviceWorker);

        const onActivate = () => {
            cleanup();
            resolve(serviceWorker);
        };

        const onError = () => {
            cleanup();
            reject(new Error("Service worker failed to activate"));
        };

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Service worker activation timed out"));
        }, 10000);

        const cleanup = () => {
            navigator.serviceWorker.removeEventListener("activate", onActivate);
            navigator.serviceWorker.removeEventListener("error", onError);
            clearTimeout(timeout);
        };

        navigator.serviceWorker.addEventListener("activate", onActivate);
        navigator.serviceWorker.addEventListener("error", onError);
    });
}

export function extendVirtualCoin(
    wallet: Wallet,
    vtxo: VirtualCoin
): ExtendedVirtualCoin {
    return {
        ...vtxo,
        forfeitTapLeafScript: wallet.offchainTapscript.forfeit(),
        intentTapLeafScript: wallet.offchainTapscript.exit(),
        tapTree: wallet.offchainTapscript.encode(),
    };
}
