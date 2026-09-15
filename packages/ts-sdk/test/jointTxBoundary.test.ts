import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { SigHash } from "@scure/btc-signer";
import {
    CSVMultisigTapscript,
    MultisigTapscript,
    SingleKey,
    Transaction,
    VtxoScript,
    assertDefaultTapScriptSigs,
    assertSameUnsignedTx,
    assertUnsignedPsbt,
    setTapScriptSigEntries,
    tapLeavesOfInput,
    tapScriptSigEntries,
    unsignedPsbtBytes,
    buildOffchainTx,
    type ArkTxInput,
} from "../src";

const userSeed = new Uint8Array(32).fill(0x11);
const serverSeed = new Uint8Array(32).fill(0x22);
const userKey = schnorr.getPublicKey(userSeed);
const serverKey = schnorr.getPublicKey(serverSeed);

const tree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [userKey, serverKey] }).script]);
const unroll = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: BigInt(10) },
    pubkeys: [serverKey],
});
const coin = (txid: string): ArkTxInput => ({
    txid,
    vout: 0,
    value: 5000,
    tapLeafScript: tree.leaves[0],
    tapTree: tree.encode(),
});
const p2tr = (key: Uint8Array) => new Uint8Array([0x51, 0x20, ...key]);

const fresh = () =>
    buildOffchainTx(
        [coin("aa".repeat(32)), coin("bb".repeat(32))],
        [{ script: p2tr(userKey), amount: 9990n }],
        unroll,
    ).arkTx;

describe("joint tx boundary primitives", () => {
    it("accepts an unsigned graph and rejects any signature or declared sighash", () => {
        expect(() => assertUnsignedPsbt(fresh(), "fresh")).not.toThrow();
    });

    it("rejects script-path signatures once signed", async () => {
        const tx = fresh();
        const signed = await SingleKey.fromPrivateKey(userSeed).sign(tx.clone(), [0]);
        expect(() => assertUnsignedPsbt(signed, "signed")).toThrow(/script-path signatures/);
        expect(unsignedPsbtBytes(signed)).toEqual(unsignedPsbtBytes(tx));
    });

    it("rejects a declared non-DEFAULT sighash", () => {
        const tx = fresh();
        tx.updateInput(0, { sighashType: SigHash.ALL });
        expect(() => assertUnsignedPsbt(tx, "declared")).toThrow(/Unallowed sighash/);
    });

    it("compares unsigned bytes only", async () => {
        const tx = fresh();
        const signed = await SingleKey.fromPrivateKey(userSeed).sign(tx.clone(), [0]);
        expect(() => assertSameUnsignedTx(signed, tx, "same")).not.toThrow();
        const edited = fresh();
        edited.updateOutput(0, { script: p2tr(serverKey), amount: 9990n });
        expect(() => assertSameUnsignedTx(edited, tx, "edited")).toThrow(/differs/);
    });

    it("verifies DEFAULT signatures against a pinned leaf and key", async () => {
        const tx = fresh();
        const signed = await SingleKey.fromPrivateKey(userSeed).sign(tx.clone(), [0]);
        const leaf = tapLeavesOfInput(tx, 0)[0].leafHashHex;
        const userHex = hex.encode(userKey);
        expect(() =>
            assertDefaultTapScriptSigs(signed, 0, {
                allowedPubKeys: [userHex],
                leafHash: hex.decode(leaf),
                context: "ok",
            }),
        ).not.toThrow();
        expect(() =>
            assertDefaultTapScriptSigs(signed, 0, {
                allowedPubKeys: [hex.encode(serverKey)],
                leafHash: hex.decode(leaf),
                context: "key",
            }),
        ).toThrow(/unexpected key/);
        expect(() =>
            assertDefaultTapScriptSigs(signed, 0, {
                allowedPubKeys: [userHex],
                leafHash: new Uint8Array(32).fill(7),
                context: "leaf",
            }),
        ).toThrow(/unexpected leaf/);
        const [[keyData, sig]] = signed.getInput(0).tapScriptSig!;
        const long = fresh();
        long.updateInput(0, {
            tapScriptSig: [
                [
                    { pubKey: keyData.pubKey, leafHash: keyData.leafHash },
                    new Uint8Array([...sig, 0]),
                ],
            ],
        });
        expect(() =>
            assertDefaultTapScriptSigs(long, 0, {
                allowedPubKeys: [userHex],
                leafHash: keyData.leafHash,
                context: "length",
            }),
        ).toThrow(/65-byte/);
    });

    it("reads and replaces tapScriptSig entries", async () => {
        const tx = fresh();
        expect(tapScriptSigEntries(tx, 0)).toEqual([]);
        expect(tapLeavesOfInput(tx, 0)).toHaveLength(1);
        const signed = await SingleKey.fromPrivateKey(userSeed).sign(tx.clone(), [0]);
        const entries = tapScriptSigEntries(signed, 0);
        expect(entries).toHaveLength(1);
        const target = fresh();
        setTapScriptSigEntries(target, 0, [
            {
                pubKey: hex.decode(entries[0].pubKeyHex),
                leafHash: hex.decode(entries[0].leafHashHex),
                signature: entries[0].signature,
            },
        ]);
        expect(unsignedPsbtBytes(target)).toEqual(unsignedPsbtBytes(tx));
        expect(tapScriptSigEntries(target, 0)).toHaveLength(1);
        // A shorter set must remove what it omits: an array alone merges, so
        // this stays at 1 unless the helper clears first.
        setTapScriptSigEntries(target, 0, []);
        expect(tapScriptSigEntries(target, 0)).toEqual([]);
    });

    it("treats locktime as unsigned data", () => {
        const at = (lockTime: number) => {
            const tx = new Transaction({ version: 3, lockTime });
            tx.addInput({
                txid: "aa".repeat(32),
                index: 0,
                witnessUtxo: { script: p2tr(userKey), amount: 5000n },
            });
            tx.addOutput({ script: p2tr(serverKey), amount: 4990n });
            return tx;
        };
        expect(() => assertSameUnsignedTx(at(0), at(0), "same")).not.toThrow();
        expect(() => assertSameUnsignedTx(at(500000), at(0), "locktime")).toThrow(/differs/);
    });
});
