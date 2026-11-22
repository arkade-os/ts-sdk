import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, DiscoveredMarket } from "@arkade-os/solver-discovery";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { createSwapClient } from "../../src/client/client";
import { collectOpenRfqBids } from "../../src/openRfqTransport";
import { btcOn } from "../../src/client/assetId";
import { QuoteExpired, QuoteVerificationFailed } from "../../src/client/errors";
import { ASSET_SWAP_DIRECTED_NONCE } from "../../src/protocol";
import {
    assetCard,
    clockAt,
    EMULATOR_PUBKEY_HEX,
    feedServing,
    hdWallet,
    solverTransport,
    arkadeAssetAnswer,
    onchainCard,
    onchainSendAnswer,
    USD_ASSET_ID,
    type SolverAnswer,
} from "./fixtures";
import { ONCHAIN_CLAIM_FEE_RATE_SATVB } from "../../src/client/corridors/deps";
import { claimFeeSats } from "../../src/payment/onchainSwap";

vi.mock("../../src/openRfqTransport", () => ({ collectOpenRfqBids: vi.fn() }));
const NOW = 1_700_000_000;
const key = new Uint8Array(32).fill(4);
const pubkey = hex.encode(schnorr.getPublicKey(key));
const give = btcOn("arkade", "regtest");
const take = `arkade:regtest/asset:${USD_ASSET_ID}` as const;
const input = { give, take, amount: 25_000n, amountOn: "give" as const };
const canonical = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, entry]) => [key, canonical(entry)]),
            )
          : value;
