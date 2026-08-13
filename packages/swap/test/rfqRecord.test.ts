/**
 * The projection exists because `RfqSwap` is a live record, not a storage
 * format: it holds derived `Uint8Array`s and a `VHTLC.ScriptV2` class instance,
 * and IndexedDB's structured clone strips prototypes.
 *
 * The covenant is NOT part of it: every lockup registers a contract row before
 * it can be funded, and the rebuild takes that row's params. So what is worth
 * testing here is the seam — that the rebuild refuses params which are not this
 * swap's, and that it carries through the facts no covenant can give back.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { VHTLCV2ContractHandler } from "@arkade-os/sdk";
import {
    RFQ_SWAP_RETENTION_SECONDS,
    createRfqSwapRecord,
    rebuildRfqSwap,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type LockupParams,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "../src/rfqRecord";
import { lightningSendVtxoScript, receiveVtxoScript } from "../src/rfq";
import type { LightningReceiveSwap, LightningSendSwap, RfqSwapState } from "../src/swapManager";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const REFUND_LOCKTIME = 1_900_000_000;
// BIP68 encodes second-based relative timelocks in 512s units, and the refund
// tiers stack +512 / +1024 on top, so every value here must be a multiple of
// 512 — the same 4096 the rest of the suite uses.
const CLAIM_DELAY = 4096;
const PAYMENT_HASH = "d4".repeat(32);
const SERVER = key(3);

/** The two halves a consumer holds: the row's params, and the address that was
 * funded. Built the way the entry points build them, so the fixture exercises
 * the real `serializeParams` round trip rather than a hand-written record. */
const lockupOf = (script: ReturnType<typeof receiveVtxoScript>) => ({
    params: VHTLCV2ContractHandler.serializeParams(script.options),
    address: script.address("tark", SERVER).encode(),
});

const SEND_LOCKUP = lockupOf(
    lightningSendVtxoScript({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        serverPubkey: SERVER,
        paymentHash: PAYMENT_HASH,
        claimDelay: CLAIM_DELAY,
        emulatorPubkey: key(9),
        refundPkScript: p2tr(key(21)),
        senderPubkey: key(7),
        receiverPkScript: p2tr(key(1)),
    }),
);

const RECEIVE_LOCKUP = lockupOf(
    receiveVtxoScript({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        serverPubkey: SERVER,
        paymentHash: PAYMENT_HASH,
        claimDelay: CLAIM_DELAY,
        emulatorPubkey: key(9),
        solverRefundPkScript: p2tr(key(2)),
        payoutPubkey: key(15),
        payoutPkScript: p2tr(key(15)),
    }),
);

const sendOrigin: RfqSwapOrigin = {
    kind: "lightning_send",
    paymentHash: PAYMENT_HASH,
    lockupAddress: SEND_LOCKUP.address,
    signingDescriptor: `tr(${hex.encode(key(7))})`,
    amount: 25_000,
};

const receiveOrigin: RfqSwapOrigin = {
    kind: "lightning_receive",
    paymentHash: PAYMENT_HASH,
    lockupAddress: RECEIVE_LOCKUP.address,
    payoutAddress: "tark1qpayout",
    expectedAmount: 20_000,
    signingDescriptor: `tr(${hex.encode(key(15))})`,
    preimageHex: "ee".repeat(32),
    amount: 20_400,
};

const paramsOf = (origin: RfqSwapOrigin): LockupParams =>
    origin.kind === "lightning_send" ? SEND_LOCKUP.params : RECEIVE_LOCKUP.params;

