/**
 * The asset dimension on the router, and the `ark-asset` rail that needed it.
 *
 * The load-bearing fact: an Arkade address is the SAME STRING for BTC and for
 * an asset, so the target cannot tell a BTC payment from an asset one. The
 * amount names the asset. Everything here follows from that — the two rails
 * split on `available()` rather than `match()`, and a BTC-only rail handed an
 * asset request must refuse rather than pay its carrier sats and drop the
 * asset on the floor.
 */
import { describe, expect, it, vi } from "vitest";
import {
    ASSET_CARRIER_SATS,
    PaymentRouter,
    arkAssetRail,
    arkRail,
    assertNoAssets,
    assetsOf,
    createDefaultPaymentRouter,
    onchainRail,
    resolveAssetAmount,
    type Asset,
    type RouterContext,
} from "../../src";

const ARK_ADDR =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";
const USDX: Asset = { assetId: "aa".repeat(34), amount: 500n };

const ctx = (send = vi.fn(async () => "txid")): RouterContext =>
    ({ wallet: { send } as never, prefs: {} }) as RouterContext;

describe("assetsOf", () => {
    it("normalizes an absent list to []", () => {
        expect(assetsOf({ raw: ARK_ADDR })).toEqual([]);
        expect(assetsOf({ raw: ARK_ADDR, assets: [] })).toEqual([]);
        expect(assetsOf({ raw: ARK_ADDR, assets: [USDX] })).toEqual([USDX]);
    });
});

describe("assertNoAssets", () => {
    it("passes a request that names no asset", () => {
        expect(() => assertNoAssets("ark", { raw: ARK_ADDR, amount: 1000 })).not.toThrow();
    });

    it("names the asset it cannot deliver", () => {
        expect(() => assertNoAssets("ark", { raw: ARK_ADDR, assets: [USDX] })).toThrow(
            new RegExp(`cannot deliver ${USDX.assetId}`),
        );
    });
});

describe("resolveAssetAmount", () => {
    it("returns the single asset a request names", () => {
        expect(resolveAssetAmount("ark-asset", { raw: ARK_ADDR, assets: [USDX] })).toEqual(USDX);
    });

    it("refuses zero and more than one, rather than paying the first", () => {
        expect(() => resolveAssetAmount("ark-asset", { raw: ARK_ADDR })).toThrow(/got 0/);
        expect(() =>
            resolveAssetAmount("ark-asset", { raw: ARK_ADDR, assets: [USDX, USDX] }),
        ).toThrow(/got 2/);
    });

    it("refuses a non-positive quantity", () => {
        for (const amount of [0n, -1n]) {
            expect(() =>
                resolveAssetAmount("ark-asset", { raw: ARK_ADDR, assets: [{ ...USDX, amount }] }),
            ).toThrow(/invalid amount/);
        }
    });

    it("refuses a number where atomic units belong", () => {
        // The whole reason the SDK types asset amounts as bigint is that Number
        // truncates supplies past 2^53-1. A rail that accepted one would corrupt
        // the balance silently rather than fail.
        expect(() =>
            resolveAssetAmount("ark-asset", {
                raw: ARK_ADDR,
                assets: [{ assetId: USDX.assetId, amount: 500 as unknown as bigint }],
            }),
        ).toThrow(/expected a positive bigint/);
    });

    it("carries an amount past Number.MAX_SAFE_INTEGER intact", () => {
        const huge = BigInt(Number.MAX_SAFE_INTEGER) * 1000n + 7n;
        const resolved = resolveAssetAmount("ark-asset", {
            raw: ARK_ADDR,
            assets: [{ assetId: USDX.assetId, amount: huge }],
        });
        expect(resolved.amount).toBe(huge);
    });

    it("refuses an unnamed asset", () => {
        expect(() =>
            resolveAssetAmount("ark-asset", {
                raw: ARK_ADDR,
                assets: [{ assetId: "", amount: 500n }],
            }),
        ).toThrow(/must name an asset/);
    });
});

