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
    rfqSwapOriginOf,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type LockupParams,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "../src/rfqRecord";
import { lightningSendVtxoScript, receiveVtxoScript } from "../src/rfq";
import { onchainHtlcScript } from "../src/onchainHtlc";
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
    // The live swap watches this, and the record stores only the address it
    // decodes from — so a fixture that let the two disagree would be a swap no
    // consumer could build.
    pkScript: script.pkScript,
});

const SEND_LOCKUP = lockupOf(
    lightningSendVtxoScript({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        operatorPubkey: SERVER,
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
        operatorPubkey: SERVER,
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
    lockupAddress: SEND_LOCKUP.address,
    // A refund key and a hash it can never open: P belongs to the payee.
    profile: {
        signer: { signingDescriptor: `tr(${hex.encode(key(7))})` },
        hashlock: { paymentHash: PAYMENT_HASH },
    },
    amount: 25_000,
};

const receiveOrigin: RfqSwapOrigin = {
    kind: "lightning_receive",
    lockupAddress: RECEIVE_LOCKUP.address,
    profile: {
        signer: { signingDescriptor: `tr(${hex.encode(key(15))})` },
        hashlock: { paymentHash: PAYMENT_HASH, preimageHex: "ee".repeat(32) },
        expectedAmount: 20_000,
        payoutAddress: "tark1qpayout",
    },
    amount: 20_400,
};

/** The corridor's own hashlock, for an assertion about what was stored. */
const hashlockOf = (record: { profile: Record<string, unknown> }) =>
    record.profile.hashlock as { paymentHash: string; preimageHex?: string };

const signerOf = (record: { profile: Record<string, unknown> }) =>
    record.profile.signer as { signingDescriptor: string };

const lockupFor = (origin: RfqSwapOrigin) =>
    origin.kind === "lightning_receive" ? RECEIVE_LOCKUP : SEND_LOCKUP;

const paramsOf = (origin: RfqSwapOrigin): LockupParams => lockupFor(origin).params;

const swapOf = (
    origin: RfqSwapOrigin,
    state: RfqSwapState = "pending",
): LightningSendSwap | LightningReceiveSwap => {
    const common = {
        rfqId: "rfq-1",
        state,
        lockupPkScript: lockupFor(origin).pkScript,
        paymentHash: hashlockOf(origin).paymentHash,
        refundLocktime: REFUND_LOCKTIME,
        createdAt: 1_000,
        updatedAt: 1_000,
    };
    return origin.kind === "lightning_send"
        ? ({ ...common, kind: "lightning_send" } as LightningSendSwap)
        : ({
              ...common,
              kind: "lightning_receive",
              expectedAmount: origin.profile.expectedAmount as number,
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
        const { expectedAmount: _dropped, ...profile } = record.profile;
        expect(() => rebuildRfqSwap({ ...record, profile }, RECEIVE_LOCKUP.params)).toThrow(
            /expectedAmount/,
        );
    });

    it("carries the receive leg's own claim txid through a restart", () => {
        // Per-kind, and so on the profile rather than the record's common half:
        // it is the counterpart of the onchain leg's `claimTxid`, and the two
        // send legs have no such txid at all. Losing it re-arms the value gate
        // against a lockup we have already partly claimed — `claimIfFunded`
        // reads `partiallyClaimed` off exactly this — so the remainder is
        // refused over a preimage that is already public, and a swap that did
        // claim is relabelled `needs_counterparty` once its window shuts.
        const record = updateRfqSwapRecord(
            createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin)),
            {
                ...swapOf(receiveOrigin, "claimed"),
                claimTxid: "ab".repeat(32),
            } as LightningReceiveSwap,
        );
        expect(record.profile.claimTxid).toBe("ab".repeat(32));

        const rebuilt = rebuildRfqSwap(record, RECEIVE_LOCKUP.params) as LightningReceiveSwap;
        expect(rebuilt.claimTxid).toBe("ab".repeat(32));
    });
});

