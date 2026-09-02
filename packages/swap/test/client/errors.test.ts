import { describe, expect, it } from "vitest";
import { AddressMismatch, SwapRefusal } from "../../src/rfq";
import {
    AcceptConflict,
    AmbiguousDestination,
    AmountEncodingUnsupported,
    AmountMismatch,
    ClientDisposed,
    DiscoverySnapshotUnavailable,
    InconsistentRoute,
    InsufficientFunds,
    MaxFeeExceeded,
    MissingCorridorDep,
    NotCancellable,
    OperatorUnreachable,
    QuoteExpired,
    QuoteVerificationFailed,
    SWAP_ERROR_NAMES,
    type SwapError,
    type SwapErrorName,
    UnsupportedRoute,
    isSwapError,
} from "../../src/client/errors";

const BTC = "arkade:regtest/slip44:0" as const;

/** One instance per member, so the coverage assertion has something to count. */
const every: readonly SwapError[] = [
    new AmbiguousDestination("0xdeadbeef", "no corridor claims it"),
    new UnsupportedRoute("onchain -> arkade", { give: "onchain", take: "arkade" }),
    new DiscoverySnapshotUnavailable("regtest", "no cached snapshot"),
    new AmountMismatch(["amount", "the invoice"]),
    new AmountEncodingUnsupported("to_amount", "9007199254740992", "past the safe-integer range"),
    new QuoteVerificationFailed("lockup_address", "tark1derived", "tark1quoted"),
    new SwapRefusal("amount_out_of_range", "rfq-1"),
    new QuoteExpired("quote-1", 1_700_000_000, 1_700_000_060),
    new MaxFeeExceeded("quote-1", BTC, 120n, 100n),
    new InsufficientFunds(BTC, 50_000n, 10_000n),
    new AcceptConflict("quote-1", "swap-1", ["take.amount", "refundLocktime"]),
    new ClientDisposed("quote"),
    new NotCancellable("swap-1"),
    new InconsistentRoute(BTC, "bc1qexample"),
    new OperatorUnreachable("the operator did not answer"),
    new MissingCorridorDep("onchain", "chain source"),
];

describe("the swap error taxonomy", () => {
    it("has exactly the sixteen members §7 declares", () => {
        expect(SWAP_ERROR_NAMES).toHaveLength(16);
        expect(new Set(SWAP_ERROR_NAMES).size).toBe(16);
    });

    it("declares one class per member, and none spare", () => {
        // What the coverage pass checks against: a member with no class is a
        // member nothing can throw.
        const built = every.map((e) => e.name);
        expect(new Set(built)).toEqual(new Set<SwapErrorName>(SWAP_ERROR_NAMES));
    });

    it("carries a message that identifies the condition without the fields", () => {
        // Own properties and a custom `name` do not survive structured clone,
        // so the message has to stand on its own across a worker boundary.
        for (const error of every) {
            expect(error.message.length, error.name).toBeGreaterThan(0);
        }
    });

    it("recognises every member, including the protocol's own class", () => {
        for (const error of every) expect(isSwapError(error), error.name).toBe(true);
        expect(isSwapError(new SwapRefusal("rate_limited"))).toBe(true);
    });

    it("narrows to one member on request", () => {
        const error: unknown = new QuoteExpired("quote-1", 1_700_000_000, 1_700_000_060);
        expect(isSwapError(error, "QuoteExpired")).toBe(true);
        expect(isSwapError(error, "AcceptConflict")).toBe(false);
        if (isSwapError(error, "QuoteExpired")) {
            expect(error.quoteId).toBe("quote-1");
        }
    });

    it("claims nothing it did not throw", () => {
        expect(isSwapError(new Error("boom"))).toBe(false);
        expect(isSwapError("boom")).toBe(false);
        // An impostor wearing a member's name is still not a member — which a
        // chain of `instanceof` against a shared base could not tell.
        const impostor = new Error("boom");
        impostor.name = "QuoteExpired";
        expect(isSwapError(impostor)).toBe(false);
    });

    it("does not admit v1's AddressMismatch as a seventeenth member", () => {
        // M3 folds it into QuoteVerificationFailed's lockup_address check, and
        // M8 gives it the /protocol re-export and the @deprecated pointer.
        expect(isSwapError(new AddressMismatch("tark1derived", "tark1quoted"))).toBe(false);
    });

    it("keeps the evidence a caller acts on", () => {
        expect(new AcceptConflict("quote-1", "swap-1", ["take.amount"]).fields).toEqual([
            "take.amount",
        ]);
        const refusal = new SwapRefusal("exposure_cap", "rfq-9");
        expect([refusal.reason, refusal.rfqId]).toEqual(["exposure_cap", "rfq-9"]);
        expect(new MissingCorridorDep("lightning", "decode").dep).toBe("decode");
        expect(new MaxFeeExceeded("quote-1", BTC, 120n, 100n).fee).toBe(120n);
        expect(new UnsupportedRoute("no market", { give: "arkade" }).take).toBe(undefined);
    });
});
