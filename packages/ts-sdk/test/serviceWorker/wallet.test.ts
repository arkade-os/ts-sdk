import { describe, it, expect, vi, afterEach } from "vitest";

import {
    ServiceWorkerReadonlyWallet,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    ReadonlySingleKey,
    MnemonicIdentity,
    SeedIdentity,
    ReadonlyDescriptorIdentity,
    ArkCashCreateError,
    type ContractSyncState,
} from "../../src";
import { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hex } from "@scure/base";
import {
    WalletMessageHandler,
    DEFAULT_MESSAGE_TAG,
} from "../../src/wallet/serviceWorker/wallet-message-handler";
import { MESSAGE_BUS_NOT_INITIALIZED, ServiceWorkerTimeoutError } from "../../src/worker/errors";
import { DEFAULT_ARKADE_SERVER_URL } from "../../src/networks";

type MessageHandler = (event: { data: any }) => void;

const STUB_XONLY_PUBLIC_KEY = new Uint8Array(32).fill(0xab);

// Simulate the structured clone algorithm that postMessage uses
function structuredCloneError(error: any): any {
    if (error instanceof Error) {
        const cloned = new Error(error.message);
        cloned.name = error.name;
        return cloned;
    }
    if (error && typeof error === "object") {
        return JSON.parse(JSON.stringify(error));
    }
    return error;
}

function structuredCloneResponse(response: any): any {
    if (!response || !response.error) return response;
    return { ...response, error: structuredCloneError(response.error) };
}

const createServiceWorkerHarness = (
    responder?: (message: any) => any,
    options?: {
        handlePing?: boolean;
        getStatusKey?: Uint8Array | null;
        contractSyncState?: ContractSyncState;
    },
) => {
    const handlePing = options?.handlePing ?? true;
    const contractSyncState: ContractSyncState = options?.contractSyncState ?? { mode: "online" };
    // Auto-answer GET_STATUS with this x-only key when the responder does not
    // handle it, so the create()/reinitialize() identity assertion can pass.
    // Pass `null` to disable the auto-answer (e.g. to exercise a worker that
    // reports no identity).
    const getStatusKey =
        options && "getStatusKey" in options ? options.getStatusKey : STUB_XONLY_PUBLIC_KEY;
    const listeners = new Set<MessageHandler>();

    const navigatorServiceWorker = {
        addEventListener: vi.fn((type: string, handler: MessageHandler) => {
            if (type === "message") listeners.add(handler);
        }),
        removeEventListener: vi.fn((type: string, handler: MessageHandler) => {
            if (type === "message") listeners.delete(handler);
        }),
    };

    const serviceWorker = {
        postMessage: vi.fn((message: any) => {
            if (handlePing && message.tag === "PING") {
                listeners.forEach((handler) =>
                    handler({
                        data: { id: message.id, tag: "PONG" },
                    }),
                );
                return;
            }
            const response = responder ? responder(message) : null;
            if (response) {
                const cloned = structuredCloneResponse(response);
                listeners.forEach((handler) => handler({ data: cloned }));
                return;
            }
            if (message.type === "GET_STATUS" && getStatusKey !== null) {
                listeners.forEach((handler) =>
                    handler({
                        data: {
                            id: message.id,
                            tag: message.tag,
                            type: "WALLET_STATUS",
                            payload: {
                                walletInitialized: true,
                                xOnlyPublicKey: getStatusKey,
                            },
                        },
                    }),
                );
            }
            // Auto-answer the contract-manager proxy's construction-time /
            // refresh sync-state probe so tests that don't care about sync state
            // don't hang. Tests that assert degraded state pass a `responder`.
            if (message.type === "GET_CONTRACT_SYNC_STATE") {
                listeners.forEach((handler) =>
                    handler({
                        data: {
                            id: message.id,
                            tag: message.tag,
                            type: "CONTRACT_SYNC_STATE",
                            payload: { syncState: contractSyncState },
                        },
                    }),
                );
            }
        }),
    };

    const emit = (data: any) => {
        const cloned = structuredCloneResponse(data);
        listeners.forEach((handler) => handler({ data: cloned }));
    };

    return { navigatorServiceWorker, serviceWorker, emit, listeners };
};

const createWallet = (serviceWorker: ServiceWorker, messageTag: string = DEFAULT_MESSAGE_TAG) =>
    new (ServiceWorkerReadonlyWallet as any)(
        serviceWorker,
        { xOnlyPublicKey: async () => STUB_XONLY_PUBLIC_KEY } as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        messageTag,
    ) as ServiceWorkerReadonlyWallet;