const swapOf = (
    origin: RfqSwapOrigin,
    state: RfqSwapState = "pending",
): LightningSendSwap | LightningReceiveSwap => {
    const common = {
        rfqId: "rfq-1",
        state,
        lockupPkScript: p2tr(key(11)),
        paymentHash: origin.paymentHash,
        refundLocktime: REFUND_LOCKTIME,
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
    ] as const)("rebuilds %s from the contract row's params", (kind, origin) => {
        const record = createRfqSwapRecord(origin, swapOf(origin));
        const rebuilt = rebuildRfqSwap(record, paramsOf(origin));

        expect(rebuilt.kind).toBe(kind);
        expect(rebuilt.rfqId).toBe("rfq-1");
        // the covenant itself, not a copy of the stored bytes
        expect(rebuilt.lockup?.script).toBeDefined();
        expect(hex.encode(rebuilt.lockupPkScript)).toBe(
            hex.encode(rebuilt.lockup!.script.pkScript),
        );
        expect(rebuilt.lockup?.address).toBe(origin.lockupAddress);
        // read off the covenant, which binds it — the record stores no copy
        expect(rebuilt.refundLocktime).toBe(REFUND_LOCKTIME);
        expect(rebuilt.paymentHash).toBe(PAYMENT_HASH);
    });

    it("refuses params that are not this swap's", () => {
        // The check the record can still make about itself: the params and the
        // funded address reach it by independent routes — the row was written
        // from the covenant, the address came from the entry point — so the
        // wrong row is caught at restore rather than at refund time.
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(() => rebuildRfqSwap(record, RECEIVE_LOCKUP.params)).toThrow(
            /not this swap's|lockup address/,
        );
    });

    it("refuses params a backend read back short a key", () => {
        // A field-mapped store that drops one: `createScript` either throws or
        // derives another covenant, and both must fail here rather than hand
        // back a live record watching a script nobody funded.
        const { refundNoReceiverDelay: _dropped, ...partial } = SEND_LOCKUP.params;
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(() => rebuildRfqSwap(record, partial)).toThrow();
    });

    it("carries the receive leg's expectedAmount, which is not re-derivable", () => {
        const record = createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin));
        const rebuilt = rebuildRfqSwap(record, RECEIVE_LOCKUP.params) as LightningReceiveSwap;
        expect(rebuilt.expectedAmount).toBe(20_000);
    });

    it("refuses a receive record missing expectedAmount rather than deleting the value gate", () => {
        // The one required field the covenant cannot vouch for: dropping it
        // leaves the params and the lockup check intact, so nothing about the
        // address would catch it — only this does.
        const record = createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin));
        expect(() =>
            rebuildRfqSwap({ ...record, expectedAmount: undefined }, RECEIVE_LOCKUP.params),
        ).toThrow(/expectedAmount/);
    });
});

describe("the record never carries a private key", () => {
    it.each([
        ["lightning_send", sendOrigin],
        ["lightning_receive", receiveOrigin],
    ] as const)("%s", (_kind, origin) => {
        const record = createRfqSwapRecord(origin, swapOf(origin));
        expect(JSON.stringify(record)).not.toContain("senderPrivateKey");
    });

    it("keeps the descriptor and optional preimage used to recover the claim", () => {
        const record = createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin));
        expect(record.signingDescriptor).toBe(receiveOrigin.signingDescriptor);
        expect(record.preimageHex).toBe("ee".repeat(32));
    });

    it("stores no covenant tree parameter — the contract row is the one copy", () => {
        // Nothing here may become a second source for the covenant. The
        // solver's key is the canary: it binds the tree and appears nowhere in
        // what the record keeps.
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(JSON.stringify(record)).not.toContain(hex.encode(key(1)));
    });
});

describe("updateRfqSwapRecord", () => {
    it("updates manager state without disturbing the origin", () => {
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
        expect(moved.paymentHash).toBe(sendOrigin.paymentHash);
        expect(moved.lockupAddress).toBe(sendOrigin.lockupAddress);
        expect(moved.signingDescriptor).toBe(sendOrigin.signingDescriptor);
    });

    it("clears a field the swap no longer carries, not just sets new ones", () => {
        const blocked = updateRfqSwapRecord(createRfqSwapRecord(sendOrigin, swapOf(sendOrigin)), {
            ...swapOf(sendOrigin, "needs_counterparty"),
            blockedReason: "no secrets on this wallet",
            failure: "an earlier push failed",
        } as LightningSendSwap);
        expect(blocked.blockedReason).toBe("no secrets on this wallet");
        expect(blocked.failure).toBe("an earlier push failed");

        const recovered = updateRfqSwapRecord(blocked, swapOf(sendOrigin, "pending"));
        expect(recovered.blockedReason).toBeUndefined();
        expect(recovered.failure).toBeUndefined();
        expect(recovered.paymentHash).toBe(sendOrigin.paymentHash);
        expect(recovered.lockupAddress).toBe(sendOrigin.lockupAddress);
    });

    it("keeps a rebuilt covenant identical across a state change", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        const moved = updateRfqSwapRecord(record, swapOf(sendOrigin, "settled"));
        expect(hex.encode(rebuildRfqSwap(moved, SEND_LOCKUP.params).lockupPkScript)).toBe(
            hex.encode(rebuildRfqSwap(record, SEND_LOCKUP.params).lockupPkScript),
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
