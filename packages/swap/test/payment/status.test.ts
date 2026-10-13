/**
 * The fourteen-to-four projection, and the two things it must not lose.
 *
 * Totality is asserted against the outcome vocabulary itself rather than
 * against a list retyped here — a member added upstream has to fail something,
 * and a second hand-written list is a second thing to forget.
 */
import { describe, expect, it } from "vitest";
import { ACTIVITY_TOKEN, type Outcome } from "../../src/client/outcome";
import { PAYMENT_STATUS, isTerminalStatus, paymentStatusOf } from "../../src/payment/status";
import { SwapPaymentFailedError } from "../../src/payment/swapRail";
import type { Swap } from "../../src/client/record";

/** Every `Outcome`, read off the one other total map over the same union. */
const OUTCOMES = Object.keys(ACTIVITY_TOKEN) as Outcome[];

const swap = (over: Partial<Swap> = {}): Swap => ({ id: "rfq:q1", family: "rfq", ...over }) as Swap;

describe("Outcome -> PaymentStatus", () => {
    it("maps all fourteen members, and no more", () => {
        expect(OUTCOMES).toHaveLength(14);
        expect(Object.keys(PAYMENT_STATUS).sort()).toEqual([...OUTCOMES].sort());
        for (const outcome of OUTCOMES) {
            expect(paymentStatusOf(outcome), outcome).toMatch(/^(pending|sent|settled|failed)$/);
        }
    });

    it("puts the funded lockup on the status nothing in core has emitted since #811", () => {
        expect(paymentStatusOf("funded")).toBe("sent");
        expect(OUTCOMES.filter((o) => PAYMENT_STATUS[o] === "sent")).toEqual(["funded"]);
    });

    it("settles only on a completed leg", () => {
        expect(OUTCOMES.filter((o) => PAYMENT_STATUS[o] === "settled").sort()).toEqual([
            "claimed",
            "filled",
            "paid",
        ]);
    });

    it("goes terminal at refunding, not at refunded", () => {
        // Holding terminality back until the refund resolves would hang every
        // `settled({ timeoutMs })` caller for a whole refund window — and the
        // handle could not hear the `refunded` anyway, since a terminal update
        // clears core's subscriber set.
        expect(isTerminalStatus(paymentStatusOf("refunding"))).toBe(true);
        expect(paymentStatusOf("refunding")).toBe("failed");
    });

    it("never silently retries a swap that needs recovery", () => {
        expect(paymentStatusOf("needs_recovery")).toBe("failed");
    });

    it("keeps refunded and lapsed distinguishable on the error, having merged them", () => {
        // P6's whole point: value returned, versus an incoming payment that
        // never arrived. The projection loses it; the `error` carries it.
        expect(paymentStatusOf("refunded")).toBe("failed");
        expect(paymentStatusOf("lapsed")).toBe("failed");

        const refunded = new SwapPaymentFailedError("onchain-swap", "refunded", swap());
        const lapsed = new SwapPaymentFailedError("onchain-swap", "lapsed", swap());
        expect(refunded.outcome).not.toBe(lapsed.outcome);
        expect(refunded.message).toContain("refunded");
        expect(lapsed.message).toContain("lapsed");
    });

    it("carries the record's own reason onto the failure, when there is one", () => {
        const blocked = new SwapPaymentFailedError(
            "lightning",
            "needs_recovery",
            swap({ blockedReason: "no claim callback" }),
        );
        expect(blocked.message).toContain("no claim callback");
        expect(blocked.name.endsWith("Error")).toBe(true);
    });
});
