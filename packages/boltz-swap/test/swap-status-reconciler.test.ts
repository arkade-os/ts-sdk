import { describe, it, expect } from "vitest";
import { deriveSwapState, SwapActionLog } from "../src/swap-status-reconciler";
import { BoltzSwap } from "../src/types";
import {
    makeArkInfoFixture,
    makeReverseSwapFixture,
    makeSubmarineSwapFixture,
    makeChainSwapFixture,
    makeChainSwapFromArkFixture,
} from "./fixtures/swaps";

const EMPTY_LOG: SwapActionLog = { claimed: new Set(), refunded: new Set() };
const claimedLog = (id: string): SwapActionLog => ({ claimed: new Set([id]), refunded: new Set() });
const refundedLog = (id: string): SwapActionLog => ({
    claimed: new Set(),
    refunded: new Set([id]),
});

describe("deriveSwapState", () => {
    const arkInfo = makeArkInfoFixture();

    describe("reverse swap (wallet is VHTLC receiver — only the wallet can claim)", () => {
        const swap = makeReverseSwapFixture(arkInfo);

        it.each([
            ["invoice.settled", "Settled"],
            ["transaction.refunded", "Refunded"],
            ["invoice.expired", "Failed"],
            ["transaction.failed", "Failed"],
            ["swap.expired", "Failed"],
        ] as const)(
            "terminal status %s -> %s (failsafe, regardless of signal/log)",
            (status, expected) => {
                const terminalSwap: BoltzSwap = { ...swap, status };
                // A contradicting signal/log must not override a terminal Boltz status.
                expect(deriveSwapState(terminalSwap, "none", EMPTY_LOG)).toBe(expected);
                expect(deriveSwapState(terminalSwap, "spent", claimedLog("other-id"))).toBe(
                    expected,
                );
            },
        );

        it("spent + we claimed -> Settled", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.confirmed" };
            expect(deriveSwapState(pending, "spent", claimedLog(swap.id))).toBe("Settled");
        });

        it("spent + we refunded -> Refunded", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.confirmed" };
            expect(deriveSwapState(pending, "spent", refundedLog(swap.id))).toBe("Refunded");
        });

        it("spent + neither -> Failed (only we can claim; spent-without-us = Boltz refunded its lockup)", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.confirmed" };
            expect(deriveSwapState(pending, "spent", EMPTY_LOG)).toBe("Failed");
        });

        it("funded, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.mempool" };
            expect(deriveSwapState(pending, "funded", EMPTY_LOG)).toBe("Pending");
        });

        it("none, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "none", EMPTY_LOG)).toBe("Pending");
        });
    });

    describe("submarine swap (wallet is VHTLC sender — only the wallet can refund)", () => {
        const swap = makeSubmarineSwapFixture(arkInfo);

        it.each([
            ["transaction.claimed", "Settled"],
            ["invoice.failedToPay", "Failed"],
            ["swap.expired", "Failed"],
        ] as const)(
            "terminal status %s -> %s (failsafe, regardless of signal/log)",
            (status, expected) => {
                const terminalSwap: BoltzSwap = { ...swap, status };
                expect(deriveSwapState(terminalSwap, "none", EMPTY_LOG)).toBe(expected);
                expect(deriveSwapState(terminalSwap, "spent", claimedLog("other-id"))).toBe(
                    expected,
                );
            },
        );

        it("transaction.lockupFailed is NOT terminal (negotiable) -> falls through to operational Pending", () => {
            const negotiable: BoltzSwap = { ...swap, status: "transaction.lockupFailed" };
            expect(deriveSwapState(negotiable, "none", EMPTY_LOG)).toBe("Pending");
        });

        it("spent + we claimed -> Settled", () => {
            const pending: BoltzSwap = { ...swap, status: "invoice.pending" };
            expect(deriveSwapState(pending, "spent", claimedLog(swap.id))).toBe("Settled");
        });

        it("spent + we refunded -> Refunded", () => {
            const pending: BoltzSwap = { ...swap, status: "invoice.pending" };
            expect(deriveSwapState(pending, "spent", refundedLog(swap.id))).toBe("Refunded");
        });

        it("spent + neither -> Settled (Boltz claimed our lockup after paying the invoice)", () => {
            const pending: BoltzSwap = { ...swap, status: "invoice.pending" };
            expect(deriveSwapState(pending, "spent", EMPTY_LOG)).toBe("Settled");
        });

        it("funded, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.mempool" };
            expect(deriveSwapState(pending, "funded", EMPTY_LOG)).toBe("Pending");
        });

        it("none, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "none", EMPTY_LOG)).toBe("Pending");
        });
    });

    describe("chain swap BTC->ARK (wallet is VHTLC receiver on the ARK lockup — same role shape as reverse)", () => {
        const swap = makeChainSwapFixture(arkInfo); // request: {from: "BTC", to: "ARK"}

        it.each([
            ["transaction.claimed", "Settled"],
            ["transaction.refunded", "Refunded"],
            ["transaction.failed", "Failed"],
            ["swap.expired", "Failed"],
        ] as const)(
            "terminal status %s -> %s (failsafe, regardless of signal/log)",
            (status, expected) => {
                const terminalSwap: BoltzSwap = { ...swap, status };
                expect(deriveSwapState(terminalSwap, "none", EMPTY_LOG)).toBe(expected);
                expect(deriveSwapState(terminalSwap, "spent", claimedLog("other-id"))).toBe(
                    expected,
                );
            },
        );

        it("spent + we claimed -> Settled", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.server.mempool" };
            expect(deriveSwapState(pending, "spent", claimedLog(swap.id))).toBe("Settled");
        });

        it("spent + we refunded -> Refunded", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.server.mempool" };
            expect(deriveSwapState(pending, "spent", refundedLog(swap.id))).toBe("Refunded");
        });

        it("spent + neither -> Failed (wallet is receiver; spent-without-us = Boltz refunded its lockup)", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.server.mempool" };
            expect(deriveSwapState(pending, "spent", EMPTY_LOG)).toBe("Failed");
        });

        it("funded, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.mempool" };
            expect(deriveSwapState(pending, "funded", EMPTY_LOG)).toBe("Pending");
        });

        it("none, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "none", EMPTY_LOG)).toBe("Pending");
        });
    });

    describe("chain swap ARK->BTC (wallet is VHTLC sender on the ARK lockup — same role shape as submarine)", () => {
        const swap = makeChainSwapFromArkFixture(arkInfo); // request: {from: "ARK", to: "BTC"}

        it.each([
            ["transaction.claimed", "Settled"],
            ["transaction.refunded", "Refunded"],
            ["transaction.failed", "Failed"],
            ["swap.expired", "Failed"],
        ] as const)(
            "terminal status %s -> %s (failsafe, regardless of signal/log)",
            (status, expected) => {
                const terminalSwap: BoltzSwap = { ...swap, status };
                expect(deriveSwapState(terminalSwap, "none", EMPTY_LOG)).toBe(expected);
                expect(deriveSwapState(terminalSwap, "spent", claimedLog("other-id"))).toBe(
                    expected,
                );
            },
        );

        it("spent + we claimed -> Settled", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "spent", claimedLog(swap.id))).toBe("Settled");
        });

        it("spent + we refunded -> Refunded", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "spent", refundedLog(swap.id))).toBe("Refunded");
        });

        it("spent + neither -> Settled (wallet is sender; spent-without-us = Boltz claimed our lockup)", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "spent", EMPTY_LOG)).toBe("Settled");
        });

        it("funded, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "transaction.mempool" };
            expect(deriveSwapState(pending, "funded", EMPTY_LOG)).toBe("Pending");
        });

        it("none, no terminal status -> Pending", () => {
            const pending: BoltzSwap = { ...swap, status: "swap.created" };
            expect(deriveSwapState(pending, "none", EMPTY_LOG)).toBe("Pending");
        });

        it("spent + neither, malformed non-ARK/non-ARK direction -> Pending (genuinely ambiguous fallback)", () => {
            const malformed: BoltzSwap = {
                ...swap,
                status: "swap.created",
                request: { ...swap.request, from: "BTC", to: "BTC" },
            };
            expect(deriveSwapState(malformed, "spent", EMPTY_LOG)).toBe("Pending");
        });
    });
});
