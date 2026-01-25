const registrations = new Map<string, Promise<ServiceWorkerRegistration>>();

const ensureServiceWorkerSupport = () => {
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }
};

const registerOnce = (path: string): Promise<ServiceWorkerRegistration> => {
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
};

export const setupServiceWorkerOnce = async (
    path: string
): Promise<ServiceWorkerRegistration> => {
    ensureServiceWorkerSupport();
    return registerOnce(path);
};

export const getActiveServiceWorker = async (
    path?: string
): Promise<ServiceWorker> => {
    ensureServiceWorkerSupport();
    if (path) {
        await registerOnce(path);
    }
    const registration = await navigator.serviceWorker.ready;
    const serviceWorker =
        registration.active ||
        registration.waiting ||
        registration.installing ||
        navigator.serviceWorker.controller;

    if (!serviceWorker) {
        throw new Error("Service worker not ready yet");
    }
    return serviceWorker;
};

export const __resetServiceWorkerManager = () => {
    registrations.clear();
};
