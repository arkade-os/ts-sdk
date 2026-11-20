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
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { createSwapClient } from "../../src/client/client";
import {
    collectSwapRecords,
    InMemoryAssetSwapRepository,
    type AssetSwapRepository,
} from "../../src/repository";
import {
    MaxFeeExceeded,
    QuoteExpired,
    QuoteVerificationFailed,
    UnsupportedRoute,
} from "../../src/client/errors";
import {
    bindingFromOffer,
    decodeOffer,
    deriveOffer,
    OFFER_PACKET_TYPE,
    offerContract,
    recordOfferBinding,
} from "../../src/offer";
import { ASSET_SWAP_V2, ASSET_SWAP_DIRECTED } from "../../src/program";
import { verifyTaker } from "../../src/client/verify";
import { SwapRefusal } from "../../src/rfq";
import type { QuoteInput } from "../../src/client/quote";
import { quoteIdOfSwapId, type OfferSwapRecord } from "../../src/client/record";
import {
    ASSET_BUY_PAIR,
    ASSET_SELL_PAIR,
    EMULATOR_PUBKEY_HEX,
    FUNDING_TXID,
    OPERATOR_PUBKEY,
    SOLVER_DISCOVERY_KEY,
    SOLVER_PUBKEY,
    USD_ASSET_ID,
    acceptWallet,
    arkadeAssetAnswer,
    assetCard,
    assetPairCard,
    canonicalAssetCard,
    canonicalSpotCard,
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

vi.mock("../../src/offer", async (original) => {
    const actual = await original<typeof import("../../src/offer")>();
    return { ...actual, deriveOffer: vi.fn(actual.deriveOffer) };
});

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const USD = `arkade:regtest/asset:${USD_ASSET_ID}`;
const BTC = "arkade:regtest/slip44:1";

/** The card's own formula at the fixture price: 10_000 sats, less 30bps. */
const CARD_PAYOUT = 997n;

/** Canonical, because the plan recognises a carrier-riding leg only by its CAIP-19 `/asset:` id. */
const carrierChargingCard: DiscoveredMarket = {
    ...canonicalAssetCard,
    charges_delivered_carrier: true,
};

const setup = async (
    over: {
        answer?: SolverAnswer;
        attestedResponder?: string | undefined;
        snapshot?: (typeof assetCard)[];
        repository?: AssetSwapRepository;
        wallet?: AcceptWallet;
        fetchImpl?: typeof fetch;
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
        fetchImpl: over.fetchImpl ?? feed.fetch,
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
        expect(quote.solver).toBe(SOLVER_DISCOVERY_KEY);
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
            contract_versions: [ASSET_SWAP_DIRECTED],
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
        // The spread plus the 330-sat carrier, which the filler keeps: this solver returns none of it.
        expect(quote.fee).toEqual({ amount: 360n, asset: BTC });
    });

    it("charges no carrier to a solver that returns it in the payout", async () => {
        const { client } = await setup({
            answer: (payload) => arkadeAssetAnswer(payload, CLOCK, { toAmount: 10_300n }),
        });
        const quote = await client.quote(sell());

        expect(quote.take).toEqual({ asset: BTC, amount: 10_300n });
        expect(quote.fee).toEqual({ amount: 30n, asset: BTC });
    });

    it("carries an amount no JSON number could", async () => {
        const huge = 9_007_199_254_740_993n;
        const { client, transport } = await setup();
        const quote = await client.quote(buy(huge));

        expect(transport.sent[0]).toMatchObject({ amount: "9007199254740993" });
        expect(quote.give.amount).toBe(huge);
        expect(quote.take.amount).toBe(898_017_765_697_676n);
    });

    describe("contract version negotiation", () => {
        it("refuses a quote that names no contract version, before deriving", async () => {
            const { client } = await setup({
                answer: ({ contract_versions: _, ...payload }) => arkadeAssetAnswer(payload, CLOCK),
            });
            vi.mocked(deriveOffer).mockClear();
            await expect(client.quote(buy())).rejects.toThrow(
                "solver negotiated no contract version",
            );
            expect(deriveOffer).not.toHaveBeenCalled();
        });

        it.each(["asset-swap-v3", ASSET_SWAP_V2])("refuses a quote echoing %s", async (version) => {
            const { client } = await setup({
                answer: (payload) =>
                    arkadeAssetAnswer(payload, CLOCK, { quote: { contract_version: version } }),
            });
            vi.mocked(deriveOffer).mockClear();
            await expect(client.quote(buy())).rejects.toThrow(
                `solver chose contract version ${version}, not one of ${ASSET_SWAP_DIRECTED}`,
            );
            expect(deriveOffer).not.toHaveBeenCalled();
        });

        it("refuses a contract version it did not advertise", async () => {
            const { client } = await setup({
                answer: (payload) => ({
                    ...arkadeAssetAnswer(payload, CLOCK),
                    contract_version: "asset-swap-v9",
                }),
            });
            await expect(client.quote(buy())).rejects.toThrow(
                "solver chose contract version asset-swap-v9",
            );
        });

        it.each([
            [undefined, "unsupported_payload"],
            ["contract_version_unsupported", "unsupported_payload"],
            [undefined, "no_liquidity"],
        ] as const)("does not retry a refusal with code %s, reason %s", async (code, reason) => {
            const { client, transport } = await setup({
                answer: () => {
                    throw new SwapRefusal(reason, undefined, code ? { errorCode: code } : {});
                },
            });
            await expect(client.quote(buy())).rejects.toThrow();
            expect(transport.sent).toHaveLength(1);
        });
    });

    it("hands the accept path the covenant it verified, and writes nothing", async () => {
        const { client, repository } = await setup();
        const quote = await client.quote(buy());
        const preparation = client.preparationOf(quote.id);

        expect(preparation).toMatchObject({ backend: "rfq", route: "arkade->arkade" });
        expect(preparation && "offer" in preparation && preparation.offer.address).toMatch(
            /^tark1/,
        );
        // `accept()` registers this very value, so a caller holding it cannot rewrite it.
        const offer = preparation && "offer" in preparation ? preparation.offer : undefined;
        expect(Object.isFrozen(offer)).toBe(true);
        expect(Object.isFrozen(offer?.binding)).toBe(true);
        // The wallet double throws from `getContractManager`, so reaching here
        // is the assertion that nothing was registered — and the store is the
        // assertion that nothing was persisted.
        expect(await collectSwapRecords(repository)).toEqual([]);
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

    it("asks for a feed-priced asset deposit's carrier back in the payout", async () => {
        const { client } = await setup({ snapshot: [canonicalSpotCard] });
        const quote = await client.quote(sell());

        expect(quote.market.backend).toBe("feed");
        // 1_000 cents is 10_000 sats, less 30bps, plus the 330-sat carrier the deposit rides on.
        expect(quote.take).toEqual({ asset: BTC, amount: 10_300n });
        expect(quote.fee).toEqual({ amount: 30n, asset: BTC });
    });

    it("counts the carrier as fee on a legacy card the plan returns none of it on", async () => {
        // solver-discovery only recognises a carrier-riding leg by its CAIP-19 `/asset:` id.
        const { client } = await setup({ snapshot: [spotCard] });
        const quote = await client.quote(sell());

        expect(quote.take).toEqual({ asset: BTC, amount: 9_970n });
        expect(quote.fee).toEqual({ amount: 360n, asset: BTC });
    });

    it("quotes a card that names its legs in CAIP-19, on either backend", async () => {
        // What a deployed solver publishes. The plan's pair check read the
        // card's `AssetInfo.id` raw and compared it against the leg's short id,
        // so a canonical card failed as a pair mismatch on both backends —
        // after the request had already gone out on the negotiated one.
        const negotiated = await setup({ snapshot: [canonicalAssetCard] });
        const quote = await negotiated.client.quote(buy());

        expect(quote.market.backend).toBe("rfq");
        expect(quote.give).toEqual({ asset: BTC, amount: 10_000n });
        expect(quote.take).toEqual({ asset: USD, amount: CARD_PAYOUT });
        expect(negotiated.transport.sent[0]).toMatchObject({ pair: ASSET_BUY_PAIR });

        const priced = await setup({ snapshot: [canonicalSpotCard] });
        const fromFeed = await priced.client.quote(buy());

        expect(fromFeed.market.backend).toBe("feed");
        expect(fromFeed.take.amount).toBe(CARD_PAYOUT);
    });

    it("quotes a BTC deposit on a card that charges for the delivered carrier", async () => {
        const { client, transport } = await setup({ snapshot: [carrierChargingCard] });
        const quote = await client.quote(buy());

        expect(quote.market.backend).toBe("rfq");
        expect(quote.give).toEqual({ asset: BTC, amount: 10_000n });
        expect(quote.take).toEqual({ asset: USD, amount: CARD_PAYOUT });
        expect(transport.sent[0]).toMatchObject({ pair: ASSET_BUY_PAIR });
    });

    it("quotes a BTC deposit the same with the carrier charge absent", async () => {
        const charging = await setup({ snapshot: [carrierChargingCard] });
        const absent = await setup({ snapshot: [canonicalAssetCard] });

        const flagged = await charging.client.quote(buy());
        const plain = await absent.client.quote(buy());

        expect(flagged.give).toEqual(plain.give);
        expect(flagged.take).toEqual(plain.take);
        expect(flagged.fee).toEqual(plain.fee);
    });

    it("prices the reverse direction on a carrier-charging card unchanged", async () => {
        const charging = await setup({ snapshot: [carrierChargingCard] });
        const absent = await setup({ snapshot: [canonicalAssetCard] });

        const flagged = await charging.client.quote(sell());
        const plain = await absent.client.quote(sell());

        expect(flagged.take).toEqual(plain.take);
        expect(flagged.fee).toEqual(plain.fee);
    });
});

describe("quote() refuses before it discloses anything", () => {
    it("refuses an exact-out asset-to-BTC swap", async () => {
        const { client, transport } = await setup();

        await expect(client.quote({ ...sell(), amountOn: "take" })).rejects.toThrow(/exact-in/);
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a pair of assets, which no market prices", async () => {
        const { client, transport } = await setup({ snapshot: [assetPairCard] });

        await expect(
            client.quote({ give: "USD", take: "EUR", amount: 100n, amountOn: "give" }),
        ).rejects.toThrow(UnsupportedRoute);
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a card with no price feed to measure the fee against", async () => {
        const { price_feed: _feed, price_feed_schema: _schema, ...feedless } = assetCard;
        const { client, transport } = await setup({ snapshot: [feedless as typeof assetCard] });

        await expect(client.quote(buy())).rejects.toThrow(UnsupportedRoute);
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
    it("refuses on a failed feed before deriving a covenant", async () => {
        const { client, transport } = await setup({
            fetchImpl: (async () => {
                throw new Error("feed down");
            }) as unknown as typeof fetch,
        });
        vi.mocked(deriveOffer).mockClear();
        await expect(client.quote(buy())).rejects.toThrow();
        expect(transport.sent).toHaveLength(1);
        expect(deriveOffer).not.toHaveBeenCalled();
    });

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

    it("refuses a carrier that is not a decimal integer", async () => {
        for (const carrier_sats of ["1e3", "", "0x1", "-1", 1.5]) {
            const { client } = await failing((payload) =>
                arkadeAssetAnswer(payload, CLOCK, { quote: { carrier_sats } }),
            );
            await expect(client.quote(sell())).rejects.toMatchObject({ check: "pair" });
        }
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

describe("a directed quote (asset-swap-directed)", () => {
    const TAKER_KEY = hex.decode(SOLVER_DISCOVERY_KEY);
    const directed = (taker: Uint8Array): SolverAnswer => {
        const base = solverFor(CLOCK);
        return (payload) =>
            payload.pair === ASSET_BUY_PAIR || payload.pair === ASSET_SELL_PAIR
                ? arkadeAssetAnswer(payload, CLOCK, { taker })
                : base(payload);
    };

    it("advertises asset-swap-directed alone", async () => {
        const { client, transport } = await setup({ answer: directed(TAKER_KEY) });
        await client.quote(buy());
        expect(transport.sent[0]?.contract_versions).toEqual([ASSET_SWAP_DIRECTED]);
    });

    it("derives under the key that answered, and records the covenant as a binding", async () => {
        const wallet = await acceptWallet();
        const { client, repository } = await setup({ wallet, answer: directed(TAKER_KEY) });
        const quote = await client.quote(buy());
        expect(quote.solver).toBe(SOLVER_DISCOVERY_KEY);
        await client.accept(quote);

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.offerHex).toBeUndefined();
        expect(stored.binding).toMatchObject({
            version: ASSET_SWAP_DIRECTED,
            taker: SOLVER_DISCOVERY_KEY,
        });
        const packet = decodeOffer(wallet.sent[0]?.extensions?.[0]?.payload as Uint8Array);
        expect(hex.encode(packet.taker ?? new Uint8Array())).toBe(SOLVER_DISCOVERY_KEY);
        expect(hex.encode(packet.swapPkScript)).toBe(stored.swapPkScript);
    });

    it("refuses a directed quote whose solver key is not the responder", async () => {
        const { client } = await setup({ answer: directed(SOLVER_PUBKEY) });
        const refused = await client.quote(buy()).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(QuoteVerificationFailed);
        expect(refused).toMatchObject({
            check: "responder",
            expected: SOLVER_DISCOVERY_KEY,
            actual: hex.encode(SOLVER_PUBKEY),
        });
    });

    it("compares the keys as bytes, and refuses one that is not a key", () => {
        expect(
            verifyTaker({
                attested: SOLVER_DISCOVERY_KEY,
                solverPubkey: SOLVER_DISCOVERY_KEY.toUpperCase(),
            }),
        ).toEqual(TAKER_KEY);
        for (const solverPubkey of ["zz", undefined, SOLVER_DISCOVERY_KEY.slice(2)]) {
            expect(() => verifyTaker({ attested: SOLVER_DISCOVERY_KEY, solverPubkey })).toThrow(
                QuoteVerificationFailed,
            );
        }
        expect(() => verifyTaker({ solverPubkey: SOLVER_DISCOVERY_KEY })).toThrow(
            QuoteVerificationFailed,
        );
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
        const preparation = client.preparationOf(quote.id);
        expect(wallet.contracts).toHaveLength(0);

        const swap = await client.accept(quote);

        expect(wallet.contracts).toHaveLength(1);
        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.family).toBe("offer");
        expect(wallet.contracts[0]?.script).toBe(stored.swapPkScript);
        // The negotiation's own evidence on the record: the key that quoted it.
        expect(stored.solver).toBe(SOLVER_DISCOVERY_KEY);
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        const offerHex = preparation && "offer" in preparation ? preparation.offer.offerHex : "";
        expect(wallet.sent).toEqual([
            {
                address: stored.swapAddress,
                amount: 10_000,
                extensions: [{ type: OFFER_PACKET_TYPE, payload: hex.decode(offerHex) }],
            },
        ]);
    });

    it("funds a negotiated swap with no packet when asked", async () => {
        const { client, repository, wallet } = await harness();
        const quote = await client.quote(buy());
        await client.accept(quote, { attachOfferPacket: false });

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.attachOfferPacket).toBe(false);
        expect(wallet.sent).toEqual([{ address: stored.swapAddress, amount: 10_000 }]);
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

    it("resumes a record that carries only its binding with the packet it encodes", async () => {
        let failing = true;
        const { client, repository, wallet } = await harness({
            failSend: () => (failing ? new Error("send exploded") : (undefined as never)),
        });
        const quote = await client.quote(buy());
        await expect(client.accept(quote)).rejects.toThrow(/send exploded/);
        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.offerHex).toBeUndefined();
        failing = false;

        await client.accept(quote);

        const [extension] = wallet.sent[0]?.extensions ?? [];
        expect(extension?.type).toBe(OFFER_PACKET_TYPE);
        const sent = bindingFromOffer(decodeOffer(extension!.payload), OPERATOR_PUBKEY);
        expect(recordOfferBinding(sent)).toEqual(stored.binding);
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
            // The solver's carrier (it published none, so the SDK constant), recorded with the swap.
            amount: 330,
            assets: [{ assetId: USD_ASSET_ID, amount: 1_000n }],
        });
        expect(stored.carrierSats).toBe("330");
    });

    it("funds the carrier the solver published, and keeps it on the record", async () => {
        const wallet = await acceptWallet();
        const base = solverFor(CLOCK);
        const { client, repository } = await setup({
            wallet,
            answer: async (payload) => ({ ...(await base(payload)), carrier_sats: "546" }),
        });
        const quote = await client.quote(sell());
        await client.accept(quote);

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.carrierSats).toBe("546");
        expect(wallet.sent[0]?.amount).toBe(546);
    });

    it("attaches no carrier to a BTC deposit", async () => {
        const wallet = await acceptWallet();
        const { client, repository } = await setup({ wallet });
        const quote = await client.quote(buy());
        await client.accept(quote);

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.carrierSats).toBeUndefined();
    });

    it("records no carrier for a BTC deposit the card charges a delivered carrier on", async () => {
        // What the plan prices with is not what the trader funds: `accept` would send it as sats.
        const wallet = await acceptWallet();
        const { client, repository } = await setup({ wallet, snapshot: [carrierChargingCard] });
        const quote = await client.quote(buy());
        await client.accept(quote);

        const stored = (await repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.carrierSats).toBeUndefined();
        expect(wallet.sent[0]).toMatchObject({ amount: 10_000 });
        expect(wallet.sent[0]?.assets).toBeUndefined();
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
        expect(stored.binding).toEqual(derived && recordOfferBinding(derived.offerBinding));
        // the fixture solver negotiates asset-swap-directed, so accept must keep that tree
        expect(derived?.swapPkScript).toEqual(
            derived &&
                offerContract(derived.binding, derived.operatorPubkey, ASSET_SWAP_DIRECTED)
                    .pkScript,
        );
        expect(wallet.contracts[0]?.script).toBe(
            hex.encode(derived?.swapPkScript ?? new Uint8Array()),
        );
    });
});
