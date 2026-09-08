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
import { rfqRecordOf, withRfqState } from "../../src/client/driveRecords";
import type { RfqSwapRecord } from "../../src/rfqRecord";
import type { CorridorSwapRecord } from "../../src/client/record";
import { PREIMAGE, corridorRecord } from "./driveFixtures";

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
        // The record is asserted JSON-safe, so an explicitly-undefined key is
        // noise that survives one serialization round trip and not the next.
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
