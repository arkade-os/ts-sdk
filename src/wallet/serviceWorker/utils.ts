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
    registration.update();

    const serviceWorker =
        registration.active || registration.waiting || registration.installing;
    if (!serviceWorker) {
        throw new Error("Failed to get service worker instance");
    }
    // wait for the service worker to be ready
    if (serviceWorker.state !== "activated") {
        await new Promise<void>((resolve) => {
            if (!serviceWorker) return resolve();
            serviceWorker.addEventListener("activate", () => resolve());
        });
    }
    return serviceWorker;
}
