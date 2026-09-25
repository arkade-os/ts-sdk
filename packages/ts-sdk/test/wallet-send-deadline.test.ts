import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import {
    Wallet,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    type ExtendedVirtualCoin,
} from "../src";
import { jsonResponse } from "./helpers/response";
import { MockEventSource } from "./mocks/eventSource";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const ARK_INFO = {
    signerPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    forfeitPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    batchExpiry: 144n,
    unilateralExitDelay: 144n,
    boardingExitDelay: 144n,
    roundInterval: 144n,
    network: "mutinynet",
    dust: 1000n,
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};

const identity = () =>
    SingleKey.fromHex("ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2");
const serverIdentity = SingleKey.fromHex("00".repeat(31) + "01");

async function makeWallet() {
    const signer = identity();
    const walletRepository = new InMemoryWalletRepository();
    const wallet = await Wallet.create({
        identity: signer,
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository,
            contractRepository: new InMemoryContractRepository(),
        },
    });
    return { wallet, signer, walletRepository };
}

function coin(wallet: Wallet): ExtendedVirtualCoin {
    const tapscript = (wallet as any).offchainTapscript;
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        virtualStatus: { state: "settled" },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        spentBy: "",
        commitmentTxIds: [],
        script: hex.encode(tapscript.pkScript),
        forfeitTapLeafScript: tapscript.forfeit(),
        intentTapLeafScript: tapscript.forfeit(),
        tapTree: tapscript.encode(),
    };
}

function sendParams(wallet: Wallet, validUntil: unknown, selectedVtxos = [{} as never]) {
    return {
        recipients: [{ address: wallet.arkAddress.encode(), amount: 2000 }],
        selectedVtxos,
        validUntil,
    } as never;
}

function mockSubmission(wallet: Wallet, beforeResponse?: () => void) {
    const submit = vi
        .spyOn(wallet.arkProvider, "submitTx")
        .mockImplementation(async (arkTxBase64, checkpointBase64s) => {
            beforeResponse?.();
            const arkTx = Transaction.fromPSBT(base64.decode(arkTxBase64));
            const finalArkTx = await serverIdentity.sign(arkTx);
            const signedCheckpointTxs = await Promise.all(
                checkpointBase64s.map(async (encoded) => {
                    const checkpoint = Transaction.fromPSBT(base64.decode(encoded));
                    return base64.encode((await serverIdentity.sign(checkpoint, [0])).toPSBT());
                }),
            );
            return {
                arkTxid: arkTx.id,
                finalArkTx: base64.encode(finalArkTx.toPSBT()),
                signedCheckpointTxs,
            };
        });
    const finalize = vi.spyOn(wallet.arkProvider, "finalizeTx").mockResolvedValue(undefined);
    return { submit, finalize };
}

