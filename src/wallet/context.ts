/**
 * Execution context detection for wallet implementations.
 *
 * This module determines the current execution environment and whether
 * service worker initialization is needed for cross-context communication.
 */

export type ExecutionContext = "SERVICE_WORKER" | "WORKER_CLIENT" | "DIRECT";

/**
 * Detects the current execution context.
 *
 * @returns ExecutionContext
 * - SERVICE_WORKER: Code is running inside a service worker
 * - WORKER_CLIENT: Code is running in a browser that should use service worker
 * - DIRECT: Code is running in regular web context or Node.js
 */
export function detectExecutionContext(): ExecutionContext {
    // Check if we're in a service worker context
    if (
        typeof self !== "undefined" &&
        "importScripts" in self &&
        "registration" in self
    ) {
        return "SERVICE_WORKER";
    }

    // Check if we're in Node.js
    if (typeof window === "undefined" && typeof global !== "undefined") {
        return "DIRECT";
    }

    // Check if we're in a browser context
    if (typeof window !== "undefined") {
        // Check if service workers are supported and we're in a secure context
        if (
            "serviceWorker" in navigator &&
            typeof navigator.serviceWorker.register === "function"
        ) {
            // Additional checks for environments that would benefit from service worker
            // PWA contexts typically have manifest or are served from HTTPS
            const isPWAContext =
                window.location.protocol === "https:" ||
                window.location.hostname === "localhost" ||
                window.location.hostname === "127.0.0.1" ||
                document.querySelector('link[rel="manifest"]') !== null;

            if (isPWAContext) {
                return "WORKER_CLIENT";
            }
        }

        // Regular web context without service worker needs
        return "DIRECT";
    }

    // Fallback to direct for unknown environments
    return "DIRECT";
}

/**
 * Determines if a service worker should be initialized for the given context.
 *
 * @param context - The execution context
 * @returns true if service worker initialization is needed
 */
export function needsServiceWorker(context: ExecutionContext): boolean {
    return context === "WORKER_CLIENT";
}

/**
 * Determines if the current context can support persistent storage.
 *
 * @param context - The execution context
 * @returns true if persistent storage is available
 */
export function supportsPersistentStorage(context: ExecutionContext): boolean {
    switch (context) {
        case "SERVICE_WORKER":
        case "WORKER_CLIENT":
            return typeof indexedDB !== "undefined";
        case "DIRECT":
            return (
                typeof window !== "undefined" &&
                typeof window.localStorage !== "undefined"
            );
        default:
            return false;
    }
}

/**
 * Gets the recommended storage adapter for the given context.
 * Returns the storage adapter class name as a string.
 *
 * @param context - The execution context
 * @returns Storage adapter identifier
 */
export function getRecommendedStorageAdapter(
    context: ExecutionContext
): string {
    switch (context) {
        case "SERVICE_WORKER":
        case "WORKER_CLIENT":
            return "IndexedDBStorageAdapter";
        case "DIRECT":
            if (typeof window !== "undefined") {
                return "LocalStorageAdapter";
            }
            return "InMemoryStorageAdapter";
        default:
            return "InMemoryStorageAdapter";
    }
}
