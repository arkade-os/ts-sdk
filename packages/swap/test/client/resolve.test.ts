/**
 * `resolve()`: the parse, the pair, the pin and the veto — everything that
 * happens before a solver hears anything, and the errors that stop it there.
 *
 * The discovery half is the other axis: the same route resolves against an
 * injected snapshot, a stale cache and a registry that serves nothing, and the
 * three are told apart on the resolution rather than collapsed into one empty
 * array. The last block follows a cache-served card one step past that line,
 * into the re-pin `quote()` owes it — both halves of one rule, so they are read
 * together rather than split across two files by which one reaches a solver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwapClient } from "../../src/client/client";
import {
    AmbiguousDestination,
    AmountMismatch,
    DiscoverySnapshotUnavailable,
    OperatorUnreachable,
    UnsupportedRoute,
} from "../../src/client/errors";
import { InMemoryAssetSwapRepository } from "../../src/repository";
import type { QuoteInput } from "../../src/client/quote";
import {
    ARK_INFO,
    EMULATOR_PUBKEY_HEX,
    PAYMENT_HASH,
    USD_ASSET_ID,
    clockAt,
    feedServing,
    hdWallet,
    indexOf,
    invoiceFor,
    lightningCard,
    onchainCard,
    solverFor,
    solverTransport,
    spotCard,
} from "./fixtures";
import { ArkAddress } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const OPERATOR = schnorr.getPublicKey(new Uint8Array(32).fill(3));
const OURS = new ArkAddress(OPERATOR, schnorr.getPublicKey(new Uint8Array(32).fill(21)), "tark");
const FOREIGN = new ArkAddress(
    schnorr.getPublicKey(new Uint8Array(32).fill(30)),
    schnorr.getPublicKey(new Uint8Array(32).fill(21)),
    "tark",
);

const clientWith = async (
    over: {
        snapshot?: unknown[];
        registryUrl?: string;
        fetchImpl?: typeof fetch;
        repository?: InMemoryAssetSwapRepository;
        policy?: Parameters<typeof createSwapClient>[0]["policy"];
        wallet?: Awaited<ReturnType<typeof hdWallet>>;
    } = {},
) => {
    const wallet = over.wallet ?? (await hdWallet());
    const transport = solverTransport(solverFor(CLOCK));
    const feed = feedServing();
    return {
        transport,
        client: createSwapClient({
            wallet,
            discovery: {
                ...(over.snapshot === undefined ? {} : { snapshot: over.snapshot as never }),
                ...(over.registryUrl === undefined ? {} : { registryUrl: over.registryUrl }),
                ...(over.fetchImpl === undefined ? {} : { fetchImpl: over.fetchImpl }),
            },
            ...(over.repository === undefined ? {} : { repository: over.repository }),
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feed.fetch,
            ...(over.policy === undefined ? {} : { policy: over.policy }),
        }),
    };
};

const withCards = (over: Record<string, unknown> = {}) =>
    clientWith({ snapshot: [lightningCard, onchainCard, spotCard], ...over });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the destination, parsed once", () => {
    it("reads a bolt11 as the lightning corridor, with the invoice as the instrument", async () => {
        const { client } = await withCards();
        const resolution = await client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) });

        expect(resolution.give).toMatchObject({
            corridor: "arkade",
            asset: "arkade:regtest/slip44:0",
            instrument: { kind: "wallet" },
        });
        expect(resolution.take).toMatchObject({
            corridor: "lightning",
            asset: "bolt11:regtest/slip44:0",
            instrument: { kind: "invoice", amount: 5_000n },
        });
        // The invoice pins the take leg by existing.
        expect(resolution.amount).toEqual({ value: 5_000n, on: "take", source: "invoice" });
        expect(resolution.eligible).toBe(1);
        expect(resolution.market?.kind === "card" && resolution.market.backend).toBe("rfq");
    });

    it("reads an L1 address as the onchain corridor", async () => {
        const { client } = await withCards();
        const resolution = await client.resolve({ to: BCRT1, amount: 100_000n, amountOn: "give" });
        expect(resolution.take).toMatchObject({
            corridor: "onchain",
            asset: "bitcoin:regtest/slip44:0",
            instrument: { kind: "address", address: BCRT1 },
        });
        expect(resolution.amount).toEqual({ value: 100_000n, on: "give", source: "caller" });
    });

    it("sends a plain Arkade address back to the wallet, where it belongs", async () => {
        const { client } = await withCards();
        await expect(client.resolve({ to: OURS.encode() })).rejects.toThrow(/plain Arkade payment/);
    });

    it("refuses another operator's Arkade address as underdetermined, not unrouted", async () => {
        const { client } = await withCards();
        await expect(client.resolve({ to: FOREIGN.encode() })).rejects.toThrow(
            AmbiguousDestination,
        );
    });

    it("leaves a destination no corridor serves to the route, not to the parse", async () => {
        const { client } = await withCards();
        // Core classifies an LNURL and no corridor claims it.
        await expect(
            client.resolve({
                to: "lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7tnhv4kxctttdehhwm30d3h82unvwqhkxctnda3h",
            }),
        ).rejects.toThrow(UnsupportedRoute);
    });

    it("refuses a destination nothing classifies at all", async () => {
        const { client } = await withCards();
        await expect(client.resolve({ to: "0xdeadbeef" })).rejects.toThrow(AmbiguousDestination);
    });
});

describe("the corridor pair", () => {
    it("takes `via` for the leg with no instrument yet", async () => {
        const { client } = await withCards();
        const resolution = await client.resolve({
            via: "lightning",
            amount: 5_000n,
            amountOn: "give",
        });
        expect(resolution.give).toMatchObject({ corridor: "lightning" });
        // No instrument on the give leg: the quote mints it.
        expect(resolution.give.instrument).toBeUndefined();
        expect(resolution.take).toMatchObject({
            corridor: "arkade",
            instrument: { kind: "wallet" },
        });
    });

    it("refuses onchain -> arkade, and says why it is missing", async () => {
        const { client } = await withCards();
        await expect(
            client.resolve({ via: "onchain", amount: 100_000n, amountOn: "give" }),
        ).rejects.toThrow(/L1 refund path/);
    });

    it("refuses `via: arkade`, which names the wallet's own side", async () => {
        const { client } = await withCards();
        await expect(
            client.resolve({ via: "arkade", amount: 1_000n, amountOn: "give" }),
        ).rejects.toThrow(UnsupportedRoute);
    });

    it("refuses one leg twice", async () => {
        const { client } = await withCards();
        await expect(client.resolve({ amount: 1_000n, amountOn: "give" })).rejects.toThrow(
            /both legs are/,
        );
    });

    it("refuses an asset whose rail disagrees with the leg it was named on", async () => {
        const { client } = await withCards();
        await expect(
            client.resolve({
                to: invoiceFor(PAYMENT_HASH, CLOCK),
                take: "arkade:regtest/slip44:0",
            }),
        ).rejects.toThrow(UnsupportedRoute);
    });
});

describe("the pin", () => {
    const invoice = (): QuoteInput => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) });

    it("refuses a caller amount beside an invoice, even before a market is chosen", async () => {
        const { client } = await clientWith({ snapshot: [] });
        await expect(
            client.resolve({ ...invoice(), amount: 5_000n, amountOn: "take" }),
        ).rejects.toThrow(AmountMismatch);
    });

    it("refuses an amount with no side", async () => {
        const { client } = await withCards();
        await expect(client.resolve({ via: "lightning", amount: 5_000n })).rejects.toThrow(
            /amountOn/,
        );
    });

    it("refuses a non-positive amount", async () => {
        const { client } = await withCards();
        await expect(
            client.resolve({ via: "lightning", amount: 0n, amountOn: "give" }),
        ).rejects.toThrow(/must be positive/);
    });
});

describe("what the snapshot serves", () => {
    it("refuses to resolve at all with no market data anywhere", async () => {
        const { client } = await clientWith({});
        await expect(client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) })).rejects.toThrow(
            DiscoverySnapshotUnavailable,
        );
    });

    it("resolves against a stale cache, and marks it stale", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const registryUrl = "https://registry.example/regtest.json";
        await repository.saveCachedMarkets("regtest", registryUrl, {
            markets: [lightningCard],
            fetchedAt: Date.now() - 3_600_000,
        });
        const { client } = await clientWith({
            registryUrl,
            repository,
            fetchImpl: (async () => {
                throw new Error("registry unreachable");
            }) as unknown as typeof fetch,
        });
        const resolution = await client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) });
        expect(resolution.snapshot).toMatchObject({ live: false, source: "cache" });
        expect(resolution.eligible).toBe(1);
    });

    it("resolves with an empty eligible set when the registry serves no such market", async () => {
        const { client } = await clientWith({ snapshot: [spotCard] });
        const resolution = await client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) });
        expect(resolution.eligible).toBe(0);
        expect(resolution.market).toBeUndefined();
        // The route itself resolved: nothing about the destination or the
        // corridor pair failed.
        expect(resolution.take.corridor).toBe("lightning");
    });

    it("turns that empty set into UnsupportedRoute at quote time, naming the snapshot", async () => {
        const { client, transport } = await clientWith({ snapshot: [spotCard] });
        const error = await client.quote({ to: invoiceFor(PAYMENT_HASH, CLOCK) }).catch((e) => e);
        expect(error).toBeInstanceOf(UnsupportedRoute);
        expect(error.message).toMatch(/active discovery snapshot/);
        expect(transport.sent).toHaveLength(0);
    });

    it("lands an allowlist that empties the set in the same place", async () => {
        const { client } = await withCards({
            policy: { allowedRegistries: ["https://somewhere.else/regtest.json"] },
        });
        const resolution = await client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) });
        expect(resolution.eligible).toBe(0);
        await expect(client.quote({ to: invoiceFor(PAYMENT_HASH, CLOCK) })).rejects.toThrow(
            UnsupportedRoute,
        );
    });

    it("lands a policy veto there too", async () => {
        const { client } = await withCards({ policy: { selectMarket: () => undefined } });
        expect((await client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) })).eligible).toBe(0);
    });

    it("resolves an asset swap's tickers against the cards", async () => {
        const { client } = await withCards();
        const resolution = await client.resolve({
            give: "btc",
            take: "usd",
            amount: 10_000n,
            amountOn: "give",
        });
        expect(resolution.give.asset).toBe("arkade:regtest/slip44:0");
        expect(resolution.take.asset).toBe(`arkade:regtest/asset:${USD_ASSET_ID}`);
        expect(resolution.market?.kind === "card" && resolution.market.backend).toBe("feed");
    });

    it("does not touch the network to answer", async () => {
        const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch &
            ReturnType<typeof vi.fn>;
        const { client } = await clientWith({
            snapshot: [lightningCard],
            registryUrl: "https://registry.example/regtest.json",
            fetchImpl,
        });
        await client.resolve({ to: invoiceFor(PAYMENT_HASH, CLOCK) });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("the deferred init", () => {
    it("retries the operator read rather than serving its rejection forever", async () => {
        let reads = 0;
        let offline = true;
        const wallet = await hdWallet({
            getArkadeInfo: async () => {
                reads += 1;
                if (offline) throw new Error("operator unreachable");
                return ARK_INFO;
            },
        });
        const { client } = await clientWith({ wallet, snapshot: [lightningCard] });
        const invoice = invoiceFor(PAYMENT_HASH, CLOCK);

        const error = await client.resolve({ to: invoice }).catch((e) => e);
        expect(error).toBeInstanceOf(OperatorUnreachable);

        offline = false;
        expect((await client.resolve({ to: invoice })).take.corridor).toBe("lightning");
        // ...and the retry is the ONLY extra read: the resolved context is
        // still memoized once it succeeds.
        await client.resolve({ to: invoice });
        expect(reads).toBe(2);
    });
});

describe("a quote against a cache-served card", () => {
    it("re-pins the card from the registry, and refuses when it cannot", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const registryUrl = "https://registry.example/regtest.json";
        await repository.saveCachedMarkets("regtest", registryUrl, {
            markets: [lightningCard],
            fetchedAt: Date.now(),
        });
        const fetchImpl = vi.fn(async () => {
            throw new Error("registry unreachable");
        }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
        const { client, transport } = await clientWith({ registryUrl, repository, fetchImpl });

        const error = await client.quote({ to: invoiceFor(PAYMENT_HASH, CLOCK) }).catch((e) => e);
        // The refetch was attempted, the card stayed cache content, and the
        // responder check refused to pin against it.
        expect(fetchImpl).toHaveBeenCalled();
        expect(error.name).toBe("QuoteVerificationFailed");
        expect(error.check).toBe("responder");
        expect(transport.sent).toHaveLength(0);
    });

    it("quotes against the re-pinned card when the retry reaches the registry", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const registryUrl = "https://registry.example/regtest.json";
        await repository.saveCachedMarkets("regtest", registryUrl, {
            markets: [lightningCard],
            fetchedAt: Date.now(),
        });
        // Unreachable for the load that resolves the route, reachable for the
        // re-pin: the one sequence that tells the refresh apart from it.
        let reached = false;
        const fetchImpl = vi.fn(async () => {
            if (!reached) {
                reached = true;
                throw new Error("registry unreachable");
            }
            return new Response(JSON.stringify(indexOf([lightningCard])));
        }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
        const { client, transport } = await clientWith({ registryUrl, repository, fetchImpl });

        const quote = await client.quote({ to: invoiceFor(PAYMENT_HASH, CLOCK) });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(quote.market.kind === "card" && quote.market.snapshot).toMatchObject({
            live: true,
            source: "live",
        });
        // A live card names the key the responder check pins against, so this
        // is the one path on which the invoice reaches a solver at all.
        expect(transport.sent).toHaveLength(1);
    });

    it("leaves a feed-priced market on the stale snapshot, having nothing to pin", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const registryUrl = "https://registry.example/regtest.json";
        await repository.saveCachedMarkets("regtest", registryUrl, {
            markets: [spotCard],
            fetchedAt: Date.now(),
        });
        const fetchImpl = vi.fn(async () => {
            throw new Error("registry unreachable");
        }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
        const { client } = await clientWith({ registryUrl, repository, fetchImpl });

        const quote = await client.quote({
            give: "BTC",
            take: "USD",
            amount: 10_000n,
            amountOn: "give",
        });
        // No re-pin attempted: the refresh is the addressed backend's, and a
        // feed quote discloses nothing to a responder.
        expect(quote.market.backend).toBe("feed");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
