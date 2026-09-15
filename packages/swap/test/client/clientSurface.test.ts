/**
 * The rest of the v2 client surface: `swaps()`, `markets()`, cancel's refusals
 * and the disposal gate.
 *
 * These run through `createSwapClient` because the composition is what M6
 * closes — cancel's mechanics are pinned in `cancel.test.ts`, and what matters
 * here is the surface a caller meets: which ids are refused before a repository
 * is touched, what the history read returns independently of the drive, and
 * which of the thirteen members a disposed instance still answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwapClient, type SwapClient } from "../../src/client/client";
import { ClientDisposed, MissingCorridorDep, NotCancellable } from "../../src/client/errors";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import type { SwapRecord } from "../../src/client/record";
import type { QuoteInput } from "../../src/client/quote";
import {
    EMULATOR_PUBKEY_HEX,
    acceptWallet,
    clockAt,
    feedServing,
    lightningCard,
    onchainCard,
    rivalLightningCard,
    solverFor,
    solverTransport,
    spotCard,
    type AcceptWallet,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface Harness {
    readonly client: SwapClient;
    readonly repository: AssetSwapRepository;
    readonly wallet: AcceptWallet;
}

const harness = async (
    over: {
        omitRepository?: boolean;
        drive?: "auto" | "manual" | "readonly";
        repository?: AssetSwapRepository;
        allowedRegistries?: readonly string[];
        snapshot?: (typeof lightningCard)[];
    } = {},
): Promise<Harness> => {
    const wallet = await acceptWallet();
    const repository = over.repository ?? new InMemoryAssetSwapRepository();
    const client = createSwapClient({
        wallet: wallet.wallet,
        ...(over.omitRepository ? {} : { repository }),
        discovery: { snapshot: over.snapshot ?? [lightningCard, onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => solverTransport(solverFor(CLOCK)),
        fetchImpl: feedServing().fetch,
        ...(over.drive === undefined && over.allowedRegistries === undefined
            ? {}
            : {
                  policy: {
                      ...(over.drive === undefined ? {} : { drive: over.drive }),
                      ...(over.allowedRegistries === undefined
                          ? {}
                          : { allowedRegistries: over.allowedRegistries }),
                  },
              }),
    });
    return { client, repository, wallet };
};

/** `arkade -> arkade`: the offer family, and the only one that cancels. */
const SPOT: QuoteInput = { give: "BTC", take: "USD", amount: 100_000n, amountOn: "give" };
/** `lightning -> arkade`: the corridor family, whose exits are a claim or a refund. */
const RECEIVE: QuoteInput = { via: "lightning", amount: 5_000n, amountOn: "give" };

/** Accept one of each family, and answer with their tagged public ids. */
const bothFamilies = async (h: Harness): Promise<{ offer: string; rfq: string }> => {
    const offer = await h.client.accept(await h.client.quote(SPOT));
    const rfq = await h.client.accept(await h.client.quote(RECEIVE));
    return { offer: offer.id, rfq: rfq.id };
};

describe("swaps()", () => {
    it("returns both families, under the tagged public id", async () => {
        const h = await harness();
        const { offer, rfq } = await bothFamilies(h);

        const swaps = await h.client.swaps();
        expect(swaps.map((s) => s.id).sort()).toEqual([offer, rfq].sort());
        expect(offer.startsWith("offer:")).toBe(true);
        expect(rfq.startsWith("rfq:")).toBe(true);
        await h.client[Symbol.asyncDispose]();
    });

    it("answers the same set before start(), under readonly, and after a pass", async () => {
        // Membership is a property of the keyspace, not of the drive: the same
        // records come back whether or not anything is being driven.
        const repository = new InMemoryAssetSwapRepository();
        const h = await harness({ repository });
        const { offer, rfq } = await bothFamilies(h);
        const before = (await h.client.swaps()).map((s) => s.id).sort();
        await h.client.start();
        await h.client.stop();
        const after = (await h.client.swaps()).map((s) => s.id).sort();
        await h.client[Symbol.asyncDispose]();

        // A second client over the same store, told to actuate nothing.
        const ro = await harness({ repository, drive: "readonly" });
        const readonly = (await ro.client.swaps()).map((s) => s.id).sort();
        await ro.client[Symbol.asyncDispose]();

        expect(before).toEqual([offer, rfq].sort());
        expect(after).toEqual(before);
        expect(readonly).toEqual(before);
    });

    it("filters family and outcome in memory", async () => {
        const h = await harness();
        const { offer, rfq } = await bothFamilies(h);

        expect((await h.client.swaps({ family: "offer" })).map((s) => s.id)).toEqual([offer]);
        expect((await h.client.swaps({ family: "rfq" })).map((s) => s.id)).toEqual([rfq]);
        // The offer is funded and unfilled, the receive leg is a durable invoice
        // nothing has looked at yet.
        expect((await h.client.swaps({ outcome: "open" })).map((s) => s.id)).toEqual([offer]);
        expect(await h.client.swaps({ family: "offer", outcome: "cancelled" })).toEqual([]);
        await h.client[Symbol.asyncDispose]();
    });

    it("skips a record that will not decode rather than failing the read", async () => {
        // The v1 store's rule, applied to the v2 keyspace: one unreadable row
        // must not cost a caller its whole history.
        const h = await harness();
        const { offer } = await bothFamilies(h);
        await h.repository.saveSwapRecord({ id: "corrupt", family: "offer" } as SwapRecord);

        const swaps = await h.client.swaps();
        expect(swaps.map((s) => s.id)).toContain(offer);
        expect(swaps.map((s) => s.id)).not.toContain("offer:corrupt");
        await h.client[Symbol.asyncDispose]();
    });

    it("keeps an aged terminal corridor record the v1 retention window would prune", async () => {
        // M5/A2, read from the `swaps()` side: the bridge's `removeRfqSwap` is
        // inert for v2 records, so the manager's prune deletes nothing and the
        // v2 keyspace is never pruned at all.
        const h = await harness();
        const { rfq } = await bothFamilies(h);
        const id = rfq.slice("rfq:".length);
        const stored = await h.repository.getSwapRecord(id);
        await h.repository.saveSwapRecord({
            ...stored,
            state: "settled",
            // Far outside any retention window.
            updatedAt: NOW - 400 * 24 * 3600,
        } as SwapRecord);
        await h.client[Symbol.asyncDispose]();

        // A fresh client's construction restore is what runs the prune.
        const next = await harness({ repository: h.repository });
        await next.client.ready;
        expect((await next.client.swaps()).map((s) => s.id)).toContain(rfq);
        expect(await next.repository.getSwapRecord(id)).toBeDefined();
        await next.client[Symbol.asyncDispose]();
    });

    it("answers with nothing for a client that was given no storage", async () => {
        const h = await harness({ omitRepository: true });
        expect(await h.client.swaps()).toEqual([]);
        await h.client[Symbol.asyncDispose]();
    });
});

