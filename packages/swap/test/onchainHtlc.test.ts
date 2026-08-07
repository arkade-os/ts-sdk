/**
 * The L1 side of the onchain corridor. The golden test pins the taproot HTLC
 * byte-for-byte — like the program-artifact goldens, any drift here changes
 * addresses on BOTH sides of a swap. The builder tests verify real BIP-341
 * script-path spends end to end: recomputed sighash, valid schnorr signature,
 * preimage recoverable from the witness.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";

import {
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    awaitOnchainFill,
    buildHtlcClaim,
    buildHtlcRefund,
    claimOnchainFill,
    classifyOnchainHtlc,
    extractPreimage,
    newPreimage,
    onchainHtlcScript,
    paymentHashOf,
    type ChainSource,
    type ChainUtxo,
} from "../src/onchainHtlc";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));

const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = paymentHashOf(PREIMAGE);
const LOCKTIME = 1_800_000_000;

const htlc = () =>
    onchainHtlcScript(
        {
            paymentHash: PAYMENT_HASH,
            claimKey: key(1),
            refundKey: key(3),
            refundLocktime: LOCKTIME,
        },
        "bitcoin",
    );

const UTXO = { txid: "11".repeat(32), vout: 0, amount: 100_000n };
const PAYOUT = Uint8Array.from([0x51, 0x20, ...key(5)]);
const signWith =
    (fill: number) =>
    async (sighash: Uint8Array): Promise<Uint8Array> =>
        schnorr.sign(sighash, priv(fill));

describe("onchainHtlcScript — golden", () => {
    it("derives the pinned address and scriptPubKey", () => {
        const h = htlc();
        expect(h.address).toBe("bc1pha7jrk3203ypttdk866vhdjlznzpd92esp0vdlfgw2plmjsxpwwq7wecyt");
        expect(hex.encode(h.pkScript)).toBe(
            "5120bf7d21da2a7c4815adb63eb4cbb65f14c4169559805ec6fd287283fdca060b9c",
        );
    });

    it("compiles the two leaves and control blocks, byte for byte", () => {
        const h = htlc();
        // SIZE 32 EQUALVERIFY HASH160 <ripemd160(sha256(P))> EQUALVERIFY
        // <claimKey> CHECKSIG — the length gate pins the witness preimage to
        // exactly 32 bytes before it's hashed; the hash itself is the SAME
        // h160 the Arkade leaf commits to — one P unlocks both sides.
        expect(hex.encode(h.leaves.claim)).toBe(
            "82012088a914b566a3eecce809896361988823cd2f423fe800e788" + `20${hex.encode(key(1))}ac`,
        );
        // <locktime> CLTV DROP <refundKey> CHECKSIG — untouched by the claim-side change.
        expect(hex.encode(h.leaves.refund)).toBe(`0400d2496bb17520${hex.encode(key(3))}ac`);
        // NUMS internal key — no key-path spend exists. Both control blocks
        // changed even though only the claim leaf's script did: each control
        // block's merkle path includes the OTHER leaf's hash as a sibling.
        expect(hex.encode(h.controlBlocks.claim)).toBe(
            "c150929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0" +
                "439b655bf27409423fc603101d15f5eeed93bb09bc080a21d1ddeee7bc207202",
        );
        expect(hex.encode(h.controlBlocks.refund)).toBe(
            "c150929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0" +
                "4c0d6c2942558916bf08e1671b9a1392d49d076475da1a7962b194706804d19c",
        );
    });

    it("rejects malformed keys and locktimes", () => {
        expect(() =>
            onchainHtlcScript(
                {
                    paymentHash: PAYMENT_HASH,
                    claimKey: key(1).slice(1),
                    refundKey: key(3),
                    refundLocktime: LOCKTIME,
                },
                "bitcoin",
            ),
        ).toThrow(/x-only/);
        expect(() =>
            onchainHtlcScript(
                {
                    paymentHash: PAYMENT_HASH,
                    claimKey: key(1),
                    refundKey: key(3),
                    refundLocktime: 0,
                },
                "bitcoin",
            ),
        ).toThrow(/positive/);
    });
});

describe("buildHtlcClaim", () => {
    it("builds a valid script-path spend whose witness reveals P", async () => {
        const h = htlc();
        const spend = await buildHtlcClaim({
            htlc: h,
            utxo: UTXO,
            preimage: PREIMAGE,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: signWith(1),
        });

        const tx = btc.Transaction.fromRaw(hex.decode(spend.txHex), {
            allowUnknownInputs: true,
            allowUnknownOutputs: true,
        });
        expect(tx.id).toBe(spend.txid);
        expect(tx.getOutput(0).amount).toBe(spend.payoutAmount);
        expect(spend.payoutAmount).toBeLessThan(UTXO.amount);
        expect(spend.payoutAmount).toBeGreaterThan(UTXO.amount - 1000n);

        // The signature verifies against the recomputed BIP-341 sighash.
        const witness = tx.getInput(0).finalScriptWitness!;
        expect(witness).toHaveLength(4);
        const sighash = tx.preimageWitnessV1(
            0,
            [h.pkScript],
            btc.SigHash.DEFAULT,
            [UTXO.amount],
            undefined,
            h.leaves.claim,
            0xc0,
        );
        expect(schnorr.verify(witness[0]!, sighash, key(1))).toBe(true);
        expect(hex.encode(witness[1]!)).toBe(hex.encode(PREIMAGE));

        // The published preimage is recoverable — the receipt.
        expect(hex.encode(extractPreimage(spend.txHex, PAYMENT_HASH)!)).toBe(hex.encode(PREIMAGE));
    });

    it("refuses a preimage that does not match the HTLC", async () => {
        await expect(
            buildHtlcClaim({
                htlc: htlc(),
                utxo: UTXO,
                preimage: newPreimage(),
                payoutPkScript: PAYOUT,
                feeRateSatVb: 2,
                sign: signWith(1),
            }),
        ).rejects.toThrow(/does not hash/);
    });

    it("refuses to build below the dust limit", async () => {
        await expect(
            buildHtlcClaim({
                htlc: htlc(),
                utxo: { ...UTXO, amount: 600n },
                preimage: PREIMAGE,
                payoutPkScript: PAYOUT,
                feeRateSatVb: 2,
                sign: signWith(1),
            }),
        ).rejects.toThrow(/dust/);
    });

    it("rejects a signer that returns the wrong signature size", async () => {
        await expect(
            buildHtlcClaim({
                htlc: htlc(),
                utxo: UTXO,
                preimage: PREIMAGE,
                payoutPkScript: PAYOUT,
                feeRateSatVb: 2,
                sign: async () => new Uint8Array(63),
            }),
        ).rejects.toThrow(/64-byte/);
    });
});

describe("buildHtlcRefund", () => {
    it("sets nLockTime, enables it via sequence, and signs the refund leaf", async () => {
        const h = htlc();
        const spend = await buildHtlcRefund({
            htlc: h,
            utxo: UTXO,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: signWith(3),
        });
        const tx = btc.Transaction.fromRaw(hex.decode(spend.txHex), {
            allowUnknownInputs: true,
            allowUnknownOutputs: true,
        });
        expect(tx.lockTime).toBe(LOCKTIME);
        expect(tx.getInput(0).sequence).toBe(0xfffffffe);
        const witness = tx.getInput(0).finalScriptWitness!;
        expect(witness).toHaveLength(3);
        const sighash = tx.preimageWitnessV1(
            0,
            [h.pkScript],
            btc.SigHash.DEFAULT,
            [UTXO.amount],
            undefined,
            h.leaves.refund,
            0xc0,
        );
        expect(schnorr.verify(witness[0]!, sighash, key(3))).toBe(true);
        // A refund reveals nothing.
        expect(extractPreimage(spend.txHex, PAYMENT_HASH)).toBeNull();
    });
});

describe("extractPreimage", () => {
    it("returns null on garbage", () => {
        expect(extractPreimage("not-hex", PAYMENT_HASH)).toBeNull();
    });
});

/** A scripted ChainSource: a mutable fake standing in for esplora. */
const fakeChain = (state: {
    utxos?: ChainUtxo[];
    spend?: { txHex: string } | null;
    mtp?: number;
}): ChainSource & { broadcasts: string[] } => ({
    broadcasts: [] as string[],
    async getScriptUtxos() {
        return state.utxos ?? [];
    },
    async getSpendingTx() {
        return state.spend ?? null;
    },
    async broadcast(txHex: string) {
        this.broadcasts.push(txHex);
        return "aa".repeat(32);
    },
    async getMtp() {
        return state.mtp ?? 0;
    },
});

