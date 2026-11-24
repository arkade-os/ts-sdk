import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    Script,
    SigHash,
    TaprootControlBlock,
    Transaction as BtcSignerTransaction,
} from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { DefaultVtxo, EmulatorPacket, Transaction } from "../../src";
import { attachExtension } from "../../src/arkade/contract";
import {
    OnchainCosignPreflightError,
    assertCosignable,
    emulatorInputIndexes,
    estimateOnchainCosignFee,
    isCosignFallback,
    prepareOwnedInput,
    rehydrateCosignError,
    submitOnchainSpend,
} from "../../src/contracts/onchainSpend";
import { TxWeightEstimator } from "../../src/utils/txSizeEstimator";
import {
    OnchainCosignAmbiguousError,
    OnchainCosignRejectedError,
    OnchainCosignUnsupportedError,
} from "../../src/providers/ark";
import { ConditionMultisigTapscript } from "../../src/script/tapscript";
import { VtxoScript, scriptFromTapLeafScript } from "../../src/script/base";
import { ConditionWitness, VtxoTaprootTree, getArkPsbtFields } from "../../src/utils/unknownFields";

const script = new DefaultVtxo.Script({
    pubKey: schnorr.getPublicKey(new Uint8Array(32).fill(1)),
    serverPubKey: schnorr.getPublicKey(new Uint8Array(32).fill(2)),
    csvTimelock: { type: "blocks", value: 144n },
});
const coin = {
    txid: "aa".repeat(32),
    vout: 0,
    value: 10_000,
    status: { confirmed: true, block_height: 100 },
    isUnrolled: true,
    script: hex.encode(script.pkScript),
} as any;

function txWithInput() {
    const tx = new Transaction({ version: 2 });
    tx.addInput({ txid: hex.decode(coin.txid), index: 0 });
    tx.addOutput({ script: script.pkScript, amount: 9_000n });
    return tx;
}

describe("prepareOwnedInput", () => {
    it("fills witnessUtxo, leaf, taptree and sighash", () => {
        const tx = txWithInput();
        prepareOwnedInput(tx, {
            index: 0,
            coin,
            path: { leaf: script.forfeit() },
            tapTree: script.encode(),
        });
        const input = tx.getInput(0);
        expect(input.witnessUtxo?.amount).toBe(10_000n);
        expect(input.tapLeafScript).toHaveLength(1);
        expect(input.sighashType).toBe(SigHash.DEFAULT);
        expect(getArkPsbtFields(tx, 0, VtxoTaprootTree)).toHaveLength(1);
        expect(getArkPsbtFields(tx, 0, ConditionWitness)).toHaveLength(0);
    });

    it("adds ConditionWitness when the path has extraWitness", () => {
        const tx = txWithInput();
        const preimage = new Uint8Array(32).fill(7);
        prepareOwnedInput(tx, {
            index: 0,
            coin,
            path: { leaf: script.forfeit(), extraWitness: [preimage] },
            tapTree: script.encode(),
        });
        expect(getArkPsbtFields(tx, 0, ConditionWitness)[0]).toEqual([preimage]);
    });

    it("replaces leaves and signatures already listed on the input", () => {
        const tx = txWithInput();
        const stale = new Uint8Array(64).fill(5);
        const pubKey = schnorr.getPublicKey(new Uint8Array(32).fill(1));
        tx.updateInput(0, {
            tapLeafScript: [script.forfeit(), script.exit()],
            tapScriptSig: [[{ pubKey, leafHash: new Uint8Array(32) }, stale]],
        });
        prepareOwnedInput(tx, {
            index: 0,
            coin,
            path: { leaf: script.forfeit() },
            tapTree: script.encode(),
        });
        expect(tx.getInput(0).tapLeafScript).toEqual([script.forfeit()]);
        expect(tx.getInput(0).tapScriptSig).toBeUndefined();
    });

    it("replaces taptree and condition witness fields instead of duplicating them", () => {
        const tx = txWithInput();
        const foreignField: [{ type: number; key: Uint8Array }, Uint8Array] = [
            { type: 0x99, key: new Uint8Array([9]) },
            new Uint8Array([1]),
        ];
        tx.updateInput(0, { unknown: [foreignField] });
        prepareOwnedInput(tx, {
            index: 0,
            coin,
            path: { leaf: script.forfeit(), extraWitness: [new Uint8Array(32).fill(7)] },
            tapTree: script.encode(),
        });
        const retried = Transaction.fromPSBT(tx.toPSBT());
        prepareOwnedInput(retried, {
            index: 0,
            coin,
            path: { leaf: script.forfeit(), extraWitness: [new Uint8Array(32).fill(8)] },
            tapTree: script.encode(),
        });
        expect(getArkPsbtFields(retried, 0, VtxoTaprootTree)).toHaveLength(1);
        expect(getArkPsbtFields(retried, 0, ConditionWitness)).toEqual([
            [new Uint8Array(32).fill(8)],
        ]);
        expect(retried.getInput(0).unknown).toContainEqual(foreignField);
    });
});