describe("an onchain-send record carries its L1 half", () => {
    // The arkade lockup has a contract row; the HTLC does not — it is Bitcoin
    // L1, not an arkade contract — and `OnchainHtlc` hands back only derived
    // values. So this is the one set of script parameters the record stores,
    // and a restored swap without them would let its L1 refund window pass
    // unwatched.
    const HTLC_LOCKTIME = 1_850_000_000;
    // The contract the request derived — what the record's inputs must give back.
    const L1_HTLC = onchainHtlcScript(
        {
            paymentHash: PAYMENT_HASH,
            claimKey: key(15),
            refundKey: key(11),
            refundLocktime: HTLC_LOCKTIME,
        },
        "regtest",
    );

    const L1 = {
        claimKey: hex.encode(key(15)),
        refundKey: hex.encode(key(11)),
        htlcLocktime: HTLC_LOCKTIME,
        network: "regtest" as const,
        htlcAddress: L1_HTLC.address,
        minConfirmations: 2,
    };

    const onchainOrigin: RfqSwapOrigin = {
        kind: "onchain_send",
        lockupAddress: SEND_LOCKUP.address,
        profile: {
            signer: { signingDescriptor: `tr(${hex.encode(key(7))})` },
            hashlock: { paymentHash: PAYMENT_HASH },
            ...L1,
        },
        amount: 100_000,
    };

    const onchainSwap = (over: Record<string, unknown> = {}) =>
        ({
            kind: "onchain_send",
            rfqId: "rfq-1",
            state: "pending",
            lockupPkScript: SEND_LOCKUP.pkScript,
            paymentHash: PAYMENT_HASH,
            refundLocktime: REFUND_LOCKTIME,
            htlc: {},
            minConfirmations: 2,
            createdAt: 1_000,
            updatedAt: 1_000,
            ...over,
        }) as unknown as Parameters<typeof createRfqSwapRecord>[1];

    it("rebuilds the L1 htlc from the stored inputs", () => {
        const record = createRfqSwapRecord(onchainOrigin, onchainSwap());
        const rebuilt = rebuildRfqSwap(record, SEND_LOCKUP.params);

        expect(rebuilt.kind).toBe("onchain_send");
        const onchain = rebuilt as { htlc: { address: string }; minConfirmations: number };
        // the contract the request derived, not merely a well-formed one
        expect(onchain.htlc.address).toBe(L1_HTLC.address);
        expect(onchain.minConfirmations).toBe(2);
    });

    it("refuses L1 inputs that derive some other HTLC", () => {
        // The check `rebuildRfqSwap` makes for the arkade lockup, on the leg
        // that has no contract row to make it from. Swapping the two keys is
        // the case nothing else catches: every input stays well formed, the
        // rebuild succeeds, and the address it produces is one nobody funded.
        const record = createRfqSwapRecord(onchainOrigin, onchainSwap());
        const swapped = { ...record.profile, claimKey: L1.refundKey, refundKey: L1.claimKey };
        expect(() => rebuildRfqSwap({ ...record, profile: swapped }, SEND_LOCKUP.params)).toThrow(
            /not this swap's/,
        );
    });

    it("refuses an onchain record with no L1 half rather than half-driving it", () => {
        const record = createRfqSwapRecord(onchainOrigin, onchainSwap());
        // keys and hashlock kept: this is about the L1 half alone, and a profile
        // stripped of everything would fail the hashlock gate first
        const { signer, hashlock } = record.profile;
        expect(() =>
            rebuildRfqSwap({ ...record, profile: { signer, hashlock } }, SEND_LOCKUP.params),
        ).toThrow(/L1 keys/);
    });

    it("refuses an onchain record whose confirmation gate cannot be checked", () => {
        // The onchain leg's counterpart to the receive leg's `expectedAmount`:
        // `classifyOnchainHtlc` gates on `confirmations < minConfirmations`, and
        // that comparison against `undefined` is false — so a missing value does
        // not fail the gate, it deletes it, and the swap publishes `P` against
        // an unconfirmed fill.
        const record = createRfqSwapRecord(onchainOrigin, onchainSwap());
        const { minConfirmations: _dropped, ...profile } = record.profile;
        expect(() => rebuildRfqSwap({ ...record, profile }, SEND_LOCKUP.params)).toThrow(
            /minConfirmations/,
        );
    });

    it("refuses an onchain record naming a network it cannot build for", () => {
        // `btc.p2tr` reads an unknown network as mainnet, so this would restore
        // a regtest swap holding a `bc1p…` address and say nothing about it.
        const record = createRfqSwapRecord(onchainOrigin, onchainSwap());
        expect(() =>
            rebuildRfqSwap(
                { ...record, profile: { ...record.profile, network: "signet" } },
                SEND_LOCKUP.params,
            ),
        ).toThrow(/unknown L1 network/);
    });

    it("carries the fill outpoint and our claim through the mutable half", () => {
        // Without `funding` a SPENT htlc reads as never funded; without
        // `claimTxid` a restored swap would re-broadcast a claim it already made.
        const record = updateRfqSwapRecord(
            createRfqSwapRecord(onchainOrigin, onchainSwap()),
            onchainSwap({
                funding: { txid: "ab".repeat(32), vout: 1 },
                claimTxid: "cd".repeat(32),
            }),
        );
        expect(record.profile.funding).toEqual({ txid: "ab".repeat(32), vout: 1 });
        expect(record.profile.claimTxid).toBe("cd".repeat(32));

        const rebuilt = rebuildRfqSwap(record, SEND_LOCKUP.params) as {
            funding?: { txid: string };
            claimTxid?: string;
        };
        expect(rebuilt.funding?.txid).toBe("ab".repeat(32));
        expect(rebuilt.claimTxid).toBe("cd".repeat(32));
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
        // Under the corridor's own keys, not on the record: the descriptor is a
        // signer question and the preimage material a hashlock one.
        const record = createRfqSwapRecord(receiveOrigin, swapOf(receiveOrigin));
        expect(signerOf(record).signingDescriptor).toBe(signerOf(receiveOrigin).signingDescriptor);
        expect(hashlockOf(record).preimageHex).toBe("ee".repeat(32));
    });

    it("stores no covenant tree parameter — the contract row is the one copy", () => {
        // Nothing here may become a second source for the covenant. The
        // solver's key is the canary: it binds the tree and appears nowhere in
        // what the record keeps.
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(JSON.stringify(record)).not.toContain(hex.encode(key(1)));
    });
});

