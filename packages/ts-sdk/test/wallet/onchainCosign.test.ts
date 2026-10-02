import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Address, OutScript } from "@scure/btc-signer";
import { Wallet } from "../../src/wallet/wallet";
import { InMemoryWalletRepository } from "../../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../../src/repositories/inMemory/contractRepository";
import { SingleKey } from "../../src/identity/singleKey";
import { Transaction } from "../../src/utils/transaction";
import {
    OnchainCosignPreflightError,
    estimateOnchainCosignFee,
} from "../../src/contracts/onchainSpend";

const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CHECKPOINT_TAPSCRIPT =
    "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac";
const COSIGNED = "ff".repeat(32);
const externalAddress = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

async function makeWallet(coinOverrides: Record<string, unknown> = {}) {
    const info = {
        signerPubkey: SERVER_PUBKEY_HEX,
        forfeitPubkey: SERVER_PUBKEY_HEX,
        network: "mutinynet",
        batchExpiry: 144n,
        unilateralExitDelay: 144n,
        // seconds timelock: ceil(604672 / 600) = 1008 blocks
        boardingExitDelay: 604672n,
        roundInterval: 144n,
        dust: 1000n,
        forfeitAddress: externalAddress,
        checkpointTapscript: CHECKPOINT_TAPSCRIPT,
    };
    const boardingCoin = {
        txid: "ab".repeat(32),
        vout: 1,
        value: 50_000,
        status: { confirmed: true, block_height: 100, block_time: 1700000000 },
        ...coinOverrides,
    };
    const arkProvider = {
        getInfo: vi.fn(async () => info),
        cosignOnchainTx: vi.fn(async (_psbt: string) => COSIGNED),
    } as any;
    const indexerProvider = {
        getVtxos: vi.fn(async () => ({ vtxos: [] })),
        subscribeForScripts: vi.fn(async () => "sub-id"),
        unsubscribeForScripts: vi.fn(async () => {}),
        getSubscription: vi.fn(async function* (_id: string, signal: AbortSignal) {
            await new Promise<void>((resolve) => {
                if (signal?.aborted) return resolve();
                signal?.addEventListener("abort", () => resolve(), { once: true });
            });
        }),
    } as any;
    const onchainProvider = {
        getCoins: vi.fn(async () => [] as any[]),
        getTransactions: vi.fn(async () => []),
        getTxOutspends: vi.fn(async () => [{ spent: false, txid: "" }]),
        getTxStatus: vi.fn(async () => ({ confirmed: false })),
        getChainTip: vi.fn(async () => ({ height: 110, time: 0, hash: "" })),
        getFeeRate: vi.fn(async () => 2),
        broadcastTransaction: vi.fn(async () => "broadcast"),
        getRawTransaction: vi.fn(),
        watchAddresses: vi.fn(async () => () => {}),
    } as any;
    const walletRepository = new InMemoryWalletRepository();
    const wallet = await Wallet.create({
        identity: SingleKey.fromHex("1".repeat(64)),
        settlementConfig: false,
        arkProvider,
        indexerProvider,
        onchainProvider,
        storage: { walletRepository, contractRepository: new InMemoryContractRepository() },
    });
    const boardingAddress = wallet.boardingTapscript.onchainAddress(wallet.network);
    onchainProvider.getCoins.mockImplementation(async (a: string) =>
        a === boardingAddress ? [boardingCoin] : [],
    );
    const boardingScriptHex = hex.encode(wallet.boardingTapscript.pkScript);
    const externalScript = OutScript.encode(Address(wallet.network).decode(externalAddress));
    return {
        wallet,
        arkProvider,
        onchainProvider,
        walletRepository,
        boardingCoin,
        boardingScriptHex,
        externalScript,
    };
}

const sentPsbt = (arkProvider: any) =>
    Transaction.fromPSBT(base64.decode(arkProvider.cosignOnchainTx.mock.calls[0][0]));