const digestCard = (card: Card): Uint8Array => {
    const { sig: _sig, ...unsigned } = card;
    return sha256(new TextEncoder().encode(JSON.stringify(canonical(unsigned))));
};
const rawCard = (source = assetCard): Card => {
    const {
        solver: _solver,
        source: _source,
        sourceType: _type,
        discovery_pubkey: _key,
        transports: _transports,
        ...market
    } = source;
    const card: Card = {
        version: 0,
        name: "open-solver",
        discovery_pubkey: pubkey,
        transports: { nostr: { relays: ["wss://relay.example"] } },
        markets: [structuredClone(market)],
    };
    card.sig = hex.encode(schnorr.sign(digestCard(card), key));
    return card;
};
const bid = (toAmount = 2_492n) => ({
    id: "a".repeat(64),
    solverPubkey: pubkey,
    openId: "open",
    pair: `${give}->${take}`,
    amountSide: "from" as const,
    fromAmount: 25_000n,
    toAmount,
    validUntil: NOW + 60,
    card: rawCard(),
});
const options = {
    secretKey: new Uint8Array(32).fill(5),
    relays: ["wss://relay.example"],
    windowMs: 500,
};
const setup = async (
    over: {
        allowedRegistries?: string[];
        paused?: boolean;
        disabledSource?: string;
        veto?: boolean;
        beforePreferences?: () => void | Promise<void>;
        snapshot?: DiscoveredMarket[];
        ttlFloor?: number;
        quoteDelaySeconds?: number;
        directedExpiresAt?: number;
        answer?: SolverAnswer;
        corridors?: Parameters<typeof createSwapClient>[0]["corridors"];
    } = {},
) => {
    const attempted: string[] = [];
    const wallet = await hdWallet();
    const client = createSwapClient({
        wallet,
        discovery: { snapshot: over.snapshot ?? [] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        fetchImpl: feedServing().fetch,
        ...(over.corridors === undefined ? {} : { corridors: over.corridors }),
        policy: {
            drive: "manual",
            allowedRegistries: over.allowedRegistries,
            quoteTtlFloorSeconds: over.ttlFloor,
            ...(over.veto ? { selectMarket: () => undefined } : {}),
            solverRouting: {
                preferences: async ({ candidates }) => {
                    await over.beforePreferences?.();
                    return {
                        disabled: candidates
                            .filter((c) => over.paused || c.card.source === over.disabledSource)
                            .map((c) => c.solverId),
                    };
                },
            },
        },
        transportFor: ({ card }) => {
            attempted.push(card.solver);
            return solverTransport(
                (payload) => {
                    if (over.answer !== undefined) return over.answer(payload);
                    if (over.quoteDelaySeconds !== undefined)
                        vi.setSystemTime((NOW + over.quoteDelaySeconds) * 1000);
                    return arkadeAssetAnswer(payload, clockAt(NOW), {
                        ...(over.directedExpiresAt === undefined
                            ? {}
                            : { quote: { valid_until: over.directedExpiresAt } }),
                    });
                },
                { attestedResponder: pubkey },
            );
        },
    });
    vi.mocked(collectOpenRfqBids).mockImplementation(async (request) => [
        { ...bid(), openId: request.openId },
    ]);
    return { client, attempted, wallet };
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe("open RFQ selection", () => {
    it("refuses unsupported cross-corridor asset economics before broadcasting", async () => {
        const { client } = await setup({
            snapshot: [{ ...onchainCard, base_asset: assetCard.quote_asset }],
        });
        await expect(
            client.openRfq(
                { give: take, take: btcOn("bitcoin", "regtest"), amount: 2_492n, amountOn: "give" },
                options,
            ),
        ).rejects.toThrow("Bitcoin only");
        expect(collectOpenRfqBids).not.toHaveBeenCalled();
        await client[Symbol.asyncDispose]();
    });
    it("never publishes when disposal races the initial operator read", async () => {
        const { client, wallet } = await setup();
        const info = await wallet.getArkadeInfo();
        let reading!: () => void;
        let release!: (value: typeof info) => void;
        const started = new Promise<void>((resolve) => {
            reading = resolve;
        });
        const gate = new Promise<typeof info>((resolve) => {
            release = resolve;
        });
        vi.spyOn(wallet, "getArkadeInfo").mockImplementation(async () => {
            reading();
            return gate;
        });
        const pending = client.openRfq(input, options);
        void pending.catch(() => {});
        await started;
        await client[Symbol.asyncDispose]();
        release(info);
        await expect(pending).rejects.toThrow("disposed");
        expect(collectOpenRfqBids).not.toHaveBeenCalled();
    });
    it("stops an already-cancelled search before publication", async () => {
        const { client } = await setup();
        const controller = new AbortController();
        controller.abort(new Error("cancelled search"));
        await expect(
            client.openRfq(input, { ...options, signal: controller.signal }),
        ).rejects.toThrow("cancelled search");
        expect(collectOpenRfqBids).not.toHaveBeenCalled();
        await client[Symbol.asyncDispose]();
    });
    it("discovers an authenticated unknown solver without disclosing the destination", async () => {
        const { client } = await setup();
        const auction = await client.openRfq(input, options);
        expect(auction.bids).toHaveLength(1);
        expect(auction.bids[0]).toMatchObject({
            solverPubkey: pubkey,
            solverName: "open-solver",
            fromAmount: 25_000n,
            toAmount: 2_492n,
        });
        expect(collectOpenRfqBids).toHaveBeenCalledWith(
            expect.objectContaining({
                pair: `${give}->${take}`,
                amount: 25_000n,
                amountSide: "from",
            }),
            expect.anything(),
        );
        expect(Object.keys(vi.mocked(collectOpenRfqBids).mock.calls[0][0]).sort()).toEqual([
            "amount",
            "amountSide",
            "bidsUntil",
            "openId",
            "pair",
        ]);
        expect(vi.mocked(collectOpenRfqBids).mock.calls[0][0].openId).toMatch(/^[0-9a-f]{64}$/);
        await client[Symbol.asyncDispose]();
    });
    it.each([false, true])(
        "keeps bids valid through redundant progress snapshots (observer: %s)",
        async (observe) => {
            const { client } = await setup({
                beforePreferences: async () => {
                    await Promise.resolve();
                    vi.setSystemTime(Date.now() + 5_000);
                },
            });
            const onBids = vi.fn();
            vi.mocked(collectOpenRfqBids).mockImplementation(async (request, progress) => {
                const first = { ...bid(), openId: request.openId };
                let latest = first;
                for (let i = 0; i < 64; i++) {
                    latest = {
                        ...first,
                        id: i.toString(16).padStart(64, "0"),
                        toAmount: first.toAmount + BigInt(i),
                    };
                    progress.onBids?.([latest]);
                }
                return [latest];
            });
            const auction = await client.openRfq(input, {
                ...options,
                ...(observe ? { onBids } : {}),
            });
            expect(auction.bids.map((offer) => offer.toAmount)).toEqual([2_555n]);
            if (observe) expect(onBids).toHaveBeenLastCalledWith(auction.bids);
            else expect(onBids).not.toHaveBeenCalled();
            await client[Symbol.asyncDispose]();
        },
    );
    it("suppresses an obsolete progress result after an asynchronous preference read", async () => {
        let started!: () => void;
        let release!: () => void;
        let first = true;
        const reading = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { client } = await setup({
            beforePreferences: async () => {
                if (!first) return;
                first = false;
                started();
                await gate;
            },
        });
        const onBids = vi.fn();
        vi.mocked(collectOpenRfqBids).mockImplementation(async (request, progress) => {
            const older = { ...bid(), openId: request.openId };
            const newer = { ...older, id: "b".repeat(64), toAmount: 2_493n };
            progress.onBids?.([older]);
            await reading;
            progress.onBids?.([newer]);
            release();
            return [newer];
        });
        const auction = await client.openRfq(input, { ...options, onBids });
        expect(auction.bids.map((offer) => offer.toAmount)).toEqual([2_493n]);
        expect(onBids.mock.calls.map(([offers]) => offers[0]?.toAmount)).toEqual([2_493n]);
        await client[Symbol.asyncDispose]();
    });
    it("filters policy-paused offers and registry-restricted sources", async () => {
        const { client } = await setup({ paused: true });
        expect((await client.openRfq(input, options)).bids).toEqual([]);
        await client[Symbol.asyncDispose]();
        const { client: restricted } = await setup({
            allowedRegistries: ["https://trusted.example"],
        });
        expect((await restricted.openRfq(input, options)).bids).toEqual([]);
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card: { ...rawCard(), sig: "0".repeat(128) } },
        ]);
        expect((await restricted.openRfq(input, options)).bids).toEqual([]);
        await restricted[Symbol.asyncDispose]();
    });
    it("independently refuses an unauthenticated card and a selection-policy veto", async () => {
        const { client } = await setup();
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card: { ...rawCard(), sig: "0".repeat(128) } },
        ]);
        expect((await client.openRfq(input, options)).bids).toEqual([]);
        await client[Symbol.asyncDispose]();
        const { client: vetoed } = await setup({ veto: true });
        expect((await vetoed.openRfq(input, options)).bids).toEqual([]);
        await vetoed[Symbol.asyncDispose]();
    });
    it("refuses a validly signed card advertising another network", async () => {
        const { client } = await setup();
        const card = rawCard();
        card.version = 1;
        delete card.markets![0].pair;
        card.markets![0].base_asset.id = "arkade:bitcoin/slip44:0";
        card.markets![0].quote_asset.id = `arkade:bitcoin/asset:${USD_ASSET_ID}`;
        card.sig = hex.encode(schnorr.sign(digestCard(card), key));
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card },
        ]);
        expect((await client.openRfq(input, options)).bids).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it("pins canonical asset identities even when a bidder swaps ticker labels", async () => {
        const { client } = await setup({
            snapshot: [assetCard],
            answer: (payload) => arkadeAssetAnswer(payload, clockAt(NOW), { supportsNonce: true }),
        });
        const card = rawCard();
        card.markets![0].base_asset.ticker = "USD";
        card.markets![0].quote_asset.ticker = "BTC";
        card.markets![0].pair = "USD/BTC";
        card.sig = hex.encode(schnorr.sign(digestCard(card), key));
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card },
        ]);
        const auction = await client.openRfq({ ...input, give: "BTC", take: "USD" }, options);
        const quote = await client.quoteBid(auction, auction.bids[0]);
        expect(quote.give.asset).toBe(give);
        expect(quote.take.asset).toBe(take);
        expect(client.preparationOf(quote.id)).toMatchObject({
            offer: { offerBinding: { version: ASSET_SWAP_DIRECTED_NONCE } },
        });
        await expect(
            client.accept({ ...quote, auction: undefined, expiresAt: NOW + 3600 }),
        ).rejects.toThrow("original issued quote");
        await client[Symbol.asyncDispose]();
    });
    it("drops an offer that expires while later bids are checked", async () => {
        let reads = 0;
        const { client } = await setup({
            // each bid's routing preference read takes two seconds
            beforePreferences: () => {
                vi.setSystemTime((NOW + 2 * ++reads) * 1000);
            },
        });
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, id: "a".repeat(64), validUntil: NOW + 3 },
            { ...bid(), openId: r.openId, id: "b".repeat(64) },
        ]);
        const auction = await client.openRfq(input, options);
        expect(reads).toBe(2);
        expect(auction.bids.map((offer) => offer.id)).toEqual(["b".repeat(64)]);
        await client[Symbol.asyncDispose]();
    });
    it("checks expiry after asynchronous preferences before contacting a bidder", async () => {
        let expire = false;
        const { client, attempted } = await setup({
            beforePreferences: () => {
                if (expire) vi.setSystemTime((NOW + 61) * 1000);
            },
        });
        const auction = await client.openRfq(input, options);
        expire = true;
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toBeInstanceOf(
            QuoteExpired,
        );
        expect(attempted).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it("applies the TTL floor to a selected bid before contacting its solver", async () => {
        const { client, attempted } = await setup({ ttlFloor: 10 });
        vi.mocked(collectOpenRfqBids).mockImplementation(async (request) => [
            { ...bid(), openId: request.openId, validUntil: NOW + 4 },
        ]);
        const auction = await client.openRfq(input, options);
        expect(auction.bids).toHaveLength(1);
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toBeInstanceOf(
            QuoteExpired,
        );
        expect(attempted).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it("rechecks the bid TTL floor after private quote preparation", async () => {
        const { client, attempted } = await setup({ ttlFloor: 10, quoteDelaySeconds: 55 });
        const auction = await client.openRfq(input, options);
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toBeInstanceOf(
            QuoteExpired,
        );
        expect(attempted).toEqual(["open-solver"]);
        await client[Symbol.asyncDispose]();
    });
    it("checks the actual remaining directed quote TTL after preparation", async () => {
        const { client } = await setup({
            ttlFloor: 10,
            quoteDelaySeconds: 55,
            directedExpiresAt: NOW + 60,
        });
        vi.mocked(collectOpenRfqBids).mockImplementation(async (request) => [
            { ...bid(), openId: request.openId, validUntil: NOW + 180 },
        ]);
        const auction = await client.openRfq(input, options);
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toBeInstanceOf(
            QuoteExpired,
        );
        await client[Symbol.asyncDispose]();
    });
    it("rejects a copied bid or expired auction before contacting a solver", async () => {
        const { client, attempted } = await setup();
        const auction = await client.openRfq(input, options);
        await expect(client.quoteBid(auction, { ...auction.bids[0] })).rejects.toThrow("bid");
        vi.setSystemTime((NOW + 61) * 1000);
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toBeInstanceOf(
            QuoteExpired,
        );
        expect(attempted).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it("does not offer a signed feed-only card without a directed rendezvous", async () => {
        const { client, attempted } = await setup();
        const card = rawCard();
        delete card.transports;
        card.sig = hex.encode(schnorr.sign(digestCard(card), key));
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card },
        ]);
        expect((await client.openRfq(input, options)).bids).toEqual([]);
        expect(attempted).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it.each(["asset", "onchain"])(
        "accepts a one-way %s card whose opposite payout is disabled",
        async (kind) => {
            const { client } = await setup();
            const card = rawCard({
                ...(kind === "asset" ? assetCard : onchainCard),
                min_base_amount: "0",
                max_base_amount: "0",
            });
            const target = kind === "asset" ? take : btcOn("bitcoin", "regtest");
            const payout = kind === "asset" ? 2_492n : 24_900n;
            vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
                { ...bid(), openId: r.openId, pair: r.pair, card, toAmount: payout },
            ]);
            const auction = await client.openRfq({ ...input, take: target }, options);
            expect(auction.bids).toHaveLength(1);
            if (kind === "asset")
                expect((await client.quoteBid(auction, auction.bids[0])).take.amount).toBe(payout);
            await client[Symbol.asyncDispose]();
        },
    );
    it("retains allowed registry provenance only for exactly listed market terms", async () => {
        const known = { ...assetCard, solver: "open-solver", source: "https://trusted.example" };
        const { client } = await setup({
            allowedRegistries: [known.source],
            snapshot: [{ ...known, source: "https://unlisted.example" }, known],
        });
        expect((await client.openRfq(input, options)).bids[0].market.source).toBe(known.source);
        const card = rawCard();
        card.markets![0].fee_bps = 100;
        card.sig = hex.encode(schnorr.sign(digestCard(card), key));
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card },
        ]);
        expect((await client.openRfq(input, options)).bids).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it("keeps a known authenticated solver paused when updated terms have new provenance", async () => {
        const known = { ...assetCard, solver: "open-solver" };
        const state = { snapshot: [known], disabledSource: "" };
        const { client, attempted } = await setup(state);
        const card = rawCard();
        card.markets![0].fee_bps = 100;
        card.sig = hex.encode(schnorr.sign(digestCard(card), key));
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(), openId: r.openId, card },
        ]);
        const auction = await client.openRfq(input, options);
        expect(auction.bids).toHaveLength(1);
        expect(auction.bids[0].market.source).toBe(`nostr:${pubkey}`);
        state.disabledSource = known.source;
        expect((await client.openRfq(input, options)).bids).toEqual([]);
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toThrow("paused");
        expect(attempted).toEqual([]);
        await client[Symbol.asyncDispose]();
    });
    it("pins the selected bidder and rejects a worse directed quote without funding", async () => {
        const { client, attempted } = await setup();
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            { ...bid(100_000n), openId: r.openId },
        ]);
        const auction = await client.openRfq(input, options);
        await expect(client.quoteBid(auction, auction.bids[0])).rejects.toBeInstanceOf(
            QuoteVerificationFailed,
        );
        expect(attempted).toEqual(["open-solver"]);
        await client[Symbol.asyncDispose]();
    });
    it("verifies the chosen cross-asset amounts and retains auction provenance", async () => {
        const { client, attempted } = await setup();
        const auction = await client.openRfq(input, options);
        const quote = await client.quoteBid(auction, auction.bids[0]);
        expect(quote.give.amount).toBe(25_000n);
        expect(quote.take.amount).toBe(2_492n);
        expect(quote.market).toMatchObject({ solver: "open-solver", discoveryPubkey: pubkey });
        expect(quote.auction?.winner.bidder).toBe(pubkey);
        expect(attempted).toEqual(["open-solver"]);
        expect(Object.isFrozen(auction.bids[0].market.base_asset)).toBe(true);
        await client[Symbol.asyncDispose]();
    });
});