describe("the origin and the live swap must be one swap", () => {
    it("refuses an origin whose kind is not the swap's", () => {
        // Not cosmetic: the handler resolved from `kind` casts on it, so a
        // receive origin projected off a send swap writes
        // `expectedAmount: undefined` over the value the caller just supplied —
        // deleting the value gate at the moment it was being recorded.
        expect(() => createRfqSwapRecord(receiveOrigin, swapOf(sendOrigin))).toThrow(
            /lightning_receive origin paired with a lightning_send swap/,
        );
    });

    it("refuses an origin whose lockup is not the one the swap watches", () => {
        // The record stores no `lockupPkScript` — the rebuild derives it from
        // `lockupAddress` — so a disagreement here restores a swap watching a
        // covenant this one never had, and only these two functions ever hold
        // both halves.
        const wrongLockup = { ...sendOrigin, lockupAddress: RECEIVE_LOCKUP.address };
        expect(() => createRfqSwapRecord(wrongLockup, swapOf(sendOrigin))).toThrow(
            /not the same swap/,
        );
    });

    it("re-checks on every write, not just the first", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        expect(() => updateRfqSwapRecord(record, swapOf(receiveOrigin, "claimed"))).toThrow(
            /lightning_send origin paired with a lightning_receive swap/,
        );
    });
});

