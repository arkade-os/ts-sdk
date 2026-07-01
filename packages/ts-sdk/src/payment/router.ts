import type {
    PaymentRail,
    PaymentOption,
    RouterPreferences,
    RouterContext,
    RouteQuote,
} from "./types";

/** Thrown by `route()` when several options survive and `tieBreak` is
 *  `"require-choice"` — the app must disambiguate via `options()`. */
export class AmbiguousRouteError extends Error {
    constructor(public readonly railIds: string[]) {
        super(`ambiguous route: ${railIds.join(", ")}`);
        this.name = "AmbiguousRouteError";
    }
}

/**
 * Registry-based payment router. Holds id-keyed {@link PaymentRail} entries
 * (mirroring `ActivityRegistry`): `use()` overwrites by id, `remove()` deletes.
 * It operates on the raw request string — rails self-extract their target via
 * the shared helpers. `options()` returns every matching+available rail ranked
 * by preferences; `route()` is the "take the top" convenience.
 */
export class PaymentRouter {
    private readonly rails = new Map<string, PaymentRail>();

    constructor(private readonly ctx: RouterContext) {}

    /** Register a rail (or overwrite one with the same id). */
    use(rail: PaymentRail): this {
        this.rails.set(rail.id, rail);
        return this;
    }

    /** Remove a rail by id. */
    remove(id: string): this {
        this.rails.delete(id);
        return this;
    }

    /** Rails matching `raw`, filtered by `disabled`/`available()`, ranked by
     *  `priority` (unlisted rails keep insertion order, after listed ones). */
    async options(raw: string, prefs?: RouterPreferences): Promise<PaymentOption[]> {
        const merged = { ...this.ctx.prefs, ...prefs };
        const ctx: RouterContext = { ...this.ctx, prefs: merged };

        const matched = [...this.rails.values()].filter(
            (rail) => !merged.disabled?.includes(rail.id) && rail.match(raw, ctx),
        );

        const available = (
            await Promise.all(
                matched.map(async (rail) =>
                    ((await rail.available?.(ctx)) ?? true) ? rail : null,
                ),
            )
        ).filter((rail): rail is PaymentRail => rail !== null);

        const rank = (id: string): number => {
            const i = merged.priority?.indexOf(id) ?? -1;
            return i < 0 ? Number.MAX_SAFE_INTEGER : i;
        };
        available.sort((a, b) => rank(a.id) - rank(b.id));

        return available.map((rail) => ({
            railId: rail.id,
            quote: (amount?: number) => rail.quote(raw, amount, ctx),
        }));
    }

    /** Top-ranked option's quote. Throws when nothing routes, or
     *  {@link AmbiguousRouteError} when `tieBreak` is `"require-choice"` and
     *  more than one option survives. */
    async route(raw: string, amount?: number, prefs?: RouterPreferences): Promise<RouteQuote> {
        const options = await this.options(raw, prefs);
        if (options.length === 0) {
            throw new Error(`no rail for: ${raw}`);
        }
        const tieBreak = { ...this.ctx.prefs, ...prefs }.tieBreak ?? "first";
        if (tieBreak === "require-choice" && options.length > 1) {
            throw new AmbiguousRouteError(options.map((o) => o.railId));
        }
        return options[0].quote(amount);
    }
}
