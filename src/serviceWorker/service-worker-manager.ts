const registrations = new Map<string, Promise<ServiceWorkerRegistration>>();

function ensureServiceWorkerSupport() {
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }
}

function registerOnce(path: string): Promise<ServiceWorkerRegistration> {
    if (!registrations.has(path)) {
        registrations.set(
            path,
            navigator.serviceWorker
                .register(path)
                .then(async (registration) => {
                    await registration.update();
                    return registration;
                })
        );
    }
    return registrations.get(path)!;
}

export async function setupServiceWorkerOnce(
    path: string
): Promise<ServiceWorkerRegistration> {
    ensureServiceWorkerSupport();
    return registerOnce(path);
}

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

export const __resetServiceWorkerManager = () => {
    registrations.clear();
};