describe("ServiceWorkerReadonlyWallet", () => {
    const handler = new WalletMessageHandler();
    const messageTag = handler.messageTag;

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("passes the activation timeout through setup", async () => {
        const serviceWorker = { state: "activated" } as ServiceWorker;
        const setupServiceWorkerMock = vi
            .spyOn(await import("../../src/worker/browser/utils"), "setupServiceWorker")
            .mockResolvedValue(serviceWorker);
        const createMock = vi
            .spyOn(ServiceWorkerReadonlyWallet, "create")
            .mockResolvedValue({} as ServiceWorkerReadonlyWallet);

        await ServiceWorkerReadonlyWallet.setup({
            serviceWorkerPath: "/sw.js",
            serviceWorkerActivationTimeoutMs: 30_000,
            arkServerUrl: "https://ark.example",
            identity: {} as any,
        });

        expect(setupServiceWorkerMock).toHaveBeenCalledWith({
            path: "/sw.js",
            activationTimeoutMs: 30_000,
        });
        expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ serviceWorker }));
    });

    it("sends GET_ADDRESS and returns the payload", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => ({
            id: message.id,
            tag: messageTag,
            type: "ADDRESS",
            payload: { address: "bc1-test" },
        }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        await expect(wallet.getAddress()).resolves.toBe("bc1-test");

        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "GET_ADDRESS",
            }),
        );
    });

    it("returns boarding UTXOs from BOARDING_UTXOS payload", async () => {
        const utxos = [{ txid: "tx", vout: 0, value: 1, status: { confirmed: true } }];
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => ({
            id: message.id,
            tag: messageTag,
            type: "BOARDING_UTXOS",
            payload: { utxos },
        }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        await expect(wallet.getBoardingUtxos()).resolves.toEqual(utxos);
    });

    it("rejects when the response contains an error", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => ({
            id: message.id,
            tag: messageTag,
            error: new Error("boom"),
        }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        await expect(wallet.getBalance()).rejects.toThrow("boom");
    });

    it("routes contract manager calls through WalletUpdater messages", async () => {
        const contract = { id: "c1" };
        const contracts = [contract];
        const contractsWithVtxos = [{ contract, vtxos: [] }];
        const paths = [{ id: "p1" }];

        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            switch (message.type) {
                case "CREATE_CONTRACT":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "CONTRACT_CREATED",
                        payload: { contract },
                    };
                case "GET_CONTRACTS":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "CONTRACTS",
                        payload: { contracts },
                    };
                case "GET_CONTRACTS_WITH_VTXOS":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "CONTRACTS_WITH_VTXOS",
                        payload: { contracts: contractsWithVtxos },
                    };
                case "UPDATE_CONTRACT":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "CONTRACT_UPDATED",
                        payload: { contract },
                    };
                case "DELETE_CONTRACT":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "CONTRACT_DELETED",
                        payload: { deleted: true },
                    };
                case "GET_SPENDABLE_PATHS":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "SPENDABLE_PATHS",
                        payload: { paths },
                    };
                case "IS_CONTRACT_MANAGER_WATCHING":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "CONTRACT_WATCHING",
                        payload: { isWatching: true },
                    };
                default:
                    return null;
            }
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager();

        await expect(
            manager.createContract({
                type: "test",
                params: {},
                script: "00",
                address: "addr",
            } as any),
        ).resolves.toEqual(contract);
        await expect(manager.getContracts()).resolves.toEqual(contracts);
        await expect(manager.getContractsWithVtxos({} as any)).resolves.toEqual(contractsWithVtxos);
        await expect(manager.updateContract("c1", { label: "new" })).resolves.toEqual(contract);
        await expect(manager.deleteContract("c1")).resolves.toBeUndefined();
        await expect(manager.getSpendablePaths({ contractScript: "c1" } as any)).resolves.toEqual(
            paths,
        );
        await expect(manager.isWatching()).resolves.toBe(true);

        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "CREATE_CONTRACT",
            }),
        );
    });

    it("relays CONTRACT_EVENT broadcasts to onContractEvent subscribers", async () => {
        const { navigatorServiceWorker, serviceWorker, emit, listeners } =
            createServiceWorkerHarness();

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager();

        const callback = vi.fn();
        const unsubscribe = manager.onContractEvent(callback);

        emit({
            tag: messageTag,
            type: "CONTRACT_EVENT",
            payload: { event: { type: "connection_reset", timestamp: 1 } },
        });

        expect(callback).toHaveBeenCalledWith({
            type: "connection_reset",
            timestamp: 1,
        });

        unsubscribe();
        emit({
            tag: messageTag,
            type: "CONTRACT_EVENT",
            payload: { event: { type: "connection_reset", timestamp: 2 } },
        });

        expect(callback).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(0);
    });

    it("seeds the contract-manager proxy sync cache from the worker (degraded, not the online stub)", async () => {
        const degraded: ContractSyncState = {
            mode: "degraded",
            reason: "indexer down",
            lastSyncedAt: 7,
        };
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(undefined, {
            contractSyncState: degraded,
        });
        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager();

        expect(manager.getSyncState()).toEqual(degraded);
    });

    it("refreshes the proxy sync cache after getContractsWithVtxos", async () => {
        let syncProbe = 0;
        const responder = (message: any) => {
            if (message.type === "GET_CONTRACTS_WITH_VTXOS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "CONTRACTS_WITH_VTXOS",
                    payload: { contracts: [] },
                };
            }
            if (message.type === "GET_CONTRACT_SYNC_STATE") {
                syncProbe += 1;
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "CONTRACT_SYNC_STATE",
                    payload: {
                        syncState:
                            syncProbe === 1
                                ? { mode: "online" }
                                : { mode: "degraded", reason: "indexer down" },
                    },
                };
            }
            return null;
        };
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(responder);
        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager(); // probe #1 → online
        expect(manager.getSyncState()).toEqual({ mode: "online" });

        await manager.getContractsWithVtxos({} as any); // worker degraded → probe #2
        expect(manager.getSyncState()).toMatchObject({ mode: "degraded", reason: "indexer down" });
    });

    it("reports degraded (never a fabricated online) when the initial sync-state probe fails", async () => {
        // Probe fails (error response) — models a timeout / old worker / error.
        const responder = (message: any) => {
            if (message.type === "GET_CONTRACT_SYNC_STATE") {
                return { id: message.id, tag: messageTag, error: new Error("probe failed") };
            }
            return null;
        };
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(responder);
        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager();

        expect(manager.getSyncState().mode).toBe("degraded");
    });

    it("recovers from a failed initial probe once an operation refresh succeeds", async () => {
        let probe = 0;
        const responder = (message: any) => {
            if (message.type === "GET_CONTRACTS_WITH_VTXOS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "CONTRACTS_WITH_VTXOS",
                    payload: { contracts: [] },
                };
            }
            if (message.type === "GET_CONTRACT_SYNC_STATE") {
                probe += 1;
                // Construction probe fails; the post-operation probe succeeds.
                return probe === 1
                    ? { id: message.id, tag: messageTag, error: new Error("probe failed") }
                    : {
                          id: message.id,
                          tag: messageTag,
                          type: "CONTRACT_SYNC_STATE",
                          payload: { syncState: { mode: "online" } },
                      };
            }
            return null;
        };
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(responder);
        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager();
        expect(manager.getSyncState().mode).toBe("degraded"); // initial probe failed

        await manager.getContractsWithVtxos({} as any); // refresh succeeds
        expect(manager.getSyncState()).toEqual({ mode: "online" });
    });

    it("preserves the last known state when a refresh fails after a prior success", async () => {
        let probe = 0;
        const responder = (message: any) => {
            if (message.type === "GET_CONTRACTS_WITH_VTXOS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "CONTRACTS_WITH_VTXOS",
                    payload: { contracts: [] },
                };
            }
            if (message.type === "GET_CONTRACT_SYNC_STATE") {
                probe += 1;
                // Construction probe succeeds (online); the post-operation probe fails.
                return probe === 1
                    ? {
                          id: message.id,
                          tag: messageTag,
                          type: "CONTRACT_SYNC_STATE",
                          payload: { syncState: { mode: "online" } },
                      }
                    : { id: message.id, tag: messageTag, error: new Error("probe failed") };
            }
            return null;
        };
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(responder);
        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const manager = await wallet.getContractManager();
        expect(manager.getSyncState()).toEqual({ mode: "online" });

        await manager.getContractsWithVtxos({} as any); // refresh fails → keep last known
        expect(manager.getSyncState()).toEqual({ mode: "online" });
    });
});

