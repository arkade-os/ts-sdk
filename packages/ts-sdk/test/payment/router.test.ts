import { describe, it, expect } from "vitest";
import { PaymentRouter, AmbiguousRouteError } from "../../src/payment/router";
import type { PaymentRail, RouterContext } from "../../src/payment/types";

/** A fake rail with no Wallet dependency — exercises the registry/ranking only. */
const rail = (id: string, matches: boolean, avail = true): PaymentRail => ({
    id,
    match: () => matches,
    available: () => avail,
    quote: async () => ({
        railId: id,
        amount: 1,
        fee: 0,
        total: 1,
        send: async () => ({ id, status: "pending" }) as any,
    }),
});

const ctx: RouterContext = { wallet: {} as any, prefs: {} };

describe("PaymentRouter", () => {
    it("ranks matching+available rails by priority", async () => {
        const r = new PaymentRouter(ctx)
            .use(rail("onchain", true))
            .use(rail("ark", true))
            .use(rail("lightning", true));
        const opts = await r.options("bitcoin:x?ark=a&lightning=l", {
            priority: ["ark", "lightning", "onchain"],
        });
        expect(opts.map((o) => o.railId)).toEqual(["ark", "lightning", "onchain"]);
    });

    it("places unlisted rails after listed ones (stable)", async () => {
        const r = new PaymentRouter(ctx)
            .use(rail("vendor:x", true))
            .use(rail("ark", true))
            .use(rail("onchain", true));
        const opts = await r.options("x", { priority: ["ark"] });
        expect(opts.map((o) => o.railId)).toEqual(["ark", "vendor:x", "onchain"]);
    });

    it("drops non-matching + unavailable + disabled rails", async () => {
        const r = new PaymentRouter(ctx)
            .use(rail("ark", true))
            .use(rail("lightning", false)) // does not match
            .use(rail("onchain", true, false)); // not available
        const opts = await r.options("x", { disabled: ["onchain"] });
        expect(opts.map((o) => o.railId)).toEqual(["ark"]);
    });

    it("route() returns the top-ranked option's quote (default tieBreak first)", async () => {
        const r = new PaymentRouter(ctx).use(rail("onchain", true)).use(rail("ark", true));
        const quote = await r.route("x", undefined, { priority: ["ark", "onchain"] });
        expect(quote.railId).toBe("ark");
    });

    it("route() throws when no rail matches", async () => {
        const r = new PaymentRouter(ctx).use(rail("ark", false));
        await expect(r.route("x")).rejects.toThrow(/no rail/i);
    });

    it("route() throws AmbiguousRouteError when require-choice and >1 option", async () => {
        const r = new PaymentRouter(ctx).use(rail("ark", true)).use(rail("lightning", true));
        await expect(r.route("x", undefined, { tieBreak: "require-choice" })).rejects.toThrow(
            AmbiguousRouteError,
        );
    });

    it("remove() and use()-overwrite by id (registry semantics)", async () => {
        const r = new PaymentRouter(ctx)
            .use(rail("ark", true))
            .use(rail("ark", false)) // overwrite: same id now does not match
            .use(rail("onchain", true));
        r.remove("onchain");
        const opts = await r.options("x");
        expect(opts.map((o) => o.railId)).toEqual([]);
    });
});
