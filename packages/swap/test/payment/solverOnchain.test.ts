/**
 * `solverOnchainRail` — the solver-routed onchain send, as a rail.
 *
 * The subject is not "does it call requestOnchainSend". It is the three things
 * the Arkade wallet reimplemented app-side and this rail exists to give back to
 * `PaymentRouter`:
 *
 * 1. selection — which card, and only one that serves the SIZE;
 * 2. the drop — every refusal is `available()` returning false, so the router's
 *    ranking hands the send to the collaborative-exit `onchain` rail with no
 *    error type and no enum in between;
 * 3. the order — the record is written before the lockup is funded, always.
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { PaymentRouter, onchainRail, type RouterContext } from "@arkade-os/sdk";
import {
    SOLVER_ONCHAIN_RAIL,
    solverOnchainRail,
    solverOnchainRendezvous,
    type SolverOnchainRailDeps,
    type SolverOnchainSend,
} from "../../src/payment/solverOnchain";

const BTC_ADDR = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const SOLVER_PUBKEY = "aa".repeat(32);
const EMULATOR_PUBKEY = "bb".repeat(32);
const PAYOUT_PUBKEY = new Uint8Array(32).fill(15);

/**
 * A card serving `arkade:BTC -> onchain:BTC`, paying out between `min` and
 * `max` sats on the onchain (quote) side.
 *
 * The field names are the registry's own — `base_corridor`/`quote_corridor`
 * carry the corridor and `min_quote_amount`/`max_quote_amount` the bounds, and
 * `marketCorridor` defaults an absent or malformed corridor to `arkade`.
 */
const card = (min: string, max: string, overrides: Record<string, unknown> = {}) =>
    ({
        pair: "BTC/onchain:BTC",
        base_asset: { id: "BTC", decimals: 8 },
        quote_asset: { id: "BTC", decimals: 8 },
        base_corridor: "arkade",
        quote_corridor: "onchain",
        discovery_pubkey: SOLVER_PUBKEY,
        emulator_pubkey: EMULATOR_PUBKEY,
        transports: { nostr: { relays: ["wss://relay"] } },
        min_base_amount: "1",
        max_base_amount: "100000000",
        min_quote_amount: min,
        max_quote_amount: max,
        ...overrides,
    }) as unknown as DiscoveredMarket;

/** What `requestOnchainSend` hands back, only as far as the rail reads it. */
const negotiated = (fundAmount: number, toAmount: number) =>
    ({
        rfqId: "rfq-1",
        address: "tark1lockup",
        fundAmount,
        quote: { from_amount: fundAmount, to_amount: toAmount, valid_until: 1_800_000_000 },
        htlc: { address: "bcrt1phtlc" },
        htlcParams: {},
        minConfirmations: 2,
        secrets: {},
        script: {},
    }) as unknown as Awaited<SolverOnchainSend>;

const ctxWith = (send = vi.fn(async () => "funding-txid")): RouterContext =>
    ({ wallet: { send } as never, prefs: {} }) as RouterContext;

const depsWith = (over: Partial<SolverOnchainRailDeps> = {}): SolverOnchainRailDeps => ({
    arkServerUrl: "http://ark",
    l1Network: "regtest",
    payoutPubkey: PAYOUT_PUBKEY,
    discover: vi.fn(async () => [card("1000", "1000000")]),
    connect: vi.fn(async (_r, fn) => fn({} as never)),
    persist: vi.fn(async () => {}),
    ...over,
});

/** Stub `requestOnchainSend` for the tests that drive quote()/send(). */
const mockRequest = (result = negotiated(101_000, 100_000)) => {
    const spy = vi.fn(async () => result);
    return { spy, result };
};

vi.mock("../../src/rfq", async (importOriginal) => {
    const mod = await importOriginal<typeof import("../../src/rfq")>();
    return { ...mod, requestOnchainSend: (...args: unknown[]) => rfqStub(...args) };
});

// Reassigned per test; the module mock reads it at call time so each test can
// supply its own without re-mocking.
let rfqStub: (...args: unknown[]) => Promise<unknown> = async () => {
    throw new Error("requestOnchainSend not stubbed");
};

