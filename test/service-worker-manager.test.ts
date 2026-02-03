import { describe, it, expect, vi, afterEach } from "vitest";
import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
    __resetServiceWorkerManager,
} from "../src/serviceWorker/service-worker-manager";

const stubNavigator = (serviceWorker: Partial<ServiceWorkerContainer>) => {
    vi.stubGlobal("navigator", { serviceWorker } as Navigator);
};

describe("service-worker-manager", () => {
    afterEach(() => {
        __resetServiceWorkerManager();
        vi.unstubAllGlobals();
    });

    it("registers only once per path", async () => {
        const update = vi.fn().mockResolvedValue(undefined);
        const register = vi.fn().mockResolvedValue({
            update,
        } as unknown as ServiceWorkerRegistration);

        stubNavigator({
            register,
            ready: Promise.resolve({} as ServiceWorkerRegistration),
        });

        await setupServiceWorkerOnce("/sw.js");
        await setupServiceWorkerOnce("/sw.js");

        expect(register).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("returns the active service worker when ready", async () => {
        const active = { state: "activated" } as ServiceWorker;
        const update = vi.fn().mockResolvedValue(undefined);
        const register = vi.fn().mockResolvedValue({
            update,
        } as unknown as ServiceWorkerRegistration);

        stubNavigator({
            register,
            ready: Promise.resolve({ active } as ServiceWorkerRegistration),
            controller: null,
        });

        const serviceWorker = await getActiveServiceWorker("/sw.js");

        expect(serviceWorker).toBe(active);
        expect(register).toHaveBeenCalledTimes(1);
    });

    it("falls back to the controller when no active worker is ready", async () => {
        const controller = { state: "activated" } as ServiceWorker;

        stubNavigator({
            register: vi.fn(),
            ready: Promise.resolve({} as ServiceWorkerRegistration),
            controller,
        });

        const serviceWorker = await getActiveServiceWorker();

        expect(serviceWorker).toBe(controller);
    });
});