describe("assertCosignable", () => {
    const blocks = (value: number) => ({ type: "blocks" as const, value: BigInt(value) });
    const seconds = (value: number) => ({ type: "seconds" as const, value: BigInt(value) });
    const tip = (height: number, time = 0) => ({ height, time });

    it("accepts unconfirmed, as arkd does", () => {
        expect(() =>
            assertCosignable({ ...coin, status: { confirmed: false } }, blocks(144), tip(120)),
        ).not.toThrow();
    });
    it("rejects a confirmed coin without its confirmation height", () => {
        expect(() =>
            assertCosignable({ ...coin, status: { confirmed: true } }, blocks(144), tip(120)),
        ).toThrow(`${coin.txid}:${coin.vout} has no confirmation height`);
    });
    it("rejects within the margin of CSV maturity", () => {
        expect(() => assertCosignable(coin, blocks(144), tip(238))).toThrow(/maturity/);
    });
    it("accepts one block beyond the margin", () => {
        expect(() => assertCosignable(coin, blocks(144), tip(237))).not.toThrow();
    });
    it("takes the margin as a parameter", () => {
        expect(() => assertCosignable(coin, blocks(144), tip(101), 143)).toThrow(/maturity/);
    });
    it("accepts when far from maturity", () => {
        expect(() => assertCosignable(coin, blocks(1008), tip(101))).not.toThrow();
    });
    it("rejects a coin with no CSV exit path under its own reason", () => {
        expect(() => assertCosignable(coin, undefined, tip(101))).toThrow(
            `${coin.txid}:${coin.vout} has no CSV exit path; cosign margin cannot be evaluated`,
        );
    });

    describe("seconds CSV, judged against the tip's median time", () => {
        const T = 1_700_000_000;
        const timed = { ...coin, status: { ...coin.status, block_time: T } };
        const csv = seconds(604_672);

        it("accepts far from maturity whatever the height says", () => {
            expect(() => assertCosignable(timed, csv, tip(100 + 1008, T + 1_000))).not.toThrow();
        });
        it("rejects within marginBlocks × 600 seconds of maturity", () => {
            expect(() => assertCosignable(timed, csv, tip(101, T + 604_672 - 3_600))).toThrow(
                `${coin.txid}:${coin.vout} is within 6 blocks of exit maturity`,
            );
            expect(() => assertCosignable(timed, csv, tip(101, T + 604_672 - 3_601))).not.toThrow();
        });
        it("rejects a confirmed coin without block_time", () => {
            expect(() => assertCosignable(coin, csv, tip(101, T))).toThrow(
                /has no confirmation time/,
            );
        });
    });
});

describe("isCosignFallback", () => {
    it("falls back only when arkd definitely did not sign", () => {
        expect(isCosignFallback(new OnchainCosignUnsupportedError())).toBe(true);
        expect(isCosignFallback(new OnchainCosignRejectedError("x", "INVALID_ARK_PSBT"))).toBe(
            true,
        );
        expect(isCosignFallback(new OnchainCosignRejectedError("x", "TX_TOO_LARGE"))).toBe(true);
        expect(isCosignFallback(new OnchainCosignRejectedError("x", "SOMETHING_NEW"))).toBe(false);
        expect(isCosignFallback(new OnchainCosignPreflightError("x"))).toBe(true);
        expect(isCosignFallback(new OnchainCosignRejectedError("x"))).toBe(false);
        expect(isCosignFallback(new OnchainCosignRejectedError("x", "INTERNAL_ERROR"))).toBe(false);
        expect(isCosignFallback(new OnchainCosignAmbiguousError("x"))).toBe(false);
        expect(isCosignFallback(new Error("x"))).toBe(false);
    });
});

