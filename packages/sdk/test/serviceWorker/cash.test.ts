import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Transaction } from "../../src/utils/transaction";
import { ArkadeCash } from "../../src/arkadeCash";
import { Wallet } from "../../src/wallet/wallet";
import { InMemoryContractRepository } from "../../src/repositories/inMemory/contractRepository";
import { InMemoryWalletRepository } from "../../src/repositories/inMemory/walletRepository";
import { SingleKey } from "../../src/identity/singleKey";
import type { VirtualCoin } from "../../src/wallet";
import { WalletMessageHandler } from "../../src/wallet/serviceWorker/wallet-message-handler";

const point = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const info = {
    signerPubkey: point,
    forfeitPubkey: point,
    network: "mutinynet",
    batchExpiry: 144n,
    unilateralExitDelay: 144n,
    boardingExitDelay: 604672n,
    roundInterval: 144n,
    dust: 1000n,
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
    deprecatedSigners: [],
    digest: "d",
    fees: { intentFee: {}, txFeeRate: "0" },
    serviceStatus: {},
    sessionDuration: 3600n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
    version: "1",
};

function chain() {
    return {
        getCoins: vi.fn(async () => []),
        getTransactions: vi.fn(async () => []),
        getTxOutspends: vi.fn(async () => []),
        getTxStatus: vi.fn(async () => ({ confirmed: false })),
        getChainTip: vi.fn(async () => ({ height: 0, hash: "", time: 0 })),
        broadcastTransaction: vi.fn(async () => "txid"),
        watchAddresses: vi.fn(async () => () => {}),
    } as never;
}

async function fakeWallet(cash: ArkadeCash, coins: VirtualCoin[] = []) {
    const script = hex.encode(cash.vtxoScript.pkScript);
    return await Wallet.create({
        identity: SingleKey.fromHex("1".repeat(64)),
        settlementConfig: false,
        arkProvider: {
            getInfo: vi.fn(async () => info),
            getPendingTxs: vi.fn(async () => []),
            submitTx: vi.fn((ark: string, checkpoints: string[]) => ({
                arkTxid: Transaction.fromPSBT(base64.decode(ark)).id,
                finalArkTx: ark,
                signedCheckpointTxs: checkpoints,
            })),
        } as never,
        indexerProvider: {
            getVtxos: vi.fn(async ({ scripts }: { scripts?: string[] } = {}) => ({
                vtxos: scripts?.includes(script) ? coins.slice() : [],
            })),
            subscribeForScripts: vi.fn(async () => "sid"),
            unsubscribeForScripts: vi.fn(async () => {}),
            getSubscription: vi.fn(async function* (_: string, abort: AbortSignal) {
                await new Promise<void>((r) =>
                    abort.addEventListener("abort", () => r(), { once: true }),
                );
            }),
            watchAddresses: vi.fn(async () => () => {}),
        } as never,
        onchainProvider: chain(),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
}

async function message(
    wallet: Awaited<ReturnType<typeof fakeWallet>>,
    action: string,
    token?: string,
    amount?: number,
) {
    const handler = new WalletMessageHandler();
    await handler.start({ arkProvider: wallet.arkProvider, wallet, readonlyWallet: wallet }, {
        walletRepository: wallet.walletRepository,
    } as never);
    return (await handler.handleMessage({
        id: "1",
        tag: handler.messageTag,
        type: "ARKADE_CASH",
        payload: { action, token, amount },
    } as never)) as import("../../src/wallet/serviceWorker/wallet-message-handler").ResponseArkadeCash;
}

const cash = () =>
    ArkadeCash.generate(hex.decode(point).slice(1), { type: "blocks", value: 144n }, "tarkadecash");
const live = (c: ArkadeCash): VirtualCoin => ({
    txid: "a".repeat(64),
    vout: 0,
    value: 5000,
    script: hex.encode(c.vtxoScript.pkScript),
    createdAt: new Date(),
    status: { confirmed: false },
    isUnrolled: false,
});

describe("Worker ArkadeCash", () => {
    it("answers inspection and claim through existing signing wallet", async () => {
        const note = cash();
        const wallet = await fakeWallet(note, [live(note)]);
        const status = await message(wallet, "get", note.toString());
        if (status.payload?.action !== "get") throw new Error("expected cash inspection");
        expect(status.payload.status).toBe("available");
        const claimed = await message(wallet, "claim", note.toString());
        if (claimed.payload?.action !== "claim") throw new Error("expected cash claim");
        expect(claimed.payload.swept).toBe(5000);
        expect(claimed.payload.claimTxIds).toHaveLength(1);
        expect(claimed.payload.claimTxIds?.[0]).not.toBe("a".repeat(64));
    });

    it("rejects an operator mismatch before sweeping", async () => {
        const note = ArkadeCash.generate(
            new Uint8Array(32).fill(2),
            { type: "blocks", value: 144n },
            "tarkadecash",
        );
        const wallet = await fakeWallet(note);
        const err = await message(wallet, "claim", note.toString());
        expect((err as { error?: Error }).error?.message).toContain("another operator");
    });

    it("exposes the created token and preserves its recoverable error", async () => {
        const wallet = await fakeWallet(cash());
        vi.spyOn(wallet, "createCash").mockResolvedValue("tarkadecash1example");
        const created = await message(wallet, "create", undefined, 5000);
        if (created.payload?.action !== "create") throw new Error("expected cash creation");
        expect(created.payload.token).toBe("tarkadecash1example");
        const error = Object.assign(new Error("tentative"), { cash: "recover-me" });
        vi.spyOn(wallet, "createCash").mockRejectedValue(error);
        const failed = await message(wallet, "create", undefined, 5000);
        expect((failed as { error?: unknown }).error).toBe(error);
        expect((failed as { error?: { cash?: string } }).error?.cash).toBe("recover-me");
        expect((failed as { cash?: string }).cash).toBe("recover-me");
    });
});
