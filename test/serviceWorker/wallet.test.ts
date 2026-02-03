import { describe, it, expect, vi, afterEach } from "vitest";

import {
    ServiceWorkerReadonlyWallet,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import { WalletUpdater } from "../../src/wallet/serviceWorker/wallet-updater";

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

const createWallet = (serviceWorker: ServiceWorker) =>
    new (ServiceWorkerReadonlyWallet as any)(
        serviceWorker,
        {} as any,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository()
    ) as ServiceWorkerReadonlyWallet;

describe("ServiceWorkerReadonlyWallet", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("sends GET_ADDRESS and returns the payload", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
                id: message.id,
                tag: WalletUpdater.messageTag,
                type: "ADDRESS",
                payload: { address: "bc1-test" },
            }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any);
        await expect(wallet.getAddress()).resolves.toBe("bc1-test");

        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: WalletUpdater.messageTag,
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
                tag: WalletUpdater.messageTag,
                type: "BOARDING_UTXOS",
                payload: { utxos },
            }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any);
        await expect(wallet.getBoardingUtxos()).resolves.toEqual(utxos);
    });

    it("rejects when the response contains an error", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
                id: message.id,
                tag: WalletUpdater.messageTag,
                error: new Error("boom"),
            }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const wallet = createWallet(serviceWorker as any);
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
                            tag: WalletUpdater.messageTag,
                            type: "CONTRACT_CREATED",
                            payload: { contract },
                        };
                    case "GET_CONTRACTS":
                        return {
                            id: message.id,
                            tag: WalletUpdater.messageTag,
                            type: "CONTRACTS",
                            payload: { contracts },
                        };
                    case "GET_CONTRACTS_WITH_VTXOS":
                        return {
                            id: message.id,
                            tag: WalletUpdater.messageTag,
                            type: "CONTRACTS_WITH_VTXOS",
                            payload: { contracts: contractsWithVtxos },
                        };
                    case "UPDATE_CONTRACT":
                        return {
                            id: message.id,
                            tag: WalletUpdater.messageTag,
                            type: "CONTRACT_UPDATED",
                            payload: { contract },
                        };
                    case "DELETE_CONTRACT":
                        return {
                            id: message.id,
                            tag: WalletUpdater.messageTag,
                            type: "CONTRACT_DELETED",
                            payload: { deleted: true },
                        };
                    case "GET_SPENDABLE_PATHS":
                        return {
                            id: message.id,
                            tag: WalletUpdater.messageTag,
                            type: "SPENDABLE_PATHS",
                            payload: { paths },
                        };
                    case "IS_CONTRACT_MANAGER_WATCHING":
                        return {
                            id: message.id,
                            tag: WalletUpdater.messageTag,
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

        const wallet = createWallet(serviceWorker as any);
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
        await expect(manager.updateContract("c1", { label: "new" })).resolves.toEqual(
            contract
        );
        await expect(manager.deleteContract("c1")).resolves.toBeUndefined();
        await expect(
            manager.getSpendablePaths({ contractId: "c1" })
        ).resolves.toEqual(paths);
        await expect(manager.isWatching()).resolves.toBe(true);

        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: WalletUpdater.messageTag,
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

        const wallet = createWallet(serviceWorker as any);
        const manager = await wallet.getContractManager();

        const callback = vi.fn();
        const unsubscribe = manager.onContractEvent(callback);

        emit({
            tag: WalletUpdater.messageTag,
            type: "CONTRACT_EVENT",
            payload: { event: { type: "connection_reset", timestamp: 1 } },
        });

        expect(callback).toHaveBeenCalledWith({
            type: "connection_reset",
            timestamp: 1,
        });

        unsubscribe();
        emit({
            tag: WalletUpdater.messageTag,
            type: "CONTRACT_EVENT",
            payload: { event: { type: "connection_reset", timestamp: 2 } },
        });

        expect(callback).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(0);
    });
});