describe("markets()", () => {
    it("publishes the same card a quote cites", async () => {
        const h = await harness();
        const quote = await h.client.quote(SPOT);
        const markets = await h.client.markets();

        const cited = markets.find((m) => m.key === quote.market.key);
        expect(cited).toEqual(quote.market);
        // The escape hatch's own vocabulary: discovery's asset ids and display
        // labels never cross the v2 root.
        expect(markets.every((m) => m.kind === "card")).toBe(true);
        await h.client[Symbol.asyncDispose]();
    });

    it("offers no card the quote path would then refuse", async () => {
        // The registry allowlist is the routing read's filter, and the hatch
        // applies the same one — a caller cannot pick a market `quote()` would
        // not price.
        const h = await harness({
            snapshot: [lightningCard, rivalLightningCard],
            allowedRegistries: [lightningCard.source],
        });
        const markets = await h.client.markets();
        expect(markets.map((m) => m.source)).toEqual([lightningCard.source]);
        await h.client[Symbol.asyncDispose]();
    });
});

describe("cancel() — what it refuses, and when", () => {
    it("refuses a corridor id on the parse, with no repository read", async () => {
        // The point of the tag: the id round-tripped through `swaps()` names its
        // family, so the refusal costs nothing.
        const h = await harness();
        const { rfq } = await bothFamilies(h);
        const read = vi.spyOn(h.repository, "getSwapRecord");

        await expect(h.client.cancel(rfq as `rfq:${string}`)).rejects.toBeInstanceOf(
            NotCancellable,
        );
        expect(read).not.toHaveBeenCalled();
        await h.client[Symbol.asyncDispose]();
    });

    it("refuses an offer id no record backs, after the one read", async () => {
        const h = await harness();
        await expect(h.client.cancel("offer:nothing-here")).rejects.toBeInstanceOf(NotCancellable);
        await h.client[Symbol.asyncDispose]();
    });

    it("names the repository when the client was given none", async () => {
        const h = await harness({ omitRepository: true });
        await expect(h.client.cancel("offer:anything")).rejects.toBeInstanceOf(MissingCorridorDep);
        await h.client[Symbol.asyncDispose]();
    });
});

describe("ClientDisposed", () => {
    it("refuses every new act after disposal", async () => {
        const h = await harness();
        const quote = await h.client.quote(SPOT);
        await h.client[Symbol.asyncDispose]();

        // Synchronous members, `ready` included: a property that handed back a
        // rejected promise nobody awaited would be an unhandled rejection.
        expect(() => h.client.ready).toThrow(ClientDisposed);
        expect(() => h.client.onUpdate(() => {})).toThrow(ClientDisposed);
        expect(() => h.client.preparationOf(quote.id)).toThrow(ClientDisposed);

        await expect(h.client.start()).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.stop()).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.resolve(SPOT)).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.quote(SPOT)).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.accept(quote)).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.cancel("offer:anything")).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.swaps()).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.markets()).rejects.toBeInstanceOf(ClientDisposed);
        await expect(h.client.recover("offer:anything")).rejects.toBeInstanceOf(ClientDisposed);
    });

    it("leaves a handed-out Unsubscribe callable, as a no-op", async () => {
        // Disposal has already dropped every listener, so the closure has
        // nothing left to do — and refusing it would turn correct React-effect
        // teardown into a throw.
        const h = await harness();
        const unsubscribe = h.client.onUpdate(() => {});
        await h.client[Symbol.asyncDispose]();

        expect(() => unsubscribe()).not.toThrow();
    });

    it("closes nothing the caller injected, and disposes idempotently", async () => {
        const h = await harness();
        await h.client.accept(await h.client.quote(SPOT));
        await h.client[Symbol.asyncDispose]();
        await expect(h.client[Symbol.asyncDispose]()).resolves.toBeUndefined();

        // The repository is the caller's, and it outlives the client.
        expect(await h.repository.getAllSwapRecords()).toHaveLength(1);
    });
});
