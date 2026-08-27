import { describe, it, expect } from "vitest";
import { Intent } from "../src/intent";
import { Transaction } from "../src/utils/transaction";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    getArkPsbtFields,
    MultisigTapscript,
    PrevArkTxField,
    VtxoScript,
    type IntentCoin,
} from "../src";

const PSBT_GLOBAL_GENERIC_SIGNED_MESSAGE = 0x09;

function globalSignedMessage(tx: unknown): Uint8Array | undefined {
    const unknown =
        (tx as { global?: { unknown?: [{ type: number; key: Uint8Array }, Uint8Array][] } }).global
            ?.unknown ?? [];
    return unknown.find(
        ([k]) => k.type === PSBT_GLOBAL_GENERIC_SIGNED_MESSAGE && k.key.length === 0,
    )?.[1];
}

describe("Intent", () => {
    // Minimal P2TR-shaped pkscript (OP_1 <32-byte x-only key>). The Intent
    // builder doesn't execute scripts; it only needs a witnessUtxo.
    const witnessUtxo = {
        script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(1)]),
        amount: 1000n,
    };

    const zeroTxid = new Uint8Array(32);

    describe("craftToSignTx lockTime", () => {
        it("sets lockTime = 0 when a BIP-68 nSequence is present on an input", () => {
            // 4195486 = 0x40_049E = seconds flag (bit 22) + 1182 (=605184s).
            // This is a valid BIP-68 nSequence for a CSV leaf and must NOT
            // be copied into tx.lockTime (which is absolute nLockTime).
            const input = {
                txid: zeroTxid,
                index: 0,
                sequence: 4195486,
                witnessUtxo,
            };

            const proof = Intent.create("hello", [input]);

            expect(proof.lockTime).toBe(0);
            // Per-input nSequence must still carry the BIP-68 value.
            // Index 0 is the to_spend-referencing input; ownership input is at index 1.
            expect(proof.getInput(1).sequence).toBe(4195486);
        });

        it("sets lockTime = 0 regardless of large input.sequence values", () => {
            const input = {
                txid: zeroTxid,
                index: 0,
                sequence: 0xfffffffe,
                witnessUtxo,
            };

            const proof = Intent.create("msg", [input]);

            expect(proof.lockTime).toBe(0);
        });

        it("sets lockTime = 0 when no input.sequence is set", () => {
            const input = {
                txid: zeroTxid,
                index: 0,
                witnessUtxo,
            };

            const proof = Intent.create("msg", [input]);

            expect(proof.lockTime).toBe(0);
        });

        it("sets lockTime = 0 across multiple inputs with mixed sequences", () => {
            const inputs = [
                {
                    txid: zeroTxid,
                    index: 0,
                    sequence: 4195486,
                    witnessUtxo,
                },
                {
                    txid: new Uint8Array(32).fill(2),
                    index: 1,
                    sequence: 144,
                    witnessUtxo,
                },
            ];

            const proof = Intent.create("msg", inputs);

            expect(proof.lockTime).toBe(0);
        });
    });

    describe("prevTx (emulator v0.0.7+)", () => {
        function vtxoCoin(seed: number, prevTx?: Uint8Array) {
            const vs = new VtxoScript([
                MultisigTapscript.encode({
                    pubkeys: [
                        schnorr.getPublicKey(new Uint8Array(32).fill(seed)),
                        schnorr.getPublicKey(new Uint8Array(32).fill(seed + 1)),
                    ],
                }).script,
            ]);
            return {
                txid: hex.encode(new Uint8Array(32).fill(seed)),
                vout: 0,
                value: 1000,
                tapTree: vs.encode(),
                forfeitTapLeafScript: vs.leaves[0],
                intentTapLeafScript: vs.leaves[0],
                prevTx,
            } as unknown as IntentCoin;
        }

        it("puts the field on the coin's proof input, never on the synthetic input 0", () => {
            const prevTx = new Uint8Array(40).fill(3);

            const proof = Intent.create("msg", [vtxoCoin(1, prevTx)]);

            expect(getArkPsbtFields(proof, 0, PrevArkTxField)).toHaveLength(0);
            const onCoin = getArkPsbtFields(proof, 1, PrevArkTxField);
            expect(onCoin).toHaveLength(1);
            expect(hex.encode(onCoin[0])).toBe(hex.encode(prevTx));
        });

        it("keeps input 0's witnessUtxo at the first coin's script with a zero amount", () => {
            // The emulator synthesises a one-output tx for input 0 from exactly
            // these two values, so they are part of the wire contract.
            const coin = vtxoCoin(5, new Uint8Array(40).fill(3));

            const proof = Intent.create("msg", [coin]);

            expect(proof.getInput(0).witnessUtxo!.amount).toBe(0n);
            expect(hex.encode(proof.getInput(0).witnessUtxo!.script)).toBe(
                hex.encode(proof.getInput(1).witnessUtxo!.script),
            );
        });

        it("attaches nothing when the coin carries no prevTx", () => {
            const proof = Intent.create("msg", [vtxoCoin(9)]);

            expect(getArkPsbtFields(proof, 1, PrevArkTxField)).toHaveLength(0);
        });
    });

    describe("BIP-322 generic signed message (0x09)", () => {
        it("sets the 0x09 global field to the signed message", () => {
            const input = { txid: zeroTxid, index: 0, witnessUtxo };

            const proof = Intent.create("hello", [input]);

            const value = globalSignedMessage(proof);
            expect(value).toBeDefined();
            expect(new TextDecoder().decode(value)).toBe("hello");
        });

        it("sets the 0x09 global field to the canonical encoded message for object messages", () => {
            const input = { txid: zeroTxid, index: 0, witnessUtxo };
            const message: Intent.Message = { type: "delete", expire_at: 42 };

            const proof = Intent.create(message, [input]);

            const value = globalSignedMessage(proof);
            expect(value).toBeDefined();
            expect(new TextDecoder().decode(value)).toBe(Intent.encodeMessage(message));
        });

        it("survives a PSBT round-trip so a co-signer recovers the message from wire bytes", () => {
            const input = { txid: zeroTxid, index: 0, witnessUtxo };

            const proof = Intent.create("round-trip", [input]);
            const parsed = Transaction.fromPSBT(proof.toPSBT());

            const value = globalSignedMessage(parsed);
            expect(value).toBeDefined();
            expect(new TextDecoder().decode(value)).toBe("round-trip");
        });
    });
});
