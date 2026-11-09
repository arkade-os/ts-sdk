import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwapClient } from "../../src/client/client";
import { expectQuote, SwapRefusal } from "../../src/rfq";
import { AmountMismatch, QuoteVerificationFailed } from "../../src/client/errors";
import type { SwapPolicy } from "../../src/client/policy";
import { completedSolverUsage, SolverRoutesUnavailable } from "../../src/client/solverRouting";
import { SolverUnavailable } from "../../src/transportErrors";
import { solverDirectionKey, solverId } from "@arkade-os/solver-discovery";
import { collectSwapRecords, InMemoryAssetSwapRepository } from "../../src/repository";
import type { Swap } from "../../src/client/record";
import {
    EMULATOR_PUBKEY_HEX,
    PAYMENT_HASH,
    clockAt,
    hdWallet,
    acceptWallet,
    feedServing,
    invoiceFor,
    lightningCard,
    rivalLightningCard,
    solverFor,
    solverTransport,
    spotCard,
    USD_ASSET_ID,
    assetCard,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const first = { ...lightningCard, solver: "first" };
const second = { ...rivalLightningCard, solver: "second", source: "second-source" };
const input = () => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});
afterEach(() => vi.useRealTimers());

const setup = async (
    options: {
        enabled?: boolean;
        failure?: Error;
        selectMarket?: SwapPolicy["selectMarket"];
        routing?: SwapPolicy["solverRouting"];
    } = {},
) => {
    const wallet = await hdWallet();
    const firstTransport = solverTransport(() => {
        throw options.failure ?? new SwapRefusal("rate_limited");
    });
    const secondTransport = solverTransport(solverFor(CLOCK), {
        attestedResponder: second.discovery_pubkey,
    });
    const attempted: string[] = [];
    const client = createSwapClient({
        wallet,
        discovery: { snapshot: [first, second] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        policy: {
            drive: "manual",
            ...(options.enabled === false ? {} : { solverRouting: options.routing ?? {} }),
            ...(options.selectMarket ? { selectMarket: options.selectMarket } : {}),
        },
        transportFor: ({ card }) => {
            attempted.push(card.solver);
            return card.solver === "first" ? firstTransport : secondTransport;
        },
    });
    return { client, attempted, firstTransport, secondTransport };
};

describe("solver quote failover", () => {
    it("tries the next solver before accepting and keeps its preparation pinned", async () => {
        const { client, attempted, firstTransport, secondTransport } = await setup();
        const quote = await client.quote(input());
        expect(attempted).toEqual(["first", "second"]);
        expect(quote.market).toMatchObject({ solver: "second", source: "second-source" });
        expect(firstTransport.closed()).toBe(true);
        expect(secondTransport.closed()).toBe(true);
        await expect(client.accept(quote)).rejects.toMatchObject({ name: "MissingCorridorDep" });
        expect(attempted).toEqual(["first", "second"]);
    });

    it("preserves single-solver behavior without opting in", async () => {
        const { client, attempted } = await setup({ enabled: false });
        await expect(client.quote(input())).rejects.toMatchObject({ reason: "rate_limited" });
        expect(attempted).toEqual(["first"]);
    });

    it("keeps an explicit selection pinned even with routing enabled", async () => {
        const { client, attempted } = await setup({ selectMarket: (candidates) => candidates[0] });
        await expect(client.quote(input())).rejects.toMatchObject({ reason: "rate_limited" });
        expect(attempted).toEqual(["first"]);
    });

    it("does not disclose to another solver after invalid caller input", async () => {
        const { client, attempted } = await setup();
        await expect(
            client.quote({ ...input(), amount: 5000n, amountOn: "take" }),
        ).rejects.toBeInstanceOf(AmountMismatch);
        expect(attempted).toEqual([]);
    });

    it("does not hide arbitrary wallet or dependency errors as solver failures", async () => {
        const error = new Error("wallet locked");
        const { client, attempted } = await setup({ failure: error });
        await expect(client.quote(input())).rejects.toBe(error);
        expect(attempted).toEqual(["first"]);
    });

    it("discards unverifiable terms before trying a different solver", async () => {
        const { client, attempted } = await setup({
            failure: new QuoteVerificationFailed("responder"),
        });
        const quote = await client.quote(input());
        expect(quote.market).toMatchObject({ solver: "second" });
        expect(attempted).toEqual(["first", "second"]);
    });

    it("enumerates saved priority without disclosing an invoice", async () => {
        const { client, attempted } = await setup({
            routing: { preferences: () => ({ priority: [solverId(second, "regtest")] }) },
        });
        const candidates = await client.candidates(input());
        expect(candidates.map(({ card }) => card.solver)).toEqual(["second", "first"]);
        expect(candidates[0].direction).toBe(solverDirectionKey(second, "base", "regtest"));
        expect(attempted).toEqual([]);
        expect((await client.quote(input())).market).toMatchObject({ solver: "second" });
        expect(attempted).toEqual(["second"]);
    });

    it("never resurrects an explicit policy veto", async () => {
        const { client, attempted } = await setup({ selectMarket: () => undefined });
        expect(await client.candidates(input())).toEqual([]);
        await expect(client.quote(input())).rejects.toMatchObject({ name: "UnsupportedRoute" });
        expect(attempted).toEqual([]);
    });

    it("can order solvers while failover is disabled", async () => {
        const { client, attempted } = await setup({ routing: { failover: false } });
        await expect(client.quote(input())).rejects.toMatchObject({ reason: "rate_limited" });
        expect(attempted).toEqual(["first"]);
    });

    it("reports exhausted attempts and closes every transport", async () => {
        const { client, attempted, firstTransport, secondTransport } = await setup();
        secondTransport.requestQuote = async () => {
            throw new SolverUnavailable("offline");
        };
        const error = await client.quote(input()).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SolverRoutesUnavailable);
        expect((error as SolverRoutesUnavailable).attempts.map(({ solverId: id }) => id)).toEqual([
            solverId(first, "regtest"),
            solverId(second, "regtest"),
        ]);
        expect(attempted).toEqual(["first", "second"]);
        expect(firstTransport.closed()).toBe(true);
        expect(secondTransport.closed()).toBe(true);
    });

    it("stops on disposal before advancing after a late timeout", async () => {
        const { client, attempted, firstTransport, secondTransport } = await setup();
        let fail: ((error: Error) => void) | undefined;
        firstTransport.requestQuote = () =>
            new Promise((_, reject) => {
                fail = reject;
            });
        const pending = client.quote(input());
        const rejection = expect(pending).rejects.toMatchObject({ name: "ClientDisposed" });
        await vi.waitFor(() => expect(fail).toBeDefined());
        await client[Symbol.asyncDispose]();
        fail!(new SolverUnavailable("late timeout"));
        await rejection;
        expect(attempted).toEqual(["first"]);
        expect(firstTransport.closed()).toBe(true);
        expect(secondTransport.sent).toEqual([]);
    });

    it("retains the accepted solver after uncertain funding", async () => {
        const wallet = await acceptWallet();
        const repository = new InMemoryAssetSwapRepository();
        const attempted: string[] = [];
        const client = createSwapClient({
            wallet: wallet.wallet,
            repository,
            discovery: { snapshot: [first, second] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            policy: { drive: "manual", solverRouting: {} },
            transportFor: ({ card }) => {
                attempted.push(card.solver);
                return card.solver === "first"
                    ? solverTransport(() => {
                          throw new SolverUnavailable("offline");
                      })
                    : solverTransport(solverFor(CLOCK), {
                          attestedResponder: second.discovery_pubkey,
                      });
            },
        });
        const quote = await client.quote(input());
        vi.spyOn(wallet.wallet, "send").mockRejectedValue(new Error("submission uncertain"));
        await expect(client.accept(quote)).rejects.toThrow("submission uncertain");
        const records = await collectSwapRecords(repository);
        expect(records).toHaveLength(1);
        expect(records[0].market).toMatchObject({ solver: "second" });
        expect(attempted).toEqual(["first", "second"]);
        await client[Symbol.asyncDispose]();
    });

    it("tries the next feed when the first advertised price is unavailable", async () => {
        const wallet = await hdWallet();
        const feed = feedServing();
        const client = createSwapClient({
            wallet,
            discovery: {
                snapshot: [
                    { ...spotCard, solver: "offline", price_feed: "https://offline.example/price" },
                    { ...spotCard, solver: "working" },
                ],
            },
            policy: { solverRouting: {} },
            fetchImpl: (url, init) =>
                String(url).includes("offline")
                    ? Promise.reject(new TypeError("network unavailable"))
                    : feed.fetch(url, init),
        });
        const quote = await client.quote({
            give: "BTC",
            take: `arkade:regtest/asset:${USD_ASSET_ID}`,
            amount: 100_000n,
            amountOn: "give",
        });
        expect(quote.market).toMatchObject({ solver: "working" });
    });

    it("counts successful durable IDs once and separates directions and networks", async () => {
        const { client } = await setup({
            routing: { preferences: () => ({ priority: [solverId(second, "regtest")] }) },
        });
        const quote = await client.quote(input());
        const swap: Swap = {
            ...quote,
            id: `rfq:${quote.id}`,
            family: "rfq",
            outcome: "paid",
            createdAt: NOW,
            updatedAt: NOW,
        };
        const direction = solverDirectionKey(second, "base", "regtest");
        const usage = completedSolverUsage(
            [
                swap,
                swap,
                { ...swap, id: "rfq:unfinished", outcome: "funded" },
                { ...swap, id: "rfq:refunded", outcome: "refunded" },
            ],
            "regtest",
            direction,
        );
        expect(usage).toEqual({ [solverId(second, "regtest")]: 1 });
        expect(
            completedSolverUsage([swap], "regtest", solverDirectionKey(second, "quote", "regtest")),
        ).toEqual({});
        expect(completedSolverUsage([swap], "bitcoin", direction)).toEqual({});
    });

    it("fails over after the real reply parser rejects a mismatched pair", async () => {
        const { client, attempted, firstTransport } = await setup();
        firstTransport.requestQuote = async (payload) =>
            expectQuote(
                { ...(await solverFor(CLOCK)(payload)), pair: "wrong-pair" },
                String(payload.rfq_id),
                String(payload.pair),
            );
        expect((await client.quote(input())).market).toMatchObject({ solver: "second" });
        expect(attempted).toEqual(["first", "second"]);
    });

    it("fails over after malformed incoming amount encoding", async () => {
        const { client, attempted, firstTransport } = await setup();
        firstTransport.requestQuote = async (payload) => ({
            ...(await solverFor(CLOCK)(payload)),
            from_amount: "not-an-amount",
        });
        expect((await client.quote(input())).market).toMatchObject({ solver: "second" });
        expect(attempted).toEqual(["first", "second"]);
    });

    it("preserves cancellation rather than returning another feed quote", async () => {
        const error = new DOMException("cancelled", "AbortError");
        const feeds: string[] = [];
        const feed = feedServing();
        const client = createSwapClient({
            wallet: await hdWallet(),
            discovery: {
                snapshot: [
                    {
                        ...spotCard,
                        solver: "cancelled",
                        price_feed: "https://cancelled.example/price",
                    },
                    { ...spotCard, solver: "working" },
                ],
            },
            policy: { solverRouting: {} },
            fetchImpl: (url, init) => {
                feeds.push(String(url));
                return String(url).includes("cancelled")
                    ? Promise.reject(error)
                    : feed.fetch(url, init);
            },
        });
        await expect(
            client.quote({ give: "BTC", take: "USD", amount: 100_000n, amountOn: "give" }),
        ).rejects.toBe(error);
        expect(feeds).toEqual(["https://cancelled.example/price"]);
    });

    it("fails over when a negotiated asset solver's reference feed is unavailable", async () => {
        const feed = feedServing();
        const attempts: string[] = [];
        const client = createSwapClient({
            wallet: await hdWallet(),
            discovery: {
                snapshot: [
                    {
                        ...assetCard,
                        solver: "offline",
                        price_feed: "https://offline.example/price",
                    },
                    { ...assetCard, solver: "working", discovery_pubkey: second.discovery_pubkey },
                ],
            },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            policy: { solverRouting: {} },
            fetchImpl: (url, init) =>
                String(url).includes("offline")
                    ? Promise.reject(new TypeError("feed offline"))
                    : feed.fetch(url, init),
            transportFor: ({ card }) => {
                attempts.push(card.solver);
                return solverTransport(solverFor(CLOCK), {
                    attestedResponder: card.discovery_pubkey,
                });
            },
        });
        expect(
            (await client.quote({ give: "BTC", take: "USD", amount: 10_000n, amountOn: "give" }))
                .market,
        ).toMatchObject({ solver: "working" });
        expect(attempts).toEqual(["offline", "working"]);
    });

    it("never discloses an invoice when disposal races a pending transport factory", async () => {
        let opened: ((transport: ReturnType<typeof solverTransport>) => void) | undefined;
        const transport = solverTransport(solverFor(CLOCK));
        const client = createSwapClient({
            wallet: await hdWallet(),
            discovery: { snapshot: [first] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            policy: { solverRouting: {} },
            transportFor: () =>
                new Promise((resolve) => {
                    opened = resolve;
                }),
        });
        const pending = client.quote(input());
        const rejection = expect(pending).rejects.toMatchObject({ name: "ClientDisposed" });
        await vi.waitFor(() => expect(opened).toBeDefined());
        await client[Symbol.asyncDispose]();
        opened!(transport);
        await rejection;
        expect(transport.sent).toEqual([]);
        expect(transport.closed()).toBe(true);
    });

    it("disposes an active quote transport without waiting for its timeout", async () => {
        const { client, attempted, firstTransport } = await setup();
        let fail: ((error: Error) => void) | undefined;
        firstTransport.requestQuote = () =>
            new Promise((_, reject) => {
                fail = reject;
            });
        const close = firstTransport.close.bind(firstTransport);
        const closeSpy = vi.spyOn(firstTransport, "close").mockImplementation(async () => {
            await close();
            fail?.(new Error("closed"));
        });
        const pending = client.quote(input());
        const rejection = expect(pending).rejects.toMatchObject({ name: "ClientDisposed" });
        await vi.waitFor(() => expect(fail).toBeDefined());
        await client[Symbol.asyncDispose]();
        expect(closeSpy).toHaveBeenCalledTimes(1);
        await rejection;
        expect(attempted).toEqual(["first"]);
    });
});
