/**
 * `crossAssetRail` — pay an asset the wallet does not hold.
 *
 * The claim under test is the design one: **swap-then-pay fits inside a rail**,
 * with no router composition primitive. Both legs are priced into one
 * `RouteQuote`, the swap is reported on `RouteResult.swapId`, and the router is
 * unchanged. The tests that matter are therefore about the seams that would
 * otherwise leak into the router:
 *
 * - the quote names two DIFFERENT assets (`spent` BTC, `delivered` the asset),
 *   which is the reason `RouteQuote.assets` is a pair rather than a triple;
 * - the rail does not route when no corridor exists — it drops, it does not
 *   quote a swap nobody can fill;
 * - the recipient is paid only AFTER the fill, never before.
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket, OfferPlan, Side } from "@arkade-os/solver-discovery";
import { PaymentRouter, type Asset, type RouterContext } from "@arkade-os/sdk";
import {
    CROSS_ASSET_RAIL,
    crossAssetRail,
    type CrossAssetRailDeps,
    type CrossAssetSwap,
} from "../../src/payment/crossAsset";

const ARK_ADDR =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";
// A real asset id: 34 bytes of hex. `AssetId.fromString` rejects anything
// else, and `createOffer` binds `.txid`/`.groupIndex` off the parsed value.
const USDX_ID = "aa".repeat(34);
const USDX: Asset = { assetId: USDX_ID, amount: 500n };

/** A BTC/USDX market: BTC is the base (the side this rail gives). */
const market = (over: Record<string, unknown> = {}) =>
    ({
        pair: "BTC/USDX",
        base_asset: { id: "btc", decimals: 8 },
        quote_asset: { id: USDX_ID, decimals: 2 },
        min_base_amount: "1",
        max_base_amount: "100000000",
        min_quote_amount: "1",
        max_quote_amount: "100000000",
        ...over,
    }) as unknown as DiscoveredMarket;

const plan = (depositSats: bigint, receive: bigint): OfferPlan =>
    ({
        market: market(),
        give: "base" as Side,
        deposit: { atomic: depositSats, asset: { id: "btc", decimals: 8 } },
        receive: { atomic: receive, asset: { id: USDX_ID, decimals: 2 } },
        priceDisplay: "0.00020000",
        safetyBps: 0,
        limits: {
            min: { atomic: 1n, asset: { id: USDX_ID, decimals: 2 } },
            max: { atomic: 100_000_000n, asset: { id: USDX_ID, decimals: 2 } },
            withinLimits: true,
        },
    }) as unknown as OfferPlan;

const ctxWith = (send = vi.fn(async () => "txid")): RouterContext =>
    ({ wallet: { send } as never, prefs: {} }) as RouterContext;

const depsWith = (over: Partial<CrossAssetRailDeps> = {}): CrossAssetRailDeps => ({
    arkServerUrl: "http://ark",
    discover: vi.fn(async () => [market()]),
    quote: vi.fn(async () => plan(100_000n, 500n)),
    btcBalance: vi.fn(async () => 1_000_000n),
    dust: vi.fn(async () => 330n),
    persist: vi.fn(async () => {}),
    awaitFill: vi.fn(async () => {}),
    ...over,
});

const offer = {
    offerHex: "0fe0",
    address: "tark1offer",
    swapPkScript: new Uint8Array([0x51, 0x20]),
    extension: { type: 1, payload: new Uint8Array([1]) },
};

vi.mock("../../src/offer", async (importOriginal) => {
    const mod = await importOriginal<typeof import("../../src/offer")>();
    return { ...mod, createOffer: (...args: unknown[]) => offerStub(...args) };
});

let offerStub: (...args: unknown[]) => Promise<unknown> = async () => offer;