describe("solverOnchainRendezvous", () => {
    it("picks a card that serves the pair AND the size", () => {
        const r = solverOnchainRendezvous([card("1000", "1000000")], 100_000);
        expect(r?.solverPubkey).toBe(SOLVER_PUBKEY);
        expect(r).toMatchObject({ minSats: 1000, maxSats: 1_000_000 });
    });

    it("skips a card that serves the pair but not the size", () => {
        // Quoting outside a card's advertised range burns a negotiation, tells
        // a third party what the user is about to do, and is refused anyway.
        expect(solverOnchainRendezvous([card("1000", "50000")], 100_000)).toBeUndefined();
        expect(solverOnchainRendezvous([card("200000", "1000000")], 100_000)).toBeUndefined();
    });

    it("takes the bounds inclusively at both ends", () => {
        expect(solverOnchainRendezvous([card("1000", "100000")], 100_000)).toBeDefined();
        expect(solverOnchainRendezvous([card("100000", "1000000")], 100_000)).toBeDefined();
        expect(solverOnchainRendezvous([card("1000", "99999")], 100_000)).toBeUndefined();
    });

    it("prefers a later card that takes the size over an earlier one that does not", () => {
        const wide = card("1000", "1000000", { discovery_pubkey: "cc".repeat(32) });
        const r = solverOnchainRendezvous([card("1000", "500"), wide], 100_000);
        expect(r?.solverPubkey).toBe("cc".repeat(32));
    });

    it("skips a card with no relays to reach it on", () => {
        const noRelay = card("1000", "1000000", { transports: { nostr: { relays: [] } } });
        expect(solverOnchainRendezvous([noRelay], 100_000)).toBeUndefined();
    });

    it("skips the receive direction of the same corridor", () => {
        const receive = card("1000", "1000000", {
            base_corridor: "onchain",
            quote_corridor: "arkade",
        });
        expect(solverOnchainRendezvous([receive], 100_000)).toBeUndefined();
    });

    it("skips a plain intra-Arkade market, which has no L1 side at all", () => {
        // An absent corridor field defaults to `arkade` on both sides.
        const intraArkade = card("1000", "1000000", {
            base_corridor: undefined,
            quote_corridor: undefined,
        });
        expect(solverOnchainRendezvous([intraArkade], 100_000)).toBeUndefined();
    });

    it("reads a disabled quote side as no corridor, not as out-of-bounds", () => {
        // `sideLimits` reads max "0" as null; without that a disabled corridor
        // would surface to the user as "amount outside solver bounds".
        expect(solverOnchainRendezvous([card("0", "0")], 100_000)).toBeUndefined();
    });

    describe("the emulator key the covenant needs", () => {
        const pinned = new Uint8Array(32).fill(0xbb); // === EMULATOR_PUBKEY

        it("falls back to the pin when the card advertises none", () => {
            const bare = card("1000", "1000000", { emulator_pubkey: undefined });
            expect(solverOnchainRendezvous([bare], 100_000, pinned)?.emulatorPubkey).toBe(
                EMULATOR_PUBKEY,
            );
            // …and without a pin there is nothing to derive the covenant from.
            expect(solverOnchainRendezvous([bare], 100_000)).toBeUndefined();
        });

        it("fails closed on a malformed advertised key, pin or no pin", () => {
            const bad = card("1000", "1000000", { emulator_pubkey: "not-hex" });
            expect(solverOnchainRendezvous([bad], 100_000, pinned)).toBeUndefined();
            expect(solverOnchainRendezvous([bad], 100_000)).toBeUndefined();
        });

        it("skips a card that disagrees with the pin rather than resolving it", () => {
            const other = card("1000", "1000000", { emulator_pubkey: "cc".repeat(32) });
            expect(solverOnchainRendezvous([other], 100_000, pinned)).toBeUndefined();
        });
    });
});

describe("solverOnchainRail.match", () => {
    it("matches a bare BTC address and the on-chain part of a BIP21 URI", () => {
        const rail = solverOnchainRail(depsWith());
        const ctx = ctxWith();
        expect(rail.match({ raw: BTC_ADDR }, ctx)).toBe(true);
        expect(rail.match({ raw: `bitcoin:${BTC_ADDR}?amount=0.001` }, ctx)).toBe(true);
        expect(rail.match({ raw: "lnbcrt10u1pj" }, ctx)).toBe(false);
        expect(rail.match({ raw: "tark1qexample" }, ctx)).toBe(false);
    });
});

