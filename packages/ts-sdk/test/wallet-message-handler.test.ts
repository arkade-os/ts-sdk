import { describe, it, expect, vi, beforeEach } from "vitest";

import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../src/wallet/serviceWorker/wallet-message-handler";
import { InMemoryWalletRepository } from "../src";
import {
    createMockExtendedVtxo,
    createMockIndexerProvider,
    TEST_DEFAULT_ARK_ADDRESS,
    TEST_DEFAULT_SCRIPT,
} from "./contracts/helpers";
const baseMessage = (id: string = "1") => ({
    id,
    tag: DEFAULT_MESSAGE_TAG,
});

describe("WalletMessageHandler handleMessage", () => {
    let updater: WalletMessageHandler;

    beforeEach(() => {
        updater = new WalletMessageHandler();
    });

    const init = () =>
        updater.handleMessage({
            ...baseMessage(),
            type: "INIT_WALLET",
            payload: {
                key: { publicKey: "00" },
                arkServerUrl: "http://example.com",
            },
        } as any);

    it("initializes the wallet on INIT_WALLET", async () => {
        const initSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).handleInitWallet = initSpy;

        const message = {
            ...baseMessage(),
            type: "INIT_WALLET",
            payload: {
                key: { publicKey: "00" },
                arkServerUrl: "http://example.com",
            },
        } as any;

        const response = await updater.handleMessage(message);

        expect(initSpy).toHaveBeenCalledWith(message);
        expect(response).toEqual({
            tag: updater.messageTag,
            id: "1",
            type: "WALLET_INITIALIZED",
        });
    });

    it("returns a tagged error when the wallet is missing", async () => {
        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_ADDRESS",
        } as any);

        expect(response.tag).toBe(updater.messageTag);
        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Wallet handler not initialized");
    });

    it("handles SETTLE messages", async () => {
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {};
        const settleSpy = vi.fn().mockResolvedValue({
            type: "SETTLE_SUCCESS",
            payload: { txid: "tx" },
        });
        (updater as any).handleSettle = settleSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "SETTLE",
            payload: {},
        } as any);

        expect(settleSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "SETTLE_SUCCESS",
            payload: { txid: "tx" },
        });
    });

    it("handles SEND_BITCOIN messages", async () => {
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {};
        const sendSpy = vi.fn().mockResolvedValue({
            type: "SEND_BITCOIN_SUCCESS",
            payload: { txid: "tx" },
        });
        (updater as any).handleSendBitcoin = sendSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "SEND_BITCOIN",
            payload: { address: "addr", amount: 1 },
        } as any);

        expect(sendSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "SEND_BITCOIN_SUCCESS",
            payload: { txid: "tx" },
        });
    });

    it("handles SIGN_TRANSACTION messages", async () => {
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {};
        const signedTx = { id: "signed-tx" };
        const signSpy = vi.fn().mockResolvedValue({
            type: "SIGN_TRANSACTION",
            payload: { tx: signedTx },
        });
        (updater as any).handleSignTransaction = signSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "SIGN_TRANSACTION",
            payload: { tx: { id: "unsigned-tx" } },
        } as any);

        expect(signSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "SIGN_TRANSACTION",
            payload: { tx: signedTx },
        });
    });

    it("handles GET_ADDRESS messages", async () => {
        (updater as any).readonlyWallet = {
            getAddress: vi.fn().mockResolvedValue("bc1-test"),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_ADDRESS",
        } as any);

        expect(response).toEqual({
            tag: updater.messageTag,
            id: "1",
            type: "ADDRESS",
            payload: { address: "bc1-test" },
        });
    });

    it("handles GET_BOARDING_ADDRESS messages", async () => {
        (updater as any).readonlyWallet = {
            getBoardingAddress: vi.fn().mockResolvedValue("bc1-boarding"),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BOARDING_ADDRESS",
        } as any);

        expect(response).toEqual({
            tag: updater.messageTag,
            id: "1",
            type: "BOARDING_ADDRESS",
            payload: { address: "bc1-boarding" },
        });
    });

    it("handles GET_BALANCE messages", async () => {
        (updater as any).readonlyWallet = {};
        const balance = {
            boarding: { confirmed: 1, unconfirmed: 0, total: 1 },
            settled: 1,
            preconfirmed: 0,
            available: 1,
            recoverable: 0,
            total: 2,
        };
        (updater as any).handleGetBalance = vi.fn().mockResolvedValue(balance);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BALANCE",
        } as any);

        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "BALANCE",
            payload: balance,
        });
    });

    it("handles GET_VTXOS messages", async () => {
        (updater as any).readonlyWallet = {};
        const vtxos = [{ id: "v1" }];
        (updater as any).handleGetVtxos = vi.fn().mockResolvedValue(vtxos);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_VTXOS",
            payload: {},
        } as any);

        expect(response).toEqual({
            tag: updater.messageTag,
            id: "1",
            type: "VTXOS",
            payload: { vtxos },
        });
    });

    it("handles GET_BOARDING_UTXOS messages", async () => {
        (updater as any).readonlyWallet = {};
        const utxos = [{ txid: "tx", vout: 0, value: 1, status: { confirmed: true } }];
        (updater as any).getAllBoardingUtxos = vi.fn().mockResolvedValue(utxos);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BOARDING_UTXOS",
        } as any);

        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "BOARDING_UTXOS",
            payload: { utxos },
        });
    });

    it("handles GET_TRANSACTION_HISTORY messages", async () => {
        const transactions = [{ txid: "tx" }];
        (updater as any).readonlyWallet = {};
        (updater as any).buildTransactionHistoryFromCache = vi.fn().mockResolvedValue(transactions);
        (updater as any).getVtxosFromRepo = vi.fn().mockResolvedValue([]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_TRANSACTION_HISTORY",
        } as any);

        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "TRANSACTION_HISTORY",
            payload: { transactions },
        });
    });

    it("handles GET_STATUS messages", async () => {
        const pubkey = new Uint8Array([1, 2, 3]);
        (updater as any).readonlyWallet = {
            identity: {
                xOnlyPublicKey: vi.fn().mockResolvedValue(pubkey),
            },
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_STATUS",
        } as any);

        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "WALLET_STATUS",
            payload: {
                walletInitialized: true,
                xOnlyPublicKey: pubkey,
            },
        });
    });

    it("handles CLEAR messages", async () => {
        (updater as any).readonlyWallet = {};
        const clearSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).clear = clearSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "CLEAR",
        } as any);

        expect(clearSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "CLEAR_SUCCESS",
            payload: { cleared: true },
        });
    });

    it("handles RELOAD_WALLET messages", async () => {
        (updater as any).readonlyWallet = {};
        const reloadSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).reloadWallet = reloadSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RELOAD_WALLET",
        } as any);

        expect(reloadSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "RELOAD_SUCCESS",
            payload: { reloaded: true },
        });
    });

    it("handles contract manager messages", async () => {
        const contract = { id: "c1" };
        const contracts = [contract];
        const contractsWithVtxos = [{ id: "c2", vtxos: [] }];
        const paths = [{ id: "p1" }];
        const manager = {
            createContract: vi.fn().mockResolvedValue(contract),
            getContracts: vi.fn().mockResolvedValue(contracts),
            getContractsWithVtxos: vi.fn().mockResolvedValue(contractsWithVtxos),
            updateContract: vi.fn().mockResolvedValue(contract),
            deleteContract: vi.fn().mockResolvedValue(undefined),
            getSpendablePaths: vi.fn().mockResolvedValue(paths),
            isWatching: vi.fn().mockResolvedValue(true),
            refreshVtxos: vi.fn().mockResolvedValue(undefined),
        };
        (updater as any).readonlyWallet = {
            getContractManager: vi.fn().mockResolvedValue(manager),
        };

        const createResponse = await updater.handleMessage({
            ...baseMessage("c"),
            type: "CREATE_CONTRACT",
            payload: { type: "test", params: {}, script: "00", address: "a" },
        } as any);
        expect(createResponse).toMatchObject({
            tag: updater.messageTag,
            type: "CONTRACT_CREATED",
            payload: { contract },
        });

        const getResponse = await updater.handleMessage({
            ...baseMessage("g"),
            type: "GET_CONTRACTS",
            payload: {},
        } as any);
        expect(getResponse).toMatchObject({
            tag: updater.messageTag,
            type: "CONTRACTS",
            payload: { contracts },
        });

        const getWithVtxosResponse = await updater.handleMessage({
            ...baseMessage("gw"),
            type: "GET_CONTRACTS_WITH_VTXOS",
            payload: {},
        } as any);
        expect(getWithVtxosResponse).toMatchObject({
            tag: updater.messageTag,
            type: "CONTRACTS_WITH_VTXOS",
            payload: { contracts: contractsWithVtxos },
        });

        const updateResponse = await updater.handleMessage({
            ...baseMessage("u"),
            type: "UPDATE_CONTRACT",
            payload: { script: "00", updates: { label: "new" } },
        } as any);
        expect(updateResponse).toMatchObject({
            tag: updater.messageTag,
            type: "CONTRACT_UPDATED",
            payload: { contract },
        });

        const deleteResponse = await updater.handleMessage({
            ...baseMessage("d"),
            type: "DELETE_CONTRACT",
            payload: { script: "00" },
        } as any);
        expect(deleteResponse).toMatchObject({
            tag: updater.messageTag,
            type: "CONTRACT_DELETED",
            payload: { deleted: true },
        });

        const spendablePathsResponse = await updater.handleMessage({
            ...baseMessage("p"),
            type: "GET_SPENDABLE_PATHS",
            payload: { options: { contractId: "c1" } },
        } as any);
        expect(spendablePathsResponse).toMatchObject({
            tag: updater.messageTag,
            type: "SPENDABLE_PATHS",
            payload: { paths },
        });

        const watchingResponse = await updater.handleMessage({
            ...baseMessage("w"),
            type: "IS_CONTRACT_MANAGER_WATCHING",
        } as any);
        expect(watchingResponse).toMatchObject({
            tag: updater.messageTag,
            type: "CONTRACT_WATCHING",
            payload: { isWatching: true },
        });

        const refreshResponse = await updater.handleMessage({
            ...baseMessage("r"),
            type: "REFRESH_VTXOS",
        } as any);
        expect(manager.refreshVtxos).toHaveBeenCalled();
        expect(refreshResponse).toMatchObject({
            tag: updater.messageTag,
            type: "REFRESH_VTXOS_SUCCESS",
        });
    });

    it("broadcasts contract events without subscriptions", async () => {
        const unsubscribe = vi.fn();
        let eventCallback: ((event: any) => void) | undefined;
        const manager = {
            onContractEvent: vi.fn((cb: any) => {
                eventCallback = cb;
                return unsubscribe;
            }),
        };
        (updater as any).readonlyWallet = {
            getContractManager: vi.fn().mockResolvedValue(manager),
        };

        await (updater as any).ensureContractEventBroadcasting();
        expect(manager.onContractEvent).toHaveBeenCalled();

        const event = { type: "test", contractId: "c1" };
        eventCallback?.(event);

        const tickResponses = await updater.tick(Date.now());
        expect(tickResponses).toEqual([
            {
                tag: updater.messageTag,
                type: "CONTRACT_EVENT",
                broadcast: true,
                payload: { event },
            },
        ]);
    });

    it("returns a tagged error for unknown message types", async () => {
        (updater as any).readonlyWallet = {};

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "UNKNOWN",
        } as any);

        expect(response.tag).toBe(updater.messageTag);
        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Unknown message");
    });

    it("read operations work with readonly wallet only", async () => {
        (updater as any).readonlyWallet = {
            getAddress: vi.fn().mockResolvedValue(TEST_DEFAULT_ARK_ADDRESS),
            getBoardingAddress: vi.fn().mockResolvedValue("bc1-boarding"),
            getBoardingTxs: vi.fn().mockResolvedValue({
                boardingTxs: [],
                commitmentsToIgnore: new Set(),
            }),
            getContractManager: vi.fn().mockResolvedValue({
                getContracts: vi.fn().mockResolvedValue([]),
            }),
            identity: {
                xOnlyPublicKey: vi.fn().mockResolvedValue(new Uint8Array([1])),
            },
        };
        (updater as any).walletRepository = {
            getVtxos: vi.fn().mockResolvedValue([]),
        };
        // wallet is NOT set — readonly only

        const addrRes = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_ADDRESS",
        } as any);
        expect(addrRes).toMatchObject({
            type: "ADDRESS",
            payload: { address: TEST_DEFAULT_ARK_ADDRESS },
        });

        const boardingRes = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BOARDING_ADDRESS",
        } as any);
        expect(boardingRes).toMatchObject({
            type: "BOARDING_ADDRESS",
            payload: { address: "bc1-boarding" },
        });

        const historyRes = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_TRANSACTION_HISTORY",
        } as any);
        expect(historyRes).toMatchObject({
            type: "TRANSACTION_HISTORY",
            payload: { transactions: [] },
        });

        const statusRes = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_STATUS",
        } as any);
        expect(statusRes).toMatchObject({
            type: "WALLET_STATUS",
            payload: { walletInitialized: true },
        });
    });

    it("handles DELEGATE messages successfully", async () => {
        const vtxos = [
            { txid: "abc", vout: 0, value: 1000 },
            { txid: "def", vout: 1, value: 2000 },
        ];
        const delegateResult = {
            delegated: [{ txid: "abc", vout: 0 }],
            failed: [
                {
                    outpoints: [{ txid: "def", vout: 1 }],
                    error: "some error",
                },
            ],
        };
        const delegateSpy = vi.fn().mockResolvedValue(delegateResult);
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxos: vi.fn().mockResolvedValue(vtxos),
            getDelegateManager: vi.fn().mockResolvedValue({
                delegate: delegateSpy,
            }),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "DELEGATE",
            payload: {
                vtxoOutpoints: [
                    { txid: "abc", vout: 0 },
                    { txid: "def", vout: 1 },
                ],
                destination: "dest-addr",
            },
        } as any);

        expect(delegateSpy).toHaveBeenCalledWith(vtxos, "dest-addr", undefined);
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "DELEGATE_SUCCESS",
            payload: {
                delegated: [{ txid: "abc", vout: 0 }],
                failed: [
                    {
                        outpoints: [{ txid: "def", vout: 1 }],
                        error: "some error",
                    },
                ],
            },
        });
    });

    it("handles DELEGATE with delegateAt timestamp", async () => {
        const vtxos = [{ txid: "abc", vout: 0, value: 1000 }];
        const delegateAt = 1700000000000;
        const delegateSpy = vi.fn().mockResolvedValue({
            delegated: [{ txid: "abc", vout: 0 }],
            failed: [],
        });
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxos: vi.fn().mockResolvedValue(vtxos),
            getDelegateManager: vi.fn().mockResolvedValue({
                delegate: delegateSpy,
            }),
        };

        await updater.handleMessage({
            ...baseMessage(),
            type: "DELEGATE",
            payload: {
                vtxoOutpoints: [{ txid: "abc", vout: 0 }],
                destination: "dest-addr",
                delegateAt,
            },
        } as any);

        expect(delegateSpy).toHaveBeenCalledWith(vtxos, "dest-addr", new Date(delegateAt));
    });

    it("DELEGATE filters vtxos by requested outpoints", async () => {
        const allVtxos = [
            { txid: "abc", vout: 0, value: 1000 },
            { txid: "xyz", vout: 2, value: 3000 },
        ];
        const delegateSpy = vi.fn().mockResolvedValue({
            delegated: [{ txid: "abc", vout: 0 }],
            failed: [],
        });
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxos: vi.fn().mockResolvedValue(allVtxos),
            getDelegateManager: vi.fn().mockResolvedValue({ delegate: delegateSpy }),
        };

        await updater.handleMessage({
            ...baseMessage(),
            type: "DELEGATE",
            payload: {
                vtxoOutpoints: [{ txid: "abc", vout: 0 }],
                destination: "dest-addr",
            },
        } as any);

        // only the matching vtxo should be passed
        expect(delegateSpy).toHaveBeenCalledWith([allVtxos[0]], "dest-addr", undefined);
    });

    it("DELEGATE fails when delegateManager is not configured", async () => {
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxos: vi.fn().mockResolvedValue([]),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "DELEGATE",
            payload: {
                vtxoOutpoints: [],
                destination: "dest-addr",
            },
        } as any);

        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Delegate not configured");
    });

    it("DELEGATE fails with readonly wallet only", async () => {
        (updater as any).readonlyWallet = {};
        // wallet is NOT set — readonly only

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "DELEGATE",
            payload: {
                vtxoOutpoints: [],
                destination: "dest-addr",
            },
        } as any);

        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Read-only wallet: operation requires signing");
    });

    it("GET_DELEGATE_INFO returns delegate info", async () => {
        const info = {
            pubkey: "02abc",
            fee: "100",
            delegateAddress: "tark1addr",
            delegatorAddress: "tark1addr",
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getDelegateManager: vi.fn().mockResolvedValue({
                getDelegateInfo: vi.fn().mockResolvedValue(info),
            }),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_DELEGATE_INFO",
        } as any);

        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "DELEGATE_INFO",
            payload: { info },
        });
    });

    it("GET_DELEGATE_INFO fails when delegateManager is not configured", async () => {
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_DELEGATE_INFO",
        } as any);

        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Delegate not configured");
    });

    it("handles RECOVER_VTXOS messages", async () => {
        const vtxoManager = {
            recoverVtxos: vi.fn().mockResolvedValue("recover-txid"),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RECOVER_VTXOS",
        } as any);

        expect(vtxoManager.recoverVtxos).toHaveBeenCalledWith(expect.any(Function));
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "RECOVER_VTXOS_SUCCESS",
            payload: { txid: "recover-txid" },
        });
    });

    it("RECOVER_VTXOS forwards settlement events via tick", async () => {
        const event = { type: "batch_started", id: "b1" };
        const vtxoManager = {
            recoverVtxos: vi.fn().mockImplementation(async (cb: any) => {
                cb(event);
                return "recover-txid";
            }),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        await updater.handleMessage({
            ...baseMessage("r1"),
            type: "RECOVER_VTXOS",
        } as any);

        const tickResponses = await updater.tick(Date.now());
        expect(tickResponses).toEqual([
            {
                tag: updater.messageTag,
                id: "r1",
                type: "RECOVER_VTXOS_EVENT",
                payload: event,
            },
        ]);
    });

    it("handles GET_RECOVERABLE_BALANCE messages", async () => {
        const balance = {
            recoverable: 5000n,
            subdust: 100n,
            includesSubdust: true,
            vtxoCount: 3,
        };
        const vtxoManager = {
            getRecoverableBalance: vi.fn().mockResolvedValue(balance),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_RECOVERABLE_BALANCE",
        } as any);

        expect(vtxoManager.getRecoverableBalance).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "RECOVERABLE_BALANCE",
            payload: {
                recoverable: "5000",
                subdust: "100",
                includesSubdust: true,
                vtxoCount: 3,
            },
        });
    });

    it("handles GET_EXPIRING_VTXOS messages", async () => {
        const vtxos = [{ txid: "v1", vout: 0, value: 1000 }];
        const vtxoManager = {
            getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_EXPIRING_VTXOS",
            payload: { thresholdMs: 86400000 },
        } as any);

        expect(vtxoManager.getExpiringVtxos).toHaveBeenCalledWith(86400000);
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "EXPIRING_VTXOS",
            payload: { vtxos },
        });
    });

    it("handles GET_EXPIRING_VTXOS without thresholdMs", async () => {
        const vtxoManager = {
            getExpiringVtxos: vi.fn().mockResolvedValue([]),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_EXPIRING_VTXOS",
            payload: {},
        } as any);

        expect(vtxoManager.getExpiringVtxos).toHaveBeenCalledWith(undefined);
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "EXPIRING_VTXOS",
            payload: { vtxos: [] },
        });
    });

    it("handles RENEW_VTXOS messages", async () => {
        const vtxoManager = {
            renewVtxos: vi.fn().mockResolvedValue("renew-txid"),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RENEW_VTXOS",
        } as any);

        expect(vtxoManager.renewVtxos).toHaveBeenCalledWith(expect.any(Function), undefined);
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "RENEW_VTXOS_SUCCESS",
            payload: { txid: "renew-txid" },
        });
    });

    it("handles RENEW_VTXOS messages with a thresholdSeconds payload", async () => {
        const thresholdSeconds = 3600;
        const vtxoManager = {
            renewVtxos: vi.fn().mockResolvedValue("renew-txid"),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RENEW_VTXOS",
            payload: { thresholdSeconds },
        } as any);

        expect(vtxoManager.renewVtxos).toHaveBeenCalledWith(expect.any(Function), {
            thresholdSeconds,
        });
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "RENEW_VTXOS_SUCCESS",
            payload: { txid: "renew-txid" },
        });
    });

    it("RENEW_VTXOS forwards settlement events via tick", async () => {
        const event = { type: "batch_finalized", id: "b2" };
        const vtxoManager = {
            renewVtxos: vi.fn().mockImplementation(async (cb: any) => {
                cb(event);
                return "renew-txid";
            }),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        await updater.handleMessage({
            ...baseMessage("n1"),
            type: "RENEW_VTXOS",
        } as any);

        const tickResponses = await updater.tick(Date.now());
        expect(tickResponses).toEqual([
            {
                tag: updater.messageTag,
                id: "n1",
                type: "RENEW_VTXOS_EVENT",
                payload: event,
            },
        ]);
    });

    it("handles GET_EXPIRED_BOARDING_UTXOS messages", async () => {
        const utxos = [{ txid: "tx1", vout: 0, value: 5000, status: { confirmed: true } }];
        const vtxoManager = {
            getExpiredBoardingUtxos: vi.fn().mockResolvedValue(utxos),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_EXPIRED_BOARDING_UTXOS",
        } as any);

        expect(vtxoManager.getExpiredBoardingUtxos).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "EXPIRED_BOARDING_UTXOS",
            payload: { utxos },
        });
    });

    it("handles SWEEP_EXPIRED_BOARDING_UTXOS messages", async () => {
        const vtxoManager = {
            sweepExpiredBoardingUtxos: vi.fn().mockResolvedValue("sweep-txid"),
        };
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue(vtxoManager),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "SWEEP_EXPIRED_BOARDING_UTXOS",
        } as any);

        expect(vtxoManager.sweepExpiredBoardingUtxos).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "SWEEP_EXPIRED_BOARDING_UTXOS_SUCCESS",
            payload: { txid: "sweep-txid" },
        });
    });

    it("handles RESTORE_WALLET messages and forwards gapLimit", async () => {
        const restoreSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = { restore: restoreSpy };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RESTORE_WALLET",
            payload: { gapLimit: 50 },
        } as any);

        expect(restoreSpy).toHaveBeenCalledWith({ gapLimit: 50 });
        expect(response).toMatchObject({
            tag: updater.messageTag,
            id: "1",
            type: "RESTORE_WALLET_SUCCESS",
        });
    });

    it("handles RESTORE_WALLET messages without gapLimit", async () => {
        const restoreSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = { restore: restoreSpy };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RESTORE_WALLET",
            payload: {},
        } as any);

        expect(restoreSpy).toHaveBeenCalledWith({});
        expect(response).toMatchObject({
            tag: updater.messageTag,
            type: "RESTORE_WALLET_SUCCESS",
        });
    });

    it("RESTORE_WALLET serializes AggregateError into a structured envelope", async () => {
        const child1 = new Error("handler-a-failed");
        child1.name = "HandlerAError";
        const child2 = new Error("handler-b-failed");
        const aggregate = new AggregateError([child1, child2], "restore failed");
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            restore: vi.fn().mockRejectedValue(aggregate),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RESTORE_WALLET",
            payload: { gapLimit: 20 },
        } as any);

        expect(response.error).toMatchObject({
            name: "AggregateError",
            message: "restore failed",
            errors: [
                { name: "HandlerAError", message: "handler-a-failed" },
                { name: "Error", message: "handler-b-failed" },
            ],
        });
    });

    it("RESTORE_WALLET propagates non-AggregateError failures through the standard error path", async () => {
        const err = new Error("oh no");
        (updater as any).readonlyWallet = {};
        (updater as any).wallet = {
            restore: vi.fn().mockRejectedValue(err),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RESTORE_WALLET",
            payload: {},
        } as any);

        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("oh no");
    });

    it("RESTORE_WALLET rejects on readonly wallet", async () => {
        (updater as any).readonlyWallet = {};
        // wallet is NOT set — readonly only

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RESTORE_WALLET",
            payload: {},
        } as any);

        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Read-only wallet: operation requires signing");
    });

    it("isLongRunning returns true for RESTORE_WALLET", () => {
        expect(
            updater.isLongRunning({
                ...baseMessage(),
                type: "RESTORE_WALLET",
                payload: {},
            } as any),
        ).toBe(true);
    });

    it("eagerly starts VtxoManager on wallet initialization", async () => {
        const getVtxoManagerSpy = vi.fn().mockResolvedValue({});
        (updater as any).readonlyWallet = {
            getAddress: vi.fn().mockResolvedValue(TEST_DEFAULT_ARK_ADDRESS),
            getBoardingAddress: vi.fn().mockResolvedValue("bc1-boarding"),
            getBoardingTxs: vi.fn().mockResolvedValue({
                boardingTxs: [],
                commitmentsToIgnore: new Set(),
            }),
            onchainProvider: {
                getCoins: vi.fn().mockResolvedValue([]),
            },
            notifyIncomingFunds: vi.fn().mockResolvedValue(vi.fn()),
            getContractManager: vi.fn().mockResolvedValue({
                getContracts: vi.fn().mockResolvedValue([]),
                onContractEvent: vi.fn().mockReturnValue(vi.fn()),
            }),
        };
        (updater as any).wallet = {
            getVtxoManager: getVtxoManagerSpy,
            finalizePendingTxs: vi.fn().mockResolvedValue({ pending: [], finalized: [] }),
        };
        (updater as any).arkProvider = {};
        (updater as any).indexerProvider = {};
        (updater as any).walletRepository = {
            getVtxos: vi.fn().mockResolvedValue([]),
            saveVtxos: vi.fn().mockResolvedValue(undefined),
            deleteUtxos: vi.fn().mockResolvedValue(undefined),
            saveUtxos: vi.fn().mockResolvedValue(undefined),
            saveTransactions: vi.fn().mockResolvedValue(undefined),
        };

        await (updater as any).onWalletInitialized();

        expect(getVtxoManagerSpy).toHaveBeenCalled();
    });

    it("does not start VtxoManager for readonly wallets", async () => {
        (updater as any).readonlyWallet = {
            getAddress: vi.fn().mockResolvedValue(TEST_DEFAULT_ARK_ADDRESS),
            getBoardingAddress: vi.fn().mockResolvedValue("bc1-boarding"),
            getBoardingTxs: vi.fn().mockResolvedValue({
                boardingTxs: [],
                commitmentsToIgnore: new Set(),
            }),
            onchainProvider: {
                getCoins: vi.fn().mockResolvedValue([]),
            },
            notifyIncomingFunds: vi.fn().mockResolvedValue(vi.fn()),
            getContractManager: vi.fn().mockResolvedValue({
                getContracts: vi.fn().mockResolvedValue([]),
                onContractEvent: vi.fn().mockReturnValue(vi.fn()),
            }),
        };
        // wallet is NOT set — readonly only
        (updater as any).arkProvider = {};
        (updater as any).indexerProvider = {};
        (updater as any).walletRepository = {
            getVtxos: vi.fn().mockResolvedValue([]),
            saveVtxos: vi.fn().mockResolvedValue(undefined),
            deleteUtxos: vi.fn().mockResolvedValue(undefined),
            saveUtxos: vi.fn().mockResolvedValue(undefined),
            saveTransactions: vi.fn().mockResolvedValue(undefined),
        };

        // Should not throw — just skips VtxoManager startup
        await (updater as any).onWalletInitialized();
    });

    it("vtxo manager operations fail with readonly wallet only", async () => {
        (updater as any).readonlyWallet = {};
        // wallet is NOT set — readonly only

        const recoverRes = await updater.handleMessage({
            ...baseMessage(),
            type: "RECOVER_VTXOS",
        } as any);
        expect(recoverRes.error).toBeInstanceOf(Error);
        expect(recoverRes.error?.message).toBe("Read-only wallet: operation requires signing");

        const renewRes = await updater.handleMessage({
            ...baseMessage(),
            type: "RENEW_VTXOS",
        } as any);
        expect(renewRes.error).toBeInstanceOf(Error);
        expect(renewRes.error?.message).toBe("Read-only wallet: operation requires signing");

        const sweepRes = await updater.handleMessage({
            ...baseMessage(),
            type: "SWEEP_EXPIRED_BOARDING_UTXOS",
        } as any);
        expect(sweepRes.error).toBeInstanceOf(Error);
        expect(sweepRes.error?.message).toBe("Read-only wallet: operation requires signing");
    });

    it("signing operations fail with readonly wallet only", async () => {
        (updater as any).readonlyWallet = {};
        // wallet is NOT set — readonly only

        const settleRes = await updater.handleMessage({
            ...baseMessage(),
            type: "SETTLE",
            payload: {},
        } as any);
        expect(settleRes.error).toBeInstanceOf(Error);
        expect(settleRes.error?.message).toBe("Read-only wallet: operation requires signing");

        const sendRes = await updater.handleMessage({
            ...baseMessage(),
            type: "SEND_BITCOIN",
            payload: { address: "addr", amount: 1 },
        } as any);
        expect(sendRes.error).toBeInstanceOf(Error);
        expect(sendRes.error?.message).toBe("Read-only wallet: operation requires signing");

        const signRes = await updater.handleMessage({
            ...baseMessage(),
            type: "SIGN_TRANSACTION",
            payload: { tx: {} },
        } as any);
        expect(signRes.error).toBeInstanceOf(Error);
        expect(signRes.error?.message).toBe("Read-only wallet: operation requires signing");
    });

    it("stop() disposes the wallet and clears references", async () => {
        const disposeSpy = vi.fn().mockResolvedValue(undefined);
        const unsubIncoming = vi.fn();
        const unsubContract = vi.fn();
        (updater as any).wallet = { dispose: disposeSpy };
        (updater as any).readonlyWallet = {};
        (updater as any).arkProvider = {};
        (updater as any).indexerProvider = {};
        (updater as any).incomingFundsSubscription = unsubIncoming;
        (updater as any).contractEventsSubscription = unsubContract;

        await updater.stop();

        expect(unsubIncoming).toHaveBeenCalled();
        expect(unsubContract).toHaveBeenCalled();
        expect(disposeSpy).toHaveBeenCalled();
        expect((updater as any).wallet).toBeUndefined();
        expect((updater as any).readonlyWallet).toBeUndefined();
        expect((updater as any).arkProvider).toBeUndefined();
        expect((updater as any).indexerProvider).toBeUndefined();
        expect((updater as any).incomingFundsSubscription).toBeUndefined();
        expect((updater as any).contractEventsSubscription).toBeUndefined();
    });

    it("stop() disposes readonly wallet when no signing wallet", async () => {
        const disposeSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).readonlyWallet = { dispose: disposeSpy };

        await updater.stop();

        expect(disposeSpy).toHaveBeenCalled();
        expect((updater as any).readonlyWallet).toBeUndefined();
    });

    it("stop() is safe to call when not initialized", async () => {
        await expect(updater.stop()).resolves.toBeUndefined();
    });
});