const createSWWallet = (
    serviceWorker: ServiceWorker,
    messageTag: string = DEFAULT_MESSAGE_TAG,
    hasDelegate: boolean = false,
) =>
    new (ServiceWorkerWallet as any)(
        serviceWorker,
        { toHex: () => "deadbeef", xOnlyPublicKey: async () => STUB_XONLY_PUBLIC_KEY } as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        messageTag,
        hasDelegate,
    ) as ServiceWorkerWallet;

describe("ServiceWorkerWallet", () => {
    const handler = new WalletMessageHandler();
    const messageTag = handler.messageTag;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("getDelegateManager returns undefined when no delegate configured", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness();

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag, false);
        await expect(wallet.getDelegateManager()).resolves.toBeUndefined();
    });

    it("getDelegateManager returns a manager that proxies messages", async () => {
        const delegateInfo = {
            pubkey: "02abc",
            fee: "100",
            delegateAddress: "tark1addr",
            delegatorAddress: "tark1addr",
        };

        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            switch (message.type) {
                case "GET_DELEGATE_INFO":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "DELEGATE_INFO",
                        payload: { info: delegateInfo },
                    };
                case "DELEGATE":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "DELEGATE_SUCCESS",
                        payload: {
                            delegated: [{ txid: "abc", vout: 0 }],
                            failed: [],
                        },
                    };
                default:
                    return null;
            }
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag, true);
        const manager = await wallet.getDelegateManager();
        expect(manager).toBeDefined();

        await expect(manager!.getDelegateInfo()).resolves.toEqual(delegateInfo);
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "GET_DELEGATE_INFO",
            }),
        );

        const result = await manager!.delegate([{ txid: "abc", vout: 0 }] as any, "dest-addr");
        expect(result).toEqual({
            delegated: [{ txid: "abc", vout: 0 }],
            failed: [],
        });
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "DELEGATE",
            }),
        );
    });

    it("restore() forwards gapLimit and resolves on RESTORE_WALLET_SUCCESS", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "RESTORE_WALLET") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "RESTORE_WALLET_SUCCESS",
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        await expect(wallet.restore({ gapLimit: 30 })).resolves.toBeUndefined();
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "RESTORE_WALLET",
                payload: { gapLimit: 30 },
            }),
        );
    });

    it("restore() defaults to an empty payload when called without options", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => ({
            id: message.id,
            tag: messageTag,
            type: "RESTORE_WALLET_SUCCESS",
        }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        await expect(wallet.restore()).resolves.toBeUndefined();
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "RESTORE_WALLET",
                payload: {},
            }),
        );
    });

    it("restore() reconstructs a worker-side AggregateError on the page", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type !== "RESTORE_WALLET") return null;
            return {
                id: message.id,
                tag: messageTag,
                error: {
                    name: "AggregateError",
                    message: "restore failed",
                    errors: [
                        { name: "HandlerAError", message: "handler-a-failed" },
                        { name: "Error", message: "handler-b-failed" },
                    ],
                },
            };
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        let caught: unknown;
        try {
            await wallet.restore({ gapLimit: 20 });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(AggregateError);
        const agg = caught as AggregateError;
        expect(agg.message).toBe("restore failed");
        expect(agg.errors).toHaveLength(2);
        expect(agg.errors[0]).toBeInstanceOf(Error);
        expect((agg.errors[0] as Error).name).toBe("HandlerAError");
        expect((agg.errors[0] as Error).message).toBe("handler-a-failed");
        expect((agg.errors[1] as Error).message).toBe("handler-b-failed");
    });

    it("createCash() forwards the amount and returns the token", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type !== "CREATE_CASH") return null;
            return {
                id: message.id,
                tag: messageTag,
                type: "CREATE_CASH_SUCCESS",
                payload: { cash: "arkcash1token" },
            };
        });

        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        await expect(wallet.createCash(5000)).resolves.toBe("arkcash1token");
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "CREATE_CASH",
                payload: { amount: 5000 },
            }),
        );
    });

    it("createCash() reconstructs a worker-side ArkCashCreateError with its token", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type !== "CREATE_CASH") return null;
            return {
                id: message.id,
                tag: messageTag,
                error: {
                    name: "ArkCashCreateError",
                    message: "send failed",
                    cash: "arkcash1recover",
                },
            };
        });

        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        let caught: unknown;
        try {
            await wallet.createCash(5000);
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(ArkCashCreateError);
        expect((caught as ArkCashCreateError).cash).toBe("arkcash1recover");
    });

    it("claimCash() forwards the token and returns the claim result", async () => {
        const result = { swept: 5000, unclaimed: { amount: 0, vtxos: [] } };
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type !== "CLAIM_CASH") return null;
            return {
                id: message.id,
                tag: messageTag,
                type: "CLAIM_CASH_SUCCESS",
                payload: { result },
            };
        });

        vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        await expect(wallet.claimCash("arkcash1token")).resolves.toEqual(result);
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "CLAIM_CASH",
                payload: { cash: "arkcash1token" },
            }),
        );
    });

    it("restore() propagates non-AggregateError failures as-is", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type !== "RESTORE_WALLET") return null;
            return {
                id: message.id,
                tag: messageTag,
                error: new Error("boom"),
            };
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        await expect(wallet.restore()).rejects.toThrow("boom");
    });
});

