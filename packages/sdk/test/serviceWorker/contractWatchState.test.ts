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

// Keeps the subscription non-empty, so an absent POST cannot mean "nothing to subscribe".
const SECOND_SCRIPT_OPTIONS = {
    pubKey: TEST_DELEGATE_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
};
const SECOND_PARAMS = DefaultContractHandler.serializeParams(SECOND_SCRIPT_OPTIONS);
const SECOND_SCRIPT = hex.encode(new DefaultVtxo.Script(SECOND_SCRIPT_OPTIONS).pkScript);

/**
 * The page-side proxy wired to a real `WalletMessageHandler` and `ContractManager`.
 * `stale` emulates a worker predating SET_CONTRACT_WATCH_STATE.
 */
const createBridgedWallet = (manager: ContractManager, options: { stale?: boolean } = {}) => {
    const handler = new WalletMessageHandler();
    (handler as any).readonlyWallet = {
        getContractManager: async () => manager,
        getContractSyncState: () => ({ mode: "online" }),
    };

    const requests: string[] = [];
    const listeners = new Set<(event: { data: any }) => void>();
    const emit = (data: any) => listeners.forEach((l) => l({ data }));
    const serviceWorker = {
        postMessage: (message: WalletUpdaterRequest & { tag?: string }) => {
            if (message.tag === "PING") {
                emit({ id: message.id, tag: "PONG" });
                return;
            }
            requests.push(message.type);
            if (options.stale && message.type === "SET_CONTRACT_WATCH_STATE") {
                queueMicrotask(() =>
                    emit({ id: message.id, tag: message.tag, error: new Error("Unknown message") }),
                );
                return;
            }
            void handler.handleMessage(message).then(emit);
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

    const wallet = new (ServiceWorkerReadonlyWallet as any)(
        serviceWorker as any,
        { xOnlyPublicKey: async () => new Uint8Array(32).fill(0xab) } as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        handler.messageTag,
    ) as ServiceWorkerReadonlyWallet;
    return { wallet, requests };
};

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
        const proxy = await createBridgedWallet(manager).wallet.getContractManager();
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
        const proxy = await createBridgedWallet(manager).wallet.getContractManager();
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
        const proxy = await createBridgedWallet(manager).wallet.getContractManager();
        const save = vi.spyOn(repository, "saveContract");

        await expect(proxy.setContractWatchState("deadbeef", "retained")).rejects.toThrow(
            /Contract deadbeef not found/,
        );
        expect(save).not.toHaveBeenCalled();
    });

    it("falls back to the generic update on a worker predating the message", async () => {
        const { wallet, requests } = createBridgedWallet(manager, { stale: true });
        const proxy = await wallet.getContractManager();

        await proxy.setContractWatchState(TEST_DEFAULT_SCRIPT, "retained");

        expect(requests.filter((type) => type !== "GET_CONTRACT_SYNC_STATE")).toEqual([
            "SET_CONTRACT_WATCH_STATE",
            "UPDATE_CONTRACT",
        ]);
        expect((await manager.getContracts({ script: TEST_DEFAULT_SCRIPT }))[0].watch).toBe(
            "retained",
        );
    });
});
