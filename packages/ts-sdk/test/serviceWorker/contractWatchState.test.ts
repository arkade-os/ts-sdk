import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { hex } from "@scure/base";

import {
    ContractManager,
    DefaultContractHandler,
    DefaultVtxo,
    IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ServiceWorkerReadonlyWallet,
    ReadonlySingleKey,
} from "../../src";
import type { ContractRepository } from "../../src/repositories";
import {
    WalletMessageHandler,
    type WalletUpdaterRequest,
} from "../../src/wallet/serviceWorker/wallet-message-handler";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_PUB_KEY,
    TEST_SERVER_PUB_KEY,
} from "../contracts/helpers";

// A second (script, params) pair so the subscription is never empty and an
// absent POST cannot be mistaken for "nothing to subscribe".
const SECOND_PARAMS = DefaultContractHandler.serializeParams({
    pubKey: TEST_DELEGATE_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
});
const SECOND_SCRIPT = hex.encode(
    new DefaultVtxo.Script({
        pubKey: TEST_DELEGATE_PUB_KEY,
        serverPubKey: TEST_SERVER_PUB_KEY,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    }).pkScript,
);

const STUB_XONLY_PUBLIC_KEY = new Uint8Array(32).fill(0xab);

/**
 * Wires the page-side `ServiceWorkerReadonlyWallet` proxy to a real
 * `WalletMessageHandler` over a fake `postMessage` bus, backed by a real
 * `ContractManager`. Nothing about the watch-state path is mocked, so the
 * assertions below are about core semantics, not about message plumbing.
 */
const createBridgedWallet = (manager: ContractManager) => {
    const handler = new WalletMessageHandler();
    (handler as any).readonlyWallet = {
        getContractManager: async () => manager,
        getContractSyncState: () => ({ mode: "online" }),
    };

    const listeners = new Set<(event: { data: any }) => void>();
    const serviceWorker = {
        postMessage: (message: WalletUpdaterRequest & { tag?: string }) => {
            if (message.tag === "PING") {
                listeners.forEach((l) => l({ data: { id: message.id, tag: "PONG" } }));
                return;
            }
            void handler.handleMessage(message).then((response) => {
                listeners.forEach((l) => l({ data: response }));
            });
        },
    };

    vi.stubGlobal("navigator", {
        serviceWorker: {
            addEventListener: (type: string, l: (event: { data: any }) => void) => {
                if (type === "message") listeners.add(l);
            },
            removeEventListener: (type: string, l: (event: { data: any }) => void) => {
                if (type === "message") listeners.delete(l);
            },
        },
    } as any);

    return new (ServiceWorkerReadonlyWallet as any)(
        serviceWorker as any,
        { xOnlyPublicKey: async () => STUB_XONLY_PUBLIC_KEY } as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        handler.messageTag,
    ) as ServiceWorkerReadonlyWallet;
};

