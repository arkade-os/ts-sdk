import { describe, it, expect, vi } from "vitest";
import type { ContractEvent } from "@arkade-os/sdk";
import {
    deriveSwapState,
    SwapActionLog,
    SwapState,
    SwapStatusReconciler,
} from "../src/swap-status-reconciler";
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

/** Minimal, well-typed `ContractEvent` fixture — only `type`/`contractScript` matter to the reconciler. */
const makeVtxoEvent = (
    type: "vtxo_received" | "vtxo_spent",
    contractScript: string,
): ContractEvent => ({
    type,
    contractScript,
    vtxos: [],
    contract: {
        type: "vhtlc",
        params: {},
        script: contractScript,
        address: "ark1test",
        state: "active",
        createdAt: 0,
    },
    timestamp: Date.now(),
});

const CONNECTION_RESET_EVENT: ContractEvent = { type: "connection_reset", timestamp: Date.now() };

describe("SwapStatusReconciler", () => {
    const arkInfo = makeArkInfoFixture();
    const EMPTY_LOG: SwapActionLog = { claimed: new Set(), refunded: new Set() };
    const claimedLog = (id: string): SwapActionLog => ({
        claimed: new Set([id]),
        refunded: new Set(),
    });

    /** Builds a reconciler wired to a single swap, with mockable deps. */
    function makeReconciler(swap: BoltzSwap, actionLog: SwapActionLog = EMPTY_LOG) {
        const getSwap = vi.fn((id: string) => (id === swap.id ? swap : undefined));
        const getActionLog = vi.fn(() => actionLog);
        const onSwapResolved = vi.fn();
        const reconciler = new SwapStatusReconciler({ getSwap, getActionLog, onSwapResolved });
        return { reconciler, getSwap, getActionLog, onSwapResolved };
    }

    it("addSwapScript + vtxo_spent for a swap we claimed -> onSwapResolved(swap, Settled)", () => {
        const swap: BoltzSwap = {
            ...makeReverseSwapFixture(arkInfo),
            status: "transaction.confirmed",
        };
        const { reconciler, onSwapResolved } = makeReconciler(swap, claimedLog(swap.id));

        reconciler.addSwapScript("script-claimed", swap.id);
        reconciler.onContractEvent(makeVtxoEvent("vtxo_spent", "script-claimed"));

        expect(onSwapResolved).toHaveBeenCalledTimes(1);
        expect(onSwapResolved).toHaveBeenCalledWith(swap, "Settled" satisfies SwapState);
    });

    it("submarine vtxo_spent we did NOT refund -> onSwapResolved(swap, Settled) (Boltz claimed after paying invoice)", () => {
        const swap: BoltzSwap = { ...makeSubmarineSwapFixture(arkInfo), status: "invoice.pending" };
        const { reconciler, onSwapResolved } = makeReconciler(swap, EMPTY_LOG);

        reconciler.addSwapScript("script-submarine", swap.id);
        reconciler.onContractEvent(makeVtxoEvent("vtxo_spent", "script-submarine"));

        expect(onSwapResolved).toHaveBeenCalledWith(swap, "Settled" satisfies SwapState);
    });

    it("unknown contractScript -> no-op, does not throw, does not resolve", () => {
        const swap = makeReverseSwapFixture(arkInfo);
        const { reconciler, onSwapResolved, getSwap } = makeReconciler(swap);

        expect(() =>
            reconciler.onContractEvent(makeVtxoEvent("vtxo_spent", "never-registered")),
        ).not.toThrow();
        expect(getSwap).not.toHaveBeenCalled();
        expect(onSwapResolved).not.toHaveBeenCalled();
    });

    it("swallows and logs an internal error instead of throwing", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const swap = makeReverseSwapFixture(arkInfo);
        const onSwapResolved = vi.fn();
        const reconciler = new SwapStatusReconciler({
            getSwap: () => {
                throw new Error("boom");
            },
            getActionLog: () => EMPTY_LOG,
            onSwapResolved,
        });
        reconciler.addSwapScript("script-throws", swap.id);

        expect(() =>
            reconciler.onContractEvent(makeVtxoEvent("vtxo_spent", "script-throws")),
        ).not.toThrow();
        expect(onSwapResolved).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);

        errorSpy.mockRestore();
    });

    it("vtxo_received (funded) with no terminal Boltz status -> Pending, onSwapResolved not called", () => {
        const swap: BoltzSwap = {
            ...makeReverseSwapFixture(arkInfo),
            status: "transaction.mempool",
        };
        const { reconciler, onSwapResolved } = makeReconciler(swap);

        reconciler.addSwapScript("script-funded", swap.id);
        reconciler.onContractEvent(makeVtxoEvent("vtxo_received", "script-funded"));

        expect(onSwapResolved).not.toHaveBeenCalled();
    });

    it("ignores connection_reset events", () => {
        const swap = makeReverseSwapFixture(arkInfo);
        const { reconciler, onSwapResolved, getSwap } = makeReconciler(swap);
        reconciler.addSwapScript("script-reset", swap.id);

        expect(() => reconciler.onContractEvent(CONNECTION_RESET_EVENT)).not.toThrow();
        expect(getSwap).not.toHaveBeenCalled();
        expect(onSwapResolved).not.toHaveBeenCalled();
    });

    it("removeSwapScript stops resolving further events for that script", () => {
        const swap: BoltzSwap = {
            ...makeReverseSwapFixture(arkInfo),
            status: "transaction.confirmed",
        };
        const { reconciler, onSwapResolved } = makeReconciler(swap, claimedLog(swap.id));
        reconciler.addSwapScript("script-removed", swap.id);
        reconciler.removeSwapScript("script-removed");

        reconciler.onContractEvent(makeVtxoEvent("vtxo_spent", "script-removed"));

        expect(onSwapResolved).not.toHaveBeenCalled();
    });
});
