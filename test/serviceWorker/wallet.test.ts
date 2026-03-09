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

type MessageHandler = (event: { data: any }) => void;

const createServiceWorkerHarness = (responder?: (message: any) => any) => {
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
            if (!responder) return;
            const response = responder(message);
            if (!response) return;
            listeners.forEach((handler) => handler({ data: response }));
        }),
    };

    const emit = (data: any) => {
        listeners.forEach((handler) => handler({ data }));
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
            manager.getSpendablePaths({ contractScript: "c1" })
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
                        error: new Error("MessageBus not initialized"),
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
                    error: new Error("MessageBus not initialized"),
                };
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWalletWithConfig(serviceWorker as any);
        await expect(wallet.getAddress()).rejects.toThrow(
            "MessageBus not initialized"
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
                        error: new Error("MessageBus not initialized"),
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
});