describe("updateRfqSwapRecord", () => {
    it("updates manager state without disturbing the origin", () => {
        const record = createRfqSwapRecord(sendOrigin, swapOf(sendOrigin));
        const moved = updateRfqSwapRecord(record, {
            ...swapOf(sendOrigin, "refunded"),
            updatedAt: 2_000,
            refundTxid: "ff".repeat(32),
        } as LightningSendSwap);

        expect(moved.state).toBe("refunded");
        expect(moved.refundTxid).toBe("ff".repeat(32));
        expect(moved.updatedAt).toBe(2_000);
        // the immutable half is untouched, corridor keys included
        expect(hashlockOf(moved).paymentHash).toBe(hashlockOf(sendOrigin).paymentHash);
        expect(moved.lockupAddress).toBe(sendOrigin.lockupAddress);
        expect(signerOf(moved).signingDescriptor).toBe(signerOf(sendOrigin).signingDescriptor);
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
        expect(hashlockOf(recovered).paymentHash).toBe(hashlockOf(sendOrigin).paymentHash);
        expect(recovered.lockupAddress).toBe(sendOrigin.lockupAddress);
    });

    it("carries the caller's funding txid, which no corridor projects", () => {
        const origin = { ...sendOrigin, fundingTxid: "f0".repeat(32) };
        const record = createRfqSwapRecord(origin, swapOf(origin));
        expect(record.fundingTxid).toBe("f0".repeat(32));
        expect(updateRfqSwapRecord(record, swapOf(origin, "settled")).fundingTxid).toBe(
            "f0".repeat(32),
        );
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

/**
 * The origin projection, and why it is not just `record`.
 *
 * A record IS an origin plus manager state, so passing one where an origin is
 * wanted type-checks — and quietly carries the old state's `failure`,
 * `blockedReason` and `refundTxid` into the next `createRfqSwapRecord`,
 * where `managerState` cannot clear them because it omits what the live swap
 * no longer has. That is the same trap `updateRfqSwapRecord` strips those
 * fields to avoid, and this is the other half of it.
 */
describe("rfqSwapOriginOf", () => {
    const ended: RfqSwapRecord = {
        ...createRfqSwapRecord(sendOrigin, swapOf(sendOrigin)),
        state: "failed",
        failure: "the push was refused",
        blockedReason: "no signer for this descriptor",
        refundTxid: "ff".repeat(32),
        lockupSpendTxids: ["ab".repeat(32)],
    };

    it("keeps every request-time fact", () => {
        const origin = rfqSwapOriginOf(ended);
        expect(origin.kind).toBe("lightning_send");
        expect(origin.lockupAddress).toBe(SEND_LOCKUP.address);
        expect(origin.amount).toBe(sendOrigin.amount);
        expect(signerOf(origin).signingDescriptor).toBe(signerOf(ended).signingDescriptor);
    });

    it("drops the manager's state, so a re-create cannot resurrect it", () => {
        const rebuilt = createRfqSwapRecord(rfqSwapOriginOf(ended), swapOf(sendOrigin));
        expect(rebuilt.state).toBe("pending");
        expect(rebuilt.failure).toBeUndefined();
        expect(rebuilt.blockedReason).toBeUndefined();
        expect(rebuilt.refundTxid).toBeUndefined();
        expect(rebuilt.lockupSpendTxids).toBeUndefined();
    });

    it("gives the profile its own top-level object, so a new key does not reach the record", () => {
        // A shallow copy, deliberately: `profile` is `Record<string, unknown>`
        // and a consumer owns what goes in it, so `structuredClone` would trade
        // a nested-aliasing edge case for a throw on any function or class
        // instance a consumer stored. `createRfqSwapRecord` spreads it the same
        // way; this is the module's posture, not an oversight here.
        const origin = rfqSwapOriginOf(ended);
        origin.profile.injected = true;
        expect(ended.profile.injected).toBeUndefined();
    });
});

describe("the spend that ended the swap", () => {
    it("round-trips through the record and back onto the live swap", () => {
        const spends = ["ab".repeat(32), "cd".repeat(32)];
        const swap = { ...swapOf(sendOrigin, "settled"), lockupSpendTxids: spends };
        const record = createRfqSwapRecord(sendOrigin, swap);
        expect(record.lockupSpendTxids).toEqual(spends);
        expect(rebuildRfqSwap(record, paramsOf(sendOrigin)).lockupSpendTxids).toEqual(spends);
    });

    it("is cleared by an update whose swap no longer carries it", () => {
        // Same rule as `failure` and `blockedReason`: the mutable half is
        // REPLACED, so a field the live swap dropped leaves the record.
        const record = createRfqSwapRecord(sendOrigin, {
            ...swapOf(sendOrigin, "settled"),
            lockupSpendTxids: ["ab".repeat(32)],
        });
        expect(updateRfqSwapRecord(record, swapOf(sendOrigin)).lockupSpendTxids).toBeUndefined();
    });
});
