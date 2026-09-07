/**
 * The ladder's safety property, which had no test on this side until now.
 *
 * The three unilateral leaves are not interchangeable rungs. What each one
 * times is a different party's recourse:
 *
 *   unilateralClaim                  receiver alone, holding the preimage
 *   unilateralRefund                 sender AND receiver — needs both
 *   unilateralRefundWithoutReceiver  sender alone, needing nobody
 *
 * Only the last is a solo path for the funder, so it is the only one whose
 * timing can steal: a funder able to refund before the claimant can claim
 * takes money from someone holding the preimage who did nothing wrong. The
 * both-signature leaf cannot be spent unilaterally by either party, so it
 * needs no separation at all.
 *
 * These values are not carried on the wire — the trader and the solver each
 * derive them from the same operator `/v1/info`. That makes the derivation
 * itself the wire format: this file is the contract with the reference
 * solver's `deriveUnilateralDelays`, and drift here changes every lockup
 * address.
 */
import { describe, expect, it } from "vitest";

import {
    SOLO_REFUND_HEADROOM_SECONDS,
    unilateralClaimDelay,
    unilateralRefundDelay,
    unilateralRefundWithoutReceiverDelay,
} from "../src/rfq";

const SEQUENCE_GRANULARITY_SECONDS = 512;

describe("the unilateral ladder — what stops a funder preempting a claimant", () => {
    /** One tick, a mutinynet-scale delay, an hour, a day, a week. */
    const LADDERS = [512, 1536, 3600, 24 * 3600, 7 * 24 * 3600];

    it("opens the solo refund strictly after the claim, at every scale", () => {
        for (const exitDelay of LADDERS) {
            const claim = unilateralClaimDelay(exitDelay);
            expect(unilateralRefundWithoutReceiverDelay(claim)).toBeGreaterThan(claim);
        }
    });

    it("gives the claimant real headroom, not a single granularity tick", () => {
        // The gap has to cover an actual unilateral exit — an unroll broadcast
        // per chain step, each waiting on a confirmation, then the CSV spend —
        // not merely be non-zero.
        for (const exitDelay of LADDERS) {
            const claim = unilateralClaimDelay(exitDelay);
            expect(unilateralRefundWithoutReceiverDelay(claim) - claim).toBeGreaterThanOrEqual(
                SOLO_REFUND_HEADROOM_SECONDS,
            );
        }
    });

    it("puts claim and the both-signature refund on par", () => {
        // Nobody can spend the both-signature leaf alone, so separating it buys
        // no safety and only shortens the headroom that does.
        for (const exitDelay of LADDERS) {
            const claim = unilateralClaimDelay(exitDelay);
            expect(unilateralRefundDelay(claim)).toBe(claim);
        }
    });

    it("keeps every delay on a BIP68 512-second boundary", () => {
        // Anything else is silently rounded by the encoding, so a value that
        // looks right in config becomes a different timelock in the script.
        for (const exitDelay of LADDERS) {
            const claim = unilateralClaimDelay(exitDelay);
            for (const value of [
                claim,
                unilateralRefundDelay(claim),
                unilateralRefundWithoutReceiverDelay(claim),
            ]) {
                expect(value % SEQUENCE_GRANULARITY_SECONDS).toBe(0);
            }
        }
    });

    it("never opens any leaf before the operator's own exit delay", () => {
        // The server refuses a script whose exit delay is below its configured
        // minimum, and it does so at SPEND time — with money already in the
        // script.
        for (const exitDelay of LADDERS) {
            const claim = unilateralClaimDelay(exitDelay);
            for (const value of [
                claim,
                unilateralRefundDelay(claim),
                unilateralRefundWithoutReceiverDelay(claim),
            ]) {
                expect(value).toBeGreaterThanOrEqual(exitDelay);
            }
        }
    });

    it("pins the headroom constant against an accidental edit on this side", () => {
        // Deliberately NOT a cross-implementation check, despite what an
        // earlier title here claimed: `SOLO_REFUND_HEADROOM_SECONDS` is
        // *defined* as `8 * SEQUENCE_GRANULARITY_SECONDS`, so asserting that
        // restates its own definition. Re-declaring 512 locally is what gives
        // it any value at all — it catches someone editing the constant, and
        // nothing more.
        //
        // Agreement with the solver is not testable from inside this package;
        // nothing here can see `src/core/timelocks.ts`. What stands in for it
        // is the provenance of the golden bytes in `rfq.test.ts` /
        // `rfqReceive.test.ts` — see the note there. If the two ever need to be
        // checked mechanically, it takes a fixture shared across the repos.
        expect(SOLO_REFUND_HEADROOM_SECONDS).toBe(8 * SEQUENCE_GRANULARITY_SECONDS);
    });
});