describe("awaitOnchainFill", () => {
    it("resolves once a UTXO reaches depth, preferring the largest", async () => {
        const state: { utxos?: ChainUtxo[] } = { utxos: [] };
        const chain = fakeChain(state);
        setTimeout(() => {
            state.utxos = [
                { ...UTXO, amount: 1_000n, confirmations: 2 },
                { ...UTXO, vout: 1, confirmations: 2 },
            ];
        }, 5);
        const utxo = await awaitOnchainFill(chain, htlc(), 2, { pollMs: 1 });
        expect(utxo.amount).toBe(UTXO.amount);
    });

    it("times out with the fill_timeout reason", async () => {
        await expect(
            awaitOnchainFill(fakeChain({}), htlc(), 1, { pollMs: 1, deadline: 1 }),
        ).rejects.toMatchObject({ reason: "fill_timeout" });
    });
});

describe("claimOnchainFill", () => {
    it("claims when the window is safe", async () => {
        const chain = fakeChain({});
        const result = await claimOnchainFill(chain, {
            htlc: htlc(),
            utxo: UTXO,
            preimage: PREIMAGE,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: signWith(1),
            now: LOCKTIME - ONCHAIN_CLAIM_MARGIN_SECONDS - 60,
        });
        expect(chain.broadcasts).toHaveLength(1);
        expect(result.payoutAmount).toBeGreaterThan(0n);
    });

    it("refuses to publish P into the counterparty's refund window", async () => {
        await expect(
            claimOnchainFill(fakeChain({}), {
                htlc: htlc(),
                utxo: UTXO,
                preimage: PREIMAGE,
                payoutPkScript: PAYOUT,
                feeRateSatVb: 2,
                sign: signWith(1),
                now: LOCKTIME - ONCHAIN_CLAIM_MARGIN_SECONDS + 1,
            }),
        ).rejects.toMatchObject({ reason: "claim_window_closed" });
    });
});