describe("solverOnchainRail.available", () => {
    const req = { raw: BTC_ADDR, amount: 100_000 };

    it("is available when a card takes the pair and the size", async () => {
        expect(await solverOnchainRail(depsWith()).available?.(req, ctxWith())).toBe(true);
    });

    it("drops itself when no card serves the corridor at all", async () => {
        const deps = depsWith({ discover: vi.fn(async () => []) });
        expect(await solverOnchainRail(deps).available?.(req, ctxWith())).toBe(false);
    });

    it("drops itself when no card takes the size", async () => {
        const deps = depsWith({ discover: vi.fn(async () => [card("1000", "50000")]) });
        expect(await solverOnchainRail(deps).available?.(req, ctxWith())).toBe(false);
    });

    it("drops itself for a destination the claim could not pay to", async () => {
        // Checked BEFORE discovery: a funded HTLC whose claim has nowhere to go
        // is worse than a collaborative exit, and cheaper to rule out.
        const discover = vi.fn(async () => [card("1000", "1000000")]);
        const rail = solverOnchainRail(depsWith({ discover }));
        // A mainnet address on a regtest deployment: decodable as an address,
        // not decodable on this network.
        expect(
            await rail.available?.(
                { raw: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amount: 100_000 },
                ctxWith(),
            ),
        ).toBe(false);
        expect(discover).not.toHaveBeenCalled();
    });

    it("drops itself for an amountless request", async () => {
        // Nothing can be bounds-checked without an amount, so the rail cannot
        // claim to fit; `quote()` owns the "an amount is required" rejection.
        expect(await solverOnchainRail(depsWith()).available?.({ raw: BTC_ADDR }, ctxWith())).toBe(
            false,
        );
    });

    it("reads the BIP21 amount when the request carries no explicit one", async () => {
        const rail = solverOnchainRail(depsWith());
        // 0.001 BTC = 100_000 sats, inside 1000..1000000
        expect(await rail.available?.({ raw: `bitcoin:${BTC_ADDR}?amount=0.001` }, ctxWith())).toBe(
            true,
        );
    });
});

