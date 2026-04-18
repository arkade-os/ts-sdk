import { describe, it, expect, vi, afterEach } from "vitest";

import {
    ServiceWorkerReadonlyWallet,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";
import {
    WalletMessageHandler,
    DEFAULT_MESSAGE_TAG,
} from "../../src/wallet/serviceWorker/wallet-message-handler";
import {
    MESSAGE_BUS_NOT_INITIALIZED,
    MessageBusNotInitializedError,
    ServiceWorkerTimeoutError,
} from "../../src/worker/errors";

type MessageHandler = (event: { data: any }) => void;

// Simulate the structured clone algorithm that postMessage uses: Error
// subclasses lose their prototype chain and arrive as plain Error objects,
// but name and message are preserved as own properties.
function structuredCloneError(error: Error): Error {
    const cloned = new Error(error.message);
    cloned.name = error.name;
    return cloned;
}

function structuredCloneResponse(response: any): any {
    if (!response || !response.error) return response;
    return { ...response, error: structuredCloneError(response.error) };
}

const createServiceWorkerHarness = (
    responder?: (message: any) => any,
    options?: { handlePing?: boolean }
) => {
    const handlePing = options?.handlePing ?? true;
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
                    })
                );
                return;
            }
            if (!responder) return;
            const response = responder(message);
            if (!response) return;
            const cloned = structuredCloneResponse(response);
            listeners.forEach((handler) => handler({ data: cloned }));
        }),
    };

    const emit = (data: any) => {
        const cloned = structuredCloneResponse(data);
        listeners.forEach((handler) => handler({ data: cloned }));
    };

    return { navigatorServiceWorker, serviceWorker, emit, listeners };
};

const createWallet = (
    serviceWorker: ServiceWorker,
    messageTag: string = DEFAULT_MESSAGE_TAG
) =>
    new (ServiceWorkerReadonlyWallet as any)(
        serviceWorker,
        {} as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        messageTag
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
            .spyOn(
                await import("../../src/worker/browser/utils"),
                "setupServiceWorker"
            )
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
        expect(createMock).toHaveBeenCalledWith(
            expect.objectContaining({ serviceWorker })
        );
    });

    it("sends GET_ADDRESS and returns the payload", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
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
            })
        );
    });

    it("returns boarding UTXOs from BOARDING_UTXOS payload", async () => {
        const utxos = [
            { txid: "tx", vout: 0, value: 1, status: { confirmed: true } },
        ];
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
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
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
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

        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            } as any)
        ).resolves.toEqual(contract);
        await expect(manager.getContracts()).resolves.toEqual(contracts);
        await expect(manager.getContractsWithVtxos({} as any)).resolves.toEqual(
            contractsWithVtxos
        );
        await expect(
            manager.updateContract("c1", { label: "new" })
        ).resolves.toEqual(contract);
        await expect(manager.deleteContract("c1")).resolves.toBeUndefined();
        await expect(
            manager.getSpendablePaths({ contractScript: "c1" } as any)
        ).resolves.toEqual(paths);
        await expect(manager.isWatching()).resolves.toBe(true);

        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "CREATE_CONTRACT",
            })
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
});

const createSWWallet = (
    serviceWorker: ServiceWorker,
    messageTag: string = DEFAULT_MESSAGE_TAG,
    hasDelegator: boolean = false
) =>
    new (ServiceWorkerWallet as any)(
        serviceWorker,
        { toHex: () => "deadbeef" } as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        messageTag,
        hasDelegator
    ) as ServiceWorkerWallet;

