import { describe, it, expect, vi, beforeEach } from "vitest";

import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../src/wallet/serviceWorker/wallet-message-handler";
import { InMemoryContractRepository, InMemoryWalletRepository } from "../src";

const baseMessage = (id: string = "1") => ({
    id,
    tag: DEFAULT_MESSAGE_TAG,
});

describe("WalletUpdater handleMessage", () => {
    let updater: WalletMessageHandler;

    beforeEach(() => {
        updater = new WalletMessageHandler(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository()
        );
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
        (updater as any).wallet = {
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
        (updater as any).wallet = {
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
        (updater as any).wallet = {};
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
        (updater as any).wallet = {};
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
        (updater as any).wallet = {};
        const utxos = [
            { txid: "tx", vout: 0, value: 1, status: { confirmed: true } },
        ];
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
        (updater as any).wallet = {
            getTransactionHistory: vi.fn().mockResolvedValue(transactions),
        };

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
        (updater as any).wallet = {
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
        (updater as any).wallet = {};
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
        (updater as any).wallet = {};
        const reloadSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).onWalletInitialized = reloadSpy;

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
            getContractsWithVtxos: vi
                .fn()
                .mockResolvedValue(contractsWithVtxos),
            updateContract: vi.fn().mockResolvedValue(contract),
            deleteContract: vi.fn().mockResolvedValue(undefined),
            getSpendablePaths: vi.fn().mockResolvedValue(paths),
            isWatching: vi.fn().mockResolvedValue(true),
        };
        (updater as any).wallet = {
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
        (updater as any).wallet = {
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
        (updater as any).wallet = {};

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "UNKNOWN",
        } as any);

        expect(response.tag).toBe(updater.messageTag);
        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Unknown message");
    });
});