describe("the router drops this rail rather than failing the payment", () => {
    /** A request the collaborative-exit rail can price without a live wallet. */
    const arkProvider = { getInfo: async () => ({ fees: {} }) };
    const routerCtx = (rail: ReturnType<typeof solverOnchainRail>) =>
        new PaymentRouter({
            wallet: { arkProvider } as never,
            prefs: { priority: [SOLVER_ONCHAIN_RAIL, "onchain"] },
        })
            .use(onchainRail())
            .use(rail);

    it("ranks the solver route first when a card takes the send", async () => {
        const options = await routerCtx(solverOnchainRail(depsWith())).options({
            raw: BTC_ADDR,
            amount: 100_000,
        });
        expect(options.map((o) => o.railId)).toEqual([SOLVER_ONCHAIN_RAIL, "onchain"]);
    });

    it("leaves the collaborative exit standing when no solver serves the size", async () => {
        const deps = depsWith({ discover: vi.fn(async () => [card("1000", "500")]) });
        const options = await routerCtx(solverOnchainRail(deps)).options({
            raw: BTC_ADDR,
            amount: 100_000,
        });
        expect(options.map((o) => o.railId)).toEqual(["onchain"]);
    });

    it("leaves the collaborative exit standing when discovery itself throws", async () => {
        // The registry being unreachable is a reason to exit collaboratively,
        // never a reason to fail the payment. The router's own contract is what
        // makes that true — this rail adds no error type of its own.
        const deps = depsWith({
            discover: vi.fn(async () => {
                throw new Error("registry unreachable");
            }),
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const options = await routerCtx(solverOnchainRail(deps)).options({
                raw: BTC_ADDR,
                amount: 100_000,
            });
            expect(options.map((o) => o.railId)).toEqual(["onchain"]);
            // Dropped, but never silently: a rail broken by a bug must not vanish.
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("still offers the collaborative exit when the user disables the solver route", async () => {
        const options = await routerCtx(solverOnchainRail(depsWith())).options(
            { raw: BTC_ADDR, amount: 100_000 },
            { disabled: [SOLVER_ONCHAIN_RAIL] },
        );
        expect(options.map((o) => o.railId)).toEqual(["onchain"]);
    });
});

describe("solverOnchainRail.quote", () => {
    it("is receiver-exact: the amount is the L1 payout and the fee sits on top", async () => {
        const { spy } = mockRequest(negotiated(101_000, 100_000));
        rfqStub = spy;
        const quote = await solverOnchainRail(depsWith()).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(),
        );

        expect(quote).toMatchObject({
            railId: SOLVER_ONCHAIN_RAIL,
            amount: 100_000,
            fee: 1000,
            total: 101_000,
        });
    });

    it("asks the solver to fix the L1 side, not the amount that leaves the wallet", async () => {
        // `amountSide: "to"` is what makes the quote receiver-exact, and what
        // `assertQuotedAmount` then pins inside `requestOnchainSend`.
        const { spy } = mockRequest();
        rfqStub = spy;
        await solverOnchainRail(depsWith()).quote({ raw: BTC_ADDR, amount: 100_000 }, ctxWith());

        expect(spy.mock.calls[0][3]).toMatchObject({ amount: 100_000, amountSide: "to" });
    });

    it("negotiates through the rendezvous the size chose", async () => {
        const { spy } = mockRequest();
        rfqStub = spy;
        const connect = vi.fn(async (_r: unknown, fn: (t: never) => Promise<unknown>) =>
            fn({} as never),
        );
        await solverOnchainRail(depsWith({ connect: connect as never })).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(),
        );

        expect(connect.mock.calls[0][0]).toMatchObject({ solverPubkey: SOLVER_PUBKEY });
    });

    it("rejects an amountless request rather than quoting zero", async () => {
        rfqStub = mockRequest().spy;
        await expect(
            solverOnchainRail(depsWith()).quote({ raw: BTC_ADDR }, ctxWith()),
        ).rejects.toThrow(/amount is required/);
    });

    it("refuses to negotiate when no card takes the size", async () => {
        const spy = vi.fn();
        rfqStub = spy as never;
        const deps = depsWith({ discover: vi.fn(async () => [card("1000", "500")]) });
        await expect(
            solverOnchainRail(deps).quote({ raw: BTC_ADDR, amount: 100_000 }, ctxWith()),
        ).rejects.toThrow(/no solver serves/);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe("solverOnchainRail.send", () => {
    it("writes the record BEFORE it funds the lockup", async () => {
        const order: string[] = [];
        rfqStub = mockRequest().spy;
        const send = vi.fn(async () => {
            order.push("fund");
            return "txid";
        });
        const persist = vi.fn(async () => {
            order.push("persist");
        });

        const quote = await solverOnchainRail(depsWith({ persist })).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(send),
        );
        await (await quote.send()).settled();

        expect(order).toEqual(["persist", "fund"]);
    });

    it("does not fund when the record could not be written", async () => {
        // A funded lockup with no record cannot be refunded. This is the one
        // ordering in the rail that cannot be relaxed.
        rfqStub = mockRequest().spy;
        const send = vi.fn(async () => "txid");
        const persist = vi.fn(async () => {
            throw new Error("storage full");
        });

        const quote = await solverOnchainRail(depsWith({ persist })).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(send),
        );
        await expect((await quote.send()).settled()).rejects.toThrow(/storage full/);
        expect(send).not.toHaveBeenCalled();
    });

    it("funds the lockup address the client derived, at the quoted from_amount", async () => {
        rfqStub = mockRequest(negotiated(101_000, 100_000)).spy;
        const send = vi.fn(async () => "txid");
        const quote = await solverOnchainRail(depsWith()).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(send),
        );
        await (await quote.send()).settled();

        expect(send).toHaveBeenCalledWith({ address: "tark1lockup", amount: 101_000 });
    });

    it("stops at 'sent' with the swap id when no settlement watcher is wired", async () => {
        // The recipient has nothing until the solver fills the L1 HTLC and this
        // wallet claims it; reporting 'settled' on a funded lockup would be a lie.
        rfqStub = mockRequest().spy;
        const quote = await solverOnchainRail(depsWith()).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(),
        );
        const handle = await quote.send();
        const result = await handle.settled();

        expect(result).toEqual({ railId: SOLVER_ONCHAIN_RAIL, swapId: "rfq-1" });
        expect(result).not.toHaveProperty("txid");
        expect(handle.status).toBe("sent");
    });

    it("reaches 'settled' with the claim txid when one is", async () => {
        rfqStub = mockRequest().spy;
        const awaitSettlement = vi.fn(async () => ({ txid: "claim-txid" }));
        const quote = await solverOnchainRail(depsWith({ awaitSettlement })).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(),
        );
        const handle = await quote.send();

        expect(await handle.settled()).toEqual({
            railId: SOLVER_ONCHAIN_RAIL,
            swapId: "rfq-1",
            txid: "claim-txid",
        });
        expect(handle.status).toBe("settled");
    });

    it("hands the settlement watcher the record it persisted", async () => {
        rfqStub = mockRequest().spy;
        const persisted: SolverOnchainSend[] = [];
        const awaitSettlement = vi.fn(async (swap: SolverOnchainSend) => {
            expect(swap).toBe(persisted[0]);
            return { txid: "claim-txid" };
        });
        const quote = await solverOnchainRail(
            depsWith({
                persist: vi.fn(async (swap: SolverOnchainSend) => {
                    persisted.push(swap);
                }),
                awaitSettlement,
            }),
        ).quote({ raw: BTC_ADDR, amount: 100_000 }, ctxWith());
        await (await quote.send()).settled();

        expect(persisted[0]).toMatchObject({
            rfqId: "rfq-1",
            rendezvous: { solverPubkey: SOLVER_PUBKEY },
        });
        // The recipient's output script: not on the quote, not on the HTLC, and
        // not derivable at claim time from anything that survives this screen.
        expect(persisted[0].payoutPkScript).toBeInstanceOf(Uint8Array);
    });
});
