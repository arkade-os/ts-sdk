import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    CSVMultisigTapscript,
    networks,
    type ArkadeInfo,
    type EmulatorProvider,
} from "@arkade-os/sdk";
import {
    buyCloses,
    fillAllowed,
    fillOrder,
    orderContract,
    planFill,
    settleExpiredOrder,
    type Order,
    type OrderTerms,
} from "../src/orders";

const xOnly = (seed: number) => schnorr.getPublicKey(new Uint8Array(32).fill(seed));
const SERVER = xOnly(1);
const MAKER = xOnly(2);
const ASSET = "aa".repeat(32) + "0100";

const connect = () =>
    arkade.Arkade.connect({
        arkade: {
            getInfo: async () =>
                ({
                    signerPubkey: "02" + hex.encode(SERVER),
                    checkpointTapscript: hex.encode(
                        CSVMultisigTapscript.encode({
                            timelock: { type: "blocks", value: 10n },
                            pubkeys: [SERVER],
                        }).script,
                    ),
                    unilateralExitDelay: 2048n,
                }) as ArkadeInfo,
        },
        emulator: {} as EmulatorProvider,
        network: networks.regtest,
    });

const terms = (t: Partial<OrderTerms> = {}): OrderTerms => ({
    side: "sell",
    maker: MAKER,
    makerScript: new Uint8Array([0x51, 0x20, ...MAKER]),
    assetId: ASSET,
    priceSats: 100n,
    minFill: 1n,
    expiresAt: 0n,
    reserveSats: 330n,
    ...t,
});

describe("orderContract", () => {
    it("derives one address per terms, distinct per side and asset group", async () => {
        const client = await connect();
        const sell = orderContract(client, terms()).address;
        expect(orderContract(await connect(), terms()).address).toBe(sell);
        expect(orderContract(client, terms({ side: "buy" })).address).not.toBe(sell);
        const gidx0 = terms({ assetId: "aa".repeat(32) + "0000" });
        expect(orderContract(client, gidx0).address).not.toBe(sell);
    });

    it.each([
        [
            "a non-P2TR maker script",
            { makerScript: new Uint8Array([0x00, 0x14, ...MAKER.slice(12)]) },
        ],
        ["a zero price", { priceSats: 0n }],
        ["a zero min fill", { minFill: 0n }],
        ["a negative expiry", { expiresAt: -1n }],
    ])("rejects %s", async (_, bad) => {
        const client = await connect();
        expect(() => orderContract(client, terms(bad))).toThrow();
    });
});

// The `require`s of sell_order.ark and buy_order.ark `fill`, transcribed one by one.
const sellCovenant = (t: OrderTerms, remaining: bigint, qty: bigint) =>
    qty > 0n &&
    qty <= remaining &&
    (qty >= t.minFill || qty === remaining) &&
    qty * t.priceSats >= 330n &&
    (qty === remaining || (remaining - qty) * t.priceSats >= 330n);
const buyCovenant = (t: OrderTerms, left: bigint, qty: bigint) =>
    qty > 0n &&
    left >= 0n &&
    qty * t.priceSats >= 330n &&
    (qty >= t.minFill || left < t.minFill * t.priceSats || left < 330n);
// The branch of buy_order.ark's "continuation" require that pays the maker.
const buyPaysMaker = (t: OrderTerms, left: bigint) => left < t.minFill * t.priceSats || left < 330n;

