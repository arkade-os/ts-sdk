import { describe, it, expect } from "vitest";
import { Intent } from "../src/intent";

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
});