describe("open RFQ onchain sends with a fixed take amount", () => {
    const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
    const net = 50_000n;
    const claimFee = claimFeeSats({ claimFeeRateSatVb: ONCHAIN_CLAIM_FEE_RATE_SATVB.regtest! });
    const send = { give, take: btcOn("bitcoin", "regtest"), to: BCRT1, amount: net };
    // A solver that charges a flat 1_000 sat over whatever take it is asked for.
    const pricing =
        (spread: number): SolverAnswer =>
        (payload) =>
            onchainSendAnswer(payload, clockAt(NOW), {
                quote: { from_amount: Number(payload.amount) + spread },
            });
    const bidsAtSpread = () =>
        vi.mocked(collectOpenRfqBids).mockImplementation(async (r) => [
            {
                ...bid(),
                openId: r.openId,
                pair: r.pair,
                amountSide: "to",
                card: rawCard(onchainCard),
                fromAmount: r.amount + 1_000n,
                toAmount: r.amount,
            },
        ]);

    it("broadcasts the amount the directed quote asks and offers the recipient's net", async () => {
        const { client, attempted } = await setup({ answer: pricing(1_000) });
        bidsAtSpread();
        const auction = await client.openRfq({ ...send, amountOn: "take" }, options);
        expect(vi.mocked(collectOpenRfqBids).mock.calls[0][0].amount).toBe(net + claimFee);
        expect(auction.bids[0]).toMatchObject({
            fromAmount: net + claimFee + 1_000n,
            toAmount: net,
        });
        const quote = await client.quoteBid(auction, auction.bids[0]);
        expect(quote.give.amount).toBe(net + claimFee + 1_000n);
        expect(quote.take.amount).toBe(net);
        expect(attempted).toEqual(["open-solver"]);
        await client[Symbol.asyncDispose]();
    });
    it("still refuses a directed quote asking more than the bid", async () => {
        const { client } = await setup({ answer: pricing(2_000) });
        bidsAtSpread();
        const auction = await client.openRfq({ ...send, amountOn: "take" }, options);
        const error = await client.quoteBid(auction, auction.bids[0]).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("amount");
        await client[Symbol.asyncDispose]();
    });
    it("broadcasts the recipient's amount verbatim with the claim fee disabled", async () => {
        const { client } = await setup({
            answer: pricing(1_000),
            corridors: { onchain: { claimFeeRateSatVb: null } },
        });
        bidsAtSpread();
        const auction = await client.openRfq({ ...send, amountOn: "take" }, options);
        expect(vi.mocked(collectOpenRfqBids).mock.calls[0][0].amount).toBe(net);
        expect((await client.quoteBid(auction, auction.bids[0])).take.amount).toBe(net);
        await client[Symbol.asyncDispose]();
    });
});