describe("WalletMessageHandler repo-backed reads", () => {
    let updater: WalletMessageHandler;
    let walletRepo: InMemoryWalletRepository;
    let mockIndexer: ReturnType<typeof createMockIndexerProvider>;

    const baseMessage = (id: string = "1") => ({
        id,
        tag: DEFAULT_MESSAGE_TAG,
    });

    const setupHandler = (contracts: any[] = []) => {
        mockIndexer = createMockIndexerProvider();
        walletRepo = new InMemoryWalletRepository();

        (updater as any).readonlyWallet = {
            getAddress: vi.fn().mockResolvedValue(TEST_DEFAULT_ARK_ADDRESS),
            getBoardingAddress: vi.fn().mockResolvedValue("boarding-address"),
            getBoardingUtxos: vi.fn().mockResolvedValue([]),
            getBoardingTxs: vi.fn().mockResolvedValue({
                boardingTxs: [],
                commitmentsToIgnore: new Set(),
            }),
            dustAmount: 546n,
            getContractManager: vi.fn().mockResolvedValue({
                getContracts: vi.fn().mockResolvedValue(contracts),
                onContractEvent: vi.fn().mockReturnValue(vi.fn()),
            }),
            onchainProvider: {
                getCoins: vi.fn().mockResolvedValue([]),
            },
            notifyIncomingFunds: vi.fn().mockResolvedValue(vi.fn()),
        };
        (updater as any).arkProvider = {};
        (updater as any).indexerProvider = mockIndexer;
        (updater as any).walletRepository = walletRepo;
    };

    beforeEach(() => {
        updater = new WalletMessageHandler();
    });

    it("GET_VTXOS reads from repository, not indexer", async () => {
        setupHandler();
        const vtxo = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 50000,
            virtualStatus: { state: "settled" },
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [vtxo]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_VTXOS",
            payload: { filter: { withRecoverable: true } },
        } as any);

        expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
        expect(response).toMatchObject({
            type: "VTXOS",
            payload: {
                vtxos: expect.arrayContaining([
                    expect.objectContaining({
                        txid: "aa".repeat(32),
                    }),
                ]),
            },
        });
    });

    it("GET_VTXOS filters out recoverable/expired/dust by default", async () => {
        setupHandler();
        const settled = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 50000,
            virtualStatus: { state: "settled" },
        });
        const recoverable = createMockExtendedVtxo({
            txid: "bb".repeat(32),
            value: 50000,
            virtualStatus: { state: "swept" },
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [settled, recoverable]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_VTXOS",
            payload: { filter: { withRecoverable: false } },
        } as any);

        const vtxos = (response as any).payload.vtxos;
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0].txid).toBe("aa".repeat(32));
    });

    it("GET_BALANCE reads from repository, not indexer", async () => {
        setupHandler();
        const settled = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 100000,
            virtualStatus: { state: "settled" },
        });
        const preconfirmed = createMockExtendedVtxo({
            txid: "bb".repeat(32),
            value: 50000,
            virtualStatus: { state: "preconfirmed" },
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [settled, preconfirmed]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BALANCE",
        } as any);

        expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
        expect(response).toMatchObject({
            type: "BALANCE",
            payload: {
                settled: 100000,
                preconfirmed: 50000,
                available: 150000,
            },
        });
    });

    it("GET_TRANSACTION_HISTORY reads from repository, not indexer", async () => {
        setupHandler();
        const vtxo = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 50000,
            virtualStatus: { state: "settled" },
            createdAt: new Date(),
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [vtxo]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_TRANSACTION_HISTORY",
        } as any);

        expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
        expect(response).toMatchObject({
            type: "TRANSACTION_HISTORY",
            payload: { transactions: expect.any(Array) },
        });
    });

    it("GET_VTXOS aggregates across contract addresses", async () => {
        const contracts = [
            { address: "contract-1", script: "s1" },
            { address: "contract-2", script: "s2" },
        ];
        setupHandler(contracts);

        const vtxo1 = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 10000,
            virtualStatus: { state: "settled" },
            script: "s1",
        });
        const vtxo2 = createMockExtendedVtxo({
            txid: "bb".repeat(32),
            value: 20000,
            virtualStatus: { state: "settled" },
            script: "s2",
        });
        await walletRepo.saveVtxos("contract-1", [vtxo1]);
        await walletRepo.saveVtxos("contract-2", [vtxo2]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_VTXOS",
            payload: { filter: { withRecoverable: true } },
        } as any);

        const vtxos = (response as any).payload.vtxos;
        expect(vtxos).toHaveLength(2);
    });

    it("GET_BALANCE accounts for VTXOs from all contracts", async () => {
        const contracts = [
            { address: "contract-1", script: "s1" },
            { address: "contract-2", script: "s2" },
        ];
        setupHandler(contracts);

        await walletRepo.saveVtxos("contract-1", [
            createMockExtendedVtxo({
                txid: "aa".repeat(32),
                value: 10000,
                virtualStatus: { state: "settled" },
                script: "s1",
            }),
        ]);
        await walletRepo.saveVtxos("contract-2", [
            createMockExtendedVtxo({
                txid: "bb".repeat(32),
                value: 20000,
                virtualStatus: { state: "settled" },
                script: "s2",
            }),
        ]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BALANCE",
        } as any);

        expect(response).toMatchObject({
            type: "BALANCE",
            payload: {
                settled: 30000,
                available: 30000,
            },
        });
    });

    it("GET_VTXOS deduplicates across wallet and contract addresses", async () => {
        const contracts = [{ address: TEST_DEFAULT_ARK_ADDRESS, script: TEST_DEFAULT_SCRIPT }];
        setupHandler(contracts);

        const vtxo = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 50000,
            virtualStatus: { state: "settled" },
        });
        // Save same VTXO under both keys (contract address = wallet address)
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [vtxo]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_VTXOS",
            payload: { filter: { withRecoverable: true } },
        } as any);

        // Should not appear twice
        const vtxos = (response as any).payload.vtxos;
        expect(vtxos).toHaveLength(1);
    });

    it("finalizePendingTxs receives repo-backed VTXOs filtered by state", async () => {
        setupHandler();
        const preconfirmed = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 50000,
            virtualStatus: { state: "preconfirmed" },
        });
        const settled = createMockExtendedVtxo({
            txid: "bb".repeat(32),
            value: 30000,
            virtualStatus: { state: "settled" },
        });
        const swept = createMockExtendedVtxo({
            txid: "cc".repeat(32),
            value: 20000,
            virtualStatus: { state: "swept" },
        });
        const spent = createMockExtendedVtxo({
            txid: "dd".repeat(32),
            value: 10000,
            virtualStatus: { state: "spent" },
            isSpent: true,
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [preconfirmed, settled, swept, spent]);

        const finalizeSpy = vi.fn().mockResolvedValue({ pending: [], finalized: [] });
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue({}),
            finalizePendingTxs: finalizeSpy,
        };

        await (updater as any).onWalletInitialized();

        expect(finalizeSpy).toHaveBeenCalledOnce();
        const vtxosArg = finalizeSpy.mock.calls[0][0];
        // Should exclude swept, settled, and spent VTXOs
        expect(vtxosArg).toHaveLength(1);
        expect(vtxosArg[0].txid).toBe("aa".repeat(32));
    });

    it("boarding UTXO fetch via onchainProvider is unaffected", async () => {
        setupHandler();
        const getCoinsSpy = (updater as any).readonlyWallet.onchainProvider.getCoins;
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue({}),
            finalizePendingTxs: vi.fn().mockResolvedValue({ pending: [], finalized: [] }),
        };

        await (updater as any).onWalletInitialized();

        expect(getCoinsSpy).toHaveBeenCalledWith("boarding-address");
    });

    it("RELOAD_WALLET forces refreshVtxos before reading from repo", async () => {
        setupHandler();
        const refreshSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).readonlyWallet.getContractManager = vi.fn().mockResolvedValue({
            getContracts: vi.fn().mockResolvedValue([]),
            onContractEvent: vi.fn().mockReturnValue(vi.fn()),
            refreshVtxos: refreshSpy,
        });
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue({}),
            finalizePendingTxs: vi.fn().mockResolvedValue({ pending: [], finalized: [] }),
        };

        await updater.handleMessage({
            ...baseMessage(),
            type: "RELOAD_WALLET",
        } as any);

        expect(refreshSpy).toHaveBeenCalled();
    });

    it("RELOAD_WALLET does not re-subscribe or restart VtxoManager", async () => {
        setupHandler();
        const notifyFundsSpy = (updater as any).readonlyWallet.notifyIncomingFunds;
        const getVtxoManagerSpy = vi.fn().mockResolvedValue({});
        const refreshSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).readonlyWallet.getContractManager = vi.fn().mockResolvedValue({
            getContracts: vi.fn().mockResolvedValue([]),
            onContractEvent: vi.fn().mockReturnValue(vi.fn()),
            refreshVtxos: refreshSpy,
        });
        (updater as any).wallet = {
            getVtxoManager: getVtxoManagerSpy,
            finalizePendingTxs: vi.fn().mockResolvedValue({ pending: [], finalized: [] }),
        };

        // First: full init (sets up subscriptions + VtxoManager)
        await (updater as any).onWalletInitialized();
        expect(notifyFundsSpy).toHaveBeenCalledOnce();
        expect(getVtxoManagerSpy).toHaveBeenCalledOnce();

        // Reset spies to track only reloadWallet calls
        notifyFundsSpy.mockClear();
        getVtxoManagerSpy.mockClear();

        // Second: reload should NOT re-subscribe or restart VtxoManager
        await updater.handleMessage({
            ...baseMessage(),
            type: "RELOAD_WALLET",
        } as any);

        expect(refreshSpy).toHaveBeenCalled();
        expect(notifyFundsSpy).not.toHaveBeenCalled();
        expect(getVtxoManagerSpy).not.toHaveBeenCalled();
    });

    it("RELOAD_WALLET does not call finalizePendingTxs", async () => {
        setupHandler();
        const finalizeSpy = vi.fn().mockResolvedValue({ pending: [], finalized: [] });
        const refreshSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).readonlyWallet.getContractManager = vi.fn().mockResolvedValue({
            getContracts: vi.fn().mockResolvedValue([]),
            onContractEvent: vi.fn().mockReturnValue(vi.fn()),
            refreshVtxos: refreshSpy,
        });
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue({}),
            finalizePendingTxs: finalizeSpy,
        };

        await updater.handleMessage({
            ...baseMessage(),
            type: "RELOAD_WALLET",
        } as any);

        expect(refreshSpy).toHaveBeenCalled();
        expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it("onWalletInitialized does not call indexerProvider.getVtxos", async () => {
        setupHandler();
        (updater as any).wallet = {
            getVtxoManager: vi.fn().mockResolvedValue({}),
            finalizePendingTxs: vi.fn().mockResolvedValue({ pending: [], finalized: [] }),
        };

        await (updater as any).onWalletInitialized();

        // indexerProvider.getVtxos should NOT have been called directly
        // (contract manager calls it during its own init, but the SW
        // bootstrap should not make additional calls)
        expect(mockIndexer.getVtxos).not.toHaveBeenCalled();

        // Second call with contractEventsSubscription already set —
        // ensureContractEventBroadcasting short-circuits, but the
        // reload path should still not hit the indexer directly.
        (updater as any).contractEventsSubscription = {};
        await (updater as any).onWalletInitialized();
        expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
    });

    it("subscription updates are reflected in subsequent reads", async () => {
        setupHandler();
        const initial = createMockExtendedVtxo({
            txid: "aa".repeat(32),
            value: 10000,
            virtualStatus: { state: "settled" },
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [initial]);

        // Simulate subscription update by saving new VTXOs
        const newVtxo = createMockExtendedVtxo({
            txid: "bb".repeat(32),
            value: 20000,
            virtualStatus: { state: "settled" },
        });
        await walletRepo.saveVtxos(TEST_DEFAULT_ARK_ADDRESS, [newVtxo]);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BALANCE",
        } as any);

        expect(response).toMatchObject({
            type: "BALANCE",
            payload: {
                settled: 30000,
            },
        });
    });

    // Regression: legacy address buckets can hold rows whose `script`
    // belongs to a different contract. The aggregator must filter each
    // bucket by the owning contract's script before deduping by txid:vout
    // so a wrong-script duplicate cannot win the dedupe over the correct
    // row stored under another bucket.
    it("GET_VTXOS skips wrong-script rows and prefers script-matching ones across legacy duplicates", async () => {
        const contracts = [
            { address: "contract-A-addr", script: "scriptA" },
            { address: "contract-B-addr", script: "scriptB" },
        ];
        setupHandler(contracts);

        // Stale row under contract A's address bucket but actually locked
        // to contract B's script — left behind by a legacy save under the
        // wrong bucket. Must be ignored by the contract-A read.
        const stale = createMockExtendedVtxo({
            txid: "ee".repeat(32),
            vout: 0,
            value: 1000,
            virtualStatus: { state: "settled" },
            isSpent: false,
            script: "scriptB",
        });
        // Correct row under contract B's bucket with the same outpoint and
        // contract B's script. Marked spent — proves the read returns the
        // script-matching row regardless of its lifecycle state, instead of
        // the stale unspent row from the wrong bucket.
        const correct = createMockExtendedVtxo({
            txid: "ee".repeat(32),
            vout: 0,
            value: 1000,
            virtualStatus: { state: "settled" },
            isSpent: true,
            script: "scriptB",
        });
        await walletRepo.saveVtxos("contract-A-addr", [stale]);
        await walletRepo.saveVtxos("contract-B-addr", [correct]);

        const all = await (updater as any).getVtxosFromRepo();
        const matched = all.filter((v: any) => v.txid === "ee".repeat(32) && v.vout === 0);
        expect(matched).toHaveLength(1);
        expect(matched[0].script).toBe("scriptB");
        expect(matched[0].isSpent).toBe(true);
    });

    it("GET_VTXOS fails fast when the wallet's primary address can't be decoded", async () => {
        setupHandler();
        // Override the readonly wallet to return a malformed address that
        // scriptFromArkAddress cannot decode. Before the fix this silently
        // dropped the wallet's primary bucket and zeroed the visible balance.
        (updater as any).readonlyWallet.getAddress = vi
            .fn()
            .mockResolvedValue("not-a-valid-ark-address");

        await expect((updater as any).getVtxosFromRepo()).rejects.toThrow(
            /failed to derive script from wallet address/,
        );
    });
});
