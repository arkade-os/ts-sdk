/**
 * `solverLightningRail` — the solver-routed BOLT11 send, as a rail.
 *
 * The corridor's own shape is what is under test: the invoice fixes the
 * amount, so an explicit request amount can only agree or be wrong, and an
 * invoice that cannot be paid at all (amountless, expired, undecodable) drops
 * the rail before a negotiation is spent on it.
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { PaymentRouter, type RouterContext } from "@arkade-os/sdk";
import {
    SOLVER_LIGHTNING_RAIL,
    solverLightningRail,
    solverLightningRendezvous,
    type SolverLightningRailDeps,
    type SolverLightningSend,
} from "../../src/payment/solverLightning";
import type { InvoiceFacts } from "../../src/rfq";

const INVOICE = "lnbcrt1u1pjexampleinvoice";
const SOLVER_PUBKEY = "aa".repeat(32);
const EMULATOR_PUBKEY = "bb".repeat(32);
const NOW = () => Math.floor(Date.now() / 1000);

const card = (min: string, max: string, overrides: Record<string, unknown> = {}) =>
    ({
        pair: "BTC/lightning:BTC",
        base_asset: { id: "BTC", decimals: 8 },
        quote_asset: { id: "BTC", decimals: 8 },
        base_corridor: "arkade",
        quote_corridor: "lightning",
        discovery_pubkey: SOLVER_PUBKEY,
        emulator_pubkey: EMULATOR_PUBKEY,
        transports: { nostr: { relays: ["wss://relay"] } },
        min_base_amount: "1",
        max_base_amount: "100000000",
        min_quote_amount: min,
        max_quote_amount: max,
        ...overrides,
    }) as unknown as DiscoveredMarket;

const facts = (over: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
    raw: INVOICE,
    paymentHash: "cc".repeat(32),
    amountSats: 100_000,
    expiresAt: NOW() + 3600,
    ...over,
});

const negotiated = (fundAmount: number) =>
    ({
        rfqId: "rfq-ln-1",
        address: "tark1lockup",
        fundAmount,
        quote: { from_amount: fundAmount, to_amount: 100_000, valid_until: 1_800_000_000 },
        secrets: {},
        script: {},
    }) as unknown as Awaited<SolverLightningSend>;

const ctxWith = (send = vi.fn(async () => "funding-txid")): RouterContext =>
    ({ wallet: { send } as never, prefs: {} }) as RouterContext;

const depsWith = (over: Partial<SolverLightningRailDeps> = {}): SolverLightningRailDeps => ({
    arkServerUrl: "http://ark",
    decodeInvoice: vi.fn(() => facts()),
    discover: vi.fn(async () => [card("1000", "1000000")]),
    connect: vi.fn(async (_r, fn) => fn({} as never)),
    persist: vi.fn(async () => {}),
    ...over,
});

vi.mock("../../src/rfq", async (importOriginal) => {
    const mod = await importOriginal<typeof import("../../src/rfq")>();
    return { ...mod, requestLightningSend: (...args: unknown[]) => rfqStub(...args) };
});

let rfqStub: (...args: unknown[]) => Promise<unknown> = async () => {
    throw new Error("requestLightningSend not stubbed");
};

describe("solverLightningRendezvous", () => {
    it("looks for the lightning payout corridor, not the onchain one", () => {
        expect(solverLightningRendezvous([card("1000", "1000000")], 100_000)?.solverPubkey).toBe(
            SOLVER_PUBKEY,
        );
        const onchain = card("1000", "1000000", { quote_corridor: "onchain" });
        expect(solverLightningRendezvous([onchain], 100_000)).toBeUndefined();
    });

    it("skips a card that serves the corridor but not the size", () => {
        expect(solverLightningRendezvous([card("1000", "50000")], 100_000)).toBeUndefined();
    });
});

describe("solverLightningRail.match", () => {
    it("matches a bolt11 invoice and the lightning= param of a BIP21 URI", () => {
        const rail = solverLightningRail(depsWith());
        const ctx = ctxWith();
        expect(rail.match({ raw: INVOICE }, ctx)).toBe(true);
        expect(rail.match({ raw: `lightning:${INVOICE}` }, ctx)).toBe(true);
        const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
        expect(rail.match({ raw: `bitcoin:${btcAddr}?lightning=${INVOICE}` }, ctx)).toBe(true);
        expect(rail.match({ raw: btcAddr }, ctx)).toBe(false);
    });

    it("classifies without decoding — match is amount-blind", () => {
        // `match` is classification only; an invoice this decoder cannot read
        // still matches, and `available()` is where it drops.
        const decodeInvoice = vi.fn(() => {
            throw new Error("nope");
        });
        expect(
            solverLightningRail(depsWith({ decodeInvoice })).match({ raw: INVOICE }, ctxWith()),
        ).toBe(true);
        expect(decodeInvoice).not.toHaveBeenCalled();
    });
});

describe("solverLightningRail.available", () => {
    it("is available when a card takes the invoice's amount", async () => {
        expect(await solverLightningRail(depsWith()).available?.({ raw: INVOICE }, ctxWith())).toBe(
            true,
        );
    });

    it("gates on the INVOICE's amount, not on the request's", async () => {
        // Bounds 1000..50000 with a 100_000-sat invoice: out of range, even
        // though nothing in the request says 100_000.
        const deps = depsWith({ discover: vi.fn(async () => [card("1000", "50000")]) });
        expect(await solverLightningRail(deps).available?.({ raw: INVOICE }, ctxWith())).toBe(
            false,
        );
    });

    it("drops itself for an amountless invoice", async () => {
        // A solver cannot price one and neither can the rail.
        const deps = depsWith({ decodeInvoice: vi.fn(() => facts({ amountSats: 0 })) });
        expect(await solverLightningRail(deps).available?.({ raw: INVOICE }, ctxWith())).toBe(
            false,
        );
    });

    it("drops itself for an expired invoice before spending a negotiation", async () => {
        const discover = vi.fn(async () => [card("1000", "1000000")]);
        const deps = depsWith({
            decodeInvoice: vi.fn(() => facts({ expiresAt: NOW() - 1 })),
            discover,
        });
        expect(await solverLightningRail(deps).available?.({ raw: INVOICE }, ctxWith())).toBe(
            false,
        );
        expect(discover).not.toHaveBeenCalled();
    });

    it("drops itself when the decoder rejects the invoice", async () => {
        const deps = depsWith({
            decodeInvoice: vi.fn(() => {
                throw new Error("bad checksum");
            }),
        });
        expect(await solverLightningRail(deps).available?.({ raw: INVOICE }, ctxWith())).toBe(
            false,
        );
    });

    it("drops itself when the request names an amount the invoice contradicts", async () => {
        // The payee is paid the invoice. A request asking for a different
        // number is asking for a payment nobody can make.
        const rail = solverLightningRail(depsWith());
        expect(await rail.available?.({ raw: INVOICE, amount: 50_000 }, ctxWith())).toBe(false);
        expect(await rail.available?.({ raw: INVOICE, amount: 100_000 }, ctxWith())).toBe(true);
    });
});

describe("the router drops this rail rather than failing the payment", () => {
    const router = (rail: ReturnType<typeof solverLightningRail>) =>
        new PaymentRouter({ wallet: {} as never, prefs: {} }).use(rail);

    it("offers nothing rather than throwing when no solver serves lightning", async () => {
        const deps = depsWith({ discover: vi.fn(async () => []) });
        expect(await router(solverLightningRail(deps)).options({ raw: INVOICE })).toEqual([]);
    });

    it("drops the rail, not the router, when discovery throws", async () => {
        const deps = depsWith({
            discover: vi.fn(async () => {
                throw new Error("registry unreachable");
            }),
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await expect(
                router(solverLightningRail(deps)).options({ raw: INVOICE }),
            ).resolves.toEqual([]);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe("solverLightningRail.quote", () => {
    it("is receiver-exact: the payee gets the invoice and the spread is the fee", async () => {
        rfqStub = vi.fn(async () => negotiated(101_500));
        const quote = await solverLightningRail(depsWith()).quote({ raw: INVOICE }, ctxWith());

        expect(quote).toMatchObject({
            railId: SOLVER_LIGHTNING_RAIL,
            amount: 100_000,
            fee: 1500,
            total: 101_500,
        });
    });

    it("hands the decoded invoice facts to the corridor, not the raw request", async () => {
        const spy = vi.fn(async () => negotiated(101_500));
        rfqStub = spy;
        await solverLightningRail(depsWith()).quote({ raw: `lightning:${INVOICE}` }, ctxWith());

        // The `lightning:` prefix is stripped by `invoiceTarget` before the
        // decoder sees it, and the facts — not the string — are what the
        // covenant binds.
        expect(spy.mock.calls[0][3]).toMatchObject({
            invoice: { raw: INVOICE, amountSats: 100_000 },
        });
    });

    it("refuses a request amount that contradicts the invoice", async () => {
        rfqStub = vi.fn(async () => negotiated(101_500));
        await expect(
            solverLightningRail(depsWith()).quote({ raw: INVOICE, amount: 50_000 }, ctxWith()),
        ).rejects.toThrow(/names 50000 sats but the invoice is for 100000/);
    });

    it("refuses an unpayable invoice rather than quoting zero", async () => {
        const deps = depsWith({ decodeInvoice: vi.fn(() => facts({ amountSats: 0 })) });
        await expect(solverLightningRail(deps).quote({ raw: INVOICE }, ctxWith())).rejects.toThrow(
            /no payable BOLT11 invoice/,
        );
    });

    it("refuses to negotiate when no card takes the size", async () => {
        const spy = vi.fn();
        rfqStub = spy as never;
        const deps = depsWith({ discover: vi.fn(async () => [card("1000", "500")]) });
        await expect(solverLightningRail(deps).quote({ raw: INVOICE }, ctxWith())).rejects.toThrow(
            /no solver serves/,
        );
        expect(spy).not.toHaveBeenCalled();
    });
});

describe("solverLightningRail.send", () => {
    it("writes the record BEFORE it funds the lockup", async () => {
        const order: string[] = [];
        rfqStub = vi.fn(async () => negotiated(101_500));
        const send = vi.fn(async () => {
            order.push("fund");
            return "txid";
        });
        const persist = vi.fn(async () => {
            order.push("persist");
        });

        const quote = await solverLightningRail(depsWith({ persist })).quote(
            { raw: INVOICE },
            ctxWith(send),
        );
        await (await quote.send()).settled();
        expect(order).toEqual(["persist", "fund"]);
    });

    it("does not fund when the record could not be written", async () => {
        rfqStub = vi.fn(async () => negotiated(101_500));
        const send = vi.fn(async () => "txid");
        const persist = vi.fn(async () => {
            throw new Error("storage full");
        });

        const quote = await solverLightningRail(depsWith({ persist })).quote(
            { raw: INVOICE },
            ctxWith(send),
        );
        await expect((await quote.send()).settled()).rejects.toThrow(/storage full/);
        expect(send).not.toHaveBeenCalled();
    });

    it("funds the derived lockup at the quoted from_amount", async () => {
        rfqStub = vi.fn(async () => negotiated(101_500));
        const send = vi.fn(async () => "txid");
        const quote = await solverLightningRail(depsWith()).quote({ raw: INVOICE }, ctxWith(send));
        await (await quote.send()).settled();

        expect(send).toHaveBeenCalledWith({ address: "tark1lockup", amount: 101_500 });
    });

    it("stops at 'sent' when no settlement watcher is wired", async () => {
        // Funding is acceptance, but the invoice is not paid until the solver's
        // claim witness reveals the preimage.
        rfqStub = vi.fn(async () => negotiated(101_500));
        const handle = await (
            await solverLightningRail(depsWith()).quote({ raw: INVOICE }, ctxWith())
        ).send();

        expect(await handle.settled()).toEqual({
            railId: SOLVER_LIGHTNING_RAIL,
            swapId: "rfq-ln-1",
        });
        expect(handle.status).toBe("sent");
    });

    it("surfaces the preimage when a settlement watcher is wired", async () => {
        rfqStub = vi.fn(async () => negotiated(101_500));
        const awaitSettlement = vi.fn(async () => ({ preimage: "dd".repeat(32) }));
        const handle = await (
            await solverLightningRail(depsWith({ awaitSettlement })).quote(
                { raw: INVOICE },
                ctxWith(),
            )
        ).send();

        expect(await handle.settled()).toEqual({
            railId: SOLVER_LIGHTNING_RAIL,
            swapId: "rfq-ln-1",
            preimage: "dd".repeat(32),
        });
        expect(handle.status).toBe("settled");
    });
});