describe("sendMessage reinitialize on SW restart", () => {
    const handler = new WalletMessageHandler();
    const messageTag = handler.messageTag;

    const stubConfig = {
        initConfig: {
            wallet: { publicKey: "deadbeef" },
            arkServer: { url: "https://ark.test" },
        },
        initWalletPayload: {
            key: { publicKey: "deadbeef" },
            arkServerUrl: "https://ark.test",
        },
    };

    const createWalletWithConfig = (serviceWorker: ServiceWorker, tag = messageTag) => {
        const wallet = createWallet(serviceWorker, tag);
        (wallet as any).initConfig = stubConfig.initConfig;
        (wallet as any).initWalletPayload = stubConfig.initWalletPayload;
        return wallet;
    };

    const createSWWalletWithConfig = (serviceWorker: ServiceWorker, tag = messageTag) => {
        const wallet = createSWWallet(serviceWorker, tag);
        (wallet as any).initConfig = stubConfig.initConfig;
        (wallet as any).initWalletPayload = stubConfig.initWalletPayload;
        return wallet;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("retries after re-initializing when SW returns 'MessageBus not initialized'", async () => {
        let swInitialized = false;
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                swInitialized = true;
                return {
                    id: message.id,
                    tag: "INITIALIZE_MESSAGE_BUS",
                };
            }
            if (message.type === "INIT_WALLET") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "WALLET_INITIALIZED",
                };
            }
            if (!swInitialized) {
                return {
                    id: message.id,
                    tag: messageTag,
                    // Across the ServiceWorker boundary the custom error is transformed in a primitive Error type
                    // and `name` is lost
                    error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                };
            }
            if (message.type === "GET_ADDRESS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "ADDRESS",
                    payload: { address: "bc1-reinit" },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        const address = await wallet.getAddress();

        expect(address).toBe("bc1-reinit");
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: "INITIALIZE_MESSAGE_BUS",
            }),
        );
    });

    it("throws after exhausting retries", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                return {
                    id: message.id,
                    tag: "INITIALIZE_MESSAGE_BUS",
                };
            }
            if (message.type === "INIT_WALLET") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "WALLET_INITIALIZED",
                };
            }
            // Let the post-init identity assertion pass so reinitialize()
            // succeeds and GET_ADDRESS exhausts its own retry budget.
            if (message.type === "GET_STATUS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "WALLET_STATUS",
                    payload: {
                        walletInitialized: true,
                        xOnlyPublicKey: STUB_XONLY_PUBLIC_KEY,
                    },
                };
            }
            // Always return not-initialized (simulates persistent failure)
            return {
                id: message.id,
                tag: message.tag ?? messageTag,
                error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
            };
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        await expect(wallet.getAddress()).rejects.toThrow(MESSAGE_BUS_NOT_INITIALIZED);

        // Should have tried 3 times (1 initial + 2 retries)
        const addressCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_ADDRESS",
        );
        expect(addressCalls).toHaveLength(3);
    });

    it("deduplicates concurrent reinitializations", async () => {
        let swInitialized = false;
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                swInitialized = true;
                return {
                    id: message.id,
                    tag: "INITIALIZE_MESSAGE_BUS",
                };
            }
            if (message.type === "INIT_WALLET") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "WALLET_INITIALIZED",
                };
            }
            if (!swInitialized) {
                return {
                    id: message.id,
                    tag: messageTag,
                    error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                };
            }
            switch (message.type) {
                case "GET_ADDRESS":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "ADDRESS",
                        payload: { address: "bc1-dedup" },
                    };
                case "GET_BALANCE":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "BALANCE",
                        payload: {
                            onchain: { confirmed: 0, unconfirmed: 0 },
                            offchain: {
                                settled: 0,
                                preconfirmed: 0,
                                recoverable: 0,
                            },
                            total: 0,
                        },
                    };
                default:
                    return null;
            }
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);

        // Both fail simultaneously, triggering concurrent reinit
        const [address, balance] = await Promise.all([wallet.getAddress(), wallet.getBalance()]);

        expect(address).toBe("bc1-dedup");
        expect(balance.total).toBe(0);

        // INITIALIZE_MESSAGE_BUS should have been sent only once
        const initCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.tag === "INITIALIZE_MESSAGE_BUS",
        );
        expect(initCalls).toHaveLength(1);
    });

    it("does not retry for errors other than 'MessageBus not initialized'", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => ({
            id: message.id,
            tag: messageTag,
            error: new Error("something else went wrong"),
        }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        await expect(wallet.getAddress()).rejects.toThrow("something else went wrong");

        // Should have tried only once (no retry for unrelated errors)
        const addressCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_ADDRESS",
        );
        expect(addressCalls).toHaveLength(1);
    });

    it("retries streaming operations (settle) after dead-SW reinitialize", async () => {
        let swInitialized = false;
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                swInitialized = true;
                return {
                    id: message.id,
                    tag: "INITIALIZE_MESSAGE_BUS",
                };
            }
            if (message.type === "INIT_WALLET") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "WALLET_INITIALIZED",
                };
            }
            if (!swInitialized) {
                return {
                    id: message.id,
                    tag: messageTag,
                    error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                };
            }
            if (message.type === "SETTLE") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "SETTLE_SUCCESS",
                    payload: { txid: "txid-after-reinit" },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWalletWithConfig(serviceWorker as any);
        const txid = await wallet.settle();

        expect(txid).toBe("txid-after-reinit");
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: "INITIALIZE_MESSAGE_BUS",
            }),
        );
    });
});