describe("estimateOnchainCosignFee", () => {
    it("is positive and monotonic in inputs and outputs", () => {
        const base = estimateOnchainCosignFee(1, 1, 2);
        expect(base).toBeGreaterThan(0);
        expect(estimateOnchainCosignFee(2, 1, 2)).toBeGreaterThan(base);
        expect(estimateOnchainCosignFee(1, 2, 2)).toBeGreaterThan(base);
    });

    it("counts both signatures of the 2-of-2 leaf", () => {
        // version+locktime 10, 2 counts, input 41, P2TR output 43; witness: marker/flag 2,
        // stack count 1, two 65-byte sigs, script 1+68, control block 1+65.
        const trueVsize = Math.ceil(((10 + 2 + 41 + 43) * 4 + 2 + 1 + 130 + 69 + 66) / 4);
        expect(estimateOnchainCosignFee(1, 1, 1)).toBeGreaterThanOrEqual(trueVsize);
        const oneSig = TxWeightEstimator.create().addTapscriptInput(64, 68, 65).addP2TROutput();
        // second sig + its length byte = 65 witness bytes = 16.25 vB, rounded per tx
        const extra = estimateOnchainCosignFee(1, 1, 4) - Number(oneSig.vsize().fee(4n));
        expect(extra).toBeGreaterThanOrEqual(64);
        expect(extra).toBeLessThanOrEqual(68);
    });
});

