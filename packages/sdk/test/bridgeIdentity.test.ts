import { describe, expect, it, vi } from "vitest";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { p2tr, Script, SigHash } from "@scure/btc-signer";
import { BIP322 } from "../src/bip322";
import {
    BridgeIdentity,
    type IdentityBridge,
    type BridgeSigningRequest,
} from "../src/identity/bridge";
import { BridgeIdentity as ExportedBridgeIdentity } from "../src/index";
import { taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import { SingleKey } from "../src/identity/singleKey";
import { VtxoScript } from "../src/script/base";
import { MultisigTapscript } from "../src/script/tapscript";
import { verifyTapscriptSignatures } from "../src/utils/arkTransaction";
import { Transaction } from "../src/utils/transaction";
import { setArkPsbtField, VtxoTaprootTree } from "../src/utils/unknownFields";

const secret = hex.decode("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const operatorSecret = hex.decode(
    "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const publicKey = schnorr.getPublicKey(secret);
const operatorKey = schnorr.getPublicKey(operatorSecret);
const signer = SingleKey.fromPrivateKey(secret);

function bridge(): IdentityBridge {
    return {
        getPublicKey: vi.fn(() => signer.compressedPublicKey()),
        signPsbt: vi.fn(async (psbt, indexes) =>
            (await signer.sign(Transaction.fromPSBT(psbt), indexes)).toPSBT(),
        ),
        signMessage: vi.fn((hash, type) => signer.signMessage(hash, type)),
    };
}

function keyPathTx(withTree = false, sighashType: number = SigHash.DEFAULT): Transaction {
    const treePayment = p2tr(publicKey, { script: Script.encode([operatorKey, "CHECKSIG"]) });
    const payment = withTree ? treePayment : p2tr(publicKey);
    const tx = new Transaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(1),
        index: 0,
        witnessUtxo: { script: payment.script, amount: 12_000n },
        tapInternalKey: publicKey,
        ...(withTree ? { tapMerkleRoot: treePayment.tapMerkleRoot } : {}),
        sighashType,
    });
    tx.addOutput({ script: p2tr(operatorKey).script, amount: 11_000n });
    return tx;
}

function collaborativeTx(sighashType: number = SigHash.DEFAULT): Transaction {
    const leaf = MultisigTapscript.encode({
        pubkeys: [publicKey, operatorKey],
        type: MultisigTapscript.MultisigType.CHECKSIG,
    });
    const script = new VtxoScript([leaf.script]);
    const tx = new Transaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(2),
        index: 1,
        witnessUtxo: { script: script.pkScript, amount: 10_000n },
        tapLeafScript: [script.leaves[0]],
        sighashType,
    });
    tx.addOutput({ script: p2tr(publicKey).script, amount: 9_000n });
    setArkPsbtField(tx, 0, VtxoTaprootTree, script.encode());
    return tx;
}