describe("in-flight request deduplication", () => {
    const handler = new WalletMessageHandler();
    const messageTag = handler.messageTag;

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("deduplicates concurrent identical reads", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "GET_BALANCE") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "BALANCE",
                    payload: {
                        onchain: { confirmed: 100, unconfirmed: 0 },
                        offchain: {
                            settled: 0,
                            preconfirmed: 0,
                            recoverable: 0,
                        },
                        total: 100,
                    },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const [b1, b2] = await Promise.all([wallet.getBalance(), wallet.getBalance()]);

        expect(b1.total).toBe(100);
        expect(b2.total).toBe(100);

        const balanceCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_BALANCE",
        );
        expect(balanceCalls).toHaveLength(1);
    });

    it("does not dedup state-mutating requests", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "SEND_BITCOIN") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "SEND_BITCOIN_SUCCESS",
                    payload: { txid: "tx-" + message.id },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag);
        await Promise.all([
            wallet.sendBitcoin({ address: "addr", amount: 1000 }),
            wallet.sendBitcoin({ address: "addr", amount: 1000 }),
        ]);

        const sendCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "SEND_BITCOIN",
        );
        expect(sendCalls).toHaveLength(2);
    });

    it("deduplicates requests with identical payloads", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "GET_VTXOS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "VTXOS",
                    payload: { vtxos: [] },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        await Promise.all([
            wallet.getVtxos({ withRecoverable: true }),
            wallet.getVtxos({ withRecoverable: true }),
        ]);

        const vtxoCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_VTXOS",
        );
        expect(vtxoCalls).toHaveLength(1);
    });

    it("does NOT dedup different payloads", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "GET_VTXOS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "VTXOS",
                    payload: { vtxos: [] },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        await Promise.all([
            wallet.getVtxos({ withRecoverable: true }),
            wallet.getVtxos({ withRecoverable: false }),
        ]);

        const vtxoCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_VTXOS",
        );
        expect(vtxoCalls).toHaveLength(2);
    });

    it("cache clears after settlement so sequential calls hit SW", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "GET_BALANCE") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "BALANCE",
                    payload: {
                        onchain: { confirmed: 0, unconfirmed: 0 },
                        offchain: {
                            settled: 0,
                            preconfirmed: 0,
                            recoverable: 0,
                        },
                        total: 0,
                    },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);

        await wallet.getBalance();
        await wallet.getBalance();

        const balanceCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_BALANCE",
        );
        expect(balanceCalls).toHaveLength(2);
    });

    it("shares error across deduped callers", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "GET_BALANCE") {
                return {
                    id: message.id,
                    tag: messageTag,
                    error: new Error("server exploded"),
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const results = await Promise.allSettled([wallet.getBalance(), wallet.getBalance()]);

        expect(results[0].status).toBe("rejected");
        expect(results[1].status).toBe("rejected");
        expect((results[0] as PromiseRejectedResult).reason.message).toContain("server exploded");
        expect((results[1] as PromiseRejectedResult).reason.message).toContain("server exploded");

        const balanceCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_BALANCE",
        );
        expect(balanceCalls).toHaveLength(1);
    });
});