describe("classifyOnchainHtlc", () => {
    const funded = (confirmations: number): ChainUtxo => ({ ...UTXO, confirmations });

    it("walks every phase from chain state", async () => {
        const h = htlc();
        expect(await classifyOnchainHtlc(fakeChain({}), { htlc: h, minConfirmations: 2 })).toEqual({
            phase: "unfunded",
        });
        expect(
            (
                await classifyOnchainHtlc(fakeChain({ utxos: [funded(1)] }), {
                    htlc: h,
                    minConfirmations: 2,
                })
            ).phase,
        ).toBe("awaiting_confirmations");
        expect(
            (
                await classifyOnchainHtlc(fakeChain({ utxos: [funded(2)], mtp: LOCKTIME - 1 }), {
                    htlc: h,
                    minConfirmations: 2,
                })
            ).phase,
        ).toBe("claimable");
        expect(
            (
                await classifyOnchainHtlc(fakeChain({ utxos: [funded(2)], mtp: LOCKTIME }), {
                    htlc: h,
                    minConfirmations: 2,
                })
            ).phase,
        ).toBe("refundable");
    });

    it("classifies a spent HTLC as claimed (with P) or swept, from the stored outpoint", async () => {
        const h = htlc();
        const claim = await buildHtlcClaim({
            htlc: h,
            utxo: UTXO,
            preimage: PREIMAGE,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: signWith(1),
        });
        const claimed = await classifyOnchainHtlc(fakeChain({ spend: { txHex: claim.txHex } }), {
            htlc: h,
            minConfirmations: 2,
            funding: { txid: UTXO.txid, vout: UTXO.vout },
        });
        expect(claimed.phase).toBe("claimed");
        if (claimed.phase === "claimed") {
            expect(hex.encode(claimed.preimage)).toBe(hex.encode(PREIMAGE));
            expect(claimed.txid).toBe(claim.txid);
        }

        const refund = await buildHtlcRefund({
            htlc: h,
            utxo: UTXO,
            payoutPkScript: PAYOUT,
            feeRateSatVb: 2,
            sign: signWith(3),
        });
        const swept = await classifyOnchainHtlc(fakeChain({ spend: { txHex: refund.txHex } }), {
            htlc: h,
            minConfirmations: 2,
            funding: { txid: UTXO.txid, vout: UTXO.vout },
        });
        expect(swept.phase).toBe("swept");

        // Without the stored outpoint a spent HTLC is indistinguishable from
        // an unfunded one — the reason persisting before funding is mandatory.
        expect(
            (
                await classifyOnchainHtlc(fakeChain({ spend: { txHex: claim.txHex } }), {
                    htlc: h,
                    minConfirmations: 2,
                })
            ).phase,
        ).toBe("unfunded");
    });
});