describe("rehydrateCosignError", () => {
    const cloned = (e: Error) => new Error(e.message);

    it("restores each fallback class from a structured-cloned message", () => {
        const original = new OnchainCosignRejectedError("too late", "INVALID_ARK_PSBT");
        expect(rehydrateCosignError(cloned(original))).toEqual(original);
        const unnamed = new OnchainCosignRejectedError("[not a name");
        expect(rehydrateCosignError(cloned(unnamed))).toEqual(unnamed);
        const ambiguous = new OnchainCosignAmbiguousError("500 bad gateway");
        const restored = rehydrateCosignError(cloned(ambiguous));
        expect(restored).toBeInstanceOf(OnchainCosignAmbiguousError);
        expect(restored).toEqual(ambiguous);
        const preflight = new OnchainCosignPreflightError("nothing to sweep");
        expect(rehydrateCosignError(cloned(preflight))).toEqual(preflight);
        expect(rehydrateCosignError(cloned(new OnchainCosignUnsupportedError()))).toBeInstanceOf(
            OnchainCosignUnsupportedError,
        );
    });

    describe("with the tx the client signed", () => {
        const signed = {
            txid: "aa".repeat(32),
            outpoints: [
                { txid: "bb".repeat(32), vout: 1 },
                { txid: "cc".repeat(32), vout: 0 },
            ],
        };
        // What the bus delivers: the message and name survive the clone, `wireData` rides beside it.
        const onTheWire = (e: Error) =>
            Object.assign(new Error(e.message), { wireData: (e as any).wireData });

        it("carries it through the bus, on both classes, without growing the message", () => {
            const rejected = new OnchainCosignRejectedError("too late", "INVALID_ARK_PSBT", signed);
            const restored = rehydrateCosignError(
                onTheWire(rejected),
            ) as OnchainCosignRejectedError;
            expect(restored).toEqual(rejected);
            expect(restored.signed).toEqual(signed);
            expect(restored.serverMessage).toBe("too late");
            expect(restored.arkErrorName).toBe("INVALID_ARK_PSBT");
            expect(rejected.message).not.toContain(signed.txid);

            const unnamed = new OnchainCosignRejectedError("multi\nline", undefined, signed);
            expect(rehydrateCosignError(onTheWire(unnamed))).toEqual(unnamed);

            const ambiguous = new OnchainCosignAmbiguousError("500", { signed });
            const back = rehydrateCosignError(onTheWire(ambiguous)) as OnchainCosignAmbiguousError;
            expect(back).toEqual(ambiguous);
            expect(back.signed).toEqual(signed);
            expect(back.detail).toBe("500");
            expect(ambiguous.message).toBe(new OnchainCosignAmbiguousError("500").message);
        });

        it("leaves it absent when the error was raised before signing, or by an older worker", () => {
            expect(new OnchainCosignRejectedError("m", "X").signed).toBeUndefined();
            expect(new OnchainCosignAmbiguousError("m").signed).toBeUndefined();
            const back = rehydrateCosignError(onTheWire(new OnchainCosignAmbiguousError("m")));
            expect((back as OnchainCosignAmbiguousError).signed).toBeUndefined();
            const signedButOld = new OnchainCosignRejectedError("m", "X", signed);
            expect((rehydrateCosignError(cloned(signedButOld)) as any).signed).toBeUndefined();
        });

        it("takes it from wire data only, never from server text", () => {
            const lookalike = `oops\n[signed ${"dd".repeat(32)} ${"ee".repeat(32)}:7]`;
            const err = new OnchainCosignRejectedError(lookalike, "X");
            const back = rehydrateCosignError(onTheWire(err)) as OnchainCosignRejectedError;
            expect(back.signed).toBeUndefined();
            expect(back.serverMessage).toBe(lookalike);
        });

        it.each([
            ["a short txid", { txid: "aa", outpoints: signed.outpoints }],
            ["no outpoints", { txid: signed.txid, outpoints: [] }],
            ["outpoints that are not a list", { txid: signed.txid, outpoints: "bb:1" }],
            [
                "a fractional vout",
                { txid: signed.txid, outpoints: [{ txid: "bb".repeat(32), vout: 1.5 }] },
            ],
            [
                "a negative vout",
                { txid: signed.txid, outpoints: [{ txid: "bb".repeat(32), vout: -1 }] },
            ],
            [
                "a non-hex outpoint txid",
                { txid: signed.txid, outpoints: [{ txid: "zz", vout: 0 }] },
            ],
        ])("ignores malformed wire data: %s", (_name, bad) => {
            const err = Object.assign(new Error(new OnchainCosignAmbiguousError("x").message), {
                wireData: { signed: bad },
            });
            expect(
                (rehydrateCosignError(err) as OnchainCosignAmbiguousError).signed,
            ).toBeUndefined();
        });

        it("exposes it as wire data once the wallet sets it, on the same instance", () => {
            const e = new OnchainCosignRejectedError("m", "INVALID_ARK_PSBT");
            const stack = e.stack;
            expect(e.wireData).toBeUndefined();
            e.signed = signed;
            expect(e.wireData).toEqual({ signed });
            expect(e.stack).toBe(stack);
            expect(isCosignFallback(e)).toBe(true);

            const cause = new Error("socket hang up");
            const a = new OnchainCosignAmbiguousError("x", { cause });
            a.signed = signed;
            expect(a.wireData).toEqual({ signed });
            expect(a.cause).toBe(cause);
            expect(isCosignFallback(a)).toBe(false);
        });
    });

    it("passes other errors through unchanged", () => {
        const other = new Error("boom");
        expect(rehydrateCosignError(other)).toBe(other);
        expect(rehydrateCosignError("x")).toBe("x");
    });
});