describe("preflight ping", () => {
    const handler = new WalletMessageHandler();
    const messageTag = handler.messageTag;

    const stubConfig = {
        initConfig: {
            wallet: { publicKey: "deadbeef" },
            arkServer: { url: "https://ark.test" },
        },
        initWalletPayload: {
            key: { publicKey: "deadbeef" },
            arkServerUrl: "https://ark.test",
        },
    };

    const createWalletWithConfig = (serviceWorker: ServiceWorker, tag = messageTag) => {
        const wallet = createWallet(serviceWorker, tag);
        (wallet as any).initConfig = stubConfig.initConfig;
        (wallet as any).initWalletPayload = stubConfig.initWalletPayload;
        return wallet;
    };

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("ping succeeds → request proceeds normally", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            if (message.type === "GET_BALANCE") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "BALANCE",
                    payload: {
                        onchain: {
                            confirmed: 42,
                            unconfirmed: 0,
                        },
                        offchain: {
                            settled: 0,
                            preconfirmed: 0,
                            recoverable: 0,
                        },
                        total: 42,
                    },
                };
            }
            return null;
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        const balance = await wallet.getBalance();

        expect(balance.total).toBe(42);
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ tag: "PING" }),
        );
    });

    it("reinitializes when ping fails (dead SW)", async () => {
        vi.useFakeTimers();

        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(
            (message) => {
                if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                    return {
                        id: message.id,
                        tag: "INITIALIZE_MESSAGE_BUS",
                    };
                }
                if (message.type === "INIT_WALLET") {
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "WALLET_INITIALIZED",
                    };
                }
                if (message.type === "GET_ADDRESS") {
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "ADDRESS",
                        payload: {
                            address: "bc1-revived",
                        },
                    };
                }
                return null;
            },
            { handlePing: false },
        );

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        const addressPromise = wallet.getAddress();

        // Advance past the 2s ping timeout
        await vi.advanceTimersByTimeAsync(2_000);

        const address = await addressPromise;
        expect(address).toBe("bc1-revived");
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: "INITIALIZE_MESSAGE_BUS",
            }),
        );
    });

    it("deduplicates concurrent pings", async () => {
        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness((message) => {
            switch (message.type) {
                case "GET_ADDRESS":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "ADDRESS",
                        payload: {
                            address: "bc1-dedup",
                        },
                    };
                case "GET_BALANCE":
                    return {
                        id: message.id,
                        tag: messageTag,
                        type: "BALANCE",
                        payload: {
                            onchain: {
                                confirmed: 0,
                                unconfirmed: 0,
                            },
                            offchain: {
                                settled: 0,
                                preconfirmed: 0,
                                recoverable: 0,
                            },
                            total: 0,
                        },
                    };
                default:
                    return null;
            }
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        await Promise.all([wallet.getAddress(), wallet.getBalance()]);

        const pingCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.tag === "PING",
        );
        expect(pingCalls).toHaveLength(1);
    });

    it("ping times out after 2s, not 30s", async () => {
        vi.useFakeTimers();

        const { navigatorServiceWorker, serviceWorker } = createServiceWorkerHarness(undefined, {
            handlePing: false,
        });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const pingPromise = (wallet as any).pingServiceWorker();

        // Attach rejection handler before advancing timers to
        // avoid unhandled-rejection warning
        const assertion = expect(pingPromise).rejects.toBeInstanceOf(ServiceWorkerTimeoutError);
        await vi.advanceTimersByTimeAsync(2_000);
        await assertion;
    });
});

