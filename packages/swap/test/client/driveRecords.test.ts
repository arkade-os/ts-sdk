/**
 * The two-way record bridge: the v2 record projected down to the manager's, and
 * the manager's mutable half written back onto it.
 *
 * Both directions are total — a field missing from either projection is not a
 * gap, it is a loss. `withRfqState` REPLACES the mutable half rather than
 * merging it, so a field the manager no longer carries has to leave the record;
 * and a field `rfqRecordOf` fails to hand down comes back absent from the
 * manager's next save and is erased from disk on the write-back. The tests here
 * pin both halves of that rule against the receipt fields, whose whole value is
 * that they survive a restart.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import {
    fateMoved,
    restoredOfferRecord,
    rfqRecordOf,
    withDepositFate,
    withRfqState,
} from "../../src/client/driveRecords";
import type { RfqSwapRecord } from "../../src/rfqRecord";
import type { CorridorSwapRecord, OfferSwapRecord } from "../../src/client/record";
import type { AssetSwap } from "../../src/store";
import { OFFER_SCRIPT, PREIMAGE, corridorRecord, offerRecord } from "./driveFixtures";

/** What the solver revealed in the witness that claimed the send lockup. */
const RECEIPT = hex.encode(PREIMAGE);
const SPEND = "ab".repeat(32);

/** The manager's record for a settled send, as the bridge itself produces it. */
const settledState = (record: CorridorSwapRecord, over: Partial<RfqSwapRecord> = {}) => ({
    ...rfqRecordOf(record),
    state: "settled" as const,
    updatedAt: 2_000,
    ...over,
});

describe("the settlement receipt across the bridge", () => {
    it("reaches the manager's record and survives the write-back", () => {
        const record = corridorRecord({ settlementPreimageHex: RECEIPT, state: "settled" });
        const state = rfqRecordOf(record);
        expect(state.settlementPreimageHex).toBe(RECEIPT);
        expect(withRfqState(record, state).settlementPreimageHex).toBe(RECEIPT);
    });

    it("is absent, not undefined, on a swap that never settled", () => {
        const record = corridorRecord();
        const state = rfqRecordOf(record);
        expect("settlementPreimageHex" in state).toBe(false);
        expect("settlementPreimageHex" in withRfqState(record, state)).toBe(false);
    });
});

describe("withRfqState replaces the mutable half", () => {
    it("clears state the live swap no longer carries", () => {
        // The trap: leave either field in `origin` instead of stripping it and
        // the stale value outlives the swap that earned it.
        const stored = corridorRecord({
            state: "settled",
            settlementPreimageHex: RECEIPT,
            lockupSpendTxids: [SPEND],
            refundTxid: "cd".repeat(32),
            blockedReason: "no signer for this descriptor",
        });
        const written = withRfqState(stored, {
            ...rfqRecordOf(stored),
            settlementPreimageHex: undefined,
            lockupSpendTxids: undefined,
            refundTxid: undefined,
            blockedReason: undefined,
        });
        expect("settlementPreimageHex" in written).toBe(false);
        expect("lockupSpendTxids" in written).toBe(false);
        expect("refundTxid" in written).toBe(false);
        expect("blockedReason" in written).toBe(false);
    });

    it("takes the receipt from the state, not from the record it overwrites", () => {
        const stored = corridorRecord({ settlementPreimageHex: "00".repeat(32) });
        const written = withRfqState(
            stored,
            settledState(stored, {
                settlementPreimageHex: RECEIPT,
            }),
        );
        expect(written.settlementPreimageHex).toBe(RECEIPT);
    });

    it("leaves the accept path's half untouched", () => {
        // Without this the clearing above reads as arbitrary: `origin` is what
        // the request produced, and the manager learns none of it — `fundingTxid`
        // included, which is why a state that omits it does not clear it.
        const stored = corridorRecord({ fundingTxid: "ef".repeat(32) });
        const written = withRfqState(stored, settledState(stored, { fundingTxid: undefined }));
        expect(written.fundingTxid).toBe(stored.fundingTxid);
        expect(written.kind).toBe(stored.kind);
        expect(written.lockupAddress).toBe(stored.lockupAddress);
        expect(written.lockupPkScript).toBe(stored.lockupPkScript);
        expect(written.route).toEqual(stored.route);
        expect(written.market).toEqual(stored.market);
        expect(written.lock).toEqual(stored.lock);
        expect(written.refundLocktime).toBe(stored.refundLocktime);
        expect(written.createdAt).toBe(stored.createdAt);
        // And the mutable half is the state's, not the record's.
        expect(written.state).toBe("settled");
        expect(written.updatedAt).toBe(2_000);
    });
});