// Model browser lifecycle events at the transport boundary. Both workers use
// the real handler/manager; only the old worker's unsupported request differs.
async function createUpgradingWallet(
    manager: ContractManager,
    options: { error?: string; timeout?: number; wrongIdentity?: boolean } = {},
) {
    const handler = new WalletMessageHandler();
    (handler as any).readonlyWallet = {
        getContractManager: async () => manager,
        getContractSyncState: () => ({ mode: "online" }),
    };
    const identity = ReadonlySingleKey.fromPublicKey(
        hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
    );
    const key = await identity.xOnlyPublicKey();
    const bus = new EventTarget();
    const requests: { old: boolean; type: string }[] = [];
    function worker(old: boolean) {
        const target = Object.assign(new EventTarget(), {
            state: old ? "activated" : "installed",
            scriptURL: "https://wallet.example/sw.js",
            postMessage(message: any) {
                requests.push({ old, type: message.type ?? message.tag });
                void (async () => {
                    let response;
                    if (message.tag === "PING") {
                        response = { id: message.id, tag: "PONG" };
                    } else if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                        response = { id: message.id };
                    } else if (message.type === "INIT_WALLET") {
                        response = { id: message.id, type: "WALLET_INITIALIZED" };
                    } else if (message.type === "GET_STATUS") {
                        response = {
                            id: message.id,
                            payload: {
                                xOnlyPublicKey:
                                    !old && options.wrongIdentity ? new Uint8Array(32) : key,
                            },
                        };
                    } else if (old && message.type === "SET_CONTRACT_WATCH_STATE") {
                        response = {
                            id: message.id,
                            error: new Error(options.error ?? "Unknown message"),
                        };
                    } else {
                        response = await handler.handleMessage(message);
                    }
                    bus.dispatchEvent(
                        new MessageEvent("message", { data: structuredClone(response) }),
                    );
                })();
            },
        });
        return target;
    }
    const oldWorker = worker(true);
    const newWorker = worker(false);
    const registration = Object.assign(new EventTarget(), {
        active: oldWorker,
        waiting: newWorker as typeof newWorker | null,
        installing: null,
    });
    const serviceWorker = Object.assign(bus, {
        getRegistrations: async () => [registration],
        controller: oldWorker,
    });
    vi.stubGlobal("navigator", { serviceWorker });
    const wallet = await ServiceWorkerReadonlyWallet.create({
        serviceWorker: oldWorker as unknown as ServiceWorker,
        identity,
        arkServerUrl: "https://ark.example",
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        messageTimeouts: { SET_CONTRACT_WATCH_STATE: options.timeout ?? 2000 },
    });
    return {
        wallet,
        requests,
        newWorker,
        activate() {
            newWorker.state = "activated";
            registration.active = newWorker;
            registration.waiting = null;
            serviceWorker.controller = newWorker;
            oldWorker.state = "redundant";
            newWorker.dispatchEvent(new Event("statechange"));
            bus.dispatchEvent(new Event("controllerchange"));
        },
    };
}