describe("INITIALIZE_MESSAGE_BUS wire shape emitted by create()", () => {
    const messageTag = DEFAULT_MESSAGE_TAG;
    const TEST_MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const TEST_PRIVATE_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const initResponder = (message: any) => {
        if (message.tag === "INITIALIZE_MESSAGE_BUS") {
            return { id: message.id, tag: "INITIALIZE_MESSAGE_BUS" };
        }
        if (message.type === "INIT_WALLET") {
            return {
                id: message.id,
                tag: messageTag,
                type: "WALLET_INITIALIZED",
            };
        }
        return null;
    };

    // Answer the post-init identity assertion's GET_STATUS with the identity's
    // own x-only key so create() resolves. Tests that omit the identity fall
    // back to the stub key (only used by paths that reject before GET_STATUS).
    const setup = async (identity?: { xOnlyPublicKey(): Promise<Uint8Array> }) => {
        const getStatusKey = identity ? await identity.xOnlyPublicKey() : STUB_XONLY_PUBLIC_KEY;
        const harness = createServiceWorkerHarness(initResponder, { getStatusKey });
        vi.stubGlobal("navigator", {
            serviceWorker: harness.navigatorServiceWorker,
        } as any);
        return harness;
    };

    const storage = () => ({
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    });

    const getInitConfigWallet = (serviceWorker: {
        postMessage: ReturnType<typeof vi.fn>;
    }): unknown => {
        const call = serviceWorker.postMessage.mock.calls.find(
            ([msg]: any) => msg?.tag === "INITIALIZE_MESSAGE_BUS",
        );
        expect(call).toBeDefined();
        return call![0].config.wallet;
    };

    const getInitializeMessage = (serviceWorker: {
        postMessage: ReturnType<typeof vi.fn>;
    }): any => {
        const call = serviceWorker.postMessage.mock.calls.find(
            ([msg]: any) => msg?.tag === "INITIALIZE_MESSAGE_BUS",
        );
        expect(call).toBeDefined();
        return call![0];
    };

    const getInitWalletMessage = (serviceWorker: {
        postMessage: ReturnType<typeof vi.fn>;
    }): any => {
        const call = serviceWorker.postMessage.mock.calls.find(
            ([msg]: any) => msg?.type === "INIT_WALLET",
        );
        expect(call).toBeDefined();
        return call![0];
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("SingleKey emits a tagged single-key envelope", async () => {
        const identity = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "single-key",
            privateKey: TEST_PRIVATE_KEY_HEX,
        });
    });

    it("ServiceWorkerWallet.create uses the default Arkade server URL when omitted", async () => {
        const identity = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            identity,
            storage: storage(),
        });

        expect(getInitializeMessage(serviceWorker).config.arkServer.url).toBe(
            DEFAULT_ARKADE_SERVER_URL,
        );
        expect(getInitWalletMessage(serviceWorker).payload.arkServerUrl).toBe(
            DEFAULT_ARKADE_SERVER_URL,
        );
    });

    it("ServiceWorkerWallet.create forwards walletMode to the worker init config", async () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            walletMode: "hd",
            storage: storage(),
        });

        expect(getInitializeMessage(serviceWorker).config.walletMode).toBe("hd");
    });

    it("ServiceWorkerReadonlyWallet.create uses the default Arkade server URL when omitted", async () => {
        const signing = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const identity = await signing.toReadonly();
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerReadonlyWallet.create({
            serviceWorker: serviceWorker as any,
            identity,
            storage: storage(),
        });

        expect(getInitializeMessage(serviceWorker).config.arkServer.url).toBe(
            DEFAULT_ARKADE_SERVER_URL,
        );
        expect(getInitWalletMessage(serviceWorker).payload.arkServerUrl).toBe(
            DEFAULT_ARKADE_SERVER_URL,
        );
    });

    it("ReadonlySingleKey emits a tagged readonly-single-key envelope", async () => {
        const signing = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const identity = await signing.toReadonly();
        const expectedPubKey = hex.encode(await identity.compressedPublicKey());
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerReadonlyWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "readonly-single-key",
            publicKey: expectedPubKey,
        });
    });

    it("MnemonicIdentity emits a tagged mnemonic envelope", async () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "mnemonic",
            mnemonic: TEST_MNEMONIC,
            descriptor: identity.descriptor,
        });
    });

    it("MnemonicIdentity with passphrase includes it in the envelope", async () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
            passphrase: "extra secret",
        });
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker) as {
            type: string;
            passphrase?: string;
        };
        expect(wallet.type).toBe("mnemonic");
        expect(wallet.passphrase).toBe("extra secret");
    });

    it("SeedIdentity emits a tagged seed envelope", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "seed",
            seed: hex.encode(seed),
            descriptor: identity.descriptor,
        });
    });

    it("ReadonlyDescriptorIdentity emits a tagged readonly-descriptor envelope", async () => {
        const reference = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const identity = ReadonlyDescriptorIdentity.fromDescriptor(reference.descriptor);
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerReadonlyWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "readonly-descriptor",
            descriptor: reference.descriptor,
        });
    });

    it("ServiceWorkerReadonlyWallet downgrades a signing mnemonic identity to readonly-descriptor", async () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
            passphrase: "extra secret",
        });
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerReadonlyWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "readonly-descriptor",
            descriptor: identity.descriptor,
        });
        const onWire = JSON.stringify(wallet);
        expect(onWire).not.toContain("abandon");
        expect(onWire).not.toContain("extra secret");
    });

    it("ServiceWorkerReadonlyWallet with a signing SingleKey downgrades to readonly-single-key", async () => {
        const identity = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const expectedPubKey = hex.encode(await identity.compressedPublicKey());
        const { serviceWorker } = await setup(identity);

        await ServiceWorkerReadonlyWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        const wallet = getInitConfigWallet(serviceWorker);
        expect(wallet).toEqual({
            type: "readonly-single-key",
            publicKey: expectedPubKey,
        });
        expect(JSON.stringify(wallet)).not.toContain(TEST_PRIVATE_KEY_HEX);
    });

    it("ServiceWorkerWallet.create rejects a ReadonlyIdentity input", async () => {
        const { serviceWorker } = await setup();
        const readonly = ReadonlySingleKey.fromPublicKey(
            await SingleKey.fromHex(TEST_PRIVATE_KEY_HEX).compressedPublicKey(),
        );

        await expect(
            ServiceWorkerWallet.create({
                serviceWorker: serviceWorker as any,
                arkServerUrl: "https://ark.test",
                identity: readonly as any,
                storage: storage(),
            }),
        ).rejects.toThrow(/requires a signing Identity/);
    });
});