describe("a record rebuilt from the chain", () => {
    const FUNDING = "aa".repeat(32);
    const ASSET = "f1".repeat(34);
    /** What `restoreAssetSwaps` hands the drive for one deposit. */
    const found = (over: Partial<AssetSwap> = {}): AssetSwap => ({
        id: FUNDING,
        fromAsset: "btc",
        toAsset: ASSET,
        fromAmount: "100000",
        toAmount: "5000",
        swapAddress: "tark1qrestored",
        swapPkScript: OFFER_SCRIPT,
        offerHex: "00",
        fundingTxid: FUNDING,
        spentTxid: undefined,
        status: "pending",
        createdAt: 1_700_000_000_000,
        ...over,
    });

    it("keys on the funding txid and spells both legs as arkade ids", () => {
        const record = restoredOfferRecord(found(), "regtest", 3_000);
        expect(record).toMatchObject({
            id: FUNDING,
            family: "offer",
            status: "pending",
            fundingTxid: FUNDING,
            route: {
                give: { corridor: "arkade", asset: "arkade:regtest/slip44:0" },
                take: { corridor: "arkade", asset: `arkade:regtest/asset:${ASSET}` },
            },
            give: { asset: "arkade:regtest/slip44:0", amount: "100000" },
            take: { asset: `arkade:regtest/asset:${ASSET}`, amount: "5000" },
            swapAddress: "tark1qrestored",
            swapPkScript: OFFER_SCRIPT,
            offerHex: "00",
            updatedAt: 3_000,
        });
        const inverse = restoredOfferRecord(
            found({ fromAsset: ASSET, toAsset: "btc" }),
            "regtest",
            0,
        );
        expect(inverse.give.asset).toBe(`arkade:regtest/asset:${ASSET}`);
        expect(inverse.take.asset).toBe("arkade:regtest/slip44:0");
    });

    it("names no market it never saw", () => {
        const record = restoredOfferRecord(found(), "regtest", 0);
        expect(record.market).toEqual({ kind: "restored", backend: "feed" });
        expect(record.fee).toEqual({ asset: `arkade:regtest/asset:${ASSET}`, amount: "0" });
        expect(record.solver).toBeUndefined();
    });

    it("carries seconds where AssetSwap carries milliseconds", () => {
        const record = restoredOfferRecord(
            found({
                status: "fulfilled",
                spentTxid: "bb".repeat(32),
                completedAt: 1_700_000_100_000,
            }),
            "regtest",
            0,
        );
        expect(record.createdAt).toBe(1_700_000_000);
        expect(record.expiresAt).toBe(1_700_000_000);
        expect(record.completedAt).toBe(1_700_000_100);
        expect(record.spentTxid).toBe("bb".repeat(32));
    });

    it("writes an unspent deposit's spend absent, not undefined", () => {
        const record = restoredOfferRecord(found(), "regtest", 0);
        expect("spentTxid" in record).toBe(false);
        expect("completedAt" in record).toBe(false);
    });
});

describe("a deposit's fate on a record", () => {
    const record = (over: Partial<OfferSwapRecord> = {}) =>
        offerRecord({ fundingTxid: "aa".repeat(32), ...over });

    it("is quiet for a deposit that has not moved", () => {
        expect(fateMoved(record(), { status: "pending" })).toBe(false);
        expect(
            fateMoved(
                record({ status: "fulfilled", spentTxid: "bb".repeat(32), completedAt: 1_700 }),
                {
                    status: "fulfilled",
                    spentTxid: "bb".repeat(32),
                    completedAt: 1_700_000,
                },
            ),
        ).toBe(false);
    });

    it("moves on a spend the status alone would hide", () => {
        const fate = {
            status: "fulfilled" as const,
            spentTxid: "bb".repeat(32),
            completedAt: 1_700_000,
        };
        expect(fateMoved(record({ status: "fulfilled" }), fate)).toBe(true);
        const written = withDepositFate(record({ status: "fulfilled" }), fate, 9_000);
        expect(written).toMatchObject({
            status: "fulfilled",
            spentTxid: "bb".repeat(32),
            completedAt: 1_700,
            updatedAt: 9_000,
        });
    });

    it("leaves a spend the fate does not name alone", () => {
        const stamped = record({ spentTxid: "bb".repeat(32) });
        const written = withDepositFate(stamped, { status: "recoverable" }, 9_000);
        expect(written.spentTxid).toBe("bb".repeat(32));
        expect(written.status).toBe("recoverable");
    });

    it("writes the chain's pending over a stored cancelling", () => {
        // cancelling is the live cancel() gate, not a chain fact. A crash
        // between the gate and the broadcast leaves an unspent deposit, which
        // is pending; cancel() retries from there. Arkade txs land in <500ms,
        // so the in-between is not a durable status (arkade-os/ts-sdk#930).
        const stored = record({ status: "cancelling" });
        expect(fateMoved(stored, { status: "pending" })).toBe(true);
        expect(withDepositFate(stored, { status: "pending" }, 9_000).status).toBe("pending");
    });
});
