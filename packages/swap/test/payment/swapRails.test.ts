/**
 * The two v2 swap rails: conformance, ranking, and the handle's contract.
 *
 * The client behind them is a double. What is under test here is the adapter —
 * what `match` classifies, when `available()` drops the rail, that `quote()` is
 * the first place an amount is refused, that the three numbers are
 * receiver-exact, and what a handle observes and stops observing. The swap
 * machinery those calls stand for is pinned by `test/client/`.
 */
import { describe, expect, it, vi } from "vitest";
import { PaymentRouter, arkRail, onchainRail, type PaymentHandle } from "@arkade-os/sdk";
import { ArkAddress } from "@arkade-os/sdk";
import { UnsupportedRoute } from "../../src/client/errors";
import type { Outcome, SwapUpdate, Unsubscribe } from "../../src/client/outcome";
import type { Quote, QuoteInput, RouteResolution } from "../../src/client/quote";
import type { Swap } from "../../src/client/record";
import { LIGHTNING_RAIL, lightningRail } from "../../src/payment/lightning";
import { ONCHAIN_SWAP_RAIL, claimFeeSats, onchainSwapRail } from "../../src/payment/onchainSwap";
import { SWAP_ROUTER_PRIORITY, createSwapPaymentRouter } from "../../src/payment/router";
import { SwapPaymentFailedError, type SwapRailClient } from "../../src/payment/swapRail";
import { ONCHAIN_CLAIM_VSIZE } from "../../src/onchainHtlc";
import {
    NETWORK,
    OPERATOR_PUBKEY,
    PAYMENT_HASH,
    clockAt,
    invoiceFor,
    key,
} from "../client/fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const INVOICE = invoiceFor(PAYMENT_HASH, CLOCK);
const ARK_ADDRESS = new ArkAddress(OPERATOR_PUBKEY, key(21), NETWORK.hrp).encode();

/** 1 sat/vB, so the claim estimate is the vsize itself. */
const CLAIM_RATE = 1;
const CLAIM_FEE = claimFeeSats({ claimFeeRateSatVb: CLAIM_RATE });

const ARKADE_BTC = "arkade:regtest/slip44:0" as const;
const BOLT11_BTC = "bolt11:regtest/slip44:0" as const;
const BITCOIN_BTC = "bitcoin:regtest/slip44:0" as const;

const quoteFor = (give: bigint, take: bigint, takeAsset: string): Quote =>
    ({
        id: "q1",
        route: {} as Quote["route"],
        give: { asset: ARKADE_BTC, amount: give },
        take: { asset: takeAsset, amount: take },
        fee: { asset: ARKADE_BTC, amount: give - take },
        market: { kind: "card", key: "arkade:BTC/lightning:BTC" },
        expiresAt: NOW + 600,
    }) as unknown as Quote;

const swapFor = (over: Partial<Swap> = {}): Swap =>
    ({ id: "rfq:q1", family: "rfq", outcome: "accepted", ...over }) as Swap;

interface Double extends SwapRailClient {
    /** Push an outcome onto every subscriber, as the drive's `emit` would. */
    emit(outcome: Outcome, swap?: Partial<Swap>): void;
    inputs(): QuoteInput[];
    listeners(): number;
}

const double = (
    over: Partial<SwapRailClient> & { eligible?: number; quoted?: Quote } = {},
): Double => {
    const inputs: QuoteInput[] = [];
    const subscribers = new Set<(u: SwapUpdate) => void>();
    let replay: SwapUpdate | undefined;
    const client: Double = {
        resolve: async (input) => {
            inputs.push(input);
            return { eligible: over.eligible ?? 1 } as RouteResolution;
        },
        quote: async (input) => {
            inputs.push(input);
            return over.quoted ?? quoteFor(5_050n, 5_000n, BOLT11_BTC);
        },
        accept: async () => swapFor(),
        onUpdate: (fn): Unsubscribe => {
            subscribers.add(fn);
            if (replay) fn(replay);
            return () => subscribers.delete(fn);
        },
        emit: (outcome, swap = {}) => {
            const update = {
                swap: swapFor({ outcome, ...swap }),
                outcome,
                detail: { family: "rfq" },
            } as SwapUpdate;
            replay = update;
            for (const fn of [...subscribers]) fn(update);
        },
        inputs: () => inputs,
        listeners: () => subscribers.size,
        ...over,
    };
    return client;
};

