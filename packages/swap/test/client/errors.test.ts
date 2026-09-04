import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AddressMismatch, SwapRefusal } from "../../src/rfq";
import { SwapDriveRefusedError } from "../../src/client/drive";
import { NoSpendableDepositError, OfferCovenantMismatchError } from "../../src/offer";
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

/**
 * The track's error-coverage registry (M6/F), as a compile-time exhaustive map.
 *
 * The `satisfies` is what keeps it honest: a member missing here fails the
 * `Record`, an extra key fails the excess-property check. Non-members are
 * outside the map by construction — they are not in `SwapErrorName`.
 *
 * `thrownAt` is where the condition fires. `null` means **declared inert**: the
 * member exists so the taxonomy is complete and its only thrower ships with a
 * corridor that does not exist yet. `pending` names a milestone whose throwing
 * site has not landed — an assertion below fails when it does, which is how the
 * map is forced to keep up rather than rot.
 */
const COVERAGE = {
    AmbiguousDestination: {
        owner: "M2",
        thrownAt: "destination parse, once, in resolve()/quote()",
    },
    UnsupportedRoute: {
        owner: "M3",
        thrownAt: "route resolution, quote-time empty market set, the alias layer",
    },
    DiscoverySnapshotUnavailable: {
        owner: "M3",
        thrownAt: "resolve()/quote() with no snapshot after any allowed fetch",
    },
    AmountMismatch: { owner: "M3", thrownAt: "amount pinning, before any round trip" },
    AmountEncodingUnsupported: { owner: "M3", thrownAt: "the RFQ amount adapter" },
    QuoteVerificationFailed: { owner: "M3", thrownAt: "quote verification, all five checks" },
    SwapRefusal: { owner: "M3", thrownAt: "transport, on a solver decline" },
    QuoteExpired: { owner: "M3/M4", thrownAt: "quote() TTL floor and accept() past expiresAt" },
    InsufficientFunds: { owner: "M4", thrownAt: "accept(), before the persist, on funding routes" },
    AcceptConflict: { owner: "M4", thrownAt: "accept() vs incompatible durable evidence" },
    OperatorUnreachable: {
        owner: "M2/M3",
        thrownAt: "covenant derivation, getArkadeInfo({ requireLive: true })",
    },
    MissingCorridorDep: {
        owner: "M2/M4",
        thrownAt: "dep resolution on a corridor route; accept()/cancel() without a repository",
    },
    NotCancellable: {
        owner: "M6",
        thrownAt: "cancel(), on a corridor id or an id no record backs",
    },
    ClientDisposed: { owner: "M6", thrownAt: "any client member after async disposal" },
    MaxFeeExceeded: { owner: "M7", thrownAt: "the verb layer, before accept", pending: "M7" },
    InconsistentRoute: { owner: "M1", thrownAt: null },
} as const satisfies Record<
    SwapErrorName,
    { owner: string; thrownAt: string | null; pending?: string }
>;

/** Every `.ts` under `src/`, concatenated — what "has a throwing site" is read
 * from, so the map cannot claim coverage the code does not have. */
const SOURCES = ((): string => {
    const root = new URL("../../src", import.meta.url).pathname;
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return walk(path);
            return entry.name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
        });
    return walk(root).join("\n");
})();

const throws = (name: SwapErrorName): boolean => SOURCES.includes(`throw new ${name}(`);

describe("the error-coverage map", () => {
    it("names an owner for every member, and no member twice", () => {
        expect(Object.keys(COVERAGE).sort()).toEqual([...SWAP_ERROR_NAMES].sort());
        for (const [name, entry] of Object.entries(COVERAGE)) {
            expect(entry.owner.length, name).toBeGreaterThan(0);
        }
    });

    it("leaves exactly one member permanently throwerless, and it is InconsistentRoute", () => {
        // §9 is deferred, so its only thrower ships with the EVM corridor.
        // Dropping the member to match a schedule, or leaving it unowned, would
        // make "fires before value moves or not at all" unverifiable.
        const inert = Object.entries(COVERAGE)
            .filter(([, entry]) => entry.thrownAt === null)
            .map(([name]) => name);
        expect(inert).toEqual(["InconsistentRoute"]);
        expect(throws("InconsistentRoute")).toBe(false);
    });

    it("finds the throwing site every shipped member claims", () => {
        for (const [name, entry] of Object.entries(COVERAGE)) {
            if (entry.thrownAt === null || "pending" in entry) continue;
            expect(throws(name as SwapErrorName), `${name} @ ${entry.thrownAt}`).toBe(true);
        }
    });

    it("keeps the pending markers honest", () => {
        // When the owning milestone lands its throw, this fails and the marker
        // has to come off — which is the only thing keeping the map current.
        for (const [name, entry] of Object.entries(COVERAGE)) {
            if (!("pending" in entry)) continue;
            expect(throws(name as SwapErrorName), `${name} is owned by ${entry.pending}`).toBe(
                false,
            );
        }
    });

    it("counts the drive's refusals as documented non-members", () => {
        // M1/G's rule: a class that is not a member keeps the `Error` suffix.
        // No §7 member names a drive-refusal condition, so none absorbs these.
        const refusal = new SwapDriveRefusedError("readonly", "actuates nothing");
        expect(isSwapError(refusal)).toBe(false);
        expect(SWAP_ERROR_NAMES).not.toContain(refusal.name as SwapErrorName);
        expect(refusal.name.endsWith("Error")).toBe(true);
    });

    it("keeps cancel's protocol-level diagnoses outside the taxonomy too", () => {
        // The rebuild mismatch and the missing deposit are conditions of the
        // offer primitive, not of the client's surface: same suffix rule.
        for (const error of [
            new OfferCovenantMismatchError("5120aa"),
            new NoSpendableDepositError(),
        ]) {
            expect(isSwapError(error), error.name).toBe(false);
            expect(error.name.endsWith("Error"), error.name).toBe(true);
        }
    });
});
