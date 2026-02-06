const registrations = new Map<string, Promise<ServiceWorkerRegistration>>();

function ensureServiceWorkerSupport() {
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }
}

function registerOnce(path: string): Promise<ServiceWorkerRegistration> {
    if (!registrations.has(path)) {
        const registrationPromise = navigator.serviceWorker
            .register(path)
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
    return registrations.get(path)!;
}

/**
 * Registers a service worker for the given path only once and caches the
 * registration promise for subsequent calls.
 *
 * @param path - Service worker script path to register.
 * @throws if service workers are not supported or registration fails.
 */
export async function setupServiceWorkerOnce(
    path: string
): Promise<ServiceWorkerRegistration> {
    ensureServiceWorkerSupport();
    return registerOnce(path);
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
    const registration: ServiceWorkerRegistration = path
        ? await registerOnce(path)
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
};
