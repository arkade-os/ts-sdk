type SetupServiceWorkerOptions = {
    path: string;
    updateViaCache?: ServiceWorkerUpdateViaCache;
    autoReload?: boolean;
    onNeedRefresh?: () => void;
    onUpdated?: () => void;
    debug?: boolean;
    activationTimeoutMs?: number;
};

const registrations = new Map<string, Promise<ServiceWorkerRegistration>>();
let handshakes = new WeakSet<ServiceWorkerRegistration>();

function ensureServiceWorkerSupport() {
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }
}

function debugLog(debug: boolean | undefined, ...args: unknown[]) {
    if (debug) {
        // eslint-disable-next-line no-console
        console.debug(...args);
    }
}

function normalizeOptions(
    pathOrOptions: string | SetupServiceWorkerOptions
): Required<Omit<SetupServiceWorkerOptions, "onNeedRefresh" | "onUpdated">> &
    Pick<SetupServiceWorkerOptions, "onNeedRefresh" | "onUpdated"> {
    if (typeof pathOrOptions === "string") {
        return {
            path: pathOrOptions,
            updateViaCache: "none",
            autoReload: true,
            debug: false,
            activationTimeoutMs: 10_000,
        };
    }

    return {
        path: pathOrOptions.path,
        updateViaCache: pathOrOptions.updateViaCache ?? "none",
        autoReload: pathOrOptions.autoReload ?? true,
        onNeedRefresh: pathOrOptions.onNeedRefresh,
        onUpdated: pathOrOptions.onUpdated,
        debug: pathOrOptions.debug ?? false,
        activationTimeoutMs: pathOrOptions.activationTimeoutMs ?? 10_000,
    };
}

function sendSkipWaiting(
    worker: ServiceWorker | null | undefined,
    debug?: boolean
) {
    if (!worker) return;
    try {
        worker.postMessage({ type: "SKIP_WAITING" });
        debugLog(debug, "Sent SKIP_WAITING to waiting service worker");
    } catch (error) {
        console.warn("Failed to post SKIP_WAITING to service worker", error);
    }
}

function attachUpdateHandlers(
    registration: ServiceWorkerRegistration,
    options: ReturnType<typeof normalizeOptions>
) {
    if (handshakes.has(registration)) return;
    handshakes.add(registration);

    const { autoReload, onNeedRefresh, onUpdated, activationTimeoutMs, debug } =
        options;

    let reloadTriggered = false;

    const maybeReload = () => {
        if (reloadTriggered) return;
        reloadTriggered = true;
        debugLog(debug, "Service worker controller change detected");
        onUpdated?.();
        if (
            autoReload &&
            typeof window !== "undefined" &&
            typeof window.location?.reload === "function"
        ) {
            window.location.reload();
        }
    };

    const handleWaiting = (worker: ServiceWorker | null | undefined) => {
        if (!worker) return;
        onNeedRefresh?.();
        sendSkipWaiting(worker, debug);

        if (activationTimeoutMs > 0 && typeof window !== "undefined") {
            window.setTimeout(() => {
                if (registration.waiting) {
                    debugLog(
                        debug,
                        "Waiting worker still pending; re-sending SKIP_WAITING"
                    );
                    sendSkipWaiting(registration.waiting, debug);
                    registration
                        .update()
                        .catch(() =>
                            debugLog(
                                debug,
                                "Service worker update retry failed (timeout path)"
                            )
                        );
                }
            }, activationTimeoutMs);
        }
    };

    // Handle an already waiting worker at startup.
    if (registration.waiting) {
        handleWaiting(registration.waiting);
    }

    // Listen for newly installed workers becoming waiting.
    registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
            if (installing.state === "installed") {
                handleWaiting(registration.waiting);
            }
        });
    });

    // Reload (or callback) once the new controller takes over.
    navigator.serviceWorker.addEventListener("controllerchange", maybeReload, {
        once: true,
    });
}

function registerOnce(
    options: ReturnType<typeof normalizeOptions>
): Promise<ServiceWorkerRegistration> {
    const { path, updateViaCache } = options;

    if (!registrations.has(path)) {
        const registrationPromise = navigator.serviceWorker
            .register(path, { updateViaCache })
            .then(async (registration) => {
                try {
                    await registration.update();
                } catch (error) {
                    console.warn(
                        "Service worker update failed; continuing with registration",
                        error
                    );
                }
                return registration;
            })
            .catch((error) => {
                // delete failed registration to allow retrials
                registrations.delete(path);
                throw error;
            });
        registrations.set(path, registrationPromise);
    }

    return registrations.get(path)!.then((registration) => {
        attachUpdateHandlers(registration, options);
        return registration;
    });
}

/**
 * Registers a service worker for the given path only once, attaches an
 * update/activation handshake (SKIP_WAITING + controllerchange reload), and
 * caches the registration promise for subsequent calls.
 *
 * @param pathOrOptions - Service worker script path or a configuration object.
 * @throws if service workers are not supported or registration fails.
 */
export async function setupServiceWorkerOnce(
    pathOrOptions: string | SetupServiceWorkerOptions
): Promise<ServiceWorkerRegistration> {
    ensureServiceWorkerSupport();
    const options = normalizeOptions(pathOrOptions);
    return registerOnce(options);
}

/**
 * Returns an active service worker instance, optionally ensuring a specific
 * script path is registered before resolving.
 *
 * @param path - Optional service worker script path to register and prefer.
 * @throws if service workers are not supported or no active worker is available.
 */
export async function getActiveServiceWorker(
    path?: string
): Promise<ServiceWorker> {
    ensureServiceWorkerSupport();
    // Avoid mixing registrations when a specific script path is provided.
    const options = normalizeOptions(path ?? "");
    const registration: ServiceWorkerRegistration = path
        ? await registerOnce(options)
        : await navigator.serviceWorker.ready;
    let serviceWorker =
        registration.active ||
        registration.waiting ||
        registration.installing ||
        navigator.serviceWorker.controller;

    if (!serviceWorker && path) {
        const readyRegistration = await navigator.serviceWorker.ready;
        serviceWorker =
            readyRegistration.active ||
            readyRegistration.waiting ||
            readyRegistration.installing ||
            navigator.serviceWorker.controller;
    }

    if (!serviceWorker) {
        throw new Error("Service worker not ready yet");
    }
    return serviceWorker;
}

/**
 * Clears the cached registration promises.
 * Intended for tests to reset state between runs.
 */
export const __resetServiceWorkerManager = () => {
    registrations.clear();
    handshakes = new WeakSet<ServiceWorkerRegistration>();
};
