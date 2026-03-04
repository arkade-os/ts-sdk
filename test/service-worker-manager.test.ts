import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
    __resetServiceWorkerManager,
} from "../src/worker/browser/service-worker-manager";

const stubNavigator = (serviceWorker: Partial<ServiceWorkerContainer>) => {
    vi.stubGlobal("navigator", { serviceWorker } as Navigator);
};

const createServiceWorkerContainer = (
    registration: Partial<ServiceWorkerRegistration> = {}
) => {
    const listeners = new Map<string, Array<(evt?: Event) => void>>();
    return {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration as ServiceWorkerRegistration),
        controller: null,
        addEventListener: (event: string, cb: (evt?: Event) => void) => {
            const cbs = listeners.get(event);
            if (cbs) {
                cbs.push(cb);
            } else {
                listeners.set(event, [cb]);
            }
        },
        removeEventListener: (event: string, cb?: (evt?: Event) => void) => {
            if (!cb) {
                listeners.delete(event);
                return;
            }
            const cbs = listeners.get(event);
            if (!cbs) return;
            const idx = cbs.indexOf(cb);
            if (idx !== -1) cbs.splice(idx, 1);
            if (cbs.length === 0) listeners.delete(event);
        },
        dispatch: (event: string, evt: Event = new Event(event)) => {
            listeners.get(event)?.forEach((cb) => cb(evt));
        },
    };
};

describe("service-worker-manager", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        __resetServiceWorkerManager();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("registers only once per path", async () => {
        const update = vi.fn().mockResolvedValue(undefined);
        const registration = {
            update,
            addEventListener: vi.fn(),
        } as unknown as ServiceWorkerRegistration;
        const container = createServiceWorkerContainer(registration);

        stubNavigator(container);

        await setupServiceWorkerOnce("/sw.js");
        await setupServiceWorkerOnce("/sw.js");

        expect(container.register).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("returns the active service worker when ready", async () => {
        const active = { state: "activated" } as ServiceWorker;
        const update = vi.fn().mockResolvedValue(undefined);
        const registration = {
            active,
            update,
            addEventListener: vi.fn(),
        } as unknown as ServiceWorkerRegistration;
        const container = createServiceWorkerContainer(registration);

        stubNavigator(container);

        const serviceWorker = await getActiveServiceWorker("/sw.js");

        expect(serviceWorker).toBe(active);
        expect(container.register).toHaveBeenCalledTimes(1);
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

    it("sends SKIP_WAITING to a waiting worker and calls onUpdated after controllerchange", async () => {
        const waiting = {
            state: "installed",
            postMessage: vi.fn(),
            addEventListener: vi.fn(),
        } as unknown as ServiceWorker;
        const registration = {
            waiting,
            update: vi.fn().mockResolvedValue(undefined),
            addEventListener: vi.fn(),
        } as unknown as ServiceWorkerRegistration;
        const container = createServiceWorkerContainer(registration);
        const onUpdated = vi.fn();

        stubNavigator(container);

        await setupServiceWorkerOnce({
            path: "/sw.js",
            autoReload: false,
            onUpdated,
            activationTimeoutMs: 0,
        });

        expect(waiting.postMessage).toHaveBeenCalledWith({
            type: "SKIP_WAITING",
        });

        container.dispatch("controllerchange");
        expect(onUpdated).toHaveBeenCalledTimes(1);
    });
});
