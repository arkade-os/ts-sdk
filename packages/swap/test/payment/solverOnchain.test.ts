/**
 * `solverOnchainRail` — the three things the wallet reimplemented app-side:
 * selection (only a card that serves the SIZE), the drop (every refusal is
 * `available()` returning false), and the order (the record is written before
 * the lockup is funded, always).
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

/** A card serving `arkade:BTC -> onchain:BTC`, paying out between `min` and
 *  `max` sats. Field names are the registry's own. */
const card = (min: string, max: string, overrides: Record<string, unknown> = {}) =>
    ({
        pair: "BTC/onchain:BTC",
        base_asset: { id: "btc", decimals: 8 },
        quote_asset: { id: "btc", decimals: 8 },
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

const NOW = () => Math.floor(Date.now() / 1000);

/** What `requestOnchainSend` hands back, as far as the rail reads it. The
 *  locktimes are live and correctly ordered because `send()` re-gates on them. */
const negotiated = (fundAmount: number, toAmount: number) =>
    ({
        rfqId: "rfq-1",
        address: "tark1lockup",
        fundAmount,
        quote: {
            from_amount: fundAmount,
            to_amount: toAmount,
            valid_until: NOW() + 3600,
            refund_locktime: NOW() + 200 * 3600,
        },
        htlc: { address: "bcrt1phtlc" },
        htlcParams: { refundLocktime: NOW() + 100 * 3600 },
        l1Network: "regtest",
        minConfirmations: 2,
        secrets: {},
        script: {},
    }) as unknown as Awaited<SolverOnchainSend>;

const ctxWith = (send = vi.fn(async () => "funding-txid")): RouterContext =>
    ({ wallet: { send } as never, prefs: {} }) as RouterContext;

const depsWith = (over: Partial<SolverOnchainRailDeps> = {}): SolverOnchainRailDeps => ({
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
        const intraArkade = card("1000", "1000000", {
            base_corridor: undefined,
            quote_corridor: undefined,
        });
        expect(solverOnchainRendezvous([intraArkade], 100_000)).toBeUndefined();
    });

    it("reads a disabled quote side as no corridor, not as out-of-bounds", () => {
        expect(solverOnchainRendezvous([card("0", "0")], 100_000)).toBeUndefined();
    });

    it("skips a card whose corridors match but whose assets are not BTC", () => {
        const usdtBase = card("1000", "1000000", { base_asset: { id: "usdt", decimals: 6 } });
        const usdtQuote = card("1000", "1000000", { quote_asset: { id: "usdt", decimals: 6 } });
        expect(solverOnchainRendezvous([usdtBase], 100_000)).toBeUndefined();
        expect(solverOnchainRendezvous([usdtQuote], 100_000)).toBeUndefined();
    });

    it("takes a later BTC card over an earlier one on another asset", () => {
        const usdt = card("1000", "1000000", {
            base_asset: { id: "usdt", decimals: 6 },
            discovery_pubkey: "dd".repeat(32),
        });
        expect(
            solverOnchainRendezvous([usdt, card("1000", "1000000")], 100_000)?.solverPubkey,
        ).toBe(SOLVER_PUBKEY);
    });

    describe("the emulator key the covenant needs", () => {
        const pinned = new Uint8Array(32).fill(0xbb); // === EMULATOR_PUBKEY

        it("filters on the advertised key without carrying it", () => {
            expect(
                solverOnchainRendezvous([card("1000", "1000000")], 100_000, pinned),
            ).not.toHaveProperty("emulatorPubkey");
        });

        it("falls back to the pin when the card advertises none", () => {
            const bare = card("1000", "1000000", { emulator_pubkey: undefined });
            expect(solverOnchainRendezvous([bare], 100_000, pinned)?.solverPubkey).toBe(
                SOLVER_PUBKEY,
            );
            expect(solverOnchainRendezvous([bare], 100_000)).toBeUndefined();
        });

        it("fails closed on a malformed advertised key, pin or no pin", () => {
            const bad = card("1000", "1000000", { emulator_pubkey: "not-hex" });
            expect(solverOnchainRendezvous([bad], 100_000, pinned)).toBeUndefined();
            expect(solverOnchainRendezvous([bad], 100_000)).toBeUndefined();
        });

        it("rejects a malformed pin outright, rather than adopting it", () => {
            const bare = card("1000", "1000000", { emulator_pubkey: undefined });
            const compressed = new Uint8Array(33).fill(0xbb);
            expect(solverOnchainRendezvous([bare], 100_000, compressed)).toBeUndefined();
            expect(
                solverOnchainRendezvous([card("1000", "1000000")], 100_000, compressed),
            ).toBeUndefined();
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
        const discover = vi.fn(async () => [card("1000", "1000000")]);
        const rail = solverOnchainRail(depsWith({ discover }));
        expect(
            await rail.available?.(
                { raw: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amount: 100_000 },
                ctxWith(),
            ),
        ).toBe(false);
        expect(discover).not.toHaveBeenCalled();
    });

    it("drops itself for an amountless request", async () => {
        expect(await solverOnchainRail(depsWith()).available?.({ raw: BTC_ADDR }, ctxWith())).toBe(
            false,
        );
    });

    it("reads the BIP21 amount when the request carries no explicit one", async () => {
        const rail = solverOnchainRail(depsWith());
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
            // Dropped, never silently.
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
        const { spy } = mockRequest();
        rfqStub = spy;
        await solverOnchainRail(depsWith()).quote({ raw: BTC_ADDR, amount: 100_000 }, ctxWith());

        expect(spy.mock.calls[0][2]).toMatchObject({ amount: 100_000, amountSide: "to" });
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

    it("stays at 'sent' when the watcher fails — the lockup is funded either way", async () => {
        rfqStub = mockRequest().spy;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const quote = await solverOnchainRail(
            depsWith({
                awaitSettlement: vi.fn(async () => {
                    throw new Error("esplora timed out");
                }),
            }),
        ).quote({ raw: BTC_ADDR, amount: 100_000 }, ctxWith());
        const handle = await quote.send();
        const seen: string[] = [];
        handle.subscribe((u) => seen.push(u.status));

        expect(await handle.settled()).toEqual({
            railId: SOLVER_ONCHAIN_RAIL,
            swapId: "rfq-1",
        });
        expect(handle.status).toBe("sent");
        expect(seen).not.toContain("failed");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("refuses a quote negotiated on an L1 network the rail was not built for", async () => {
        rfqStub = vi.fn(async () => ({
            ...negotiated(101_000, 100_000),
            l1Network: "bitcoin",
        }));

        await expect(
            solverOnchainRail(depsWith({ l1Network: "regtest" })).quote(
                { raw: BTC_ADDR, amount: 100_000 },
                ctxWith(),
            ),
        ).rejects.toThrow(/regtest.*bitcoin|bitcoin.*regtest/);
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
        // Not on the quote, not on the HTLC, not derivable at claim time.
        expect(persisted[0].payoutPkScript).toBeInstanceOf(Uint8Array);
    });
});

describe("the gates are re-run before anything is spent", () => {
    const sendWith = async (result: Awaited<SolverOnchainSend>) => {
        rfqStub = vi.fn(async () => result);
        const send = vi.fn(async () => "txid");
        const persist = vi.fn(async () => {});
        const quote = await solverOnchainRail(depsWith({ persist })).quote(
            { raw: BTC_ADDR, amount: 100_000 },
            ctxWith(send),
        );
        return { handle: await quote.send(), send, persist };
    };
    const withHtlcLocktime = (at: number) => {
        const swap = negotiated(101_000, 100_000);
        (swap.htlcParams as unknown as { refundLocktime: number }).refundLocktime = at;
        return swap;
    };

    it("does not persist or fund once the quote has expired", async () => {
        const lapsed = negotiated(101_000, 100_000);
        (lapsed.quote as { valid_until: number }).valid_until = NOW() - 1;
        const { handle, send, persist } = await sendWith(lapsed);

        await expect(handle.settled()).rejects.toThrow(/quote expired/);
        expect(persist).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it("does not fund once the L1 claim window has stopped being safe", async () => {
        // A locktime a minute away: no room to confirm, let alone claim.
        const { handle, send } = await sendWith(withHtlcLocktime(NOW() + 60));
        await expect(handle.settled()).rejects.toThrow(/claim window/);
        expect(send).not.toHaveBeenCalled();
    });

    it("does not fund when the Arkade refund would open before the L1 claim", async () => {
        // The solver claims Arkade with P only AFTER the user's L1 claim, so
        // the user's refund must open last. An inverted order is unfundable.
        const { handle, send } = await sendWith(withHtlcLocktime(NOW() + 300 * 3600));
        await expect(handle.settled()).rejects.toThrow(/locktime/i);
        expect(send).not.toHaveBeenCalled();
    });
});