/** A wallet stub: `options()` never quotes, so no rail dereferences it. */
const ctxWallet = {} as never;

describe("rail conformance", () => {
    it("classifies amount-blind and without throwing", () => {
        const ln = lightningRail(double());
        const l1 = onchainSwapRail(double(), { claimFeeRateSatVb: CLAIM_RATE });
        const ctx = { wallet: ctxWallet, prefs: {} };
        for (const [rail, mine, theirs] of [
            [ln, INVOICE, BCRT1],
            [l1, BCRT1, INVOICE],
        ] as const) {
            expect(rail.match({ raw: mine }, ctx)).toBe(true);
            expect(rail.match({ raw: mine, amount: 1 }, ctx)).toBe(true);
            expect(rail.match({ raw: theirs }, ctx)).toBe(false);
            expect(rail.match({ raw: ARK_ADDRESS }, ctx)).toBe(false);
            expect(() => rail.match({ raw: "nonsense" }, ctx)).not.toThrow();
        }
    });

    it("reads both rails' targets out of a unified BIP21 URI", () => {
        const ctx = { wallet: ctxWallet, prefs: {} };
        const uri = `bitcoin:${BCRT1}?lightning=${INVOICE}`;
        expect(lightningRail(double()).match({ raw: uri }, ctx)).toBe(true);
        expect(
            onchainSwapRail(double(), { claimFeeRateSatVb: CLAIM_RATE }).match({ raw: uri }, ctx),
        ).toBe(true);
    });

    it("never quotes to answer available()", async () => {
        const client = double();
        const quote = vi.spyOn(client, "quote");
        const ctx = { wallet: ctxWallet, prefs: {} };
        await lightningRail(client).available?.({ raw: INVOICE }, ctx);
        await onchainSwapRail(client, { claimFeeRateSatVb: CLAIM_RATE }).available?.(
            { raw: BCRT1, amount: 10_000 },
            ctx,
        );
        expect(quote).not.toHaveBeenCalled();
    });

    it("drops itself when no market serves the route, and reports the fault otherwise", async () => {
        const ctx = { wallet: ctxWallet, prefs: {} };
        const none = lightningRail(double({ eligible: 0 }));
        expect(await none.available?.({ raw: INVOICE }, ctx)).toBe(false);

        // An unroutable destination is a classification, not a fault.
        const refused = lightningRail(
            double({
                resolve: async () => {
                    throw new UnsupportedRoute("nothing serves it");
                },
            }),
        );
        expect(await refused.available?.({ raw: INVOICE }, ctx)).toBe(false);

        // Anything else propagates: the router warns and drops the rail, which
        // is louder than swallowing it here.
        const broken = lightningRail(
            double({
                resolve: async () => {
                    throw new Error("registry unreachable");
                },
            }),
        );
        await expect(broken.available?.({ raw: INVOICE }, ctx)).rejects.toThrow(/unreachable/);
    });

    it("defers an amountless onchain request to quote(), where the refusal belongs", async () => {
        const rail = onchainSwapRail(double(), { claimFeeRateSatVb: CLAIM_RATE });
        const ctx = { wallet: ctxWallet, prefs: {} };
        expect(await rail.available?.({ raw: BCRT1 }, ctx)).toBe(false);
        await expect(rail.quote({ raw: BCRT1 }, ctx)).rejects.toThrow(/amount is required/);
    });

    it("refuses to build an onchain rail with no claim fee rate", () => {
        for (const rate of [0, -1, Number.NaN]) {
            expect(() => onchainSwapRail(double(), { claimFeeRateSatVb: rate })).toThrow(
                /claimFeeRateSatVb must be positive/,
            );
        }
    });
});

