export async function setupServiceWorker(path: string): Promise<ServiceWorker> {
    // check if service workers are supported
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported in this browser");
    }

    // check for existing registration
    const existingRegistration =
        await navigator.serviceWorker.getRegistration(path);
    let registration: ServiceWorkerRegistration;

    if (existingRegistration) {
        registration = existingRegistration;
        // Force unregister and re-register to ensure we get the latest version
        await existingRegistration.unregister();
    }

    registration = await navigator.serviceWorker.register(path);

    // Handle updates
    registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener("statechange", () => {
            if (
                newWorker.state === "activated" &&
                navigator.serviceWorker.controller
            ) {
                console.info("Service worker activated, reloading...");
                window.location.reload();
            }
        });
    });

    const serviceWorker =
        registration.active || registration.waiting || registration.installing;
    if (!serviceWorker) {
        throw new Error("Failed to get service worker instance");
    }
    // wait for the service worker to be ready
    if (serviceWorker.state !== "activated") {
        await new Promise<void>((resolve) => {
            if (!serviceWorker) return resolve();
            serviceWorker.addEventListener("statechange", () => {
                if (serviceWorker.state === "activated") {
                    resolve();
                }
            });
        });
    }
    return serviceWorker;
}
