import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { RelativeTimelock, VHTLC } from "../../src";
import fixture from "../fixtures/vhtlc-v2-nine-leaf.json";

/**
 * Cross-SDK conformance vectors for {@link VHTLC.ScriptV2}'s nine-leaf tree
 * (both non-interactive leaves present, `nonInteractiveRefund.withoutReceiver`
 * on). C#, Go and Rust implementations are checked against the same fixture —
 * see `test/fixtures/vhtlc-v2-nine-leaf.json`'s own `comment` field for how to
 * regenerate it. A byte anywhere in these leaves diverging across
 * implementations means a silently different taproot address and unspendable
 * funds; that is what this file exists to catch.
 */

type FixtureTimelock = { type: string; value: string };

function timelockFromFixture(t: FixtureTimelock): RelativeTimelock {
    return { type: t.type as "blocks" | "seconds", value: BigInt(t.value) };
}

/**
 * Rebuild real {@link VHTLC.Options} (Uint8Array keys, bigint timelocks) from
 * the fixture's JSON-safe encoding (hex strings, decimal strings).
 *
 * `sender`/`receiver`/`server` are stored as 33-byte compressed pubkeys, the
 * same convention `test/fixtures/vhtlc.json` uses — {@link VHTLC.Options}
 * itself wants only the 32-byte x-only tail.
 */
function optionsFromFixture(o: typeof fixture.options): VHTLC.Options {
    return {
        sender: hex.decode(o.sender).slice(1),
        receiver: hex.decode(o.receiver).slice(1),
        server: hex.decode(o.server).slice(1),
        preimageHash: hex.decode(o.preimageHash),
        refundLocktime: BigInt(o.refundLocktime),
        unilateralClaimDelay: timelockFromFixture(o.unilateralClaimDelay),
        unilateralRefundDelay: timelockFromFixture(o.unilateralRefundDelay),
        unilateralRefundWithoutReceiverDelay: timelockFromFixture(
            o.unilateralRefundWithoutReceiverDelay,
        ),
        nonInteractiveClaim: {
            receiverPkScript: hex.decode(o.nonInteractiveClaim.receiverPkScript),
            emulatorPubkey: hex.decode(o.nonInteractiveClaim.emulatorPubkey),
        },
        nonInteractiveRefund: {
            senderPkScript: hex.decode(o.nonInteractiveRefund.senderPkScript),
            emulatorPubkey: hex.decode(o.nonInteractiveRefund.emulatorPubkey),
            withoutReceiver: o.nonInteractiveRefund.withoutReceiver,
        },
    };
}

describe("VHTLC.ScriptV2 cross-SDK vectors", () => {
    it("matches the committed cross-SDK vectors", () => {
        const script = new VHTLC.ScriptV2(optionsFromFixture(fixture.options));

        expect(hex.encode(script.pkScript)).toBe(fixture.pkScript);
        expect(script.claimScript).toBe(fixture.leaves.claim);
        expect(script.refundScript).toBe(fixture.leaves.refund);
        expect(script.refundWithoutReceiverScript).toBe(fixture.leaves.refundWithoutReceiver);
        expect(script.unilateralClaimScript).toBe(fixture.leaves.unilateralClaim);
        expect(script.unilateralRefundScript).toBe(fixture.leaves.unilateralRefund);
        expect(script.unilateralRefundWithoutReceiverScript).toBe(
            fixture.leaves.unilateralRefundWithoutReceiver,
        );
        expect(script.nonInteractiveClaimScript).toBe(fixture.leaves.nonInteractiveClaim);
        expect(script.nonInteractiveRefundScript).toBe(fixture.leaves.nonInteractiveRefund);
        expect(script.nonInteractiveRefundWithoutReceiverScript).toBe(
            fixture.leaves.nonInteractiveRefundWithoutReceiver,
        );
        // Both covenant ArkadeScripts the fixture carries — not just the
        // refund one — since a divergence in either compiles into a
        // different emulator co-signer key and so a different leaf.
        expect(hex.encode(script.nonInteractiveClaimArkadeScript!)).toBe(
            fixture.arkadeScripts.nonInteractiveClaim,
        );
        expect(hex.encode(script.nonInteractiveRefundArkadeScript!)).toBe(
            fixture.arkadeScripts.nonInteractiveRefund,
        );
    });

    it("has nine leaves, in the order the merkle root depends on", () => {
        const script = new VHTLC.ScriptV2(optionsFromFixture(fixture.options));
        // `scripts` is the per-leaf array (VtxoScript's constructor property).
        // `encode()` is NOT — it returns ONE serialized TapTree blob, which is
        // what the Go side's DecodeTapTree consumes and what `tapTree` below pins.
        expect(script.scripts.map((s) => hex.encode(s))).toEqual([
            fixture.leaves.claim,
            fixture.leaves.refund,
            fixture.leaves.refundWithoutReceiver,
            fixture.leaves.unilateralClaim,
            fixture.leaves.unilateralRefund,
            fixture.leaves.unilateralRefundWithoutReceiver,
            fixture.leaves.nonInteractiveClaim,
            fixture.leaves.nonInteractiveRefund,
            fixture.leaves.nonInteractiveRefundWithoutReceiver,
        ]);
    });

    it("pins the serialized taptree the Go decoder consumes", () => {
        const script = new VHTLC.ScriptV2(optionsFromFixture(fixture.options));
        expect(hex.encode(script.encode())).toBe(fixture.tapTree);
    });
});