describe("arkAssetRail", () => {
    it("matches an Arkade address — the same string `ark` matches", () => {
        expect(arkAssetRail().match({ raw: ARK_ADDR, assets: [USDX] }, ctx())).toBe(true);
        expect(arkAssetRail().match({ raw: ARK_ADDR }, ctx())).toBe(true);
        expect(
            arkAssetRail().match({ raw: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080" }, ctx()),
        ).toBe(false);
    });

    it("is available only for a request that names an asset", async () => {
        expect(await arkAssetRail().available?.({ raw: ARK_ADDR, assets: [USDX] }, ctx())).toBe(
            true,
        );
        expect(await arkAssetRail().available?.({ raw: ARK_ADDR, amount: 1000 }, ctx())).toBe(
            false,
        );
    });

    it("quotes the asset on both sides — an off-chain transfer costs no asset", async () => {
        const quote = await arkAssetRail().quote({ raw: ARK_ADDR, assets: [USDX] }, ctx());
        expect(quote.assets).toEqual({ delivered: USDX, spent: USDX });
        expect(quote.fee).toBe(0);
    });

    it("quotes the CARRIER sats, not zero", async () => {
        // An asset does not move on its own: `total` is what leaves the wallet,
        // and the sats-carrying output leaves it too.
        const quote = await arkAssetRail().quote({ raw: ARK_ADDR, assets: [USDX] }, ctx());
        expect(quote.amount).toBe(ASSET_CARRIER_SATS);
        expect(quote.total).toBe(ASSET_CARRIER_SATS);
    });

    it("honours an explicit carrier amount", async () => {
        const quote = await arkAssetRail().quote(
            { raw: ARK_ADDR, amount: 5_000, assets: [USDX] },
            ctx(),
        );
        expect(quote.total).toBe(5_000);
    });

    it("sends the asset alongside the carrier, in one Recipient", async () => {
        const send = vi.fn(async () => "the-txid");
        const quote = await arkAssetRail().quote({ raw: ARK_ADDR, assets: [USDX] }, ctx(send));
        const result = await (await quote.send()).settled();

        expect(send).toHaveBeenCalledWith({
            address: ARK_ADDR,
            amount: ASSET_CARRIER_SATS,
            assets: [USDX],
        });
        expect(result).toEqual({ railId: "ark-asset", txid: "the-txid" });
    });

    it("refuses a malformed asset at quote time with a named error", async () => {
        // Not a silent drop: `available()` said this rail is the one, so the
        // reason it cannot pay has to be legible.
        await expect(
            arkAssetRail().quote({ raw: ARK_ADDR, assets: [USDX, USDX] }, ctx()),
        ).rejects.toThrow(/exactly one asset/);
    });
});

describe("the BTC-only rails refuse an asset rather than dropping it", () => {
    it("ark drops itself, and refuses if reached directly", async () => {
        const req = { raw: ARK_ADDR, amount: 1000, assets: [USDX] };
        expect(await arkRail().available?.(req, ctx())).toBe(false);
        // The failure this prevents: paying 1000 sats, reporting success, and
        // delivering none of the asset the user asked for.
        await expect(arkRail().quote(req, ctx())).rejects.toThrow(/cannot deliver/);
    });

    it("onchain drops itself — an Arkade asset has no L1 form to offboard to", async () => {
        const btc = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
        expect(
            await onchainRail().available?.({ raw: btc, amount: 1000, assets: [USDX] }, ctx()),
        ).toBe(false);
    });
});

describe("the default router routes on the amount, not the target", () => {
    const router = () => createDefaultPaymentRouter({ send: vi.fn() } as never);

    it("sends a BTC request to `ark` and an asset request to `ark-asset`", async () => {
        // Same address string, two different rails: the amount is what chose.
        expect(
            (await router().options({ raw: ARK_ADDR, amount: 1000 })).map((o) => o.railId),
        ).toEqual(["ark"]);
        expect(
            (await router().options({ raw: ARK_ADDR, assets: [USDX] })).map((o) => o.railId),
        ).toEqual(["ark-asset"]);
    });

    it("never offers both, so their relative priority cannot matter", async () => {
        for (const req of [
            { raw: ARK_ADDR, amount: 1000 },
            { raw: ARK_ADDR, assets: [USDX] },
        ]) {
            const ids = (await router().options(req)).map((o) => o.railId);
            expect(ids.filter((id) => id === "ark" || id === "ark-asset")).toHaveLength(1);
        }
    });

    it("route() picks the asset rail without a preference being set", async () => {
        const quote = await new PaymentRouter({
            wallet: { send: vi.fn(async () => "txid") } as never,
            prefs: {},
        })
            .use(arkRail())
            .use(arkAssetRail())
            .route({ raw: ARK_ADDR, assets: [USDX] });

        expect(quote.railId).toBe("ark-asset");
        expect(quote.assets?.delivered).toEqual(USDX);
    });
});