describe("crossAssetRail.match", () => {
    it("matches an Arkade address, like every rail that pays one", () => {
        const rail = crossAssetRail(depsWith());
        expect(rail.match({ raw: ARK_ADDR, assets: [USDX] }, ctxWith())).toBe(true);
        expect(rail.match({ raw: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080" }, ctxWith())).toBe(
            false,
        );
    });
});

describe("crossAssetRail.available", () => {
    const req = { raw: ARK_ADDR, assets: [USDX] };

    it("is available when a market swaps BTC into the asset and the balance covers it", async () => {
        expect(await crossAssetRail(depsWith()).available?.(req, ctxWith())).toBe(true);
    });

    it("does not route when no corridor exists", async () => {
        // The load-bearing negative: with no market there is nothing to quote,
        // and a rail that quoted anyway would be selling a swap nobody can fill.
        const deps = depsWith({ discover: vi.fn(async () => []) });
        expect(await crossAssetRail(deps).available?.(req, ctxWith())).toBe(false);
    });

    it("does not route an asset/asset market — the BTC keying is the restriction", async () => {
        // `createOffer` is BTC<->asset only. What enforces that is `findMarket`
        // being keyed on BTC: it matches asset ids EXACTLY in either
        // orientation, so a EURX/USDX market is never returned for
        // `(btc, USDX)` however well it connects the two. There is deliberately
        // no give-side check in the rail — one would be unreachable.
        const eurx = market({ base_asset: { id: "bb".repeat(34), decimals: 2 } });
        const deps = depsWith({ discover: vi.fn(async () => [eurx]) });
        expect(await crossAssetRail(deps).available?.(req, ctxWith())).toBe(false);
    });

    it("routes a market that names BTC on either side", async () => {
        // The mirror of the above: BTC as the QUOTE asset is the same corridor
        // read the other way round, and `findMarket` reports `give: "quote"`.
        const inverted = market({
            base_asset: { id: USDX_ID, decimals: 2 },
            quote_asset: { id: "btc", decimals: 8 },
        });
        const quoteFn = vi.fn(async () => plan(100_000n, 500n));
        const deps = depsWith({ discover: vi.fn(async () => [inverted]), quote: quoteFn });
        expect(await crossAssetRail(deps).available?.(req, ctxWith())).toBe(true);
        expect(quoteFn.mock.calls[0][1]).toBe("quote");
    });

    it("does not route when the BTC balance cannot fund the deposit", async () => {
        const deps = depsWith({ btcBalance: vi.fn(async () => 1_000n) });
        expect(await crossAssetRail(deps).available?.(req, ctxWith())).toBe(false);
    });

    it("does not route a plan outside the market's own limits", async () => {
        const deps = depsWith({
            quote: vi.fn(async () => {
                const p = plan(100_000n, 500n);
                return { ...p, limits: { ...p.limits, withinLimits: false } } as OfferPlan;
            }),
        });
        expect(await crossAssetRail(deps).available?.(req, ctxWith())).toBe(false);
    });

    it("does not route a BTC 'asset', and does not ask the registry about it", async () => {
        // That is `ark`'s payment, and there is no corridor from BTC to BTC.
        // The check is up front for a reason: a plain BTC send must not put a
        // registry round trip on the availability path of every other rail.
        const discover = vi.fn(async () => [market()]);
        expect(
            await crossAssetRail(depsWith({ discover })).available?.(
                { raw: ARK_ADDR, assets: [{ assetId: "btc", amount: 500n }] },
                ctxWith(),
            ),
        ).toBe(false);
        expect(discover).not.toHaveBeenCalled();
    });

    it("does not route a request naming no asset, or more than one, without a lookup", async () => {
        const discover = vi.fn(async () => [market()]);
        const rail = crossAssetRail(depsWith({ discover }));
        expect(await rail.available?.({ raw: ARK_ADDR, amount: 1000 }, ctxWith())).toBe(false);
        expect(await rail.available?.({ raw: ARK_ADDR, assets: [USDX, USDX] }, ctxWith())).toBe(
            false,
        );
        // Every BTC-only payment in the wallet passes through here.
        expect(discover).not.toHaveBeenCalled();
    });

    it("does not route an asset id createOffer could not bind", async () => {
        // 32 bytes reads like an id and is not one — they are 34. Dropping here
        // is what stops the failure landing at send time, with an offer funded.
        const discover = vi.fn(async () => [market()]);
        const rail = crossAssetRail(depsWith({ discover }));
        expect(
            await rail.available?.(
                { raw: ARK_ADDR, assets: [{ assetId: "aa".repeat(32), amount: 500n }] },
                ctxWith(),
            ),
        ).toBe(false);
        expect(discover).not.toHaveBeenCalled();
    });

    it("does not route a non-positive or non-bigint quantity", async () => {
        const rail = crossAssetRail(depsWith());
        expect(
            await rail.available?.({ raw: ARK_ADDR, assets: [{ ...USDX, amount: 0n }] }, ctxWith()),
        ).toBe(false);
        expect(
            await rail.available?.(
                { raw: ARK_ADDR, assets: [{ assetId: USDX_ID, amount: 500 as unknown as bigint }] },
                ctxWith(),
            ),
        ).toBe(false);
    });

    it("drops the rail, not the router, when discovery throws", async () => {
        const deps = depsWith({
            discover: vi.fn(async () => {
                throw new Error("registry unreachable");
            }),
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const options = await new PaymentRouter({ wallet: {} as never, prefs: {} })
                .use(crossAssetRail(deps))
                .options(req);
            expect(options).toEqual([]);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe("crossAssetRail.quote", () => {
    const req = { raw: ARK_ADDR, assets: [USDX] };

    it("names two different assets: BTC spent, the asset delivered", async () => {
        // This is why `RouteQuote.assets` is a pair and not a third
        // amount/fee/total triple — `total = amount + fee` cannot hold across
        // two units.
        const quote = await crossAssetRail(depsWith()).quote(req, ctxWith());
        expect(quote.assets?.delivered).toEqual(USDX);
        expect(quote.assets?.spent).toEqual({ assetId: "btc", amount: 100_000n });
        expect(quote.assets?.spent.assetId).not.toBe(quote.assets?.delivered.assetId);
    });

    it("prices BOTH legs into the sats that leave the wallet", async () => {
        // The swap deposit AND the delivery carrier: `total` means the same
        // thing here as on every other rail.
        const quote = await crossAssetRail(depsWith({ carrierSats: 330 })).quote(req, ctxWith());
        expect(quote).toMatchObject({ amount: 330, fee: 100_000, total: 100_330 });
    });

    it("asks the market for the amount the recipient must receive", async () => {
        const quoteFn = vi.fn(async () => plan(100_000n, 500n));
        await crossAssetRail(depsWith({ quote: quoteFn })).quote(req, ctxWith());
        expect(quoteFn.mock.calls[0][2]).toBe(500n);
    });

    it("refuses, with the corridor named, when no market swaps into the asset", async () => {
        const deps = depsWith({ discover: vi.fn(async () => []) });
        await expect(crossAssetRail(deps).quote(req, ctxWith())).rejects.toThrow(
            new RegExp(`no market swaps BTC into ${USDX_ID}`),
        );
    });

    it("refuses with the plan's own reason when the plan is unusable", async () => {
        const deps = depsWith({ btcBalance: vi.fn(async () => 1_000n) });
        await expect(crossAssetRail(deps).quote(req, ctxWith())).rejects.toThrow(
            /insufficient-balance/,
        );
    });
});

describe("crossAssetRail.send", () => {
    const req = { raw: ARK_ADDR, assets: [USDX] };

    it("funds the offer, waits for the fill, then pays the recipient — in that order", async () => {
        const order: string[] = [];
        offerStub = async () => offer;
        const send = vi.fn(async (r: { address: string }) => {
            order.push(r.address === offer.address ? "fund-offer" : "pay-recipient");
            return "txid";
        });
        const deps = depsWith({
            persist: vi.fn(async () => {
                order.push("persist");
            }),
            awaitFill: vi.fn(async () => {
                order.push("await-fill");
            }),
        });

        const quote = await crossAssetRail(deps).quote(req, ctxWith(send as never));
        await (await quote.send()).settled();

        expect(order).toEqual(["persist", "fund-offer", "await-fill", "pay-recipient"]);
    });

    it("does not pay the recipient when the fill never lands", async () => {
        // The asset is not in the wallet until a filler delivers it; paying
        // before that is a send that cannot be funded.
        offerStub = async () => offer;
        const send = vi.fn(async () => "txid");
        const deps = depsWith({
            awaitFill: vi.fn(async () => {
                throw new Error("offer expired");
            }),
        });

        const quote = await crossAssetRail(deps).quote(req, ctxWith(send as never));
        await expect((await quote.send()).settled()).rejects.toThrow(/offer expired/);
        // Only the offer deposit went out.
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toMatchObject({ address: offer.address });
    });

    it("does not fund the offer when the record could not be written", async () => {
        // `cancelOffer` rebuilds the covenant from `offerHex` and nothing else.
        offerStub = async () => offer;
        const send = vi.fn(async () => "txid");
        const deps = depsWith({
            persist: vi.fn(async () => {
                throw new Error("storage full");
            }),
        });

        const quote = await crossAssetRail(deps).quote(req, ctxWith(send as never));
        await expect((await quote.send()).settled()).rejects.toThrow(/storage full/);
        expect(send).not.toHaveBeenCalled();
    });

    it("deposits the planned sats into the offer, with the offer extension", async () => {
        offerStub = async () => offer;
        const send = vi.fn(async () => "txid");
        const quote = await crossAssetRail(depsWith()).quote(req, ctxWith(send as never));
        await (await quote.send()).settled();

        expect(send.mock.calls[0][0]).toEqual({
            address: offer.address,
            amount: 100_000,
            extensions: [offer.extension],
        });
    });

    it("pays the recipient the asset, on the carrier the quote named", async () => {
        offerStub = async () => offer;
        const send = vi.fn(async () => "pay-txid");
        const quote = await crossAssetRail(depsWith({ carrierSats: 546 })).quote(
            req,
            ctxWith(send as never),
        );
        const result = await (await quote.send()).settled();

        expect(send.mock.calls[1][0]).toEqual({
            address: ARK_ADDR,
            amount: 546,
            assets: [USDX],
        });
        expect(result).toEqual({
            railId: CROSS_ASSET_RAIL,
            txid: "pay-txid",
            swapId: offer.offerHex,
        });
    });

    it("hands createOffer a parsed AssetId, not the hex string", async () => {
        // `createOffer` binds `.txid` and `.groupIndex` off this value to build
        // the covenant. A raw `Asset.assetId` string has neither, so it would
        // publish an offer with an undefined want-asset rather than throw —
        // an offer nobody can fill and the user has funded.
        let seen: unknown;
        offerStub = async (..._args: unknown[]) => {
            seen = (_args[2] as { wantAsset?: unknown }).wantAsset;
            return offer;
        };
        const quote = await crossAssetRail(depsWith()).quote(req, ctxWith());
        await (await quote.send()).settled();

        const want = seen as { txid: Uint8Array; groupIndex: number; toString(): string };
        expect(want.txid).toBeInstanceOf(Uint8Array);
        expect(typeof want.groupIndex).toBe("number");
        expect(want.toString()).toBe(USDX_ID);
    });

    it("hands the fill watcher the record it persisted", async () => {
        offerStub = async () => offer;
        const persisted: CrossAssetSwap[] = [];
        const awaitFill = vi.fn(async (swap: CrossAssetSwap) => {
            expect(swap).toBe(persisted[0]);
        });
        const quote = await crossAssetRail(
            depsWith({
                persist: vi.fn(async (s: CrossAssetSwap) => {
                    persisted.push(s);
                }),
                awaitFill,
            }),
        ).quote(req, ctxWith());
        await (await quote.send()).settled();

        expect(persisted[0]).toMatchObject({
            offerHex: offer.offerHex,
            depositSats: 100_000,
            payTo: ARK_ADDR,
            asset: USDX,
        });
    });
});

describe("no BTC-only rail silently drops an asset", () => {
    // The failure this closes: a request for 500 USDX handed to a BTC rail
    // would pay its carrier sats, report success, and deliver none of the asset
    // the user asked for. Every rail that moves BTC must drop instead, so the
    // router is free to rank one that can.
    it("solver-onchain and solver-lightning both drop an asset request", async () => {
        const { solverOnchainRail } = await import("../../src/payment/solverOnchain");
        const { solverLightningRail } = await import("../../src/payment/solverLightning");
        const btc = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

        const onchain = solverOnchainRail({
            arkServerUrl: "http://ark",
            l1Network: "regtest",
            payoutPubkey: new Uint8Array(32).fill(15),
            discover: vi.fn(async () => []),
            connect: vi.fn(async (_r, fn) => fn({} as never)),
            persist: vi.fn(async () => {}),
        });
        expect(
            await onchain.available?.({ raw: btc, amount: 1000, assets: [USDX] }, ctxWith()),
        ).toBe(false);
        await expect(
            onchain.quote({ raw: btc, amount: 1000, assets: [USDX] }, ctxWith()),
        ).rejects.toThrow(/cannot deliver/);

        const lightning = solverLightningRail({
            arkServerUrl: "http://ark",
            decodeInvoice: () => ({
                raw: "lnbcrt1u1p",
                paymentHash: "cc".repeat(32),
                amountSats: 100_000,
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
            discover: vi.fn(async () => []),
            connect: vi.fn(async (_r, fn) => fn({} as never)),
            persist: vi.fn(async () => {}),
        });
        const lnReq = { raw: "lnbcrt1u1pjexampleinvoice", assets: [USDX] };
        expect(await lightning.available?.(lnReq, ctxWith())).toBe(false);
        await expect(lightning.quote(lnReq, ctxWith())).rejects.toThrow(/cannot deliver/);
    });
});
