/**
 * The asset route, negotiated: `quote()` and `accept()` on a card whose two
 * endpoints are both on arkade and which names a rendezvous.
 *
 * What these assert that no other file can. The terms come off the wire rather
 * than out of the card's formula — the double is deliberately made to answer a
 * payout its own card would not have computed, so a test that read the feed
 * would report the other number. The two legs carry different assets, so the
 * one check that does not survive that change of asset is gone and the reverse
 * direction — a payout numerically ten times the deposit — is a passing quote
 * rather than a refused one. And the covenant the solver quotes is the covenant
 * the trader derived: the double builds it out of the maker position the request
 * actually carried, so an agreeing `offer_address` means two derivations agreed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { createSwapClient } from "../../src/client/client";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import {
    MaxFeeExceeded,
    QuoteExpired,
    QuoteVerificationFailed,
    UnsupportedRoute,
} from "../../src/client/errors";
import { OFFER_PACKET_TYPE } from "../../src/offer";
import type { QuoteInput } from "../../src/client/quote";
import { quoteIdOfSwapId, type OfferSwapRecord } from "../../src/client/record";
import {
    ASSET_BUY_PAIR,
    ASSET_SELL_PAIR,
    EMULATOR_PUBKEY_HEX,
    FUNDING_TXID,
    SOLVER_DISCOVERY_KEY,
    SOLVER_PUBKEY,
    USD_ASSET_ID,
    acceptWallet,
    arkadeAssetAnswer,
    assetCard,
    assetPairCard,
    clockAt,
    feedServing,
    hdWallet,
    solverFor,
    solverTransport,
    spotCard,
    type AcceptWallet,
    type SolverAnswer,
    type SolverTransport,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const USD = `arkade:regtest/asset:${USD_ASSET_ID}`;
const BTC = "arkade:regtest/slip44:0";

/** The card's own formula at the fixture price: 10_000 sats, less 30bps. */
const CARD_PAYOUT = 997n;

