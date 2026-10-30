import { afterEach, describe, expect, it, vi } from "vitest";

import { setupServiceWorker } from "../../../src/worker/browser/utils";

const stubNavigator = (serviceWorker: Partial<ServiceWorkerContainer>) => {
    vi.stubGlobal("navigator", { serviceWorker } as Navigator);
};

describe("setupServiceWorker", () => {
    it.each([-1, 0.5, NaN, Infinity, 2 ** 31])(
        "rejects invalid activation timeout %s before registering",
        async (activationTimeoutMs) => {
            const register = vi.fn();
            stubNavigator({ register });
            await expect(
                setupServiceWorker({ path: "/sw.js", activationTimeoutMs }),
            ).rejects.toThrow("activationTimeoutMs");
            expect(register).not.toHaveBeenCalled();
        },
    );

    it("keeps zero as an immediate activation timeout", async () => {
        vi.useFakeTimers();
        stubNavigator({
            register: vi.fn().mockResolvedValue({
                installing: { state: "installing" },
                update: vi.fn().mockResolvedValue(undefined),
            }),
            ready: new Promise<ServiceWorkerRegistration>(() => {}),
        });
        const rejection = expect(
            setupServiceWorker({ path: "/sw.js", activationTimeoutMs: 0 }),
        ).rejects.toThrow("Service worker activation timed out after 0ms");
        await vi.advanceTimersByTimeAsync(0);
        await rejection;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("returns the active worker without waiting for the update check", async () => {
        const active = { state: "activated" } as ServiceWorker;
        const update = vi.fn(() => new Promise<never>(() => {}));
        stubNavigator({
            register: vi.fn().mockResolvedValue({
                active,
                update,
            } satisfies Partial<ServiceWorkerRegistration>),
        });

        const result = await Promise.race([
            setupServiceWorker("/sw.js"),
            new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
        ]);

        expect(result).toBe(active);
        expect(update).toHaveBeenCalledOnce();
    });

    it("returns the active worker when the update check fails", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const active = { state: "activated" } as ServiceWorker;
        const update = vi.fn().mockRejectedValue(new TypeError("Failed to update a ServiceWorker"));
        stubNavigator({
            register: vi.fn().mockResolvedValue({
                active,
                update,
            } satisfies Partial<ServiceWorkerRegistration>),
        });

        await expect(setupServiceWorker("/sw.js")).resolves.toBe(active);
        expect(update).toHaveBeenCalledOnce();
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
                installing: { state: "installing" } as ServiceWorker,
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
                installing: { state: "installing" } as ServiceWorker,
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
            "Service worker activation timed out after 30000ms",
        );

        await vi.advanceTimersByTimeAsync(30_000);

        await rejection;
    });
});
