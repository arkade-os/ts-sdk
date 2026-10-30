import { assertTimerMs } from "../../utils/time";

export const DEFAULT_DB_NAME = "arkade-service-worker";
export const DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS = 10_000;

type SetupServiceWorkerOptions = {
    path: string;
    activationTimeoutMs?: number;
};

function normalizeOptions(
    pathOrOptions: string | SetupServiceWorkerOptions,
): Required<SetupServiceWorkerOptions> {
    const o: SetupServiceWorkerOptions =
        typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions;
    assertTimerMs("activationTimeoutMs", o.activationTimeoutMs);
    return {
        path: o.path,
        activationTimeoutMs: o.activationTimeoutMs ?? DEFAULT_SERVICE_WORKER_ACTIVATION_TIMEOUT_MS,
    };
}

function waitForServiceWorkerReady(timeoutMs: number) {
    return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Service worker activation timed out after ${timeoutMs}ms`));
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
    pathOrOptions: string | SetupServiceWorkerOptions,
): Promise<ServiceWorker> {
    // check if service workers are supported
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }

    const { path, activationTimeoutMs } = normalizeOptions(pathOrOptions);

    // register service worker
    const registration = await navigator.serviceWorker.register(path);

    // Not awaited: only a newer worker depends on this fetch, and its failure must not block the active one.
    registration
        .update()
        .catch((error) =>
            console.warn("Service worker update failed; continuing with the active worker", error),
        );

    const serviceWorker = registration.active || registration.waiting || registration.installing;
    if (!serviceWorker) {
        throw new Error("Failed to get service worker instance");
    }

    if (serviceWorker.state === "activated") {
        return serviceWorker;
    }

    const readyRegistration = await waitForServiceWorkerReady(activationTimeoutMs);

    if (!readyRegistration.active) {
        throw new Error("Service worker registration is ready but has no active worker");
    }

    return readyRegistration.active;
}
