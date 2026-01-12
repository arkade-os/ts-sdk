import { describe, it, expect, vi } from "vitest";
import { WalletUpdater } from "../src/wallet/serviceWorker/wallet";

const baseMessage = (id: string = "1") => ({
    id,
    tag: WalletUpdater.messageTag,
});

describe("WalletUpdater handleMessage", () => {
    it("initializes the wallet on INIT_WALLET", async () => {
        const updater = new WalletUpdater();
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
            tag: WalletUpdater.messageTag,
            id: "1",
            type: "WALLET_INITIALIZED",
        });
    });

    it("returns a tagged error when the handler is missing", async () => {
        const updater = new WalletUpdater();
        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_ADDRESS",
        } as any);

        expect(response.tag).toBe(WalletUpdater.messageTag);
        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Wallet handler not initialized");
    });

    it("handles SETTLE messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
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
            tag: WalletUpdater.messageTag,
            type: "SETTLE_SUCCESS",
            payload: { txid: "tx" },
        });
    });

    it("handles SEND_BITCOIN messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
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
            tag: WalletUpdater.messageTag,
            type: "SEND_BITCOIN_SUCCESS",
            payload: { txid: "tx" },
        });
    });

    it("handles SIGN_TRANSACTION messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
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
            tag: WalletUpdater.messageTag,
            type: "SIGN_TRANSACTION",
            payload: { tx: signedTx },
        });
    });

    it("handles GET_ADDRESS messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {
            getAddress: vi.fn().mockResolvedValue("bc1-test"),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_ADDRESS",
        } as any);

        expect(response).toEqual({
            tag: WalletUpdater.messageTag,
            id: "1",
            type: "ADDRESS",
            payload: { address: "bc1-test" },
        });
    });

    it("handles GET_BOARDING_ADDRESS messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {
            getBoardingAddress: vi.fn().mockResolvedValue("bc1-boarding"),
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BOARDING_ADDRESS",
        } as any);

        expect(response).toEqual({
            tag: WalletUpdater.messageTag,
            id: "1",
            type: "BOARDING_ADDRESS",
            payload: { address: "bc1-boarding" },
        });
    });

    it("handles GET_BALANCE messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
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
            tag: WalletUpdater.messageTag,
            type: "BALANCE",
            payload: balance,
        });
    });

    it("handles GET_VTXOS messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
        const vtxos = [{ id: "v1" }];
        (updater as any).handleGetVtxos = vi.fn().mockResolvedValue(vtxos);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_VTXOS",
            payload: {},
        } as any);

        expect(response).toEqual({
            tag: WalletUpdater.messageTag,
            id: "1",
            type: "VTXOS",
            payload: { vtxos },
        });
    });

    it("handles GET_BOARDING_UTXOS messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
        const utxos = [
            { txid: "tx", vout: 0, value: 1, status: { confirmed: true } },
        ];
        (updater as any).getAllBoardingUtxos = vi.fn().mockResolvedValue(utxos);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_BOARDING_UTXOS",
        } as any);

        expect(response).toMatchObject({
            tag: WalletUpdater.messageTag,
            type: "BOARDING_UTXOS",
            payload: { utxos },
        });
    });

    it("handles GET_TRANSACTION_HISTORY messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
        const transactions = [{ txid: "tx" }];
        (updater as any).getTransactionHistory = vi
            .fn()
            .mockResolvedValue(transactions);

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_TRANSACTION_HISTORY",
        } as any);

        expect(response).toMatchObject({
            tag: WalletUpdater.messageTag,
            type: "TRANSACTION_HISTORY",
            payload: { transactions },
        });
    });

    it("handles GET_STATUS messages", async () => {
        const updater = new WalletUpdater();
        const pubkey = new Uint8Array([1, 2, 3]);
        (updater as any).handler = {
            identity: {
                xOnlyPublicKey: vi.fn().mockResolvedValue(pubkey),
            },
        };

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "GET_STATUS",
        } as any);

        expect(response).toMatchObject({
            tag: WalletUpdater.messageTag,
            type: "WALLET_STATUS",
            payload: {
                walletInitialized: true,
                xOnlyPublicKey: pubkey,
            },
        });
    });

    it("handles CLEAR messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
        const clearSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).clear = clearSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "CLEAR",
        } as any);

        expect(clearSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: WalletUpdater.messageTag,
            type: "CLEAR_SUCCESS",
            payload: { cleared: true },
        });
    });

    it("handles RELOAD_WALLET messages", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};
        const reloadSpy = vi.fn().mockResolvedValue(undefined);
        (updater as any).onWalletInitialized = reloadSpy;

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "RELOAD_WALLET",
        } as any);

        expect(reloadSpy).toHaveBeenCalled();
        expect(response).toMatchObject({
            tag: WalletUpdater.messageTag,
            type: "RELOAD_SUCCESS",
            payload: { reloaded: true },
        });
    });

    it("returns a tagged error for unknown message types", async () => {
        const updater = new WalletUpdater();
        (updater as any).handler = {};

        const response = await updater.handleMessage({
            ...baseMessage(),
            type: "UNKNOWN",
        } as any);

        expect(response.tag).toBe(WalletUpdater.messageTag);
        expect(response.error).toBeInstanceOf(Error);
        expect(response.error?.message).toBe("Unknown message");
    });
});