describe("submitOnchainSpend routing", () => {
    const onchainProvider = {
        broadcastTransaction: vi.fn(async () => "direct"),
        getRawTransaction: vi.fn(),
    };

    it("arkd inputs go to cosignOnchainTx and its txid is returned", async () => {
        const arkProvider = { cosignOnchainTx: vi.fn(async () => "arkd-txid") };
        const txid = await submitOnchainSpend(txWithInput(), new Set([0]), {
            arkProvider,
            onchainProvider,
        });
        expect(txid).toBe("arkd-txid");
        expect(onchainProvider.broadcastTransaction).not.toHaveBeenCalled();
    });

    it("throws when arkd inputs exist but no arkProvider", async () => {
        await expect(
            submitOnchainSpend(txWithInput(), new Set([0]), { onchainProvider }),
        ).rejects.toThrow(/arkProvider/);
    });

    it("treats an arkProvider without cosignOnchainTx as unsupported", async () => {
        await expect(
            submitOnchainSpend(txWithInput(), new Set([0]), { arkProvider: {}, onchainProvider }),
        ).rejects.toBeInstanceOf(OnchainCosignUnsupportedError);
    });

    it("routes emulator inputs to the emulator and broadcasts the finalized tx", async () => {
        const tx = txWithInput();
        attachExtension(tx, [
            EmulatorPacket.create([
                { vin: 0, script: new Uint8Array([0x51]), witness: new Uint8Array(0) },
            ]) as any,
        ]);
        const psbt = base64.encode(tx.toPSBT());
        const emulator = { submitOnchainTx: vi.fn(async () => ({ signedTx: psbt })) };
        const arkProvider = { cosignOnchainTx: vi.fn(async () => "arkd-txid") };
        const broadcast = vi.fn(async (_: string) => "direct");
        const finalize = vi
            .spyOn(BtcSignerTransaction.prototype, "finalizeIdx")
            .mockImplementation(() => {});
        const extract = vi
            .spyOn(BtcSignerTransaction.prototype, "extract")
            .mockImplementation(() => new Uint8Array([0]));
        vi.spyOn(BtcSignerTransaction.prototype, "finalize").mockImplementation(() => {});
        try {
            const txid = await submitOnchainSpend(tx, new Set(), {
                arkProvider,
                emulator,
                onchainProvider: { broadcastTransaction: broadcast, getRawTransaction: vi.fn() },
            });
            expect(txid).toBe("direct");
            expect(emulator.submitOnchainTx).toHaveBeenCalledTimes(1);
            expect(arkProvider.cosignOnchainTx).not.toHaveBeenCalled();
            expect(finalize).toHaveBeenCalledWith(0);
            expect(broadcast).toHaveBeenCalledWith("00");
        } finally {
            finalize.mockRestore();
            extract.mockRestore();
            vi.restoreAllMocks();
        }
    });

    it("leaves foreign finalized inputs untouched when sent to arkd", async () => {
        const tx = txWithInput();
        tx.addInput({ txid: hex.decode("bb".repeat(32)), index: 1 });
        const witness = [new Uint8Array([1, 2, 3])];
        tx.updateInput(1, { finalScriptWitness: witness });
        const arkProvider = { cosignOnchainTx: vi.fn(async (_: string) => "arkd-txid") };
        await submitOnchainSpend(tx, new Set([0]), { arkProvider, onchainProvider });
        const sent = Transaction.fromPSBT(
            base64.decode(arkProvider.cosignOnchainTx.mock.calls[0][0]),
        );
        expect(sent.getInput(1).finalScriptWitness).toEqual(witness);
    });
});

