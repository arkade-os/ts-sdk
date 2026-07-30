import { describe, it, expect, vi } from "vitest";
import { Transaction, p2tr } from "@scure/btc-signer";
import { constructClaimTransaction, targetFee } from "../src/utils/boltz-swap-tx";

// x-only pubkey (32 bytes) for a P2TR destination output.
const xOnlyPubkey = new Uint8Array(32).fill(0x02);
const p2trScript = p2tr(xOnlyPubkey).script;

const utxo = {
    transactionId: "a".repeat(64),
    vout: 0,
    amount: 100_000n,
    script: p2trScript,
};

const build = (fee: bigint): Transaction => constructClaimTransaction(utxo, p2trScript, fee);

describe("targetFee", () => {
    it("sizes the fee from the exact vsize, without a per-input pad", () => {
        // The 1-in/1-out P2TR key-path claim finalized with the 64-byte dummy
        // signature has vsize 111; the fee must be ceil(111 * rate), not
        // ceil((111 + inputsLength) * rate).
        const claimTx = targetFee(1, build);
        const probe = build(1n);
        expect(probe.vsize).toBe(111);
        expect(claimTx.getOutput(0).amount).toBe(utxo.amount - 111n);
    });

    it("passes ceil(vsize * rate) to constructTx on the second call", () => {
        const spy = vi.fn(build);
        targetFee(1, spy);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[0][0]).toBe(1n);
        // vsize (111), not vsize + inputsLength (112)
        expect(spy.mock.calls[1][0]).toBe(111n);
    });

    it("scales the fee linearly with satPerVbyte", () => {
        const claimTx = targetFee(5, build);
        // ceil(111 * 5) = 555
        expect(claimTx.getOutput(0).amount).toBe(utxo.amount - 555n);
    });
});

describe("constructClaimTransaction", () => {
    it("throws when the fee is >= the utxo amount", () => {
        expect(() => build(utxo.amount)).toThrow("fee exceeds utxo amount");
    });

    it("throws when the fee is negative", () => {
        expect(() => build(-1n)).toThrow("fee exceeds utxo amount");
    });
});
