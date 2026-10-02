import { afterEach, describe, it, expect, vi } from "vitest";
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
    needsOnchainSweep,
} from "../../src/contracts/onchainSpend";
import { OnchainCosignAmbiguousError, RestArkProvider } from "../../src/providers/ark";
import { Ramps } from "../../src/wallet/ramps";
import { convertVtxo } from "../../src/wallet/vtxo";
import { timelockToSequence } from "../../src/utils/timelock";
import { saveVtxosForContract } from "../../src/contracts/vtxoOwnership";

const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CHECKPOINT_TAPSCRIPT =
    "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac";
const COSIGNED = "ff".repeat(32);
const externalAddress = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
// The boarding coin confirms at height 100 / time 1700000000; the tip's MTP advances 600s per block.
const tipAt = (height: number) => ({
    height,
    time: 1_700_000_000 + (height - 100) * 600,
    hash: "",
});

async function makeWallet(
    coinOverrides: Record<string, unknown> = {},
    walletConfig: Record<string, unknown> = {},
    boardingExitDelay = 604672n,
) {
    const info = {
        signerPubkey: SERVER_PUBKEY_HEX,
        forfeitPubkey: SERVER_PUBKEY_HEX,
        network: "mutinynet",
        batchExpiry: 144n,
        unilateralExitDelay: 144n,
        // seconds timelock: ceil(604672 / 600) = 1008 blocks
        boardingExitDelay,
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
        getChainTip: vi.fn(async () => tipAt(110)),
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
        ...walletConfig,
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

    it("refuses no outputs without sweepTo instead of self-sending", async () => {
        const { wallet, arkProvider } = await makeWallet();
        const err = await wallet.sendOnchain({ outputs: [] }).catch((e) => e);
        expect(err).toBeInstanceOf(OnchainCosignPreflightError);
        expect(err.message).toContain("no outputs and no sweepTo");
        expect(arkProvider.cosignOnchainTx).not.toHaveBeenCalled();
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

describe("cosign outcomes through Ramps.offboardExact", () => {
    afterEach(() => vi.unstubAllGlobals());

    const arkdReplies = (arkProvider: any, status: number, name: string) => {
        const details = [
            { "@type": "type.googleapis.com/ark.v1.ErrorDetails", code: 0, name, message: "m" },
        ];
        const body = JSON.stringify({ code: 13, message: "m", details });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status })),
        );
        const rest = new RestArkProvider("http://ark");
        arkProvider.cosignOnchainTx.mockImplementation((psbt: string) =>
            rest.cosignOnchainTx(psbt),
        );
    };

    const offboard = (wallet: Wallet) => {
        const vtxo = { txid: "11".repeat(32), vout: 0, value: 50_000, createdAt: new Date() };
        vi.spyOn(wallet, "getSpendableVtxos").mockResolvedValue([vtxo] as any);
        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("txSETTLE");
        const result = new Ramps(wallet)
            .offboardExact({
                destinationAddress: externalAddress,
                feeInfo: { intentFee: {}, txFeeRate: "1" } as any,
                amount: 5_000n,
            })
            .catch((e) => e);
        return { settle, result };
    };

    it("an arkd INTERNAL_ERROR rethrows, skips settle and leaves the coins pending", async () => {
        const { wallet, arkProvider, walletRepository, boardingScriptHex } = await makeWallet();
        arkdReplies(arkProvider, 500, "INTERNAL_ERROR");
        const { settle, result } = offboard(wallet);
        expect(await result).toBeInstanceOf(OnchainCosignAmbiguousError);
        expect(settle).not.toHaveBeenCalled();
        const [row] = await walletRepository.getVtxosForScript!(boardingScriptHex);
        expect(row.spentBy).toBe(sentPsbt(arkProvider).id);
    });

    it("an arkd INVALID_ARK_PSBT falls back to settle", async () => {
        const { wallet, arkProvider, walletRepository, boardingScriptHex } = await makeWallet();
        arkdReplies(arkProvider, 400, "INVALID_ARK_PSBT");
        const { settle, result } = offboard(wallet);
        expect(await result).toBe("txSETTLE");
        expect(settle).toHaveBeenCalledTimes(1);
        const [row] = await walletRepository.getVtxosForScript!(boardingScriptHex);
        expect(row.spentBy).toBeFalsy();
    });

    it("a fee-rate failure before submission falls back to settle", async () => {
        const { wallet, arkProvider, onchainProvider } = await makeWallet();
        const down = new Error("esplora down");
        onchainProvider.getFeeRate.mockRejectedValue(down);
        const direct = await wallet
            .sendOnchain({ outputs: [{ address: externalAddress, amount: 5_000 }] })
            .catch((e) => e);
        expect(direct).toBeInstanceOf(OnchainCosignPreflightError);
        expect(direct.cause).toBe(down);
        expect(direct.message).toContain("esplora down");
        const { result } = offboard(wallet);
        expect(await result).toBe("txSETTLE");
        expect(arkProvider.cosignOnchainTx).not.toHaveBeenCalled();
    });
});