describe("emulator inputs", () => {
    const [keyA, keyB] = [3, 4].map((n) => schnorr.getPublicKey(new Uint8Array(32).fill(n)));
    const preimage = new Uint8Array(32).fill(9);
    const conditionLeaf = ConditionMultisigTapscript.encode({
        conditionScript: Script.encode(["SHA256", sha256(preimage), "EQUAL"]),
        pubkeys: [keyA, keyB],
    });
    const vtxo = new VtxoScript([conditionLeaf.script]);
    const emulatorTx = () => {
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(coin.txid), index: 0 });
        tx.addOutput({ script: script.pkScript, amount: 9_000n });
        prepareOwnedInput(tx, {
            index: 0,
            coin: { value: 10_000, script: hex.encode(vtxo.pkScript) },
            path: { leaf: vtxo.leaves[0], extraWitness: [preimage] },
            tapTree: vtxo.encode(),
        });
        attachExtension(tx, [
            EmulatorPacket.create([
                { vin: 0, script: new Uint8Array([0x51]), witness: new Uint8Array(0) },
            ]) as any,
        ]);
        return tx;
    };

    it("finalizes a condition leaf as sigs (reversed script order), condition, script, control block", async () => {
        const tx = emulatorTx();
        const sigA = new Uint8Array(64).fill(0xaa);
        const sigB = new Uint8Array(64).fill(0xbb);
        const leafHash = new Uint8Array(32);
        tx.updateInput(0, {
            tapScriptSig: [
                [{ pubKey: keyA, leafHash }, sigA],
                [{ pubKey: keyB, leafHash }, sigB],
            ],
        });
        const signed = base64.encode(tx.toPSBT());
        const broadcast = vi.fn(async (_: string) => "direct");
        await submitOnchainSpend(tx, new Set(), {
            emulator: { submitOnchainTx: async () => ({ signedTx: signed }) },
            onchainProvider: { broadcastTransaction: broadcast, getRawTransaction: vi.fn() },
        });
        const raw = BtcSignerTransaction.fromRaw(hex.decode(broadcast.mock.calls[0][0]), {
            allowUnknownInputs: true,
            allowUnknownOutputs: true,
        });
        expect(raw.getInput(0).finalScriptWitness).toEqual([
            sigB,
            sigA,
            preimage,
            scriptFromTapLeafScript(vtxo.leaves[0]),
            TaprootControlBlock.encode(vtxo.leaves[0][0]),
        ]);
    });

    it("hands arkd the emulator-signed input unfinalized, sigs and condition kept", async () => {
        const tx = emulatorTx();
        tx.addInput({ txid: hex.decode("bb".repeat(32)), index: 1 });
        const sig = new Uint8Array(64).fill(0xaa);
        tx.updateInput(0, {
            tapScriptSig: [
                [{ pubKey: keyA, leafHash: new Uint8Array(32) }, sig],
                [{ pubKey: keyB, leafHash: new Uint8Array(32) }, sig],
            ],
        });
        const signed = base64.encode(tx.toPSBT());
        const arkProvider = { cosignOnchainTx: vi.fn(async (_: string) => "arkd-txid") };

        await submitOnchainSpend(tx, new Set([1]), {
            arkProvider,
            emulator: { submitOnchainTx: async () => ({ signedTx: signed }) },
            onchainProvider: { broadcastTransaction: vi.fn(), getRawTransaction: vi.fn() },
        });

        const sent = Transaction.fromPSBT(
            base64.decode(arkProvider.cosignOnchainTx.mock.calls[0][0]),
        );
        expect(sent.getInput(0).finalScriptWitness).toBeUndefined();
        expect(sent.getInput(0).tapScriptSig).toHaveLength(2);
        expect(getArkPsbtFields(sent, 0, ConditionWitness)).toEqual([[preimage]]);
    });

    it("finalizes a condition leaf on the direct broadcast path too", async () => {
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(coin.txid), index: 0 });
        tx.addOutput({ script: script.pkScript, amount: 9_000n });
        prepareOwnedInput(tx, {
            index: 0,
            coin: { value: 10_000, script: hex.encode(vtxo.pkScript) },
            path: { leaf: vtxo.leaves[0], extraWitness: [preimage] },
            tapTree: vtxo.encode(),
        });
        const sig = new Uint8Array(64).fill(0xaa);
        tx.updateInput(0, {
            tapScriptSig: [
                [{ pubKey: keyA, leafHash: new Uint8Array(32) }, sig],
                [{ pubKey: keyB, leafHash: new Uint8Array(32) }, sig],
            ],
        });
        const broadcast = vi.fn(async (_: string) => "direct");
        await submitOnchainSpend(tx, new Set(), {
            onchainProvider: { broadcastTransaction: broadcast, getRawTransaction: vi.fn() },
        });
        const raw = BtcSignerTransaction.fromRaw(hex.decode(broadcast.mock.calls[0][0]));
        expect(raw.getInput(0).finalScriptWitness?.[2]).toEqual(preimage);
    });

    it("propagates a malformed extension instead of reporting no emulator inputs", () => {
        const tx = new Transaction({ version: 2 });
        tx.addInput({ txid: hex.decode(coin.txid), index: 0 });
        const malformed = Script.encode(["RETURN", new Uint8Array([0x41, 0x52, 0x4b, 0x01, 0xff])]);
        tx.addOutput({ script: malformed, amount: 0n });
        expect(() => emulatorInputIndexes(tx)).toThrow();
    });
});