describe("fillAllowed and buyCloses", () => {
    it("agree with the covenant on random terms, biased to the 330-sat edges", () => {
        let s = 7;
        const rand = (n: number) => {
            s ^= s << 13;
            s ^= s >>> 17;
            s ^= s << 5;
            return BigInt((s >>> 0) % n);
        };
        const pick = (xs: bigint[]) => xs[Number(rand(xs.length))];
        for (let i = 0; i < 20_000; i++) {
            const t = terms({
                side: i % 2 ? "sell" : "buy",
                priceSats: 1n + rand(800),
                minFill: 1n + rand(12),
                reserveSats: rand(700),
            });
            const qty = rand(45) - 2n;
            const edge = 330n / t.priceSats;
            const rest = pick([0n, 1n, edge, edge + 1n, rand(40) - 3n]);
            const minFillSats = t.minFill * t.priceSats;
            const left = pick([0n, -1n, 329n, 330n, minFillSats - 1n, minFillSats, rand(9_000)]);
            const held = {
                units: qty + rest,
                value: qty * t.priceSats + t.reserveSats + left,
            };
            const label = `${t.side} price ${t.priceSats} min ${t.minFill} qty ${qty}`;
            if (t.side === "sell") {
                expect(fillAllowed(t, held, qty), label).toBe(sellCovenant(t, held.units, qty));
                continue;
            }
            const ok = buyCovenant(t, left, qty);
            expect(fillAllowed(t, held, qty), label).toBe(ok);
            if (ok) expect(buyCloses(t, left), label).toBe(buyPaysMaker(t, left));
        }
    });
});

const NOW = 1_000_000;
let vout = 0;
const sell = (price: bigint, units: bigint, t: Partial<OrderTerms> = {}): Order => ({
    terms: terms({ priceSats: price, ...t }),
    coin: {
        txid: "11".repeat(32),
        vout: vout++,
        value: 330,
        assets: [{ assetId: ASSET, amount: units }],
    },
});
const buy = (price: bigint, units: bigint, t: Partial<OrderTerms> = {}): Order => ({
    terms: terms({ side: "buy", priceSats: price, ...t }),
    coin: { txid: "22".repeat(32), vout: vout++, value: Number(units * price + 330n), assets: [] },
});
const legs = (p: ReturnType<typeof planFill>) =>
    p.legs.map((l) => [l.order.terms.priceSats, l.qty]);

describe("planFill", () => {
    it("buys cheapest first and never overfills", () => {
        const p = planFill([sell(600n, 5n), sell(550n, 2n), buy(500n, 9n)], "buy", 4n, NOW);
        expect(legs(p)).toEqual([
            [550n, 2n],
            [600n, 2n],
        ]);
        expect(p.notional).toBe(2300n);
        expect(p.depth).toBe(7n);
    });

    it("takes an ask below its min fill only to empty it, and skips expiring ones", () => {
        const book = [
            sell(500n, 10n, { minFill: 5n }),
            sell(510n, 3n, { minFill: 3n }),
            sell(400n, 9n, { expiresAt: BigInt(NOW + 10) }),
        ];
        expect(legs(planFill(book, "buy", 3n, NOW))).toEqual([[510n, 3n]]);
    });

    it("sells into a bid below its min fill only when that closes it", () => {
        const p = planFill(
            [buy(400n, 10n, { minFill: 4n }), buy(450n, 2n, { minFill: 3n })],
            "sell",
            3n,
            NOW,
        );
        expect(legs(p)).toEqual([[450n, 2n]]);
        expect(p.qty).toBe(2n);
        expect(planFill([], "buy", 1n, NOW).legs).toEqual([]);
    });

    it("keeps every fill and every sell remainder at 330 sats or more", () => {
        expect(planFill([sell(100n, 10n)], "buy", 3n, NOW).legs).toEqual([]);
        expect(legs(planFill([sell(100n, 10n)], "buy", 9n, NOW))).toEqual([[100n, 6n]]);
        expect(legs(planFill([sell(100n, 10n)], "buy", 10n, NOW))).toEqual([[100n, 10n]]);
    });
});

describe("refusals before anything is built", () => {
    const taker = { fund: [], change: new Uint8Array([0x51, 0x20, ...SERVER]) };

    it("refuses a fill that leaves a sell remainder under 330 sats", async () => {
        await expect(fillOrder(await connect(), sell(100n, 10n), 9n, taker)).rejects.toThrow(
            "order refuses a fill of 9",
        );
    });

    it("refuses to fill an expired order, and to settle a live one", async () => {
        const client = await connect();
        const past = sell(100n, 10n, { expiresAt: 1n });
        await expect(fillOrder(client, past, 10n, taker)).rejects.toThrow("order has expired");
        const live = sell(100n, 10n, { expiresAt: BigInt(Date.now()) });
        await expect(settleExpiredOrder(client, live)).rejects.toThrow("order has not expired");
    });
});
