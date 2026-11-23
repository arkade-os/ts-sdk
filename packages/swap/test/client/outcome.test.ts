/**
 * The translation table, which is M5's deliverable.
 *
 * What these tests are about is the one axis a reader gets wrong: it is not
 * send-versus-receive, it is WHOSE LOCKUP the pass reads. The identical chain
 * read — "the lockup was spent by something other than a hash-verified claim" —
 * is the trader's money coming back on a send leg and the trader's incoming
 * payment never arriving on a receive one, and `refunded` against `lapsed` is
 * that difference made unmissable.
 */
import { describe, expect, it } from "vitest";
import {
    ACTIVITY_TOKEN,
    CORRIDOR_PASS,
    LOCKUP_OWNER,
    corridorOutcome,
    offerOutcome,
    readsChain,
    recordOutcome,
    type CorridorKind,
    type Outcome,
} from "../../src/client/outcome";
import { RFQ_SWAP_TERMINAL_STATES, type RfqSwapState } from "../../src/rfqSwapState";
import type { AssetSwapStatus } from "../../src/store";

const RFQ_STATES: RfqSwapState[] = [
    "pending",
    "claimable",
    "claimed",
    "needs_counterparty",
    "settled",
    "refunded",
    "failed",
];

const KINDS: CorridorKind[] = ["lightning_send", "lightning_receive", "onchain_send"];

const ASSET_STATUSES: AssetSwapStatus[] = [
    "pending",
    "cancelling",
    "fulfilled",
    "cancelled",
    "recoverable",
    "awaiting_fill",
    "claimable",
    "claimed",
    "refunded_l1",
];

describe("the corridor translation", () => {
    it("reads the lockup owner off the corridor modules rather than restating it", () => {
        // The declaration is M2's `CorridorPass`, per route side. A send leg's
        // arkade lockup is the trader's; a receive leg's is the solver's, which
        // is what inverts every row below.
        expect(LOCKUP_OWNER).toEqual({
            lightning_send: "trader",
            lightning_receive: "solver",
            onchain_send: "trader",
        });
        // And the same declaration is what decides whether the L1 seam has to be
        // resolved at all — the reason a deliberate `onchain: { chain: null }`
        // is not a construction failure for a client that never touches it.
        expect(readsChain("onchain_send")).toBe(true);
        expect(readsChain("lightning_send")).toBe(false);
        expect(readsChain("lightning_receive")).toBe(false);
        expect(CORRIDOR_PASS.onchain_send.lockups).toHaveLength(2);
    });

    it("is total over every state and every kind", () => {
        for (const kind of KINDS) {
            for (const state of RFQ_STATES) {
                expect(typeof corridorOutcome(kind, state)).toBe("string");
            }
        }
    });

    it("projects the trader's lockup", () => {
        const send = (state: RfqSwapState) => corridorOutcome("lightning_send", state);
        expect(send("pending")).toBe("funded");
        expect(send("claimable")).toBe("funded");
        expect(send("claimed")).toBe("funded");
        expect(send("needs_counterparty")).toBe("needs_recovery");
        expect(send("settled")).toBe("paid");
        expect(send("refunded")).toBe("refunded");
        expect(send("failed")).toBe("failed");
    });

    it("projects the solver's lockup, where the same words mean the opposite", () => {
        const receive = (state: RfqSwapState) => corridorOutcome("lightning_receive", state);
        // The lockup is the solver's and it is unfunded: the invoice is shown
        // and unpaid, where the send leg's `pending` is a funded lockup.
        expect(receive("pending")).toBe("open");
        expect(receive("claimable")).toBe("funded");
        expect(receive("claimed")).toBe("funded");
        expect(receive("needs_counterparty")).toBe("needs_recovery");
        // The trader's OWN claim landing, matched by the hash and not by our
        // txid — so a claim that lands without us still counts.
        expect(receive("settled")).toBe("claimed");
        expect(receive("failed")).toBe("failed");
    });

    it("keeps a receive leg's refund distinct from a send leg's", () => {
        // The single most expensive row to get wrong. Both come from the same
        // chain read; one is the trader's money returning and the other is the
        // trader's incoming payment never arriving.
        expect(corridorOutcome("lightning_send", "refunded")).toBe("refunded");
        expect(corridorOutcome("onchain_send", "refunded")).toBe("refunded");
        expect(corridorOutcome("lightning_receive", "refunded")).toBe("lapsed");
    });

    it("covers all three sites that write the raw `refunded`", () => {
        // The manager writes `refunded` from three places, and the table has to
        // answer for each: a chain-observed non-claim spend on either leg, the
        // receive leg's deadline with nothing observed, and the send leg's
        // empty lockup after a push. All three arrive here as the same word, so
        // what separates them is the owner and nothing else.
        const chainObserved = { send: "lightning_send", receive: "lightning_receive" } as const;
        expect(corridorOutcome(chainObserved.send, "refunded")).toBe("refunded");
        expect(corridorOutcome(chainObserved.receive, "refunded")).toBe("lapsed");
        // The receive deadline and the empty-lockup settle-for-less-than-proof
        // path both go through `setState(swap, "refunded")` on their own leg.
        expect(corridorOutcome("lightning_receive", "refunded")).toBe("lapsed");
        expect(corridorOutcome("lightning_send", "refunded")).toBe("refunded");
    });

    it("splits `settled` on the trader's side by what the trader is holding", () => {
        // On a lightning send the counterparty's hash-verified spend IS the
        // invoice being paid; on an onchain send the trader already holds the L1
        // coins its own claim took, and `paid` would name the wrong event.
        expect(corridorOutcome("lightning_send", "settled")).toBe("paid");
        expect(corridorOutcome("onchain_send", "settled")).toBe("claimed");
    });

    it("projects a submitted claim to `funded`, so the stream stays monotone", () => {
        // The manager's `claimed` is a local belief — a submission, from which
        // `claimable` is a documented legal backslide — while this vocabulary's
        // `claimed` is a chain fact. Both project to `funded`, so the backslide
        // emits nothing.
        expect(corridorOutcome("lightning_receive", "claimed")).toBe(
            corridorOutcome("lightning_receive", "claimable"),
        );
        expect(corridorOutcome("lightning_send", "claimed")).toBe(
            corridorOutcome("lightning_send", "claimable"),
        );
    });

    it("reports an exited lockup as needing recovery, on every leg", () => {
        // `LockupFate`'s `exited` reaches the table only through
        // `blockExitedLockup`, which blocks rather than ending the swap: the
        // money is still under the same script with the same leaves.
        for (const kind of KINDS) {
            expect(corridorOutcome(kind, "needs_counterparty")).toBe("needs_recovery");
        }
    });

    it("keeps `needs_recovery` out of the terminal set", () => {
        // Treating it as terminal unwatches a funded lockup, which is the most
        // expensive mistake available here.
        expect(RFQ_SWAP_TERMINAL_STATES).not.toContain("needs_counterparty");
    });
});

