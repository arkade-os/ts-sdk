/**
 * `quote()` end to end: the four implemented routes, both backends, and one
 * verification failure per check.
 *
 * The solver doubles derive the covenants the client will derive, from the
 * request the client actually sent, so a passing `lockup_address` check means
 * the two derivations agreed rather than that neither ran. Every failure case
 * is a tamper on that agreement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { createSwapClient } from "../../src/client/client";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import {
    AmountMismatch,
    QuoteExpired,
    QuoteVerificationFailed,
    UnsupportedRoute,
} from "../../src/client/errors";
import { AmountEncodingUnsupported } from "../../src/client/errors";
import { MIN_HEADROOM_SECONDS, SwapRefusal } from "../../src/rfq";
import { MissingCorridorDep } from "../../src/client/errors";
import type { QuoteInput } from "../../src/client/quote";
import {
    EMULATOR_PUBKEY_HEX,
    PAYMENT_HASH,
    SOLVER_DISCOVERY_KEY,
    SOLVER_PUBKEY,
    clockAt,
    feedServing,
    hdWallet,
    invoiceFor,
    lightningCard,
    lightningReceiveAnswer,
    lightningSendAnswer,
    onchainCard,
    onchainSendAnswer,
    solverTransport,
    solverFor,
    spotCard,
    type SolverAnswer,
    type SolverTransport,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

const setup = async (
    over: {
        answer?: SolverAnswer;
        attestedResponder?: string | undefined;
        snapshot?: (typeof lightningCard)[];
        policy?: Parameters<typeof createSwapClient>[0]["policy"];
        price?: number;
    } = {},
) => {
    const wallet = await hdWallet();
    const transport: SolverTransport = solverTransport(
        over.answer ?? solverFor(CLOCK),
        "attestedResponder" in over ? { attestedResponder: over.attestedResponder } : {},
    );
    const feed = feedServing(over.price);
    const client = createSwapClient({
        wallet,
        discovery: { snapshot: over.snapshot ?? [lightningCard, onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => transport,
        fetchImpl: feed.fetch,
        ...(over.policy === undefined ? {} : { policy: over.policy }),
    });
    return { client, transport, feed, wallet };
};

const sendInput = (): QuoteInput => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("quote() on arkade -> lightning", () => {
    it("pins the amount from the invoice and returns the order, fee included", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(sendInput());

        expect(quote.give).toEqual({ asset: "arkade:regtest/slip44:0", amount: 5_050n });
        expect(quote.take).toEqual({ asset: "bolt11:regtest/slip44:0", amount: 5_000n });
        expect(quote.fee).toEqual({ amount: 50n, asset: "arkade:regtest/slip44:0" });
        expect(quote.lock).toEqual({ hash: PAYMENT_HASH });
        expect(quote.refundLocktime).toBe(CLOCK.refundLocktime);
        expect(quote.expiresAt).toBe(CLOCK.validUntil);
        expect(quote.solver).toBe(hex.encode(SOLVER_PUBKEY));
        // The give leg is the wallet's, the take leg is the invoice the caller
        // handed in: the supply law, as a value.
        expect(quote.route.give.instrument).toEqual({ kind: "wallet" });
        expect(quote.route.take.instrument).toMatchObject({ kind: "invoice" });
        // Nothing to show a counterparty: the solver already has the invoice.
        expect(quote.artifact).toBeUndefined();
        expect(transport.sent).toHaveLength(1);
    });

    it("carries the card's provenance and closes the rendezvous behind it", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(sendInput());

        expect(quote.market).toMatchObject({
            kind: "card",
            backend: "rfq",
            key: "arkade:btc/lightning:btc",
            source: lightningCard.source,
            sourceType: "registry",
            solver: "frenchman",
            discoveryPubkey: SOLVER_DISCOVERY_KEY,
        });
        expect(quote.market.kind === "card" && quote.market.snapshot.source).toBe("injected");
        expect(transport.closed()).toBe(true);
    });

    it("hands the accept path the covenant it verified, and persists nothing", async () => {
        const { client } = await setup();
        const quote = await client.quote(sendInput());
        const preparation = client.preparationOf(quote.id);

        expect(preparation).toMatchObject({ backend: "rfq", route: "arkade->lightning" });
        // The wallet double throws from `getContractManager`, so reaching here
        // is the assertion that nothing was registered.
        expect(preparation && "lockup" in preparation && preparation.lockup.address).toMatch(
            /^tark1/,
        );
    });

    it("populates no auction: published RFQ is reserved and inert", async () => {
        const { client } = await setup();
        expect((await client.quote(sendInput())).auction).toBeUndefined();
    });
});

describe("quote() on lightning -> arkade", () => {
    const receive = (): QuoteInput => ({ via: "lightning", amount: 5_000n, amountOn: "give" });

    it("returns the solver's hold invoice as the artifact, verified against this swap", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(receive());

        expect(quote.artifact?.kind).toBe("invoice");
        // The artifact and the give leg's instrument are one fact, not two.
        expect(quote.artifact).toEqual({
            kind: "invoice",
            bolt11: (quote.route.give.instrument as { bolt11: string }).bolt11,
        });
        expect(transport.sent).toHaveLength(1);
        expect(quote.give.asset).toBe("bolt11:regtest/slip44:0");
        expect(quote.take).toEqual({ asset: "arkade:regtest/slip44:0", amount: 4_950n });
        // The give leg's instrument IS the artifact — the quote supplies the
        // non-wallet give instrument, which is what the artifact is.
        expect(quote.route.give.instrument).toMatchObject({ kind: "invoice", amount: 5_000n });
        expect(quote.route.take.instrument).toEqual({ kind: "wallet" });
    });

    it("sends the amount as a canonical decimal string on the side it pins", async () => {
        const { client, transport } = await setup();
        await client.quote(receive());
        expect(transport.sent[0]).toMatchObject({ amount: "5000", amount_side: "from" });
    });

    it("expires with the hold invoice rather than with the quote", async () => {
        const { client } = await setup();
        const quote = await client.quote(receive());
        // The invoice's own window is an hour from a minute ago; the quote's is
        // an hour from now. The earlier of the two binds.
        expect(quote.expiresAt).toBe(NOW + 3_540);
        expect(quote.expiresAt).toBeLessThan(CLOCK.validUntil);
    });
});

describe("quote() on arkade -> onchain", () => {
    const send = (): QuoteInput => ({ to: BCRT1, amount: 100_000n, amountOn: "give" });

    it("quotes both contracts and reports the covenant's refund deadline", async () => {
        const { client } = await setup();
        const quote = await client.quote(send());

        expect(quote.give).toEqual({ asset: "arkade:regtest/slip44:0", amount: 100_000n });
        expect(quote.take).toEqual({ asset: "bitcoin:regtest/slip44:0", amount: 99_000n });
        expect(quote.route.take.instrument).toEqual({ kind: "address", address: BCRT1 });
        expect(quote.refundLocktime).toBe(CLOCK.refundLocktime);
        const preparation = client.preparationOf(quote.id);
        expect(preparation).toMatchObject({
            route: "arkade->onchain",
            minConfirmations: 2,
            l1Network: "regtest",
        });
    });
});

describe("quote() on arkade -> arkade", () => {
    const exchange = (): QuoteInput => ({
        give: "BTC",
        take: "USD",
        amount: 10_000n,
        amountOn: "give",
    });

    it("prices from the card's feed, with no round trip to anybody", async () => {
        const { client, transport, feed } = await setup();
        const quote = await client.quote(exchange());

        // 10_000 sats at 0.1 cents/sat, less the card's 30bps and no cushion.
        expect(quote.give.amount).toBe(10_000n);
        expect(quote.take).toEqual({
            asset: `arkade:regtest/asset:${spotCard.quote_asset.id}`,
            amount: 997n,
        });
        expect(quote.fee).toEqual({
            amount: 3n,
            asset: `arkade:regtest/asset:${spotCard.quote_asset.id}`,
        });
        expect(quote.market.backend).toBe("feed");
        expect(transport.sent).toHaveLength(0);
        expect(feed.calls()).toBe(1);
    });

    it("mints an expiry from the feed's own freshness, since the plan carries none", async () => {
        const { client } = await setup();
        const quote = await client.quote(exchange());
        expect(quote.expiresAt).toBe(NOW + 30);
        expect(quote.solver).toBeUndefined();
        expect(quote.lock).toBeUndefined();
        expect(quote.refundLocktime).toBeUndefined();
    });

    it("resolves a ticker against the cards themselves", async () => {
        const { client } = await setup();
        const resolution = await client.resolve(exchange());
        expect(resolution.give.asset).toBe("arkade:regtest/slip44:0");
        expect(resolution.take.asset).toBe(`arkade:regtest/asset:${spotCard.quote_asset.id}`);
    });
});

describe("a dependency overridden to nothing", () => {
    const withoutChainSource = async () => {
        const wallet = await hdWallet();
        const transport = solverTransport(solverFor(CLOCK));
        const feed = feedServing();
        return {
            transport,
            client: createSwapClient({
                wallet,
                discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
                corridors: { onchain: { chain: null } },
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                transportFor: () => transport,
                fetchImpl: feed.fetch,
            }),
        };
    };

    it("refuses the route that touches it, before anything is disclosed", async () => {
        const { client, transport } = await withoutChainSource();
        const error = await client
            .quote({ to: BCRT1, amount: 100_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(MissingCorridorDep);
        expect(error.corridor).toBe("onchain");
        expect(transport.sent).toHaveLength(0);
    });

    it("is no error at all for a route that never touches that corridor", async () => {
        const { client } = await withoutChainSource();
        await expect(client.quote(sendInput())).resolves.toMatchObject({
            take: { amount: 5_000n },
        });
    });
});

describe("the boundary quote() stops at", () => {
    /** Every repository call this quote made, by name. */
    const recording = (): { repository: AssetSwapRepository; calls: string[] } => {
        const calls: string[] = [];
        const backing = new InMemoryAssetSwapRepository();
        const repository = new Proxy(backing, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    calls.push(String(property));
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            },
        }) as unknown as AssetSwapRepository;
        return { repository, calls };
    };

    it("writes no record on either backend, and reaches no contract manager", async () => {
        const { repository, calls } = recording();
        const wallet = await hdWallet();
        const transport = solverTransport(solverFor(CLOCK));
        const feed = feedServing();
        const client = createSwapClient({
            wallet,
            repository,
            discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feed.fetch,
        });

        await client.quote(sendInput());
        await client.quote({ give: "BTC", take: "USD", amount: 10_000n, amountOn: "give" });

        // The wallet double throws from `getContractManager`, so arriving here
        // is the proof that no lockup was registered — and the repository saw
        // no write at all, because the markets came from an injected snapshot.
        expect(calls.filter((call) => call.startsWith("save"))).toEqual([]);
        expect(calls.filter((call) => call.includes("Swap"))).toEqual([]);
    });
});