describe("ServiceWorkerWallet", () => {
    const handler = new WalletMessageHandler();
    const messageTag = handler.messageTag;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("getDelegatorManager returns undefined when no delegator configured", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness();

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createSWWallet(serviceWorker as any, messageTag, false);
        await expect(wallet.getDelegatorManager()).resolves.toBeUndefined();
    });

    it("getDelegatorManager returns a manager that proxies messages", async () => {
        const delegateInfo = {
            pubkey: "02abc",
            fee: "100",
            delegatorAddress: "tark1addr",
        };

        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
        const manager = await wallet.getDelegatorManager();
        expect(manager).toBeDefined();

        await expect(manager!.getDelegateInfo()).resolves.toEqual(delegateInfo);
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "GET_DELEGATE_INFO",
            })
        );

        const result = await manager!.delegate(
            [{ txid: "abc", vout: 0 }] as any,
            "dest-addr"
        );
        expect(result).toEqual({
            delegated: [{ txid: "abc", vout: 0 }],
            failed: [],
        });
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: messageTag,
                type: "DELEGATE",
            })
        );
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

    const createWalletWithConfig = (
        serviceWorker: ServiceWorker,
        tag = messageTag
    ) => {
        const wallet = createWallet(serviceWorker, tag);
        (wallet as any).initConfig = stubConfig.initConfig;
        (wallet as any).initWalletPayload = stubConfig.initWalletPayload;
        return wallet;
    };

    const createSWWalletWithConfig = (
        serviceWorker: ServiceWorker,
        tag = messageTag
    ) => {
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
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            })
        );
    });

    it("throws after exhausting retries", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
        await expect(wallet.getAddress()).rejects.toThrow(
            MESSAGE_BUS_NOT_INITIALIZED
        );

        // Should have tried 3 times (1 initial + 2 retries)
        const addressCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_ADDRESS"
        );
        expect(addressCalls).toHaveLength(3);
    });

    it("deduplicates concurrent reinitializations", async () => {
        let swInitialized = false;
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
        const [address, balance] = await Promise.all([
            wallet.getAddress(),
            wallet.getBalance(),
        ]);

        expect(address).toBe("bc1-dedup");
        expect(balance.total).toBe(0);

        // INITIALIZE_MESSAGE_BUS should have been sent only once
        const initCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.tag === "INITIALIZE_MESSAGE_BUS"
        );
        expect(initCalls).toHaveLength(1);
    });

    it("does not retry for errors other than 'MessageBus not initialized'", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
                id: message.id,
                tag: messageTag,
                error: new Error("something else went wrong"),
            }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        await expect(wallet.getAddress()).rejects.toThrow(
            "something else went wrong"
        );

        // Should have tried only once (no retry for unrelated errors)
        const addressCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_ADDRESS"
        );
        expect(addressCalls).toHaveLength(1);
    });

    it("retries streaming operations (settle) after dead-SW reinitialize", async () => {
        let swInitialized = false;
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            })
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
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
        const [b1, b2] = await Promise.all([
            wallet.getBalance(),
            wallet.getBalance(),
        ]);

        expect(b1.total).toBe(100);
        expect(b2.total).toBe(100);

        const balanceCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_BALANCE"
        );
        expect(balanceCalls).toHaveLength(1);
    });

    it("does not dedup state-mutating requests", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            ([msg]: any) => msg.type === "SEND_BITCOIN"
        );
        expect(sendCalls).toHaveLength(2);
    });

    it("deduplicates requests with identical payloads", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            ([msg]: any) => msg.type === "GET_VTXOS"
        );
        expect(vtxoCalls).toHaveLength(1);
    });

    it("does NOT dedup different payloads", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            ([msg]: any) => msg.type === "GET_VTXOS"
        );
        expect(vtxoCalls).toHaveLength(2);
    });

    it("cache clears after settlement so sequential calls hit SW", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            ([msg]: any) => msg.type === "GET_BALANCE"
        );
        expect(balanceCalls).toHaveLength(2);
    });

    it("shares error across deduped callers", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
        const results = await Promise.allSettled([
            wallet.getBalance(),
            wallet.getBalance(),
        ]);

        expect(results[0].status).toBe("rejected");
        expect(results[1].status).toBe("rejected");
        expect((results[0] as PromiseRejectedResult).reason.message).toContain(
            "server exploded"
        );
        expect((results[1] as PromiseRejectedResult).reason.message).toContain(
            "server exploded"
        );

        const balanceCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_BALANCE"
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

    const createWalletWithConfig = (
        serviceWorker: ServiceWorker,
        tag = messageTag
    ) => {
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
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            expect.objectContaining({ tag: "PING" })
        );
    });

    it("reinitializes when ping fails (dead SW)", async () => {
        vi.useFakeTimers();

        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness(
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
                { handlePing: false }
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
            })
        );
    });

    it("deduplicates concurrent pings", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
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
            ([msg]: any) => msg.tag === "PING"
        );
        expect(pingCalls).toHaveLength(1);
    });

    it("ping times out after 2s, not 30s", async () => {
        vi.useFakeTimers();

        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness(undefined, {
                handlePing: false,
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any, messageTag);
        const pingPromise = (wallet as any).pingServiceWorker();

        // Attach rejection handler before advancing timers to
        // avoid unhandled-rejection warning
        const assertion = expect(pingPromise).rejects.toBeInstanceOf(
            ServiceWorkerTimeoutError
        );
        await vi.advanceTimersByTimeAsync(2_000);
        await assertion;
    });
});