describe("BridgeIdentity", () => {
    it("pins a valid compressed key without exporting private or deterministic capabilities", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        expect(ExportedBridgeIdentity).toBe(BridgeIdentity);
        const key = await identity.compressedPublicKey();
        key.fill(0);
        expect(await identity.compressedPublicKey()).toEqual(secp256k1.getPublicKey(secret));
        expect(await identity.xOnlyPublicKey()).toEqual(publicKey);
        expect(identity).not.toHaveProperty("toHex");
        expect(identity).not.toHaveProperty("signSchnorrDeterministic");
        expect(identity.signerSession()).not.toBe(identity.signerSession());
        for (const key of [
            new Uint8Array(32),
            new Uint8Array(33),
            Uint8Array.of(2, ...new Uint8Array(32)),
        ]) {
            await expect(
                BridgeIdentity.create({ ...provider, getPublicKey: async () => key }),
            ).rejects.toThrow();
        }
    });

    it.each([false, true])(
        "signs and verifies BIP86 or script-tree key-path inputs (%s)",
        async (withTree) => {
            const identity = await BridgeIdentity.create(bridge());
            const tx = keyPathTx(withTree);
            const original = tx.toPSBT();
            const signed = await identity.sign(tx, [0]);
            expect(signed.getInput(0).tapKeySig).toHaveLength(64);
            signed.finalizeIdx(0);
            expect(signed.getInput(0).finalScriptWitness).toHaveLength(1);
            expect(tx.toPSBT()).toEqual(original);
        },
    );

    it.each([SigHash.DEFAULT, SigHash.ALL, SigHash.ALL_ANYONECANPAY])(
        "preserves operator signatures and opaque fields for tapscript sighash %i",
        async (sighash) => {
            const identity = await BridgeIdentity.create(bridge());
            const tx = await SingleKey.fromPrivateKey(operatorSecret).sign(
                collaborativeTx(sighash),
            );
            const before = tx.toPSBT();
            const signed = await identity.sign(tx);
            expect(tx.toPSBT()).toEqual(before);
            expect(signed.getInput(0).unknown).toEqual(tx.getInput(0).unknown);
            expect(signed.getInput(0).tapScriptSig).toContainEqual(tx.getInput(0).tapScriptSig![0]);
            verifyTapscriptSignatures(
                signed,
                0,
                [hex.encode(publicKey), hex.encode(operatorKey)],
                [],
                [sighash],
            );
        },
    );

    it("round trips a BIP322 proof without private-key material", async () => {
        const identity = await BridgeIdentity.create(bridge());
        const proof = await BIP322.sign("native bridge proof", identity);
        expect(BIP322.verify("native bridge proof", proof, p2tr(publicKey).address!)).toBe(true);
    });

    it("verifies raw signatures and normalizes compact ECDSA high-S", async () => {
        const provider = bridge();
        const hash = new Uint8Array(32).fill(42);
        const low = secp256k1.Signature.fromBytes(secp256k1.sign(hash, secret, { prehash: false }));
        provider.signMessage = async (_, type) =>
            type === "schnorr"
                ? schnorr.sign(hash, secret)
                : new secp256k1.Signature(low.r, secp256k1.Point.Fn.ORDER - low.s).toBytes();
        const identity = await BridgeIdentity.create(provider);
        expect(schnorr.verify(await identity.signMessage(hash, "schnorr"), hash, publicKey)).toBe(
            true,
        );
        const ecdsa = await identity.signMessage(hash, "ecdsa");
        expect(secp256k1.Signature.fromBytes(ecdsa).hasHighS()).toBe(false);
        expect(
            secp256k1.verify(ecdsa, hash, secp256k1.getPublicKey(secret), { prehash: false }),
        ).toBe(true);
        provider.signMessage = async () => new Uint8Array(64);
        await expect(identity.signMessage(hash, "schnorr")).rejects.toThrow();
        await expect(identity.signMessage(hash, "ecdsa")).rejects.toThrow();
        await expect(identity.signMessage(new Uint8Array(31), "schnorr")).rejects.toThrow();
    });

    it.each(["outputs", "prevout", "proprietary", "finalization", "foreign signature"])(
        "rejects bridge %s changes",
        async (change) => {
            const provider = bridge();
            const honest = provider.signPsbt;
            provider.signPsbt = async (psbt, indexes) => {
                const tx = Transaction.fromPSBT(await honest(psbt, indexes));
                if (change === "outputs") tx.updateOutput(0, { amount: 10_999n }, true);
                if (change === "prevout")
                    tx.updateInput(
                        0,
                        {
                            witnessUtxo: {
                                script: tx.getInput(0).witnessUtxo!.script,
                                amount: 12_001n,
                            },
                        },
                        true,
                    );
                if (change === "proprietary")
                    tx.updateInput(
                        0,
                        {
                            unknown: [
                                [
                                    { type: 0xfc, key: Uint8Array.of(4, 116, 101, 115, 116, 1) },
                                    Uint8Array.of(2),
                                ],
                            ],
                        },
                        true,
                    );
                if (change === "finalization") tx.finalizeIdx(0);
                if (change === "foreign signature")
                    tx.updateInput(
                        0,
                        {
                            tapScriptSig: [
                                [
                                    { pubKey: operatorKey, leafHash: new Uint8Array(32) },
                                    new Uint8Array(64),
                                ],
                            ],
                        },
                        true,
                    );
                return tx.toPSBT();
            };
            const identity = await BridgeIdentity.create(provider);
            await expect(identity.sign(keyPathTx())).rejects.toThrow();
        },
    );

    it("rejects valid signatures made for a changed transaction and signatures from a different key", async () => {
        const provider = bridge();
        provider.signPsbt = async (psbt, indexes) => {
            const changed = Transaction.fromPSBT(psbt);
            changed.updateOutput(0, { amount: 10_999n });
            return (await signer.sign(changed, indexes)).toPSBT();
        };
        const identity = await BridgeIdentity.create(provider);
        await expect(identity.sign(keyPathTx())).rejects.toThrow();
        provider.signPsbt = async (psbt) => {
            const tx = Transaction.fromPSBT(psbt);
            tx.updateInput(0, { tapKeySig: schnorr.sign(new Uint8Array(32), operatorSecret) });
            return tx.toPSBT();
        };
        await expect(identity.sign(keyPathTx())).rejects.toThrow();
    });

    it("requires every requested signature and forbids signing unselected inputs", async () => {
        const provider = bridge();
        const tx = keyPathTx();
        tx.addInput({ ...keyPathTx().getInput(0), txid: new Uint8Array(32).fill(3) });
        provider.signPsbt = async (psbt) => psbt;
        const identity = await BridgeIdentity.create(provider);
        await expect(identity.sign(tx, [1])).rejects.toThrow();
        provider.signPsbt = async (psbt) =>
            (await signer.sign(Transaction.fromPSBT(psbt))).toPSBT();
        await expect(identity.sign(tx, [1])).rejects.toThrow();
    });

    it("retains already valid signatures and avoids another bridge interaction", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        const signed = await identity.sign(keyPathTx());
        vi.mocked(provider.signPsbt).mockClear();
        expect((await identity.sign(signed)).toPSBT()).toEqual(signed.toPSBT());
        expect(provider.signPsbt).not.toHaveBeenCalled();
    });

    it("rejects removal of an operator signature or opaque input fields", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        const withOperator = await SingleKey.fromPrivateKey(operatorSecret).sign(collaborativeTx());
        provider.signPsbt = async () => (await signer.sign(collaborativeTx())).toPSBT();
        await expect(identity.sign(withOperator)).rejects.toThrow("changed PSBT fields");
        const opaque = keyPathTx();
        opaque.updateInput(0, {
            unknown: [
                [{ type: 0xfc, key: Uint8Array.of(4, 116, 101, 115, 116, 1) }, Uint8Array.of(2)],
            ],
        });
        provider.signPsbt = async () => (await signer.sign(keyPathTx())).toPSBT();
        await expect(identity.sign(opaque)).rejects.toThrow("changed PSBT fields");
    });

    it("rejects an invalid existing signature before requesting more signing", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        const tx = keyPathTx();
        tx.updateInput(0, { tapKeySig: new Uint8Array(64) });
        await expect(identity.sign(tx)).rejects.toThrow("Invalid bridge signature");
        expect(provider.signPsbt).not.toHaveBeenCalled();
    });

    it("rejects unsupported code separators and invalid tapscript control proofs", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        const script = new VtxoScript([Script.encode([publicKey, "CHECKSIG", "CODESEPARATOR"])]);
        const tx = new Transaction();
        tx.addInput({
            txid: new Uint8Array(32).fill(2),
            index: 0,
            witnessUtxo: { script: script.pkScript, amount: 10_000n },
            tapLeafScript: [script.leaves[0]],
        });
        tx.addOutput({ script: p2tr(operatorKey).script, amount: 9_000n });
        await expect(identity.sign(tx)).rejects.toThrow("OP_CODESEPARATOR");
        const invalid = new Transaction({ disableScriptCheck: true });
        invalid.addInput({
            ...collaborativeTx().getInput(0),
            witnessUtxo: { script: p2tr(publicKey).script, amount: 10_000n },
        });
        invalid.addOutput({ script: p2tr(operatorKey).script, amount: 9_000n });
        await expect(identity.sign(invalid)).rejects.toThrow();
        expect(provider.signPsbt).not.toHaveBeenCalled();
    });

    it("skips foreign inputs by default but rejects an explicit foreign selection", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        const tx = keyPathTx();
        tx.updateInput(0, {
            tapInternalKey: operatorKey,
            witnessUtxo: { script: p2tr(operatorKey).script, amount: 12_000n },
        });
        expect((await identity.sign(tx)).toPSBT()).toEqual(tx.toPSBT());
        await expect(identity.sign(tx, [0])).rejects.toThrow("not signable");
        expect(provider.signPsbt).not.toHaveBeenCalled();
    });

    it("preflights selection, sighash policy, and missing prevouts before requesting a signature", async () => {
        const provider = bridge();
        const identity = await BridgeIdentity.create(provider);
        for (const indexes of [[-1], [1], [0.5], [NaN]])
            await expect(identity.sign(keyPathTx(), indexes)).rejects.toThrow();
        for (const sighash of [SigHash.NONE, SigHash.SINGLE, SigHash.NONE_ANYONECANPAY])
            await expect(identity.sign(keyPathTx(false, sighash))).rejects.toThrow();
        const missing = keyPathTx();
        missing.addInput({ txid: new Uint8Array(32).fill(3), index: 1 });
        await expect(identity.sign(missing, [0])).rejects.toThrow();
        expect(provider.signPsbt).not.toHaveBeenCalled();
        const acp = keyPathTx(false, SigHash.ALL_ANYONECANPAY);
        acp.addInput({ txid: new Uint8Array(32).fill(3), index: 1 });
        provider.signPsbt = async (psbt) => {
            const tx = Transaction.fromPSBT(psbt);
            const prevout = tx.getInput(0).witnessUtxo!;
            const hash = tx.preimageWitnessV1(
                0,
                [prevout.script, new Uint8Array()],
                SigHash.ALL_ANYONECANPAY,
                [prevout.amount, 0n],
            );
            const signature = schnorr.sign(hash, taprootTweakPrivKey(secret, new Uint8Array()));
            tx.updateInput(0, { tapKeySig: Uint8Array.of(...signature, SigHash.ALL_ANYONECANPAY) });
            return tx.toPSBT();
        };
        expect((await identity.sign(acp, [0])).getInput(0).tapKeySig![64]).toBe(
            SigHash.ALL_ANYONECANPAY,
        );
    });

    it("signs batches once in request order and rejects missing, reordered, or altered responses", async () => {
        const provider = bridge();
        provider.signPsbts = vi.fn(async (requests: BridgeSigningRequest[]) =>
            Promise.all(
                requests.map(({ psbt, inputIndexes }) => provider.signPsbt(psbt, inputIndexes)),
            ),
        );
        const identity = await BridgeIdentity.create(provider);
        const requests = [
            { tx: keyPathTx(), inputIndexes: [0] },
            { tx: collaborativeTx(), inputIndexes: [0] },
        ];
        const signed = await identity.signMultiple(requests);
        expect(provider.signPsbts).toHaveBeenCalledTimes(1);
        expect(signed[0].getInput(0).tapKeySig).toHaveLength(64);
        expect(signed[1].getInput(0).tapScriptSig).toHaveLength(1);
        const honest = provider.signPsbts;
        provider.signPsbts = async (requests) => (await honest(requests)).slice(1);
        await expect(identity.signMultiple(requests)).rejects.toThrow();
        provider.signPsbts = async (requests) => (await honest(requests)).reverse();
        await expect(identity.signMultiple(requests)).rejects.toThrow();
    });

    it("snapshots transactions and selected indexes before crossing an asynchronous bridge", async () => {
        const provider = bridge();
        const tx = keyPathTx();
        const indexes = [0];
        const initial = tx.toPSBT();
        const honest = provider.signPsbt;
        provider.signPsbt = async (psbt, selected) => {
            tx.updateOutput(0, { amount: 1n });
            indexes[0] = 99;
            const result = await honest(psbt, selected);
            psbt.fill(0);
            selected?.fill(99);
            return result;
        };
        const identity = await BridgeIdentity.create(provider);
        const signed = await identity.sign(tx, indexes);
        expect(signed.getOutput(0).amount).toBe(Transaction.fromPSBT(initial).getOutput(0).amount);
        expect(signed.getInput(0).tapKeySig).toHaveLength(64);
    });
});
