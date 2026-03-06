export const DEFAULT_DB_NAME = "arkade-service-worker";
export const DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS = 10_000;

type SetupServiceWorkerOptions = {
    path: string;
    activationTimeoutMs?: number;
};

function normalizeOptions(
    pathOrOptions: string | SetupServiceWorkerOptions
): Required<SetupServiceWorkerOptions> {
    if (typeof pathOrOptions === "string") {
        return {
            path: pathOrOptions,
            activationTimeoutMs: DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS,
        };
    }

    return {
        path: pathOrOptions.path,
        activationTimeoutMs:
            pathOrOptions.activationTimeoutMs ??
            DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS,
    };
}

function waitForServiceWorkerReady(timeoutMs: number) {
    return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(
                new Error(
                    `Service worker activation timed out after ${timeoutMs}ms`
                )
            );
        }, timeoutMs);

        navigator.serviceWorker.ready
            .then((registration) => {
                clearTimeout(timeoutId);
                resolve(registration);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

/**
 * setupServiceWorker sets up the service worker.
 * @param pathOrOptions - the path to the service worker script or setup options
 * @throws if service workers are not supported or activation fails
 * @example
 * ```typescript
 * const worker = await setupServiceWorker("/service-worker.js");
 * ```
 */
export async function setupServiceWorker(
    pathOrOptions: string | SetupServiceWorkerOptions
): Promise<ServiceWorker> {
    // check if service workers are supported
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }

    const { path, activationTimeoutMs } = normalizeOptions(pathOrOptions);

    // register service worker
    const registration = await navigator.serviceWorker.register(path);

    // force update to ensure the service worker is active
    await registration.update();

    const serviceWorker =
        registration.active || registration.waiting || registration.installing;
    if (!serviceWorker) {
        throw new Error("Failed to get service worker instance");
    }

    if (serviceWorker.state === "activated") {
        return serviceWorker;
    }

    const readyRegistration =
        await waitForServiceWorkerReady(activationTimeoutMs);
    const activeServiceWorker =
        readyRegistration.active || navigator.serviceWorker.controller;

    if (!activeServiceWorker) {
        throw new Error("Failed to get service worker instance");
    }

    return activeServiceWorker;
}