describe("sendOnchain with explicit inputs", () => {
    it("syncs only the contracts owning the named inputs", async () => {
        const { wallet, boardingCoin, boardingScriptHex } = await makeWallet();
        const manager = await wallet.getContractManager();
        await manager.syncOnchain();
        const sync = vi.spyOn(manager, "syncOnchain");
        const txid = await wallet.sendOnchain({
            outputs: [],
            inputs: [{ txid: boardingCoin.txid, vout: boardingCoin.vout }],
            sweepTo: externalAddress,
        });
        expect(txid).toBe(COSIGNED);
        expect(sync.mock.calls).toEqual([[[boardingScriptHex]]]);
    });

    it("sweeps an unrolled VTXO stored by the indexer without a confirmation height", async () => {
        const { wallet, arkProvider, onchainProvider, walletRepository } = await makeWallet();
        const manager = await wallet.getContractManager();
        const script = hex.encode(wallet.offchainTapscript.pkScript);
        const [contract] = await manager.getContracts({ script });
        const outpoint = { txid: "cd".repeat(32), vout: 0 };
        const indexed = convertVtxo({
            outpoint,
            createdAt: "1700000000",
            expiresAt: null,
            amount: "50000",
            script,
            isPreconfirmed: false,
            isSwept: false,
            isUnrolled: true,
            isSpent: false,
            spentBy: null,
            commitmentTxids: ["ee".repeat(32)],
        });
        expect(indexed.status.block_height).toBeUndefined();
        await saveVtxosForContract(walletRepository, contract, [indexed]);
        const unrolledAddress = wallet.offchainTapscript.onchainAddress(wallet.network);
        const boardingGetCoins = onchainProvider.getCoins.getMockImplementation();
        onchainProvider.getCoins.mockImplementation(async (a: string) =>
            a === unrolledAddress
                ? [{ ...outpoint, value: 50_000, status: { confirmed: true, block_height: 105 } }]
                : boardingGetCoins(a),
        );

        await expect(
            wallet.sendOnchain({ outputs: [], inputs: [outpoint], sweepTo: externalAddress }),
        ).resolves.toBe(COSIGNED);
        const psbt = sentPsbt(arkProvider);
        expect(psbt.inputsLength).toBe(1);
        expect(hex.encode(psbt.getInput(0).txid!)).toBe(outpoint.txid);
    });

    it("names each dropped input and why", async () => {
        const { wallet, onchainProvider, boardingCoin } = await makeWallet();
        onchainProvider.getChainTip.mockResolvedValue(tipAt(1103));
        const unknown = { txid: "99".repeat(32), vout: 3 };
        const send = wallet.sendOnchain({
            outputs: [],
            inputs: [{ txid: boardingCoin.txid, vout: boardingCoin.vout }, unknown],
            sweepTo: externalAddress,
        });
        await expect(send).rejects.toBeInstanceOf(OnchainCosignPreflightError);
        await expect(send).rejects.toThrow(
            `${boardingCoin.txid}:1 is within 6 blocks of exit maturity; ${unknown.txid}:3 is not a known unspent onchain coin`,
        );
    });

    it("names a dropped input that has no CSV exit path", async () => {
        const { wallet, boardingCoin } = await makeWallet();
        const [boarding] = await (wallet as any).onchainCoins(await wallet.getContractManager());
        const { csvTimelock: _, ...params } = boarding.contract.params;
        const noCsv = { ...boarding, contract: { ...boarding.contract, params } };
        vi.spyOn(wallet as any, "onchainCoins").mockResolvedValue([noCsv]);
        await expect(
            wallet.sendOnchain({
                outputs: [],
                inputs: [{ txid: boardingCoin.txid, vout: boardingCoin.vout }],
                sweepTo: externalAddress,
            }),
        ).rejects.toThrow(`${boardingCoin.txid}:1 has no CSV exit path`);
    });
});

