import { describe, it, expect } from "vitest";
import { Transaction, SigHash } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { VtxoScript } from "../src/script/base";
import { MultisigTapscript } from "../src/script/tapscript";
import { SingleKey } from "../src/identity/singleKey";
import { verifyTapscriptSignatures } from "../src/utils/arkTransaction";

describe("verifyTapscriptSignatures", () => {
    // Test identities
    const identity1 = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const publicKey1 = identity1.xOnlyPublicKey();

    const identity2 = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const publicKey2 = identity2.xOnlyPublicKey();

    const identity3 = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const publicKey3 = identity3.xOnlyPublicKey();

    // Create a 3-of-3 multisig VtxoScript
    const multisigScript = MultisigTapscript.encode({
        pubkeys: [publicKey1, publicKey2, publicKey3],
        type: MultisigTapscript.MultisigType.CHECKSIG,
    });

    const vtxoScript = new VtxoScript([multisigScript.script]);

    // Helper to create a mock transaction with tapscript signatures
    function createMockTransaction(
        signers: { identity: SingleKey; publicKey: Uint8Array }[],
        amount: bigint = 1000n,
        sighashType: number = SigHash.DEFAULT
    ): Transaction {
        const tx = new Transaction();

        // Use the first tapLeafScript from vtxoScript
        const tapLeaf = vtxoScript.leaves[0];
        const [controlBlock, scriptWithVersion] = tapLeaf;
        const script = scriptWithVersion.subarray(0, -1);
        const version = scriptWithVersion[scriptWithVersion.length - 1];

        tx.addInput({
            txid: new Uint8Array(32).fill(0),
            index: 0,
            witnessUtxo: {
                script: vtxoScript.pkScript,
                amount: amount,
            },
            tapLeafScript: [tapLeaf],
        });

        // Add output
        tx.addOutputAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", 900n);

        // Sign with each signer using Transaction.signIdx
        for (const signer of signers) {
            const signed = tx.signIdx(signer.identity["key"], 0, [sighashType]);
            if (!signed) {
                throw new Error(
                    `Failed to sign with key ${hex.encode(signer.publicKey)}`
                );
            }
        }

        return tx;
    }

    it("should verify valid single signature", () => {
        const tx = createMockTransaction([
            { identity: identity1, publicKey: publicKey1 },
        ]);

        expect(() => {
            verifyTapscriptSignatures(tx, 0, [hex.encode(publicKey1)]);
        }).not.toThrow();
    });

    it("should verify valid 3-of-3 multisig signatures", () => {
        const tx = createMockTransaction([
            { identity: identity1, publicKey: publicKey1 },
            { identity: identity2, publicKey: publicKey2 },
            { identity: identity3, publicKey: publicKey3 },
        ]);

        expect(() => {
            verifyTapscriptSignatures(tx, 0, [
                hex.encode(publicKey1),
                hex.encode(publicKey2),
                hex.encode(publicKey3),
            ]);
        }).not.toThrow();
    });

    it("should allow excluding pubkeys from verification", () => {
        const tx = createMockTransaction([
            { identity: identity1, publicKey: publicKey1 },
            { identity: identity2, publicKey: publicKey2 },
        ]);

        // Should not throw even though pubkey3 is required but excluded
        expect(() => {
            verifyTapscriptSignatures(
                tx,
                0,
                [
                    hex.encode(publicKey1),
                    hex.encode(publicKey2),
                    hex.encode(publicKey3),
                ],
                [hex.encode(publicKey3)] // Exclude pubkey3
            );
        }).not.toThrow();
    });

    it("should throw error for missing required signature", () => {
        const tx = createMockTransaction([
            { identity: identity1, publicKey: publicKey1 },
            { identity: identity2, publicKey: publicKey2 },
        ]);

        expect(() => {
            verifyTapscriptSignatures(
                tx,
                0,
                [
                    hex.encode(publicKey1),
                    hex.encode(publicKey2),
                    hex.encode(publicKey3),
                ] // Require pubkey3 but not signed
            );
        }).toThrow(/Missing signatures from/);
    });

    it("should throw error for invalid signature", () => {
        // Create a properly signed transaction
        const tx = createMockTransaction([
            { identity: identity1, publicKey: publicKey1 },
        ]);

        // Access the internal PSBT inputs array directly (hack!)
        const txAny = tx as any;
        if (txAny.inputs && txAny.inputs.length > 0) {
            const internalInput = txAny.inputs[0];

            if (
                internalInput.tapScriptSig &&
                internalInput.tapScriptSig.length > 0
            ) {
                const [tapScriptSigData, validSignature] =
                    internalInput.tapScriptSig[0];

                // Create a completely fake signature (64 random bytes)
                const fakeSignature = new Uint8Array(64);
                crypto.getRandomValues(fakeSignature);

                // Replace the signature directly in the internal array
                internalInput.tapScriptSig[0] = [
                    tapScriptSigData,
                    fakeSignature,
                ];
            }
        }

        expect(() => {
            verifyTapscriptSignatures(tx, 0, [hex.encode(publicKey1)]);
        }).toThrow(/Invalid signature/);
    });

    it("should throw error for invalid sighash type", () => {
        // Create a properly signed transaction with DEFAULT sighash
        const tx = createMockTransaction([
            { identity: identity1, publicKey: publicKey1 },
        ]);

        // Access the internal PSBT inputs array and modify the signature to use SigHash.ALL
        const txAny = tx as any;
        if (txAny.inputs && txAny.inputs.length > 0) {
            const internalInput = txAny.inputs[0];

            if (
                internalInput.tapScriptSig &&
                internalInput.tapScriptSig.length > 0
            ) {
                const [tapScriptSigData, validSignature] =
                    internalInput.tapScriptSig[0];

                // Append SigHash.ALL byte to the signature (making it 65 bytes)
                const sigWithSighash = new Uint8Array(65);
                sigWithSighash.set(validSignature);
                sigWithSighash[64] = SigHash.ALL; // Append sighash type

                // Replace the signature with the modified one
                internalInput.tapScriptSig[0] = [
                    tapScriptSigData,
                    sigWithSighash,
                ];
            }
        }

        expect(() => {
            verifyTapscriptSignatures(
                tx,
                0,
                [hex.encode(publicKey1)],
                [],
                [SigHash.DEFAULT] // Only allow DEFAULT
            );
        }).toThrow(/Unallowed sighash type/);
    });

    it("should throw error for missing witnessUtxo", () => {
        const tx = new Transaction();

        tx.addInput({
            txid: new Uint8Array(32).fill(0),
            index: 0,
            // No witnessUtxo
        });

        expect(() => {
            verifyTapscriptSignatures(tx, 0, []);
        }).toThrow(/missing witnessUtxo/);
    });

    it("should throw error for missing tapScriptSig", () => {
        const tx = new Transaction();
        tx.addInput({
            txid: new Uint8Array(32).fill(0),
            index: 0,
            witnessUtxo: {
                script: new Uint8Array(34),
                amount: 1000n,
            },
            // No tapScriptSig
        });

        expect(() => {
            verifyTapscriptSignatures(tx, 0, []);
        }).toThrow(/missing tapScriptSig/);
    });

    // Note: Additional edge case tests (invalid signature, invalid length, missing tapLeafScript, etc.)
    // are skipped because the Transaction API doesn't allow easy manipulation of signed data.
    // The core functionality is well-tested by the positive test cases above.
});