describe("the offer translation", () => {
    it("maps the five words the package writes", () => {
        expect(offerOutcome("pending")).toBe("open");
        expect(offerOutcome("cancelling")).toBe("cancelling");
        expect(offerOutcome("cancelled")).toBe("cancelled");
        expect(offerOutcome("fulfilled")).toBe("filled");
        // A swept deposit: still the trader's money at a script no offchain
        // spend can reach until it is recovered.
        expect(offerOutcome("recoverable")).toBe("needs_recovery");
    });

    it("surfaces the four dead words rather than reporting them as progress", () => {
        // `awaiting_fill`, `claimable`, `claimed` and `refunded_l1` are
        // onchain-corridor phases nothing writes onto an offer record, and in v2
        // that corridor is family `rfq`. The cells exist to keep the map total;
        // a record carrying one is one this drive does not understand.
        for (const status of ["awaiting_fill", "claimable", "claimed", "refunded_l1"] as const) {
            expect(offerOutcome(status)).toBe("needs_recovery");
        }
    });

    it("never emits `failed`", () => {
        // The offer family's word set has no failed member; its swept half ends
        // `needs_recovery`.
        const outcomes = ASSET_STATUSES.map(offerOutcome);
        expect(outcomes).not.toContain("failed");
    });
});

describe("the record-and-clock projections", () => {
    it("reads `accepted` off a record whose funding is not broadcast", () => {
        expect(recordOutcome({ family: "rfq" })).toBe("accepted");
        expect(recordOutcome({ family: "offer", status: "pending" })).toBe("accepted");
    });

    it("reads `funding` off a corridor record the drive holds no state for", () => {
        expect(recordOutcome({ family: "rfq", fundingTxid: "aa" })).toBe("funding");
    });

    it("lets a funded offer record answer from its own status", () => {
        // The offer family has no live object: its watcher is event-driven over
        // the store, so past the funding the record IS the state.
        expect(recordOutcome({ family: "offer", fundingTxid: "aa", status: "fulfilled" })).toBe(
            "filled",
        );
    });
});

describe("the activity projection", () => {
    it("is total over `Outcome`", () => {
        const outcomes: Outcome[] = [
            "accepted",
            "funding",
            "funded",
            "open",
            "filled",
            "claimed",
            "paid",
            "cancelling",
            "cancelled",
            "refunding",
            "refunded",
            "lapsed",
            "needs_recovery",
            "failed",
        ];
        expect(Object.keys(ACTIVITY_TOKEN).sort()).toEqual([...outcomes].sort());
    });

    it("keeps a lost receive a different token from a send refund", () => {
        // The pin `activity.test.ts` already holds, now derived rather than
        // special-cased.
        expect(ACTIVITY_TOKEN[corridorOutcome("lightning_receive", "refunded")]).toBe("lost");
        expect(ACTIVITY_TOKEN[corridorOutcome("lightning_send", "refunded")]).toBe("refunded");
    });
});