describe("onchainCosignMarginBlocks", () => {
    it("is respected by the sendOnchain preflight", async () => {
        const { wallet, arkProvider } = await makeWallet({}, { onchainCosignMarginBlocks: 1000 });
        await expect(
            wallet.sendOnchain({ outputs: [{ address: externalAddress, amount: 20_000 }] }),
        ).rejects.toThrow(/Onchain cosign preflight failed/);
        expect(arkProvider.cosignOnchainTx).not.toHaveBeenCalled();
    });

    it.each([-1, 1.5, Number.NaN])("rejects invalid value %s at creation", async (value) => {
        await expect(makeWallet({}, { onchainCosignMarginBlocks: value })).rejects.toThrow(
            /onchainCosignMarginBlocks/,
        );
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

    it("rejects a foreign input without a witnessUtxo instead of counting it as 0", async () => {
        const { wallet, arkProvider, boardingCoin, externalScript } = await makeWallet();
        const foreign = "bb".repeat(32);
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(boardingCoin.txid), index: boardingCoin.vout });
        tx.addInput({ txid: hex.decode(foreign), index: 2 });
        tx.addOutput({ script: externalScript, amount: 40_000n });
        const err = await wallet.cosignOnchainTx(tx).catch((e) => e);
        expect(err).toBeInstanceOf(OnchainCosignPreflightError);
        expect(err.message).toContain(`input 1 (${foreign}:2) has no witnessUtxo`);
        expect(arkProvider.cosignOnchainTx).not.toHaveBeenCalled();
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

describe("wallet.getOnchainSweepInputs", () => {
    const outpoint = { txid: "ab".repeat(32), vout: 1 };
    const atTip = (onchainProvider: any, height: number) =>
        onchainProvider.getChainTip.mockResolvedValue(tipAt(height));

    it("leaves a fresh boarding coin far from maturity alone", async () => {
        const { wallet } = await makeWallet();
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([]);
    });

    it("selects a boarding coin inside the renew window, and not one inside the cosign margin", async () => {
        const { wallet, onchainProvider } = await makeWallet();
        atTip(onchainProvider, 900);
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([]);
        atTip(onchainProvider, 1000);
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([outpoint]);
        atTip(onchainProvider, 1103);
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([]);
    });

    it("uses a 10-block renew window on a 40-block CSV", async () => {
        const { wallet, onchainProvider } = await makeWallet({}, {}, 40n);
        for (const [tip, selected] of [
            [123, false],
            [124, true],
            [133, true],
            [134, false],
        ] as const) {
            atTip(onchainProvider, tip);
            await expect(wallet.getOnchainSweepInputs()).resolves.toEqual(
                selected ? [outpoint] : [],
            );
        }
    });

    it("honours onchainCosignMarginBlocks in the selection", async () => {
        const { wallet, onchainProvider } = await makeWallet({}, { onchainCosignMarginBlocks: 20 });
        atTip(onchainProvider, 1103);
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([]);
        atTip(onchainProvider, 1000);
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([outpoint]);
    });

    it("never auto-selects an unrolled output, only a boarding coin in the window", async () => {
        const { wallet, onchainProvider } = await makeWallet();
        atTip(onchainProvider, 1000);
        const [boarding] = await (wallet as any).onchainCoins(await wallet.getContractManager());
        const unrolled = {
            ...boarding,
            coin: { ...boarding.coin, txid: "cd".repeat(32) },
            contract: { ...boarding.contract, scope: "offchain" },
        };
        vi.spyOn(wallet as any, "onchainCoins").mockResolvedValue([unrolled, boarding]);
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([outpoint]);
    });

    it("excludes a coin locked by an intent", async () => {
        const { wallet, onchainProvider } = await makeWallet();
        atTip(onchainProvider, 900);
        (wallet as any).intentRepository = { getLockedVtxoOutpoints: async () => [outpoint] };
        await expect(wallet.getOnchainSweepInputs()).resolves.toEqual([]);
    });
});

describe("needsOnchainSweep", () => {
    const coin = { status: { confirmed: true, block_height: 100 } } as any;

    it("never takes an unrolled coin of an offchain-scoped contract", () => {
        const contract = { type: "default", scope: "offchain" } as any;
        expect(needsOnchainSweep(coin, contract, { height: 100, time: 0 })).toBe(false);
    });

    it("caps the renew window at 144 blocks on a 1008-block CSV", () => {
        const contract = {
            type: "default",
            scope: "onchain",
            params: { csvTimelock: "1008" },
        } as any;
        const at = (tip: number) => needsOnchainSweep(coin, contract, { height: tip, time: 0 });
        expect(at(1108 - 151)).toBe(false);
        expect(at(1108 - 150)).toBe(true);
        expect(at(1108 - 7)).toBe(true);
        expect(at(1108 - 6)).toBe(false);
    });

    it("measures a seconds CSV's renew window and margin in seconds", () => {
        const T = 1_700_000_000;
        const timed = { status: { confirmed: true, block_height: 100, block_time: T } } as any;
        const sequence = timelockToSequence({ type: "seconds", value: 604_672n });
        const contract = {
            type: "default",
            scope: "onchain",
            params: { csvTimelock: String(sequence) },
        } as any;
        const maturity = T + 604_672;
        const at = (time: number) => needsOnchainSweep(timed, contract, { height: 100, time });
        expect(at(maturity - 3_600 - 86_400 - 1)).toBe(false);
        expect(at(maturity - 3_600 - 86_400)).toBe(true);
        expect(at(maturity - 3_601)).toBe(true);
        expect(at(maturity - 3_600)).toBe(false);
    });
});