describe("the quote a rail hands the router", () => {
    const ctx = { wallet: ctxWallet, prefs: {} };

    it("is receiver-exact on lightning: the payee is paid the invoice", async () => {
        const client = double();
        const quote = await lightningRail(client).quote({ raw: INVOICE }, ctx);
        expect(quote.railId).toBe(LIGHTNING_RAIL);
        expect(quote.amount).toBe(5_000);
        expect(quote.fee).toBe(50);
        expect(quote.total).toBe(quote.amount + quote.fee);
        // The invoice is the pin; the rail adds none of its own.
        expect(client.inputs().at(-1)).toEqual({ to: INVOICE });
    });

    it("grosses the onchain swap up by the claim fee, and reports it inside fee", async () => {
        // The trader claims the solver's L1 HTLC itself and the claim's fee
        // comes out of that output, so a rail quoting the spread alone would
        // beat the collaborative exit on a fee it does not charge.
        const target = 98_848n;
        const client = double({ quoted: quoteFor(100_000n, target + CLAIM_FEE, BITCOIN_BTC) });
        const rail = onchainSwapRail(client, { claimFeeRateSatVb: CLAIM_RATE });
        const quote = await rail.quote({ raw: BCRT1, amount: Number(target) }, ctx);

        expect(client.inputs().at(-1)).toEqual({
            to: BCRT1,
            amount: target + CLAIM_FEE,
            amountOn: "take",
        });
        expect(quote.amount).toBe(Number(target));
        expect(quote.fee).toBe(Number(1_152n));
        expect(quote.total).toBe(100_000);
        expect(quote.total).toBe(quote.amount + quote.fee);
        expect(quote.meta?.claimFeeSats).toBe(Number(CLAIM_FEE));
        expect(quote.meta?.htlcAmountSats).toBe(Number(target + CLAIM_FEE));
    });

    it("prices the claim off the measured vsize", () => {
        expect(claimFeeSats({ claimFeeRateSatVb: 10 })).toBe(BigInt(ONCHAIN_CLAIM_VSIZE * 10));
        expect(claimFeeSats({ claimFeeRateSatVb: 1.5, claimVsize: 100 })).toBe(150n);
    });

    it("refuses a quote whose legs are not receiver-exact rather than shipping the number", async () => {
        // `total !== amount + fee` means M3's own invariant broke; a rail that
        // passed it through would rank on a fee nobody charges.
        const bent = quoteFor(5_050n, 5_000n, BOLT11_BTC);
        const client = double({ quoted: { ...bent, fee: { asset: ARKADE_BTC, amount: 10n } } });
        await expect(lightningRail(client).quote({ raw: INVOICE }, ctx)).rejects.toThrow(
            /not receiver-exact/,
        );
    });

    it("surfaces the quote's deadline, which a RouteQuote has nowhere else to carry", async () => {
        const quote = await lightningRail(double()).quote({ raw: INVOICE }, ctx);
        expect(quote.meta?.expiresAt).toBe(NOW + 600);
    });
});

describe("ranking against core's rails", () => {
    const router = (client: SwapRailClient): PaymentRouter =>
        new PaymentRouter({ wallet: ctxWallet, prefs: { priority: [...SWAP_ROUTER_PRIORITY] } })
            .use(arkRail())
            .use(onchainRail())
            .use(lightningRail(client))
            .use(onchainSwapRail(client, { claimFeeRateSatVb: CLAIM_RATE }));

    it("prefers the swap over the collaborative exit, and still lists the exit", async () => {
        const options = await router(double()).options({ raw: BCRT1, amount: 100_000 });
        expect(options.map((o) => o.railId)).toEqual([ONCHAIN_SWAP_RAIL, "onchain"]);
    });

    it("self-heals by amount: the swap rail drops and onchain wins with no error", async () => {
        const options = await router(double({ eligible: 0 })).options({
            raw: BCRT1,
            amount: 100_000_000_000,
        });
        expect(options.map((o) => o.railId)).toEqual(["onchain"]);
    });

    it("leaves a plain Arkade address to core's ark rail alone", async () => {
        const options = await router(double()).options({ raw: ARK_ADDRESS, amount: 1_000 });
        expect(options.map((o) => o.railId)).toEqual(["ark"]);
    });

    it("registers the four rails the deleted factory registered, in its order", async () => {
        const built = createSwapPaymentRouter(ctxWallet, double(), {
            claimFeeRateSatVb: CLAIM_RATE,
        });
        const uri = `bitcoin:${BCRT1}?ark=${ARK_ADDRESS}&lightning=${INVOICE}&amount=0.001`;
        const options = await built.options({ raw: uri });
        expect(options.map((o) => o.railId)).toEqual([...SWAP_ROUTER_PRIORITY]);
    });
});

