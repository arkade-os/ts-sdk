/**
 * The projection exists because `RfqSwap` is a live record, not a storage
 * format: it holds derived `Uint8Array`s and a `VHTLC.ScriptV2` class instance,
 * and IndexedDB's structured clone strips prototypes.
 *
 * The property worth testing is that the rebuild is a PURE function of the
 * record — no wallet, no network, no ambient defaults. That is what makes a
 * dropped tree parameter a test failure instead of a covenant nobody can spend.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    RFQ_SWAP_RETENTION_SECONDS,
    createRfqSwapRecord,
    rebuildRfqSwap,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "../src/rfqRecord";
import type { LightningReceiveSwap, LightningSendSwap, RfqSwapState } from "../src/swapManager";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const REFUND_LOCKTIME = 1_900_000_000;
// BIP68 encodes second-based relative timelocks in 512s units, and the refund
// tiers stack +512 / +1024 on top, so every value here must be a multiple of
// 512 — the same 4096 the rest of the suite uses.
const CLAIM_DELAY = 4096;
const PAYMENT_HASH = "d4".repeat(32);

const sendOrigin: RfqSwapOrigin = {
    kind: "lightning_send",
    solverPubkey: hex.encode(key(1)),
    emulatorPubkey: hex.encode(key(9)),
    serverPubkey: hex.encode(key(3)),
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: CLAIM_DELAY,
    senderPubkey: hex.encode(key(7)),
    refundPkScript: hex.encode(p2tr(key(21))),
    receiverPkScript: hex.encode(p2tr(key(1))),
    signingDescriptor: `tr(${hex.encode(key(7))})`,
    lockupAddress: "tark1qsendlockup",
    amount: 25_000,
};

const receiveOrigin: RfqSwapOrigin = {
    kind: "lightning_receive",
    solverPubkey: hex.encode(key(1)),
    emulatorPubkey: hex.encode(key(9)),
    serverPubkey: hex.encode(key(3)),
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: CLAIM_DELAY,
    payoutPubkey: hex.encode(key(15)),
    payoutPkScript: hex.encode(p2tr(key(15))),
    solverRefundPkScript: hex.encode(p2tr(key(2))),
    payoutAddress: "tark1qpayout",
    expectedAmount: 20_000,
    senderKey: "baseline",
    preimageHex: "ee".repeat(32),
    lockupAddress: "tark1qreceivelockup",
    amount: 20_400,
};

const swapOf = (
    origin: RfqSwapOrigin,
    state: RfqSwapState = "pending",
): LightningSendSwap | LightningReceiveSwap => {
    const common = {
        rfqId: "rfq-1",
        state,
        lockupPkScript: p2tr(key(11)),
        paymentHash: origin.paymentHash,
        refundLocktime: origin.refundLocktime,
        createdAt: 1_000,
        updatedAt: 1_000,
    };
    return origin.kind === "lightning_send"
        ? ({ ...common, kind: "lightning_send" } as LightningSendSwap)
        : ({
              ...common,
              kind: "lightning_receive",
              expectedAmount: origin.expectedAmount!,
          } as LightningReceiveSwap);
};

describe("rebuildRfqSwap", () => {
    it.each([
        ["lightning_send", sendOrigin],
        ["lightning_receive", receiveOrigin],
    ] as const)("rebuilds %s with no wallet and no network", (kind, origin) => {
        const record = createRfqSwapRecord(origin, swapOf(origin));
        const rebuilt = rebuildRfqSwap(record);

        expect(rebuilt.kind).toBe(kind);
        expect(rebuilt.rfqId).toBe("rfq-1");
        // the covenant itself, not a copy of the stored bytes
        expect(rebuilt.lockup?.script).toBeDefined();
        expect(hex.encode(rebuilt.lockupPkScript)).toBe(
            hex.encode(rebuilt.lockup!.script.pkScript),
        );
        expect(rebuilt.lockup?.address).toBe(origin.lockupAddress);
    });

    it("is deterministic — the same record rebuilds the same covenant", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(hex.encode(rebuildRfqSwap(record).lockupPkScript)).toBe(
            hex.encode(rebuildRfqSwap(record).lockupPkScript),
        );
    });

    it("changes the covenant when any tree parameter changes", () => {
        // The guard against a projection that silently drops a field: if a
        // parameter did not reach the script, mutating it would be a no-op.
        const base = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        const baseline = hex.encode(rebuildRfqSwap(base).lockupPkScript);

        const mutations: Partial<RfqSwapRecord>[] = [
            { solverPubkey: hex.encode(key(2)) },
            { emulatorPubkey: hex.encode(key(8)) },
            { serverPubkey: hex.encode(key(4)) },
            { paymentHash: "aa".repeat(32) },
            { refundLocktime: REFUND_LOCKTIME + 1 },
            // one granularity step, so the mutated value stays encodable
            { claimDelay: CLAIM_DELAY + 512 },
            { senderPubkey: hex.encode(key(6)) },
            { refundPkScript: hex.encode(p2tr(key(22))) },
            { receiverPkScript: hex.encode(p2tr(key(5))) },
        ];
        for (const mutation of mutations) {
            const changed = hex.encode(rebuildRfqSwap({ ...base, ...mutation }).lockupPkScript);
            expect(
                changed,
                `mutating ${Object.keys(mutation)[0]} did not reach the script`,
            ).not.toBe(baseline);
        }
    });

    it("carries the receive leg's expectedAmount, which is not re-derivable", () => {
        const record = createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin));
        const rebuilt = rebuildRfqSwap(record) as LightningReceiveSwap;
        expect(rebuilt.expectedAmount).toBe(20_000);
    });

    it("refuses a record missing a tree parameter rather than rebuilding a wrong covenant", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(() => rebuildRfqSwap({ ...record, senderPubkey: undefined })).toThrow(
            /senderPubkey/,
        );
    });
});

describe("the record never carries a private key", () => {
    it.each([
        ["lightning_send", sendOrigin],
        ["lightning_receive", receiveOrigin],
    ] as const)("%s", (_kind, origin) => {
        const record = createRfqSwapRecord(origin, swapOf(origin));
        expect(record.fallbackSecrets).toBeUndefined();
        expect(JSON.stringify(record)).not.toContain("senderPrivateKey");
    });

    it("keeps the baseline marker so a restored record knows which key it meant", () => {
        const record = createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin));
        expect(record.senderKey).toBe("baseline");
        expect(record.signingDescriptor).toBeUndefined();
    });
});

describe("updateRfqSwapRecord", () => {
    it("merges manager state without disturbing the origin", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        const moved = updateRfqSwapRecord(record, {
            ...swapOf(sendOrigin, "refunded"),
            updatedAt: 2_000,
            refundArkTxid: "ff".repeat(32),
        } as LightningSendSwap);

        expect(moved.state).toBe("refunded");
        expect(moved.refundArkTxid).toBe("ff".repeat(32));
        expect(moved.updatedAt).toBe(2_000);
        // the immutable half is untouched
        expect(moved.solverPubkey).toBe(sendOrigin.solverPubkey);
        expect(moved.claimDelay).toBe(CLAIM_DELAY);
        expect(moved.lockupAddress).toBe(sendOrigin.lockupAddress);
        expect(moved.signingDescriptor).toBe(sendOrigin.signingDescriptor);
    });

    it("keeps a rebuilt covenant identical across a state change", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        const moved = updateRfqSwapRecord(record, swapOf(sendOrigin, "settled"));
        expect(hex.encode(rebuildRfqSwap(moved).lockupPkScript)).toBe(
            hex.encode(rebuildRfqSwap(record).lockupPkScript),
        );
    });
});

describe("shouldRetainRfqSwap", () => {
    const at = (state: RfqSwapState, updatedAt: number): RfqSwapRecord =>
        updateRfqSwapRecord(createRfqSwapRecord(sendOrigin, swapOf(sendOrigin)), {
            ...swapOf(sendOrigin, state),
            updatedAt,
        } as LightningSendSwap);

    it("retains a live swap however old", () => {
        expect(shouldRetainRfqSwap(at("pending", 0), 10 * RFQ_SWAP_RETENTION_SECONDS)).toBe(true);
    });

    it("never drops needs_counterparty — the money is still at the lockup", () => {
        // Not terminal, and not a dead end: the counterparty's move still ends
        // the swap, and the refusal is re-checked every pass.
        expect(
            shouldRetainRfqSwap(at("needs_counterparty", 0), 10 * RFQ_SWAP_RETENTION_SECONDS),
        ).toBe(true);
    });

    it.each(["settled", "refunded", "failed"] as const)("retains %s for 30 days", (state) => {
        expect(shouldRetainRfqSwap(at(state, 0), RFQ_SWAP_RETENTION_SECONDS - 1)).toBe(true);
    });

    it.each(["settled", "refunded", "failed"] as const)("drops %s past 30 days", (state) => {
        expect(shouldRetainRfqSwap(at(state, 0), RFQ_SWAP_RETENTION_SECONDS + 1)).toBe(false);
    });

    it("measures the window from updatedAt, not createdAt", () => {
        // A swap created long ago but settled a moment ago is fresh history.
        const record = at("settled", 10 * RFQ_SWAP_RETENTION_SECONDS);
        expect(shouldRetainRfqSwap(record, 10 * RFQ_SWAP_RETENTION_SECONDS + 1)).toBe(true);
    });
});
