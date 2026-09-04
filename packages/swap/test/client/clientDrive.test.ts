/**
 * The lifecycle as it reaches a caller: `ready`, arming on the first `accept()`,
 * the update stream, and dispose.
 *
 * These run through `createSwapClient` rather than the drive directly, because
 * the composition is the thing M5 adds — the drive's own behaviour is pinned in
 * `drive.test.ts`. What matters here is that the two halves are wired to each
 * other: the quote path still touches nothing, `accept()` now arms, and the
 * client that was given no storage still answers every question it could
 * before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwapClient, type SwapClient } from "../../src/client/client";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import { MissingCorridorDep } from "../../src/client/errors";
import { SwapDriveRefusedError } from "../../src/client/drive";
import type { SwapUpdate } from "../../src/client/outcome";
import type { QuoteInput } from "../../src/client/quote";
import type { CorridorSwapRecord } from "../../src/client/record";
import {
    EMULATOR_PUBKEY_HEX,
    PAYMENT_HASH,
    acceptWallet,
    clockAt,
    feedServing,
    invoiceFor,
    lightningCard,
    onchainCard,
    solverFor,
    solverTransport,
    spotCard,
    type AcceptWallet,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);

// The quote path reads the wall clock, and so does the drive. Pinned here, and
// left un-advanced: every pass these tests observe is one the lifecycle asked
// for, never one a timer fired.
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
    readonly seen: SwapUpdate[];
}

const harness = async (
    over: { omitRepository?: boolean; drive?: "auto" | "manual" | "readonly" } = {},
): Promise<Harness> => {
    const wallet = await acceptWallet();
    const repository = new InMemoryAssetSwapRepository();
    const client = createSwapClient({
        wallet: wallet.wallet,
        ...(over.omitRepository ? {} : { repository }),
        discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => solverTransport(solverFor(CLOCK)),
        fetchImpl: feedServing().fetch,
        ...(over.drive === undefined ? {} : { policy: { drive: over.drive } }),
    });
    const seen: SwapUpdate[] = [];
    client.onUpdate((update) => seen.push(update));
    return { client, repository, wallet, seen };
};

/** `lightning -> arkade`: the route that funds nothing and whose whole product
 * is a durable invoice. */
const RECEIVE: QuoteInput = { via: "lightning", amount: 5_000n, amountOn: "give" };
/** `arkade -> lightning`: the route that funds the lockup. */
const SEND = (): QuoteInput => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) });

describe("the client with no storage", () => {
    it("resolves ready, arms nothing, and keeps accept()'s own refusal", async () => {
        // A client built with no repository at all is legal and shipped. The
        // restore has nothing to read, so `ready` resolves; and the refusal
        // `accept()` already owned is unchanged, rather than becoming a
        // construction failure or a `ready` rejection.
        const h = await harness({ omitRepository: true });
        await expect(h.client.ready).resolves.toBeUndefined();
        await expect(h.client.start()).resolves.toBeUndefined();

        const quote = await h.client.quote(RECEIVE);
        await expect(h.client.accept(quote)).rejects.toBeInstanceOf(MissingCorridorDep);
        expect(h.seen).toEqual([]);
        await h.client[Symbol.asyncDispose]();
    });
});

describe("arming", () => {
    it("crosses the receive route's accepted -> open arrow", async () => {
        // M4 stopped at the persist: `accept()` handed back a durable invoice
        // that nothing was watching, and the record's own word was the whole
        // answer. M5 owns the edit — the accepted swap is registered with the
        // drive, and the first pass is what turns `accepted` into `open`.
        const h = await harness();
        const quote = await h.client.quote(RECEIVE);
        const swap = await h.client.accept(quote);

        // The answer `accept()` returns is the record's, because this call does
        // not wait on a pass.
        expect(swap.outcome).toBe("accepted");
        expect(swap.artifact).toMatchObject({ kind: "invoice" });

        // And the pass that follows adopts it. The lockup is the SOLVER's on
        // this leg, so `pending` there means the invoice is shown and unpaid.
        await h.client.stop();
        expect(h.seen.map((u) => u.outcome)).toEqual(["accepted", "open"]);
        expect(h.seen.at(-1)?.detail).toMatchObject({ family: "rfq", state: "pending" });
        await h.client[Symbol.asyncDispose]();
    });

    it("reports a funded send leg through the record before the drive adopts it", async () => {
        const h = await harness();
        const quote = await h.client.quote(SEND());
        const swap = await h.client.accept(quote);

        // The funding is broadcast and nothing has read the lockup yet: the
        // record and the clock are the whole answer, and no raw machine holds
        // this word.
        expect(swap.fundingTxid).toEqual(expect.any(String));
        expect(swap.outcome).toBe("funding");
        await h.client.stop();
        await h.client[Symbol.asyncDispose]();
    });

    it("does not arm under readonly, and refuses to be told to", async () => {
        const h = await harness({ drive: "readonly" });
        await expect(h.client.ready).resolves.toBeUndefined();
        await expect(h.client.start()).rejects.toBeInstanceOf(SwapDriveRefusedError);

        // `accept()` still persists — readonly is about actuating, not about
        // refusing to record what the caller did.
        const quote = await h.client.quote(RECEIVE);
        const swap = await h.client.accept(quote);
        expect(swap.outcome).toBe("accepted");
        expect(await h.repository.getSwapRecord(swap.id)).toBeDefined();
        // And nothing was driven: the swap keeps the outcome the record gave it.
        expect(h.seen.map((u) => u.outcome)).toEqual(["accepted"]);
        await h.client[Symbol.asyncDispose]();
    });
});

describe("the stream", () => {
    it("replays what the client already knows to a late subscriber", async () => {
        const h = await harness();
        const quote = await h.client.quote(RECEIVE);
        const swap = await h.client.accept(quote);
        await h.client.stop();

        const late: SwapUpdate[] = [];
        h.client.onUpdate((update) => late.push(update));
        // The listener attaches first and the replay comes off the same
        // registry the stream is fed from, so a subscriber that arrives after
        // the work does not get an empty world.
        expect(late.map((u) => u.swap.id)).toEqual([swap.id]);
        expect(late[0].outcome).toBe("open");
        await h.client[Symbol.asyncDispose]();
    });
});

describe("dispose", () => {
    it("leaves the durable state and makes the instance terminal", async () => {
        const h = await harness();
        const quote = await h.client.quote(SEND());
        const swap = await h.client.accept(quote);
        const registered = h.wallet.contracts.length;

        await h.client[Symbol.asyncDispose]();

        // Records and contract registrations survive: a new client restores and
        // resumes from them, and dropping a registration would unwatch a funded
        // lockup.
        const stored = (await h.repository.getSwapRecord(swap.id)) as CorridorSwapRecord;
        expect(stored.lockupAddress).toEqual(expect.any(String));
        expect(h.wallet.contracts).toHaveLength(registered);
        expect(h.wallet.watched.filter(([, state]) => state === "retained")).toEqual([]);
        // Terminal.
        expect(() => h.client.onUpdate(() => {})).toThrow("disposed");
    });

    it("is idempotent", async () => {
        const h = await harness();
        await h.client[Symbol.asyncDispose]();
        await expect(h.client[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });
});

describe("recover()", () => {
    it("refuses an id the client holds no record for", async () => {
        const h = await harness();
        await expect(h.client.recover("nope")).rejects.toMatchObject({ reason: "unknown-swap" });
        await h.client[Symbol.asyncDispose]();
    });
});