describe("the route the union excludes", () => {
    it("refuses onchain -> arkade before anything is disclosed", async () => {
        const { client, transport } = await setup();
        await expect(
            client.quote({ via: "onchain", amount: 100_000n, amountOn: "give" }),
        ).rejects.toThrow(UnsupportedRoute);
        expect(transport.sent).toHaveLength(0);
    });
});

describe("verification, one failure per check", () => {
    it("refuses a quote for another pair", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, { quote: { pair: "arkade:BTC->onchain:BTC" } }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("pair");
    });

    it("refuses a lockup address it did not derive", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, {
                    profile: { lockup_address: "tark1qsomebodyelses" },
                }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("lockup_address");
        // v1's AddressMismatch, folded in rather than admitted as a
        // seventeenth member.
        expect(error.cause).toMatchObject({ name: "AddressMismatch" });
    });

    it("refuses a send quote that reprices the invoice", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, { quote: { to_amount: 4_000 } }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("invoice");
    });

    it("refuses a hold invoice on another payment hash", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningReceiveAnswer(payload, CLOCK, {
                    invoice: invoiceFor("ab".repeat(32), CLOCK),
                }),
        });
        const error = await client
            .quote({ via: "lightning", amount: 5_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("invoice");
    });

    it("refuses a refund window inside the funding headroom", async () => {
        const tight = { ...CLOCK, refundLocktime: NOW + MIN_HEADROOM_SECONDS - 60 };
        const { client } = await setup({
            answer: (payload) => lightningSendAnswer(payload, tight),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
    });

    it("refuses a valid_until that would delete the expiry gate rather than fail it", async () => {
        const { client } = await setup({
            answer: (payload) => ({
                ...lightningSendAnswer(payload, CLOCK),
                valid_until: Number.NaN,
            }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
    });

    it("refuses a transport that attests nobody, before disclosing anything", async () => {
        const { client, transport } = await setup({ attestedResponder: undefined });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("responder");
        // The whole point of running it before the request.
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a transport attesting somebody other than the card's key", async () => {
        const { client } = await setup({ attestedResponder: "cd".repeat(32) });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error.check).toBe("responder");
        expect(error.expected).toBe(SOLVER_DISCOVERY_KEY);
    });

    it("keeps a solver's decline a refusal, not a verification failure", async () => {
        const { client } = await setup({
            answer: () => {
                throw new SwapRefusal("amount_out_of_range");
            },
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(SwapRefusal);
        expect(error).not.toBeInstanceOf(QuoteVerificationFailed);
        expect(error.reason).toBe("amount_out_of_range");
    });

    it("refuses a quote already inside the policy's TTL floor", async () => {
        const { client } = await setup({ policy: { quoteTtlFloorSeconds: 7_200 } });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteExpired);
    });
});

describe("the amount encoding, both ways", () => {
    it("refuses a quote amount a JSON number cannot carry", async () => {
        const { client } = await setup({
            answer: (payload) =>
                onchainSendAnswer(payload, CLOCK, {
                    quote: { from_amount: Number.MAX_SAFE_INTEGER + 2 },
                }),
        });
        const error = await client
            .quote({ to: BCRT1, amount: 100_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(AmountEncodingUnsupported);
        expect(error.field).toBe("from_amount");
    });

    it("reads a canonical decimal string quote amount", async () => {
        const { client } = await setup({
            answer: (payload) =>
                onchainSendAnswer(payload, CLOCK, {
                    quote: {
                        from_amount: "100000" as unknown as number,
                        to_amount: "99000" as unknown as number,
                    },
                }),
        });
        const quote = await client.quote({ to: BCRT1, amount: 100_000n, amountOn: "give" });
        expect(quote.give.amount).toBe(100_000n);
        expect(quote.take.amount).toBe(99_000n);
    });

    it("refuses a second pinned amount before any round trip", async () => {
        const { client, transport } = await setup();
        await expect(
            client.quote({ ...sendInput(), amount: 5_000n, amountOn: "take" }),
        ).rejects.toThrow(AmountMismatch);
        expect(transport.sent).toHaveLength(0);
    });
});