describe("ServiceWorker identity boundary assertion", () => {
    const messageTag = DEFAULT_MESSAGE_TAG;
    const KEY_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const KEY_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    const storage = () => ({
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    });

    // Drives the init handshake and answers GET_STATUS with `statusKey` so each test controls
    // exactly what identity the worker claims.
    const initResponder = (statusKey: Uint8Array | "omit") => (message: any) => {
        if (message.tag === "INITIALIZE_MESSAGE_BUS") {
            return { id: message.id, tag: "INITIALIZE_MESSAGE_BUS" };
        }
        if (message.type === "INIT_WALLET") {
            return { id: message.id, tag: messageTag, type: "WALLET_INITIALIZED" };
        }
        if (message.type === "GET_STATUS") {
            return {
                id: message.id,
                tag: messageTag,
                type: "WALLET_STATUS",
                payload: {
                    walletInitialized: true,
                    xOnlyPublicKey: statusKey === "omit" ? undefined : statusKey,
                },
            };
        }
        return null;
    };

    // Disable the harness auto-status so the responder fully controls GET_STATUS.
    const stub = (responder: (m: any) => any) => {
        const harness = createServiceWorkerHarness(responder, { getStatusKey: null });
        vi.stubGlobal("navigator", { serviceWorker: harness.navigatorServiceWorker } as any);
        return harness;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("create() resolves when the worker reports the matching identity", async () => {
        const identity = await SingleKey.fromHex(KEY_A);
        const key = await identity.xOnlyPublicKey();
        const { serviceWorker } = stub(initResponder(key));

        await expect(
            ServiceWorkerWallet.create({
                serviceWorker: serviceWorker as any,
                arkServerUrl: "https://ark.test",
                identity,
                storage: storage(),
            }),
        ).resolves.toBeDefined();
    });

    it("create() rejects when the worker reports a different identity", async () => {
        const identity = SingleKey.fromHex(KEY_A);
        const otherKey = await SingleKey.fromHex(KEY_B).xOnlyPublicKey();
        const { serviceWorker } = stub(initResponder(otherKey));

        await expect(
            ServiceWorkerWallet.create({
                serviceWorker: serviceWorker as any,
                arkServerUrl: "https://ark.test",
                identity,
                storage: storage(),
            }),
        ).rejects.toThrow(/identity mismatch/i);
    });

    it("reinitialize() rejects on mismatch before retrying the original wallet message", async () => {
        const identity = SingleKey.fromHex(KEY_A);
        const expectedKey = await identity.xOnlyPublicKey();
        const otherKey = await SingleKey.fromHex(KEY_B).xOnlyPublicKey();

        // The first init (inside create) matches; a later re-init reports a
        // different identity, so recovery must reject rather than rebind.
        let initCount = 0;
        const { serviceWorker } = stub((message: any) => {
            if (message.tag === "INITIALIZE_MESSAGE_BUS") {
                initCount += 1;
                return { id: message.id, tag: "INITIALIZE_MESSAGE_BUS" };
            }
            if (message.type === "INIT_WALLET") {
                return { id: message.id, tag: messageTag, type: "WALLET_INITIALIZED" };
            }
            if (message.type === "GET_STATUS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    type: "WALLET_STATUS",
                    payload: {
                        walletInitialized: true,
                        xOnlyPublicKey: initCount >= 2 ? otherKey : expectedKey,
                    },
                };
            }
            // Force the wallet down the not-initialized → reinitialize path.
            if (message.type === "GET_ADDRESS") {
                return {
                    id: message.id,
                    tag: messageTag,
                    error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                };
            }
            return null;
        });

        const wallet = await ServiceWorkerWallet.create({
            serviceWorker: serviceWorker as any,
            arkServerUrl: "https://ark.test",
            identity,
            storage: storage(),
        });

        await expect(wallet.getAddress()).rejects.toThrow(/identity mismatch/i);

        // The mismatch is detected inside reinitialize(), so the original
        // GET_ADDRESS is never retried against the wrong identity.
        const addressCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_ADDRESS",
        );
        expect(addressCalls).toHaveLength(1);
    });
});