describe("wallet.sendOnchain", () => {
    it("spends the boarding coin via arkd and marks it pending", async () => {
        const { wallet, arkProvider, walletRepository, boardingScriptHex } = await makeWallet();
        const txid = await wallet.sendOnchain({
            outputs: [{ address: externalAddress, amount: 20_000 }],
        });
        expect(txid).toBe(COSIGNED);
        const psbt = sentPsbt(arkProvider);
        expect(psbt.inputsLength).toBe(1);
        expect(psbt.getInput(0).tapScriptSig?.length).toBe(1);
        expect(psbt.outputsLength).toBe(2);
        const [row] = await walletRepository.getVtxosForScript!(boardingScriptHex);
        expect(row.spentBy).toBe(COSIGNED);
    });

    it("skips unconfirmed coins and fails when nothing is left", async () => {
        const { wallet } = await makeWallet({ status: { confirmed: false } });
        const send = wallet.sendOnchain({ outputs: [{ address: externalAddress, amount: 1_000 }] });
        await expect(send).rejects.toThrow(/insufficient/i);
        await expect(send).rejects.toBeInstanceOf(OnchainCosignPreflightError);
    });

    it("sweeps every cosignable coin to one output carrying Σin − fee", async () => {
        const { wallet, arkProvider, externalScript } = await makeWallet();
        await wallet.sendOnchain({ outputs: [], sweepTo: externalAddress });
        const psbt = sentPsbt(arkProvider);
        expect(psbt.inputsLength).toBe(1);
        expect(psbt.outputsLength).toBe(1);
        expect(psbt.getOutput(0).script).toEqual(externalScript);
        expect(psbt.getOutput(0).amount).toBe(BigInt(50_000 - estimateOnchainCosignFee(1, 1, 2)));
    });

    it("refuses a sweep with no candidates or a sub-dust remainder", async () => {
        const none = await makeWallet({ status: { confirmed: false } });
        await expect(
            none.wallet.sendOnchain({ outputs: [], sweepTo: externalAddress }),
        ).rejects.toThrow(/nothing to sweep/);
        const dust = await makeWallet({ value: 1_100 });
        await expect(
            dust.wallet.sendOnchain({ outputs: [], sweepTo: externalAddress }),
        ).rejects.toThrow(/nothing to sweep/);
    });

    it("refuses sweepTo combined with outputs", async () => {
        const { wallet } = await makeWallet();
        await expect(
            wallet.sendOnchain({
                outputs: [{ address: externalAddress, amount: 1_000 }],
                sweepTo: externalAddress,
            }),
        ).rejects.toThrow(/sweepTo/);
    });
});

describe("wallet.cosignOnchainTx", () => {
    it("fills owned inputs of an external PSBT and leaves foreign inputs alone", async () => {
        const { wallet, arkProvider, boardingCoin, externalScript } = await makeWallet();
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(boardingCoin.txid), index: boardingCoin.vout });
        tx.addInput({
            txid: hex.decode("bb".repeat(32)),
            index: 0,
            witnessUtxo: { script: externalScript, amount: 1_000n },
        });
        tx.addOutput({ script: externalScript, amount: 40_000n });
        tx.updateInput(1, { finalScriptWitness: [new Uint8Array([1])] });
        await wallet.cosignOnchainTx(base64.encode(tx.toPSBT()));
        const sent = sentPsbt(arkProvider);
        expect(sent.getInput(0).tapLeafScript).toHaveLength(1);
        expect(sent.getInput(1).finalScriptWitness).toEqual([new Uint8Array([1])]);
    });

    it("rejects outputs exceeding inputs", async () => {
        const { wallet, boardingCoin, externalScript } = await makeWallet();
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(boardingCoin.txid), index: boardingCoin.vout });
        tx.addOutput({ script: externalScript, amount: 60_000n });
        await expect(wallet.cosignOnchainTx(tx)).rejects.toThrow(/exceed/);
    });

    it("returns the txid when marking the spend pending fails after submit", async () => {
        const { wallet, boardingCoin, externalScript } = await makeWallet();
        const manager = await wallet.getContractManager();
        vi.spyOn(manager, "markOnchainSpendPending").mockRejectedValue(new Error("db down"));
        vi.spyOn(console, "error").mockImplementation(() => {});
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(boardingCoin.txid), index: boardingCoin.vout });
        tx.addOutput({ script: externalScript, amount: 40_000n });
        await expect(wallet.cosignOnchainTx(tx)).resolves.toBe(COSIGNED);
    });

    it("syncs first so an owned coin not yet stored is signed", async () => {
        const { wallet, arkProvider, walletRepository, boardingCoin, boardingScriptHex } =
            await makeWallet();
        expect(await walletRepository.getVtxosForScript!(boardingScriptHex)).toEqual([]);
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(boardingCoin.txid), index: boardingCoin.vout });
        tx.addOutput({ script: hex.decode(boardingScriptHex), amount: 40_000n });
        await wallet.cosignOnchainTx(tx);
        expect(sentPsbt(arkProvider).getInput(0).tapScriptSig).toHaveLength(1);
    });
});