const setup = async (
    over: {
        answer?: SolverAnswer;
        attestedResponder?: string | undefined;
        snapshot?: (typeof assetCard)[];
        repository?: AssetSwapRepository;
        wallet?: AcceptWallet;
    } = {},
) => {
    const wallet = over.wallet?.wallet ?? (await hdWallet());
    const transport: SolverTransport = solverTransport(
        over.answer ?? solverFor(CLOCK),
        "attestedResponder" in over ? { attestedResponder: over.attestedResponder } : {},
    );
    const feed = feedServing();
    const repository = over.repository ?? new InMemoryAssetSwapRepository();
    const client = createSwapClient({
        wallet,
        repository,
        discovery: { snapshot: over.snapshot ?? [assetCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => transport,
        fetchImpl: feed.fetch,
    });
    return { client, transport, feed, repository };
};

const buy = (amount = 10_000n): QuoteInput => ({
    give: "BTC",
    take: "USD",
    amount,
    amountOn: "give",
});

const sell = (amount = 1_000n): QuoteInput => ({
    give: "USD",
    take: "BTC",
    amount,
    amountOn: "give",
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("quote() on a negotiated asset market", () => {
    it("asks the solver once, and returns the terms it answered", async () => {
        // A payout the card's own formula would not have produced: 990 against
        // the 997 the feed prices. A client reading the feed for its terms
        // would report 997 and pass every other assertion here.
        const { client, transport } = await setup({
            answer: (payload) => arkadeAssetAnswer(payload, CLOCK, { toAmount: 990n }),
        });
        const quote = await client.quote(buy());

        expect(quote.give).toEqual({ asset: BTC, amount: 10_000n });
        expect(quote.take).toEqual({ asset: USD, amount: 990n });
        expect(quote.market.backend).toBe("rfq");
        expect(quote.solver).toBe(hex.encode(SOLVER_PUBKEY));
        expect(transport.sent).toHaveLength(1);
        expect(transport.closed()).toBe(true);
    });

    it("sends the solver's strict request shape", async () => {
        const { client, transport } = await setup();
        await client.quote(buy());

        expect(transport.sent[0]).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: expect.any(String),
            pair: ASSET_BUY_PAIR,
            // Exact-in, and a canonical decimal string: the solver's schema is
            // `.strict()`, so an extra or misspelled key refuses like a missing
            // one.
            amount_side: "from",
            amount: "10000",
            profile: {
                maker_pk_script: expect.stringMatching(/^5120[0-9a-f]{64}$/),
                maker_public_key: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
        });
    });

    it("denominates the fee on the take leg, against the card's own price", async () => {
        const { client } = await setup({
            answer: (payload) => arkadeAssetAnswer(payload, CLOCK, { toAmount: 990n }),
        });
        const quote = await client.quote(buy());

        // What the deposit would have bought at the card's price with no fee at
        // all (1_000), minus what this quote pays out. Subtracting the two legs
        // would be sats minus cents.
        expect(quote.fee).toEqual({ amount: 10n, asset: USD });
    });

    it("carries the card's provenance and no corridor clock", async () => {
        const { client } = await setup();
        const quote = await client.quote(buy());

        expect(quote.market).toMatchObject({
            kind: "card",
            backend: "rfq",
            key: `arkade:btc/arkade:${USD_ASSET_ID}`,
            discoveryPubkey: SOLVER_DISCOVERY_KEY,
            solver: "frenchman",
        });
        expect(quote.expiresAt).toBe(CLOCK.validUntil);
        // No hashlock and no refund clock: the covenant carries neither, so
        // `valid_until` is the only deadline and cancel is the way back out.
        expect(quote.lock).toBeUndefined();
        expect(quote.refundLocktime).toBeUndefined();
        // Nothing for a counterparty to see — the trader funds their own
        // covenant.
        expect(quote.artifact).toBeUndefined();
    });

    it("prices the reverse direction, where the payout dwarfs the deposit", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(sell());

        expect(transport.sent[0]).toMatchObject({ pair: ASSET_SELL_PAIR, amount: "1000" });
        // 1_000 cents at the card's price is 10_000 sats, less 30bps. Ten times
        // the deposit by the numbers, and the correct quote: `take > give` is a
        // mispricing only when both legs are the same asset.
        expect(quote.give).toEqual({ asset: USD, amount: 1_000n });
        expect(quote.take).toEqual({ asset: BTC, amount: 9_970n });
        expect(quote.fee).toEqual({ amount: 30n, asset: BTC });
    });

    it("carries an amount no JSON number could", async () => {
        const huge = 9_007_199_254_740_993n;
        const { client, transport } = await setup();
        const quote = await client.quote(buy(huge));

        expect(transport.sent[0]).toMatchObject({ amount: "9007199254740993" });
        expect(quote.give.amount).toBe(huge);
        expect(quote.take.amount).toBe(898_017_765_697_677n);
    });

    it("hands the accept path the covenant it verified, and writes nothing", async () => {
        const { client, repository } = await setup();
        const quote = await client.quote(buy());
        const preparation = client.preparationOf(quote.id);

        expect(preparation).toMatchObject({ backend: "rfq", route: "arkade->arkade" });
        expect(preparation && "offer" in preparation && preparation.offer.address).toMatch(
            /^tark1/,
        );
        // The wallet double throws from `getContractManager`, so reaching here
        // is the assertion that nothing was registered — and the store is the
        // assertion that nothing was persisted.
        expect(await repository.getAllSwapRecords()).toEqual([]);
    });

    it("prices from the card's feed when it names no rendezvous", async () => {
        // The same pair, the same assets, one card: the two fields that can be
        // addressed are the whole difference, and the card decides.
        const { client, transport } = await setup({ snapshot: [spotCard] });
        const quote = await client.quote(buy());

        expect(quote.market.backend).toBe("feed");
        expect(quote.take.amount).toBe(CARD_PAYOUT);
        expect(quote.solver).toBeUndefined();
        expect(transport.sent).toHaveLength(0);
    });
});

describe("quote() refuses before it discloses anything", () => {
    it("refuses an exact-out asset swap", async () => {
        const { client, transport } = await setup();

        await expect(client.quote({ ...buy(), amountOn: "take" })).rejects.toThrow(/exact-in/);
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a pair of assets, which no market prices", async () => {
        const { client, transport } = await setup({ snapshot: [assetPairCard] });

        await expect(
            client.quote({ give: "USD", take: "EUR", amount: 100n, amountOn: "give" }),
        ).rejects.toThrow(UnsupportedRoute);
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses BTC for BTC on one rail, which swaps nothing", async () => {
        const { client, transport } = await setup();

        await expect(
            client.quote({ give: "BTC", take: "BTC", amount: 10_000n, amountOn: "give" }),
        ).rejects.toThrow(UnsupportedRoute);
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a transport that attests nobody", async () => {
        const { client, transport } = await setup({ attestedResponder: undefined });

        await expect(client.quote(buy())).rejects.toThrow(QuoteVerificationFailed);
        expect(transport.sent).toHaveLength(0);
    });
});

describe("quote() verification, one case per check", () => {
    const failing = (answer: SolverAnswer) => setup({ answer });

    it("refuses a quote for another pair", async () => {
        const { client } = await failing((payload) =>
            arkadeAssetAnswer(payload, CLOCK, { quote: { pair: ASSET_SELL_PAIR } }),
        );
        await expect(client.quote(buy())).rejects.toMatchObject({
            name: "QuoteVerificationFailed",
            check: "pair",
        });
    });

    it("refuses a quote that reprices the side the request pinned", async () => {
        const { client } = await failing((payload) =>
            arkadeAssetAnswer(payload, CLOCK, { quote: { from_amount: "9999" } }),
        );
        await expect(client.quote(buy())).rejects.toMatchObject({
            check: "pair",
            actual: `${ASSET_BUY_PAIR} give=9999`,
        });
    });

    it("refuses a quote that pays out nothing", async () => {
        const { client } = await failing((payload) =>
            arkadeAssetAnswer(payload, CLOCK, { quote: { to_amount: "0" } }),
        );
        await expect(client.quote(buy())).rejects.toMatchObject({ check: "pair" });
    });

    it("refuses a quote that has already lapsed", async () => {
        const { client } = await failing((payload) =>
            arkadeAssetAnswer(payload, CLOCK, { quote: { valid_until: NOW - 1 } }),
        );
        await expect(client.quote(buy())).rejects.toThrow(QuoteExpired);
    });

    it("refuses a quote naming an offer address the trader did not derive", async () => {
        const { client } = await failing((payload) =>
            arkadeAssetAnswer(payload, CLOCK, {
                profile: { offer_address: "tark1someoneelsescovenant" },
            }),
        );
        await expect(client.quote(buy())).rejects.toMatchObject({
            check: "lockup_address",
            actual: "tark1someoneelsescovenant",
        });
    });

    it("refuses a quote whose offer script disagrees with its address", async () => {
        const { client } = await failing((payload) =>
            arkadeAssetAnswer(payload, CLOCK, {
                profile: { offer_pk_script: `5120${"11".repeat(32)}` },
            }),
        );
        await expect(client.quote(buy())).rejects.toMatchObject({ check: "lockup_address" });
    });

    it("refuses a covenant bound to a payout other than the quoted one", async () => {
        // The solver quotes 990 and derives its covenant for 997: a fill would
        // satisfy the covenant while paying less than the quote promised.
        const { client } = await failing((payload) => {
            const honest = arkadeAssetAnswer(payload, CLOCK);
            return {
                ...arkadeAssetAnswer(payload, CLOCK, { toAmount: 990n }),
                profile: honest.profile,
            };
        });
        await expect(client.quote(buy())).rejects.toMatchObject({ check: "lockup_address" });
    });
});

describe("accept() on a negotiated asset market", () => {
    const harness = async (over: Parameters<typeof acceptWallet>[0] = {}) => {
        const wallet = await acceptWallet(over);
        const { client, repository, transport } = await setup({ wallet });
        return { client, repository, transport, wallet };
    };

    it("registers the covenant, persists, then funds — in that order", async () => {
        const { client, repository, wallet } = await harness();
        const quote = await client.quote(buy());
        expect(wallet.contracts).toHaveLength(0);

        const swap = await client.accept(quote);

        expect(wallet.contracts).toHaveLength(1);
        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.family).toBe("offer");
        expect(wallet.contracts[0]?.script).toBe(stored.swapPkScript);
        // The negotiation's own evidence on the record: the key that quoted it.
        expect(stored.solver).toBe(hex.encode(SOLVER_PUBKEY));
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect(wallet.sent).toEqual([
            {
                address: stored.swapAddress,
                amount: 10_000,
                extensions: [{ type: OFFER_PACKET_TYPE, payload: hex.decode(stored.offerHex) }],
            },
        ]);
    });

    it("persists before it funds", async () => {
        const { client, repository, wallet } = await harness({
            failSend: () => new Error("send exploded"),
        });
        const quote = await client.quote(buy());

        await expect(client.accept(quote)).rejects.toThrow(/send exploded/);

        const stored = await repository.getSwapRecord(quote.id);
        expect(stored).toBeDefined();
        expect(stored?.fundingTxid).toBeUndefined();
        expect(wallet.sent).toHaveLength(0);
    });

    it("leaves nothing durable when registration fails", async () => {
        const { client, repository, wallet } = await harness({
            failRegistration: () => new Error("contract store gone"),
        });
        const quote = await client.quote(buy());

        await expect(client.accept(quote)).rejects.toThrow(/contract store gone/);
        expect(await repository.getSwapRecord(quote.id)).toBeUndefined();
        expect(wallet.sent).toHaveLength(0);
    });

    it("funds the asset leg through the carrier on the reverse direction", async () => {
        const { client, repository, wallet } = await harness();
        const quote = await client.quote(sell());
        await client.accept(quote);

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(wallet.sent[0]).toMatchObject({
            address: stored.swapAddress,
            // No sats amount: an asset deposit rides the SDK's dust carrier.
            assets: [{ assetId: USD_ASSET_ID, amount: 1_000n }],
        });
        expect(wallet.sent[0]?.amount).toBeUndefined();
    });

    it("settles one exchange() through one RFQ round trip", async () => {
        const { client, transport, wallet, repository } = await harness();
        const swap = await client.exchange({
            give: "BTC",
            take: "USD",
            amount: 10_000n,
            amountOn: "give",
            // The ceiling is in the asset the fee is in, which on a cross-asset
            // swap is the take leg: no rate converts a sats ceiling into it.
            maxFee: { amount: 5n, asset: USD },
        });

        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]).toMatchObject({ pair: ASSET_BUY_PAIR });
        expect(swap.family).toBe("offer");
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect(wallet.sent).toHaveLength(1);
        expect(await repository.getSwapRecord(quoteIdOfSwapId(swap.id))).toBeDefined();
    });

    it("refuses a ceiling the negotiated spread is over, having funded nothing", async () => {
        const { client, wallet } = await harness();

        await expect(
            client.exchange({
                give: "BTC",
                take: "USD",
                amount: 10_000n,
                amountOn: "give",
                maxFee: { amount: 2n, asset: USD },
            }),
        ).rejects.toThrow(MaxFeeExceeded);
        expect(wallet.sent).toHaveLength(0);
        expect(wallet.contracts).toHaveLength(0);
    });

    it("refuses a ceiling denominated in the leg the fee is not on", async () => {
        const { client } = await harness();

        await expect(
            client.exchange({
                give: "BTC",
                take: "USD",
                amount: 10_000n,
                amountOn: "give",
                maxFee: { amount: 100n, asset: BTC },
            }),
        ).rejects.toThrow(/no rate converts one ceiling into the other/);
    });

    it("registers the covenant the quote verified, not a second derivation", async () => {
        const { client, repository, wallet } = await harness();
        const quote = await client.quote(buy());
        const preparation = client.preparationOf(quote.id);
        await client.accept(quote);

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        const derived = preparation && "offer" in preparation ? preparation.offer : undefined;
        expect(stored.swapAddress).toBe(derived?.address);
        expect(stored.offerHex).toBe(derived?.offerHex);
        expect(wallet.contracts[0]?.script).toBe(
            hex.encode(derived?.swapPkScript ?? new Uint8Array()),
        );
    });
});