describe("Wallet.send validUntil", () => {
    beforeEach(() => {
        vi.stubGlobal("EventSource", MockEventSource);
        mockFetch.mockReset();
        mockFetch.mockImplementation((url: string) => {
            if (url.includes("/info")) return Promise.resolve(jsonResponse(ARK_INFO));
            if (url.includes("subscribe") || url.includes("subscriptions")) {
                return Promise.resolve(jsonResponse({ subscriptionId: "sub-1" }));
            }
            if (url.includes("vtxo") || url.includes("scripts")) {
                return Promise.resolve(jsonResponse({ vtxos: [] }));
            }
            return Promise.resolve(jsonResponse([]));
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "1700000001"])(
        "rejects invalid deadline %s before signing or submitting",
        async (validUntil) => {
            const { wallet, signer } = await makeWallet();
            const sign = vi.spyOn(signer, "sign");
            const submit = vi.spyOn(wallet.arkProvider, "submitTx");

            await expect(wallet.send(sendParams(wallet, validUntil))).rejects.toThrow(
                /validUntil must be a positive safe integer UNIX timestamp in seconds/,
            );
            expect(sign).not.toHaveBeenCalled();
            expect(submit).not.toHaveBeenCalled();
            await wallet.dispose();
        },
    );

    it("treats equality with the deadline as expired before signing or submitting", async () => {
        const { wallet, signer } = await makeWallet();
        const sign = vi.spyOn(signer, "sign");
        const submit = vi.spyOn(wallet.arkProvider, "submitTx");
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_001_000);

        await expect(wallet.send(sendParams(wallet, 1_700_000_001))).rejects.toMatchObject({
            name: "SendDeadlineExceededError",
        });
        expect(sign).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        await wallet.dispose();
    });

    it("refuses after a transaction-lock wait crosses the captured deadline", async () => {
        const { wallet, signer } = await makeWallet();
        const sign = vi.spyOn(signer, "sign");
        const submit = vi.spyOn(wallet.arkProvider, "submitTx");
        let now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        let release!: () => void;
        const blocker = (wallet as any)._withTxLock(
            () => new Promise<void>((resolve) => (release = resolve)),
        );
        await Promise.resolve();

        const pending = wallet.send(sendParams(wallet, 1_700_000_001));
        now = 1_700_000_001_000;
        release();

        await blocker;
        await expect(pending).rejects.toMatchObject({ name: "SendDeadlineExceededError" });
        expect(sign).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        await wallet.dispose();
    });

    it("refuses when asynchronous signing crosses the deadline", async () => {
        const { wallet, signer } = await makeWallet();
        const selected = coin(wallet);
        let now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const originalSign = signer.sign.bind(signer);
        let first = true;
        vi.spyOn(signer, "sign").mockImplementation(async (tx, indexes) => {
            const signed = await originalSign(tx, indexes);
            if (first) {
                first = false;
                now = 1_700_000_001_000;
            }
            return signed;
        });
        const submit = vi.spyOn(wallet.arkProvider, "submitTx");

        await expect(
            wallet.send(sendParams(wallet, 1_700_000_001, [selected])),
        ).rejects.toMatchObject({ name: "SendDeadlineExceededError" });
        expect(submit).not.toHaveBeenCalled();
        expect((wallet as any)._pendingSpendOutpoints).toEqual(new Set());
        await wallet.dispose();
    });

    it("refuses after pending-flag persistence crosses the deadline and releases its holds", async () => {
        const { wallet, walletRepository } = await makeWallet();
        const selected = coin(wallet);
        let now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const saveState = walletRepository.saveWalletState.bind(walletRepository);
        vi.spyOn(walletRepository, "saveWalletState").mockImplementation(async (state) => {
            await saveState(state);
            if (state.settings?.hasPendingTx === true) now = 1_700_000_001_000;
        });
        const submit = vi.spyOn(wallet.arkProvider, "submitTx");

        await expect(
            wallet.send(sendParams(wallet, 1_700_000_001, [selected])),
        ).rejects.toMatchObject({ name: "SendDeadlineExceededError" });
        expect(submit).not.toHaveBeenCalled();
        expect((await walletRepository.getWalletState())?.settings?.hasPendingTx).toBe(false);
        expect((wallet as any)._pendingSpendOutpoints).toEqual(new Set());
        await wallet.dispose();
    });

    it("does not clear a pre-existing pending flag on deadline refusal", async () => {
        const { wallet, walletRepository } = await makeWallet();
        const selected = coin(wallet);
        await walletRepository.saveWalletState({ settings: { hasPendingTx: true } });
        let now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const saveState = walletRepository.saveWalletState.bind(walletRepository);
        vi.spyOn(walletRepository, "saveWalletState").mockImplementation(async (state) => {
            await saveState(state);
            if (state.settings?.hasPendingTx === true) now = 1_700_000_001_000;
        });

        await expect(
            wallet.send(sendParams(wallet, 1_700_000_001, [selected])),
        ).rejects.toMatchObject({ name: "SendDeadlineExceededError" });
        expect((await walletRepository.getWalletState())?.settings?.hasPendingTx).toBe(true);
        await wallet.dispose();
    });

    it("propagates pending-flag callback errors and releases the input hold", async () => {
        const { wallet, walletRepository } = await makeWallet();
        const selected = coin(wallet);
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        const callbackError = new Error("pending write failed");
        const saveState = walletRepository.saveWalletState.bind(walletRepository);
        vi.spyOn(walletRepository, "saveWalletState").mockImplementation((state) =>
            state.settings?.hasPendingTx === true
                ? Promise.reject(callbackError)
                : saveState(state),
        );
        const submit = vi.spyOn(wallet.arkProvider, "submitTx");

        await expect(wallet.send(sendParams(wallet, 1_700_000_001, [selected]))).rejects.toBe(
            callbackError,
        );
        expect(submit).not.toHaveBeenCalled();
        expect((wallet as any)._pendingSpendOutpoints).toEqual(new Set());
        await wallet.dispose();
    });

    it("submits a live deadline exactly once", async () => {
        const { wallet } = await makeWallet();
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        const { submit, finalize } = mockSubmission(wallet);

        await expect(
            wallet.send(sendParams(wallet, 1_700_000_001, [coin(wallet)])),
        ).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(submit).toHaveBeenCalledOnce();
        expect(finalize).toHaveBeenCalledOnce();
        await wallet.dispose();
    });

    it("finishes finalization and records the txid when time passes after submit starts", async () => {
        const { wallet } = await makeWallet();
        let now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const { submit, finalize } = mockSubmission(wallet, () => {
            now = 1_700_000_001_000;
        });

        const txid = await wallet.send(sendParams(wallet, 1_700_000_001, [coin(wallet)]));

        expect(submit).toHaveBeenCalledOnce();
        expect(finalize).toHaveBeenCalledWith(txid, expect.any(Array));
        expect(await wallet.getTransactionHistory()).toContainEqual(
            expect.objectContaining({ key: expect.objectContaining({ arkTxid: txid }) }),
        );
        await wallet.dispose();
    });
});
