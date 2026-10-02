import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { SigHash, Transaction as BtcSignerTransaction } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { DefaultVtxo, EmulatorPacket, Transaction } from "../../src";
import { attachExtension } from "../../src/arkade/contract";
import {
    OnchainCosignPreflightError,
    assertCosignable,
    estimateOnchainCosignFee,
    isCosignFallback,
    prepareOwnedInput,
    submitOnchainSpend,
} from "../../src/contracts/onchainSpend";
import { OnchainCosignRejectedError, OnchainCosignUnsupportedError } from "../../src/providers/ark";
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
});

describe("assertCosignable", () => {
    it("rejects unconfirmed", () => {
        expect(() => assertCosignable({ ...coin, status: { confirmed: false } }, 144, 120)).toThrow(
            OnchainCosignPreflightError,
        );
    });
    it("rejects within the margin of CSV maturity", () => {
        expect(() => assertCosignable(coin, 144, 101)).toThrow(/maturity/);
    });
    it("accepts when far from maturity", () => {
        expect(() => assertCosignable(coin, 1008, 101)).not.toThrow();
    });
});

describe("isCosignFallback", () => {
    it("matches the three cosign failures only", () => {
        expect(isCosignFallback(new OnchainCosignUnsupportedError())).toBe(true);
        expect(isCosignFallback(new OnchainCosignRejectedError("x"))).toBe(true);
        expect(isCosignFallback(new OnchainCosignPreflightError("x"))).toBe(true);
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
