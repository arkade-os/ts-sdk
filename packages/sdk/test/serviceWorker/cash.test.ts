import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Transaction } from "../../src/utils/transaction";
import { ArkadeCash } from "../../src/arkadeCash";
import { ArkadeCashCreateError, Wallet } from "../../src/wallet/wallet";
import { InMemoryContractRepository } from "../../src/repositories/inMemory/contractRepository";
import { InMemoryWalletRepository } from "../../src/repositories/inMemory/walletRepository";
import { SingleKey } from "../../src/identity/singleKey";
import type { VirtualCoin } from "../../src/wallet";
import { WalletMessageHandler } from "../../src/wallet/serviceWorker/wallet-message-handler";
import { ServiceWorkerReadonlyWallet } from "../../src/wallet/serviceWorker/wallet";

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
        expect(claimed.payload.claims).toHaveLength(1);
        expect(claimed.payload.claims?.[0].txid).not.toBe("a".repeat(64));
        expect(claimed.payload.claims?.[0].amount).toBe(5000);
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

    it("exposes the created token", async () => {
        const wallet = await fakeWallet(cash());
        vi.spyOn(wallet, "createCash").mockResolvedValue("tarkadecash1example");
        const created = await message(wallet, "create", undefined, 5000);
        if (created.payload?.action !== "create") throw new Error("expected cash creation");
        expect(created.payload.token).toBe("tarkadecash1example");
    });
});

const STUB_KEY = new Uint8Array(32).fill(7);

/**
 * A page-side readonly wallet wired to a fake worker. `respond` answers each
 * request, optionally after a delay; every reply crosses `structuredClone`.
 */
function pageWallet(respond: (message: any) => Promise<unknown>) {
    const listeners = new Set<(event: { data: unknown }) => void>();
    vi.stubGlobal("navigator", {
        serviceWorker: {
            addEventListener: (type: string, handler: never) => {
                if (type === "message") listeners.add(handler);
            },
            removeEventListener: (type: string, handler: never) => {
                if (type === "message") listeners.delete(handler);
            },
        },
    });
    const worker = {
        postMessage: (message: any) => {
            void respond(message).then((response) => {
                const data = structuredClone(response);
                listeners.forEach((handler) => handler({ data }));
            });
        },
    };
    return new (ServiceWorkerReadonlyWallet as any)(
        worker,
        { xOnlyPublicKey: async () => STUB_KEY },
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        "wallet-tag",
    ) as ServiceWorkerReadonlyWallet;
}

describe("Page-side ArkadeCash requests", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("rejects a funded-but-failed create with the recoverable token across the clone", async () => {
        const worker = await fakeWallet(cash());
        vi.spyOn(worker, "createCash").mockRejectedValue(
            new ArkadeCashCreateError("tarkadecash1recover", new Error("send failed")),
        );
        const handler = new WalletMessageHandler();
        await handler.start(
            { arkProvider: worker.arkProvider, wallet: worker, readonlyWallet: worker },
            { walletRepository: worker.walletRepository } as never,
        );
        const page = pageWallet((request) => handler.handleMessage(request));

        const failure = await page.arkadeCash({ action: "create", amount: 5000 }).catch((e) => e);

        expect(failure).toBeInstanceOf(ArkadeCashCreateError);
        expect((failure as ArkadeCashCreateError).cash).toBe("tarkadecash1recover");
        expect(((failure as ArkadeCashCreateError).cause as Error).message).toBe("send failed");
    });

    it("waits for a claim that finishes long after the 50s message deadline", async () => {
        vi.useFakeTimers();
        const wallet = pageWallet(async (message) => {
            await new Promise((resolve) => setTimeout(resolve, 120_000));
            return {
                id: message.id,
                tag: message.tag,
                type: "ARKADE_CASH",
                payload: {
                    action: "claim",
                    swept: 5000,
                    claims: [{ txid: "c".repeat(64), amount: 5000 }],
                    recovering: { amount: 0, vtxos: [] },
                    unclaimed: { amount: 0, vtxos: [] },
                },
            };
        });
        const claim = wallet.arkadeCash({ action: "claim", token: "t" });
        await vi.advanceTimersByTimeAsync(120_000);
        await expect(claim).resolves.toMatchObject({ action: "claim", swept: 5000 });
    });
});