describe("the handle a send returns", () => {
    const ctx = { wallet: ctxWallet, prefs: {} };
    const settled = (handle: PaymentHandle): Promise<unknown> =>
        handle.settled().then(
            (r) => ({ ok: r }),
            (e) => ({ error: e }),
        );

    const send = async (client: Double): Promise<PaymentHandle> => {
        const quote = await lightningRail(client).quote({ raw: INVOICE }, ctx);
        return quote.send();
    };

    it("streams the projection and resolves on the terminal outcome", async () => {
        const client = double();
        const handle = await send(client);
        const seen: string[] = [];
        handle.subscribe((u) => seen.push(u.status));

        client.emit("funded", { fundingTxid: "f".repeat(64) });
        client.emit("paid", { fundingTxid: "f".repeat(64) });

        const result = await handle.settled();
        expect(seen).toEqual(["pending", "sent", "settled"]);
        expect(result.railId).toBe(LIGHTNING_RAIL);
        // The tagged public id M6 minted, so it round-trips to `swaps()`.
        expect(result.swapId).toBe("rfq:q1");
        expect(result.txid).toBe("f".repeat(64));
    });

    it("fails with the outcome on the error, and drops its subscription", async () => {
        const client = double();
        const handle = await send(client);
        client.emit("funded");
        client.emit("refunding");

        const outcome = (await settled(handle)) as { error: SwapPaymentFailedError };
        expect(outcome.error).toBeInstanceOf(SwapPaymentFailedError);
        expect(outcome.error.outcome).toBe("refunding");
        expect(client.listeners()).toBe(0);
    });

    it("goes terminal at refunding and never hears the refunded that follows", async () => {
        const client = double();
        const handle = await send(client);
        client.emit("refunding");
        await settled(handle);

        const after: string[] = [];
        handle.subscribe((u) => after.push(u.status));
        // The refund resolving is real and observable — on `client.onUpdate`,
        // keyed by the tagged swap id, which is where `swaps()` reads it too.
        const onClient: Outcome[] = [];
        client.onUpdate((u) => onClient.push(u.outcome));
        client.emit("refunded");

        // A late subscriber gets the replay of the terminal update and nothing
        // after it; the client's own stream carries the rest.
        expect(after).toEqual(["failed"]);
        expect(onClient).toEqual(["refunding", "refunded"]);
    });

    it("delivers the unblock backslide on the client, after the handle went terminal", async () => {
        // `needs_recovery -> funded` crosses the terminality boundary the rail
        // drew. It is emitted rather than swallowed — the drive's idempotence
        // key is the derived outcome, so the second `funded` is a new key — and
        // it reaches `onUpdate`, never the handle.
        const client = double();
        const handle = await send(client);
        client.emit("funded");
        client.emit("needs_recovery");
        const failure = (await settled(handle)) as { error: SwapPaymentFailedError };
        expect(failure.error.outcome).toBe("needs_recovery");

        const seen: Array<[Outcome, string | undefined]> = [];
        client.onUpdate((u) => seen.push([u.outcome, u.swap.id]));
        client.emit("funded");
        client.emit("claimed");

        expect(seen).toEqual([
            ["needs_recovery", "rfq:q1"],
            ["funded", "rfq:q1"],
            ["claimed", "rfq:q1"],
        ]);
        expect(handle.status).toBe("failed");
    });

    it("resolves a swap that was already terminal when the handle subscribed", async () => {
        // The replay runs inside `onUpdate`, so the terminal listener fires
        // before there is an unsubscribe to call.
        const client = double();
        client.emit("paid");
        const handle = await send(client);
        await expect(handle.settled()).resolves.toMatchObject({ railId: LIGHTNING_RAIL });
        expect(client.listeners()).toBe(0);
    });

    it("ignores another swap's updates", async () => {
        const client = double();
        const handle = await send(client);
        const seen: string[] = [];
        handle.subscribe((u) => seen.push(u.status));
        client.emit("paid", { id: "rfq:other" });
        expect(seen).toEqual(["pending"]);
    });
});