describe("ServiceWorkerWallet contract watch state", () => {
    let manager: ContractManager;
    let repository: ContractRepository;
    let mockIndexer: IndexerProvider;

    beforeEach(async () => {
        mockIndexer = createMockIndexerProvider();
        repository = new InMemoryContractRepository();
        manager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 1000, reconnectDelayMs: 500 },
        });
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address-1",
        });
        await manager.createContract({
            type: "default",
            params: SECOND_PARAMS,
            script: SECOND_SCRIPT,
            address: "address-2",
        });
    });

    afterEach(async () => {
        await manager.dispose();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("does not rewrite or resubscribe when the proxy repeats the same watch state", async () => {
        const proxy = await createBridgedWallet(manager).getContractManager();
        const save = vi.spyOn(repository, "saveContract");
        const subscribe = vi.mocked(mockIndexer.subscribeForScripts);
        subscribe.mockClear();

        await proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");

        expect(save).toHaveBeenCalledTimes(1);
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0][0]).not.toContain(TEST_DEFAULT_SCRIPT);

        await proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");
        await proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");

        expect(save).toHaveBeenCalledTimes(1);
        expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it("persists real transitions made through the proxy", async () => {
        const proxy = await createBridgedWallet(manager).getContractManager();
        const subscribe = vi.mocked(mockIndexer.subscribeForScripts);

        for (const watch of ["retained", "watched", "awaiting-funds"] as const) {
            subscribe.mockClear();
            await proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, watch);

            expect((await manager.getContracts({ script: TEST_DEFAULT_SCRIPT }))[0].watch).toBe(
                watch,
            );
            expect(subscribe).toHaveBeenCalledTimes(1);
            const scripts = subscribe.mock.calls[0][0];
            expect(scripts).toContain(SECOND_SCRIPT);
            expect(scripts.includes(TEST_DEFAULT_SCRIPT)).toBe(watch !== "retained");
        }
    });

    it("propagates the worker-side error for a missing contract", async () => {
        const proxy = await createBridgedWallet(manager).getContractManager();
        const save = vi.spyOn(repository, "saveContract");

        await expect(proxy.setContractWatchState("deadbeef", "retained")).rejects.toThrow(
            /Contract deadbeef not found/,
        );
        expect(save).not.toHaveBeenCalled();
    });

    it("keeps generic updateContract writes flowing through the proxy", async () => {
        const proxy = await createBridgedWallet(manager).getContractManager();
        const save = vi.spyOn(repository, "saveContract");

        const updated = await proxy.updateContract(TEST_DEFAULT_SCRIPT, { label: "renamed" });

        expect(updated.label).toBe("renamed");
        expect(save).toHaveBeenCalledTimes(1);
    });

    it("waits for an updated worker and preserves watch-state idempotency", async () => {
        const harness = await createUpgradingWallet(manager);
        const proxy = await harness.wallet.getContractManager();
        const save = vi.spyOn(repository, "saveContract");
        const update = proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");
        const result = update.then(
            () => undefined,
            (error: Error) => error,
        );
        await vi.waitFor(() => {
            expect(harness.requests).toContainEqual({
                old: true,
                type: "SET_CONTRACT_WATCH_STATE",
            });
        });
        harness.activate();
        expect(await result).toBeUndefined();
        await proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");
        expect((await manager.getContracts({ script: TEST_DEFAULT_SCRIPT }))[0].watch).toBe(
            "retained",
        );
        expect(save).toHaveBeenCalledTimes(1);
        expect(harness.wallet.serviceWorker).toBe(harness.newWorker);
        expect(harness.requests.some(({ type }) => type === "UPDATE_CONTRACT")).toBe(false);
        expect(harness.requests).toContainEqual({ old: false, type: "INITIALIZE_MESSAGE_BUS" });
    });

    it("does not retry a normal worker error", async () => {
        const harness = await createUpgradingWallet(manager, { error: "Contract not found" });
        const proxy = await harness.wallet.getContractManager();
        await expect(proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained")).rejects.toThrow(
            "Contract not found",
        );
        expect(
            harness.requests.filter(({ type }) => type === "SET_CONTRACT_WATCH_STATE"),
        ).toHaveLength(1);
        expect((await manager.getContracts({ script: TEST_DEFAULT_SCRIPT }))[0].watch).not.toBe(
            "retained",
        );
    });

    it("keeps supported reads available while waiting for worker activation", async () => {
        const harness = await createUpgradingWallet(manager);
        const proxy = await harness.wallet.getContractManager();
        const update = proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");
        await vi.waitFor(() => {
            expect(harness.requests).toContainEqual({
                old: true,
                type: "SET_CONTRACT_WATCH_STATE",
            });
        });
        let readCompleted = false;
        const read = proxy.getContracts().then(() => (readCompleted = true));
        try {
            await expect.poll(() => readCompleted, { timeout: 100 }).toBe(true);
        } finally {
            harness.activate();
            await Promise.all([update, read]);
        }
    });

    it("bounds the wait when the replacement never activates", async () => {
        const harness = await createUpgradingWallet(manager, { timeout: 30 });
        const proxy = await harness.wallet.getContractManager();
        await expect(proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained")).rejects.toThrow(
            /activation timed out/i,
        );
        harness.activate();
        expect(
            harness.requests.some(({ old, type }) => !old && type === "SET_CONTRACT_WATCH_STATE"),
        ).toBe(false);
    });

    it("refuses to retry through a replacement with a different wallet identity", async () => {
        const harness = await createUpgradingWallet(manager, { wrongIdentity: true });
        const proxy = await harness.wallet.getContractManager();
        const update = proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");
        const result = update.then(
            () => undefined,
            (error: Error) => error,
        );
        await vi.waitFor(() => {
            expect(harness.requests).toContainEqual({
                old: true,
                type: "SET_CONTRACT_WATCH_STATE",
            });
        });
        harness.activate();
        expect((await result)?.message).toMatch(/identity mismatch/);
        expect(
            harness.requests.some(({ old, type }) => !old && type === "SET_CONTRACT_WATCH_STATE"),
        ).toBe(false);
    });
});
