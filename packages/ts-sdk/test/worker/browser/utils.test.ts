import { afterEach, describe, expect, it, vi } from "vitest";

import { setupServiceWorker } from "../../../src/worker/browser/utils";

const stubNavigator = (serviceWorker: Partial<ServiceWorkerContainer>) => {
    vi.stubGlobal("navigator", { serviceWorker } as Navigator);
};

describe("setupServiceWorker", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("waits for navigator.serviceWorker.ready using the configured activation timeout", async () => {
        vi.useFakeTimers();

        const update = vi.fn().mockResolvedValue(undefined);
        const activeWorker = { state: "activated" } as ServiceWorker;
        let resolveReady!: (registration: ServiceWorkerRegistration) => void;
        const ready = new Promise<ServiceWorkerRegistration>((resolve) => {
            resolveReady = resolve;
        });

        stubNavigator({
            register: vi.fn().mockResolvedValue({
                installing: { state: "installing" },
                update,
            } satisfies Partial<ServiceWorkerRegistration>),
            ready,
            controller: null,
        });

        const workerPromise = setupServiceWorker({
            path: "/sw.js",
            activationTimeoutMs: 30_000,
        });

        await vi.advanceTimersByTimeAsync(29_000);
        resolveReady({ active: activeWorker } as ServiceWorkerRegistration);

        await expect(workerPromise).resolves.toBe(activeWorker);
    });

    it("rejects with the configured activation timeout when ready never resolves", async () => {
        vi.useFakeTimers();

        const update = vi.fn().mockResolvedValue(undefined);
        stubNavigator({
            register: vi.fn().mockResolvedValue({
                installing: { state: "installing" },
                update,
            } satisfies Partial<ServiceWorkerRegistration>),
            ready: new Promise<ServiceWorkerRegistration>(() => {}),
            controller: null,
        });

        const workerPromise = setupServiceWorker({
            path: "/sw.js",
            activationTimeoutMs: 30_000,
        });
        const rejection = expect(workerPromise).rejects.toThrow(
            "Service worker activation timed out after 30000ms"
        );

        await vi.advanceTimersByTimeAsync(30_000);

        await rejection;
    });
});
