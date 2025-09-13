/**
 * Service worker initialization utilities for automatic wallet setup.
 *
 * This module handles the automatic registration and initialization of service workers
 * for wallet operations when running in PWA or extension contexts.
 */

let serviceWorkerPromise: Promise<ServiceWorker> | null = null;

/**
 * Initializes and registers the wallet service worker if not already done.
 *
 * @param serviceWorkerUrl - Optional custom service worker URL. Defaults to bundled worker.
 * @returns Promise that resolves to the active service worker
 */
export async function initializeServiceWorker(
    serviceWorkerUrl?: string
): Promise<ServiceWorker> {
    // Return existing promise if already initializing
    if (serviceWorkerPromise) {
        return serviceWorkerPromise;
    }

    serviceWorkerPromise = (async () => {
        if (!("serviceWorker" in navigator)) {
            throw new Error(
                "Service workers not supported in this environment"
            );
        }

        // Use bundled service worker by default
        const workerUrl = serviceWorkerUrl || "/wallet-service-worker.js";

        try {
            // Register the service worker
            const registration = await navigator.serviceWorker.register(
                workerUrl,
                {
                    scope: "/",
                    type: "module",
                }
            );

            // Wait for the service worker to be ready
            await navigator.serviceWorker.ready;

            // Get the active service worker
            let serviceWorker = registration.active;

            // If no active worker, wait for it to activate
            if (!serviceWorker) {
                if (registration.installing) {
                    serviceWorker = registration.installing;
                } else if (registration.waiting) {
                    serviceWorker = registration.waiting;
                } else {
                    throw new Error("No service worker found in registration");
                }

                // Wait for the worker to become active
                await new Promise<void>((resolve, reject) => {
                    if (!serviceWorker) {
                        reject(new Error("Service worker is null"));
                        return;
                    }

                    if (serviceWorker.state === "activated") {
                        resolve();
                        return;
                    }

                    const onStateChange = () => {
                        if (serviceWorker!.state === "activated") {
                            serviceWorker!.removeEventListener(
                                "statechange",
                                onStateChange
                            );
                            resolve();
                        } else if (serviceWorker!.state === "redundant") {
                            serviceWorker!.removeEventListener(
                                "statechange",
                                onStateChange
                            );
                            reject(
                                new Error("Service worker became redundant")
                            );
                        }
                    };

                    serviceWorker.addEventListener(
                        "statechange",
                        onStateChange
                    );
                });

                // Update reference to active worker
                serviceWorker = registration.active;
            }

            if (!serviceWorker) {
                throw new Error(
                    "Failed to get active service worker after registration"
                );
            }

            return serviceWorker;
        } catch (error) {
            // Reset promise on error so it can be retried
            serviceWorkerPromise = null;
            throw new Error(`Failed to initialize service worker: ${error}`);
        }
    })();

    return serviceWorkerPromise;
}

/**
 * Gets the current active service worker if available.
 *
 * @returns The active service worker or null if not available
 */
export function getActiveServiceWorker(): ServiceWorker | null {
    if (
        !("serviceWorker" in navigator) ||
        !navigator.serviceWorker.controller
    ) {
        return null;
    }

    return navigator.serviceWorker.controller;
}

/**
 * Checks if a service worker is already registered and active.
 *
 * @returns true if a service worker is active
 */
export function isServiceWorkerActive(): boolean {
    return getActiveServiceWorker() !== null;
}

/**
 * Unregisters the wallet service worker.
 * This is mainly useful for testing or cleanup scenarios.
 *
 * @returns Promise that resolves when unregistration is complete
 */
export async function unregisterServiceWorker(): Promise<void> {
    if (!("serviceWorker" in navigator)) {
        return;
    }

    const registrations = await navigator.serviceWorker.getRegistrations();

    await Promise.all(
        registrations.map((registration) => registration.unregister())
    );

    // Reset the promise so it can be re-initialized
    serviceWorkerPromise = null;
}

/**
 * Sets up the bundled service worker with wallet configuration.
 *
 * @param config - Initial wallet configuration for the service worker
 * @returns Promise that resolves to the configured service worker
 */
export async function setupServiceWorkerWithConfig(config: {
    arkServerUrl: string;
    arkServerPublicKey?: string;
    privateKey?: string;
}): Promise<ServiceWorker> {
    const serviceWorker = await initializeServiceWorker();

    // Send initialization message to the service worker
    const initMessage = {
        type: "INIT_WALLET",
        id: generateId(),
        privateKey: config.privateKey,
        arkServerUrl: config.arkServerUrl,
        arkServerPublicKey: config.arkServerPublicKey,
    };

    // Wait for service worker to be ready and send init message
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Service worker initialization timeout"));
        }, 30000);

        const messageHandler = (event: MessageEvent) => {
            const response = event.data;
            if (response.id === initMessage.id) {
                clearTimeout(timeout);
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );

                if (response.success) {
                    resolve();
                } else {
                    reject(
                        new Error(
                            response.message ||
                                "Service worker initialization failed"
                        )
                    );
                }
            }
        };

        navigator.serviceWorker.addEventListener("message", messageHandler);
        serviceWorker.postMessage(initMessage);
    });

    return serviceWorker;
}

/**
 * Generates a random ID for message correlation.
 */
function generateId(): string {
    return (
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15)
    );
}
