import { collectSwapRecords } from "../../src/repository";
/**
 * `accept()`: the ordering, the crash windows, and what a duplicate does.
 *
 * The centrepiece is the crash-window matrix. A process kill is not
 * reproducible in a unit test, so each window is reached by making the *next*
 * step fail and then asserting what is durable — which tests the same thing a
 * kill would, since what a kill leaves behind is exactly what the steps before
 * it wrote. The windows, in order: before register, before persist, after
 * persist and before funding, after funding and before the txid, after the txid.
 *
 * Every route is run through them: spot, lightning send and onchain send fund,
 * and lightning receive funds nothing and so runs the first rows only.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { SendDeadlineExceededError } from "@arkade-os/sdk";
import { createSwapClient, type SwapClient } from "../../src/client/client";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import {
    AcceptConflict,
    InsufficientFunds,
    MissingCorridorDep,
    QuoteExpired,
} from "../../src/client/errors";
import { OFFER_PACKET_TYPE, decodeOffer, restoreOfferCoverage } from "../../src/offer";
import { SWAP_LOCKUP_CONTRACT_TYPE } from "../../src/lockupContract";
import { offerFactsOf } from "../../src/client/driveRecords";
import { promoteOfferContract, retireOfferContract } from "../../src/coverage";
import { retireUnsubmittedFunding } from "../../src/client/fundingNotSubmitted";
import { conflictingFields } from "../../src/client/accept";
import type { Quote, QuoteInput } from "../../src/client/quote";
import {
    assetSwapIdOf,
    fundingWasNotSubmitted,
    type CorridorSwapRecord,
    type OfferSwapRecord,
} from "../../src/client/record";
import {
    EMULATOR_PUBKEY_HEX,
    FUNDING_TXID,
    PAYMENT_HASH,
    USD_ASSET_ID,
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
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

interface Harness {
    client: SwapClient;
    repository: AssetSwapRepository;
    wallet: AcceptWallet;
}

const setup = async (
    over: Parameters<typeof acceptWallet>[0] & {
        repository?: AssetSwapRepository | undefined;
        omitRepository?: boolean;
        solverClock?: ReturnType<typeof clockAt>;
    } = {},
): Promise<Harness> => {
    const wallet = await acceptWallet(over);
    const repository = over.repository ?? new InMemoryAssetSwapRepository();
    const client = createSwapClient({
        wallet: wallet.wallet,
        ...(over.omitRepository ? {} : { repository }),
        discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => solverTransport(solverFor(over.solverClock ?? CLOCK)),
        fetchImpl: feedServing().fetch,
    });
    return { client, repository, wallet };
};

/** The four routes, each as the input that resolves to it. */
const ROUTES = {
    spot: (): QuoteInput => ({ give: "BTC", take: "USD", amount: 100_000n, amountOn: "give" }),
    lightningSend: (): QuoteInput => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) }),
    lightningReceive: (): QuoteInput => ({ via: "lightning", amount: 5_000n, amountOn: "give" }),
    onchainSend: (): QuoteInput => ({ to: BCRT1, amount: 100_000n, amountOn: "give" }),
} as const;

type RouteName = keyof typeof ROUTES;
/** The three that spend from this wallet. */
const FUNDING_ROUTES: RouteName[] = ["spot", "lightningSend", "onchainSend"];
const ALL_ROUTES: RouteName[] = [...FUNDING_ROUTES, "lightningReceive"];

const quoteFor = (h: Harness, route: RouteName): Promise<Quote> => h.client.quote(ROUTES[route]());

const evictPreparationFor = async (h: Harness, id: string): Promise<void> => {
    for (let i = 0; i < 64; i++) {
        await quoteFor(h, "spot");
    }
    expect(h.client.preparationOf(id)).toBeUndefined();
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("accept() — the ordering", () => {
    it.each(ALL_ROUTES)("registers the covenant before persisting, on %s", async (route) => {
        const h = await setup();
        const quote = await quoteFor(h, route);
        // Nothing is registered by quoting: the derivation happened, the row
        // did not.
        expect(h.wallet.contracts).toHaveLength(0);

        await h.client.accept(quote);

        expect(h.wallet.contracts).toHaveLength(1);
        const stored = await h.repository.getSwapRecord(quote.id);
        expect(stored).toBeDefined();
        // The row a rebuild will read is keyed by the script the record names.
        const script =
            stored?.family === "offer"
                ? stored.swapPkScript
                : (stored as CorridorSwapRecord).lockupPkScript;
        expect(h.wallet.contracts[0]?.script).toBe(script);
    });

    it.each(ALL_ROUTES)("keys the record on the quote id, not a txid, on %s", async (route) => {
        const h = await setup();
        const quote = await quoteFor(h, route);
        const swap = await h.client.accept(quote);

        // The public id carries the family tag; the storage key stays bare.
        expect(swap.id).toBe(assetSwapIdOf(swap.family, quote.id));
        const stored = await h.repository.getSwapRecord(quote.id);
        expect(stored?.id).toBe(quote.id);
        // The txid is a field, never the identity — which is what let the
        // record exist before the money did.
        expect(stored?.fundingTxid).not.toBe(stored?.id);
    });

    it.each(FUNDING_ROUTES)("persists before it funds, on %s", async (route) => {
        const h = await setup({ failSend: () => new Error("send exploded") });
        const quote = await quoteFor(h, route);

        await expect(h.client.accept(quote)).rejects.toThrow(/send exploded/);

        // The window the invariant exists for: the record is at rest and no
        // value moved. A retry resumes this record rather than starting over.
        const stored = await h.repository.getSwapRecord(quote.id);
        expect(stored).toBeDefined();
        expect(stored?.fundingTxid).toBeUndefined();
        expect(h.wallet.sent).toHaveLength(0);
    });

    it("funds nothing on a receive, and still persists the invoice", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningReceive");
        const swap = await h.client.accept(quote);

        expect(h.wallet.sent).toHaveLength(0);
        expect(swap.artifact).toEqual({ kind: "invoice", bolt11: expect.any(String) });
        const stored = await h.repository.getSwapRecord(quote.id);
        // Durable before the payer can be shown it: an invoice whose claim
        // secret is only in memory buys a lockup nobody can claim.
        expect(stored?.artifact).toEqual(swap.artifact);
        // And so is what claims it: the descriptor the wallet re-derives P
        // from, in the corridor profile where the claim path already reads it.
        const profile = (stored as CorridorSwapRecord).profile;
        expect(profile.signer).toMatchObject({ signingDescriptor: expect.any(String) });
        expect(profile.hashlock).toMatchObject({ paymentHash: expect.any(String) });
    });

    it("writes the funding txid after the money moves", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        const swap = await h.client.accept(quote);

        expect(h.wallet.sent).toHaveLength(1);
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect((await h.repository.getSwapRecord(quote.id))?.fundingTxid).toBe(FUNDING_TXID);
    });

    it("keeps a swap whose funding landed but whose txid could not be stored", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const h = await setup({ repository });
        const quote = await quoteFor(h, "lightningSend");
        // The stamp is best effort: the money has moved, and failing the caller
        // here would report as failed a swap that is already funded.
        const saved = vi.spyOn(repository, "saveSwapRecord");
        saved.mockImplementationOnce(async (r) => {
            await InMemoryAssetSwapRepository.prototype.saveSwapRecord.call(repository, r);
        });
        saved.mockImplementationOnce(async () => {
            throw new Error("quota exceeded");
        });

        const swap = await h.client.accept(quote);
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect(h.wallet.sent).toHaveLength(1);
    });

    it("leaves nothing durable when registration fails", async () => {
        const h = await setup({ failRegistration: () => new Error("contract store gone") });
        const quote = await quoteFor(h, "lightningSend");

        await expect(h.client.accept(quote)).rejects.toThrow();
        // The safe point: no record, no funding, and the quote is inert.
        expect(await h.repository.getSwapRecord(quote.id)).toBeUndefined();
        expect(h.wallet.sent).toHaveLength(0);
    });

    it("leaves nothing durable when the record cannot be written", async () => {
        const repository = new InMemoryAssetSwapRepository();
        vi.spyOn(repository, "saveSwapRecord").mockRejectedValue(new Error("quota exceeded"));
        const h = await setup({ repository });
        const quote = await quoteFor(h, "lightningSend");

        await expect(h.client.accept(quote)).rejects.toThrow(/quota exceeded/);
        // The whole point of the throwing write: funding must not follow a lost
        // record.
        expect(h.wallet.sent).toHaveLength(0);
    });
});

describe("accept() — the offer extension packet", () => {
    it("attaches the packet the covenant commits to", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "spot");
        await h.client.accept(quote);

        const [payment] = h.wallet.sent;
        expect(payment?.extensions).toHaveLength(1);
        expect(payment?.extensions?.[0]?.type).toBe(OFFER_PACKET_TYPE);

        // The packet is the record's own TLV, so the deposit is visible to the
        // solver that priced it. Omitting it throws nowhere and lands the money
        // at a covenant nobody can see, which is the silent loss this asserts
        // against.
        const stored = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(hex.encode(payment?.extensions?.[0]?.payload as Uint8Array)).toBe(stored.offerHex);
        expect(decodeOffer(hex.decode(stored.offerHex)).wantAmount).toBe(quote.take.amount);
    });

    it("sends the asset leg as an asset, not as sats", async () => {
        const h = await setup();
        // USD -> BTC: the give leg is the asset, and it rides the dust-sat
        // carrier rather than being spelled as an amount.
        const quote = await h.client.quote({
            give: "USD",
            take: "BTC",
            amount: 10_000n,
            amountOn: "give",
        });
        await h.client.accept(quote);

        const [payment] = h.wallet.sent;
        expect(payment?.assets).toEqual([{ assetId: USD_ASSET_ID, amount: 10_000n }]);
        expect(payment?.amount).toBeUndefined();
    });
});

describe("accept() — idempotency by quote id", () => {
    it.each(ALL_ROUTES)("returns the same swap and funds once, on %s", async (route) => {
        const h = await setup();
        const quote = await quoteFor(h, route);

        const first = await h.client.accept(quote);
        const second = await h.client.accept(quote);

        expect(second).toEqual(first);
        expect(h.wallet.sent).toHaveLength(route === "lightningReceive" ? 0 : 1);
        expect(await collectSwapRecords(h.repository)).toHaveLength(1);
        // One covenant row, because `createContract` is first-writer-wins and
        // the second accept never reaches a second derivation.
        expect(h.wallet.contracts).toHaveLength(1);
    });

    it("returns the stored invoice, not a second one", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningReceive");
        const first = await h.client.accept(quote);

        // Asserted against the record rather than the quote object: after a
        // restart the quote is gone and the record is the only answer.
        const stored = await h.repository.getSwapRecord(quote.id);
        const second = await h.client.accept(quote);
        expect(second.artifact).toEqual(stored?.artifact);
        expect(second.artifact).toEqual(first.artifact);
    });

    it("resumes a persisted-but-unfunded record rather than starting over", async () => {
        let fail = true;
        const h = await setup({ failSend: () => (fail ? new Error("send exploded") : undefined!) });
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(/send exploded/);

        fail = false;
        const swap = await h.client.accept(quote);

        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect(h.wallet.sent).toHaveLength(1);
        expect(await collectSwapRecords(h.repository)).toHaveLength(1);
    });

    it("still refuses a quote whose preparation was evicted before it was persisted", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");

        await evictPreparationFor(h, quote.id);

        await expect(h.client.accept(quote)).rejects.toThrow(/re-quote before accepting/);
        expect(await h.repository.getSwapRecord(quote.id)).toBeUndefined();
    });

    it("treats a funding txid appearing where there was none as a benign resume", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        await h.client.accept(quote);
        const stored = await h.repository.getSwapRecord(quote.id);

        // The record now carries a txid the quote knows nothing about. §3.2
        // names this a resume rather than a conflict, by name.
        expect(stored?.fundingTxid).toBeDefined();
        vi.setSystemTime((quote.expiresAt + 1) * 1000);
        await expect(h.client.accept(quote)).resolves.toMatchObject({
            id: assetSwapIdOf("rfq", quote.id),
        });
    });
});

describe("accept() — AcceptConflict, one case per compared field", () => {
    /** Accept `quote`, then re-accept a tampered copy of it. */
    const conflictOn = async (
        route: RouteName,
        tamper: (quote: Quote) => Quote,
    ): Promise<readonly string[]> => {
        const h = await setup();
        const quote = await quoteFor(h, route);
        await h.client.accept(quote);
        try {
            await h.client.accept(tamper(quote));
            throw new Error("expected AcceptConflict");
        } catch (error) {
            expect(error).toBeInstanceOf(AcceptConflict);
            return (error as AcceptConflict).fields;
        }
    };

    it("refuses a changed give amount", async () => {
        expect(
            await conflictOn("lightningSend", (q) => ({
                ...q,
                give: { ...q.give, amount: q.give.amount + 1n },
            })),
        ).toContain("give.amount");
    });

    it("refuses a changed take amount", async () => {
        expect(
            await conflictOn("lightningSend", (q) => ({
                ...q,
                take: { ...q.take, amount: q.take.amount + 1n },
            })),
        ).toContain("take.amount");
    });

    it("refuses a changed give asset", async () => {
        const fields = await conflictOn(
            "spot",
            (q) =>
                ({
                    ...q,
                    route: { ...q.route, give: { ...q.route.give, asset: q.route.take.asset } },
                }) as Quote,
        );
        expect(fields).toContain("give.asset");
    });

    it("refuses a changed take asset", async () => {
        const fields = await conflictOn(
            "spot",
            (q) =>
                ({
                    ...q,
                    route: { ...q.route, take: { ...q.route.take, asset: q.route.give.asset } },
                }) as Quote,
        );
        expect(fields).toContain("take.asset");
    });

    it("refuses a changed take instrument", async () => {
        const fields = await conflictOn(
            "onchainSend",
            (q) =>
                ({
                    ...q,
                    route: {
                        ...q.route,
                        take: {
                            ...q.route.take,
                            instrument: { kind: "address", address: "bcrt1qelsewhere" },
                        },
                    },
                }) as Quote,
        );
        expect(fields).toContain("take.instrument");
    });

    it("refuses a changed lock hash", async () => {
        expect(
            await conflictOn("lightningSend", (q) => ({ ...q, lock: { hash: "f".repeat(64) } })),
        ).toContain("lock.hash");
    });

    it("refuses a changed refund locktime", async () => {
        expect(
            await conflictOn("lightningSend", (q) => ({ ...q, refundLocktime: NOW + 999 })),
        ).toContain("refundLocktime");
    });

    it("refuses a changed solver", async () => {
        expect(
            await conflictOn("lightningSend", (q) => ({ ...q, solver: "0".repeat(64) })),
        ).toContain("solver");
    });

    it("refuses a changed registry", async () => {
        const fields = await conflictOn(
            "lightningSend",
            (q) =>
                ({
                    ...q,
                    market: { ...q.market, source: "https://elsewhere.example/regtest.json" },
                }) as Quote,
        );
        expect(fields).toContain("market.source");
    });

    it("refuses a changed route pair", async () => {
        // Repricing the same id against another corridor: the pair is the first
        // thing §3.2 compares, and the one a caller could plausibly reuse an id
        // across.
        const h = await setup();
        const send = await quoteFor(h, "lightningSend");
        await h.client.accept(send);
        const onchain = await quoteFor(h, "onchainSend");
        await expect(h.client.accept({ ...onchain, id: send.id })).rejects.toThrow(AcceptConflict);
    });

    it("does not conflict on a reordered but equal stored instrument", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        await h.client.accept(quote);

        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        const instrument = stored.route.take.instrument;
        if (instrument.kind !== "invoice") throw new Error("expected invoice instrument");

        const reordered: CorridorSwapRecord = {
            ...stored,
            route: {
                ...stored.route,
                take: {
                    ...stored.route.take,
                    instrument: {
                        expiresAt: instrument.expiresAt,
                        ...(instrument.amount === undefined ? {} : { amount: instrument.amount }),
                        paymentHash: instrument.paymentHash,
                        bolt11: instrument.bolt11,
                        kind: "invoice",
                    },
                },
            },
        };

        expect(JSON.stringify(reordered.route.take.instrument)).not.toBe(
            JSON.stringify(stored.route.take.instrument),
        );
        expect(conflictingFields(reordered, quote)).not.toContain("take.instrument");

        await h.repository.saveSwapRecord(reordered);
        await expect(h.client.accept(quote)).resolves.toMatchObject({
            id: assetSwapIdOf("rfq", quote.id),
        });
    });

    it("does not conflict on a field absent from both sides", async () => {
        // A feed-priced quote carries no solver and no lock hash by
        // construction, so "absent" must read as agreement rather than as a
        // difference — otherwise every spot re-accept would conflict.
        const h = await setup();
        const quote = await quoteFor(h, "spot");
        await h.client.accept(quote);
        await expect(h.client.accept(quote)).resolves.toMatchObject({
            id: assetSwapIdOf("offer", quote.id),
        });
    });
});

describe("accept() — the pre-flight and the clock", () => {
    it.each(FUNDING_ROUTES)("refuses an unfundable %s before persisting", async (route) => {
        const h = await setup({ balance: { available: 1, availableAssets: [] } });
        const quote = await quoteFor(h, route);

        await expect(h.client.accept(quote)).rejects.toThrow(InsufficientFunds);
        // Nothing durable, nothing registered, nothing sent: a caller who
        // cannot fund leaves no record behind.
        expect(await h.repository.getSwapRecord(quote.id)).toBeUndefined();
        expect(h.wallet.contracts).toHaveLength(0);
        expect(h.wallet.sent).toHaveLength(0);
    });

    it("runs no balance check on a receive", async () => {
        // The give leg is the payer's invoice, so an empty wallet is the
        // canonical case rather than a refusal — which is why the gate is the
        // instrument and not the asset, both give legs here being BTC.
        const h = await setup({ balance: { available: 0, availableAssets: [] } });
        const quote = await quoteFor(h, "lightningReceive");
        await expect(h.client.accept(quote)).resolves.toMatchObject({
            id: assetSwapIdOf("rfq", quote.id),
        });
    });

    it("refuses an accept past the quote's own expiry", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        vi.setSystemTime((quote.expiresAt + 1) * 1000);

        await expect(h.client.accept(quote)).rejects.toThrow(QuoteExpired);
        expect(await h.repository.getSwapRecord(quote.id)).toBeUndefined();
    });

    it("accepts at the last second rather than inheriting the quote-time floor", async () => {
        // `policy.quoteTtlFloorSeconds` is the quote path's question. Applying
        // it here would refuse terms §3.2 still considers acceptable.
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        vi.setSystemTime(quote.expiresAt * 1000);
        await expect(h.client.accept(quote)).resolves.toMatchObject({
            id: assetSwapIdOf("rfq", quote.id),
        });
    });

    it("names the repository when the client was given none", async () => {
        const h = await setup({ omitRepository: true });
        // Quoting works without storage, since it persists nothing.
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(MissingCorridorDep);
        // And it never silently fell back to memory, which is the loss the
        // storage rule forbids.
        expect(h.wallet.sent).toHaveLength(0);
    });
});

describe("accept() — reconcile from evidence before a second funding", () => {
    it("adopts the deposit a crashed accept already made", async () => {
        let fail = true;
        const h = await setup({
            failSend: () => (fail ? new Error("crashed mid-send") : undefined!),
        });
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(/crashed mid-send/);

        // The window: the record is durable, the funding actually landed, and
        // the txid was never written. A blind retry would fund twice.
        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        h.wallet.deposits.set(stored.lockupPkScript, [
            { txid: "a".repeat(64), value: Number(quote.give.amount) },
        ]);

        fail = false;
        const swap = await h.client.accept(quote);

        expect(swap.fundingTxid).toBe("a".repeat(64));
        expect(h.wallet.sent).toHaveLength(0);
    });

    it("does not fund a persisted record after expiry when no deposit is found", async () => {
        let fail = true;
        const h = await setup({
            failSend: () => (fail ? new Error("send exploded") : undefined!),
        });
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(/send exploded/);

        await evictPreparationFor(h, quote.id);
        fail = false;
        vi.setSystemTime((quote.expiresAt + 1) * 1000);

        await expect(h.client.accept(quote)).rejects.toThrow(QuoteExpired);
        expect((await h.repository.getSwapRecord(quote.id))?.fundingTxid).toBeUndefined();
        expect(h.wallet.sent).toHaveLength(0);
    });

    it("funds a persisted record after preparation eviction when no deposit is found", async () => {
        let fail = true;
        const h = await setup({
            failSend: () => (fail ? new Error("send exploded") : undefined!),
        });
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(/send exploded/);

        await evictPreparationFor(h, quote.id);

        fail = false;
        const swap = await h.client.accept(quote);

        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect(h.wallet.sent).toHaveLength(1);
    });

    it("reconciles a persisted funding record after preparation eviction", async () => {
        let fail = true;
        const h = await setup({
            failSend: () => (fail ? new Error("crashed mid-send") : undefined!),
        });
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(/crashed mid-send/);

        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        h.wallet.deposits.set(stored.lockupPkScript, [
            { txid: "e".repeat(64), value: Number(quote.give.amount) },
        ]);
        await evictPreparationFor(h, quote.id);
        vi.setSystemTime((quote.expiresAt + 1) * 1000);

        fail = false;
        const swap = await h.client.accept(quote);

        expect(swap.fundingTxid).toBe("e".repeat(64));
        expect((await h.repository.getSwapRecord(quote.id))?.fundingTxid).toBe("e".repeat(64));
        expect(h.wallet.sent).toHaveLength(0);
    });

    it("does not adopt a deposit for the wrong amount", async () => {
        let fail = true;
        const h = await setup({
            failSend: () => (fail ? new Error("crashed mid-send") : undefined!),
        });
        const quote = await quoteFor(h, "lightningSend");
        await expect(h.client.accept(quote)).rejects.toThrow(/crashed mid-send/);

        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        // Identical offers derive one address, so a VTXO at the script is not
        // proof it is THIS swap's deposit. Adopting it would attach the money
        // to the wrong record and leave the right one funded twice.
        h.wallet.deposits.set(stored.lockupPkScript, [{ txid: "c".repeat(64), value: 1 }]);

        fail = false;
        const swap = await h.client.accept(quote);
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect(h.wallet.sent).toHaveLength(1);
    });

    it("matches an asset deposit on the asset entry, not the sat carrier", async () => {
        let fail = true;
        const h = await setup({
            failSend: () => (fail ? new Error("crashed mid-send") : undefined!),
        });
        const quote = await h.client.quote({
            give: "USD",
            take: "BTC",
            amount: 10_000n,
            amountOn: "give",
        });
        await expect(h.client.accept(quote)).rejects.toThrow(/crashed mid-send/);

        const stored = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        h.wallet.deposits.set(stored.swapPkScript, [
            // The sats are the carrier; the deposit is the asset entry.
            {
                txid: "d".repeat(64),
                value: 330,
                assets: [{ assetId: USD_ASSET_ID, amount: 10_000n }],
            },
        ]);

        fail = false;
        const swap = await h.client.accept(quote);
        expect(swap.fundingTxid).toBe("d".repeat(64));
        expect(h.wallet.sent).toHaveLength(0);
    });
});

describe("accept() — a record written when BTC was slip44:0 on every network", () => {
    // Before BTC's asset part depended on the network, regtest BTC was `arkade:regtest/slip44:0`.
    // A record (and the quote it answers) from then still spells it so; nothing rewrites it.
    const LEGACY_BTC = "arkade:regtest/slip44:0";

    /** A spot BTC -> USD swap left persisted but unfunded, then aged into the old spelling. */
    const legacyUnfunded = async (h: Harness, fail: { on: boolean }): Promise<Quote> => {
        const quote = await quoteFor(h, "spot");
        await expect(h.client.accept(quote)).rejects.toThrow(/send exploded/);
        fail.on = false;

        const stored = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(stored.route.give.asset).toBe("arkade:regtest/slip44:1");
        await h.repository.saveSwapRecord({
            ...stored,
            route: { ...stored.route, give: { ...stored.route.give, asset: LEGACY_BTC } },
            give: { ...stored.give, asset: LEGACY_BTC },
        });
        return {
            ...quote,
            route: { ...quote.route, give: { ...quote.route.give, asset: LEGACY_BTC } },
            give: { ...quote.give, asset: LEGACY_BTC },
        } as Quote;
    };

    it("funds the deposit as BTC, not as an asset", async () => {
        const fail = { on: true };
        const h = await setup({
            failSend: () => (fail.on ? new Error("send exploded") : undefined!),
        });
        const legacy = await legacyUnfunded(h, fail);

        const swap = await h.client.accept(legacy);

        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        const [payment] = h.wallet.sent;
        expect(payment?.amount).toBe(Number(legacy.give.amount));
        expect(payment?.assets).toBeUndefined();
    });

    it("adopts a crashed first attempt's deposit by its sat value", async () => {
        const fail = { on: true };
        const h = await setup({
            failSend: () => (fail.on ? new Error("send exploded") : undefined!),
        });
        const legacy = await legacyUnfunded(h, fail);
        const stored = (await h.repository.getSwapRecord(legacy.id)) as OfferSwapRecord;
        h.wallet.deposits.set(stored.swapPkScript, [
            { txid: "f".repeat(64), value: Number(legacy.give.amount) },
        ]);

        const swap = await h.client.accept(legacy);

        expect(swap.fundingTxid).toBe("f".repeat(64));
        expect(h.wallet.sent).toHaveLength(0);
    });
});

describe("accept() — what the record carries", () => {
    it("registers the lockup under the type a rebuild reads", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        await h.client.accept(quote);

        const [row] = h.wallet.contracts;
        expect(row?.type).toBe(SWAP_LOCKUP_CONTRACT_TYPE);
        // The row is the only place the covenant tree lives — the record
        // deliberately stores none — so a rebuild reads its params from here.
        expect(Object.keys(row?.params ?? {}).length).toBeGreaterThan(0);
    });

    it("carries the corridor profile the drive pass will hydrate", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningReceive");
        await h.client.accept(quote);

        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        expect(stored.kind).toBe("lightning_receive");
        expect(stored.profile.signer).toMatchObject({ signingDescriptor: expect.any(String) });
        expect(stored.profile.hashlock).toMatchObject({ paymentHash: stored.lock.hash });
        // The claim value gate's request-time input. Read at claim time it
        // would be whatever the solver funded, which is the attack rather than
        // a check on it.
        expect(stored.profile.expectedAmount).toBe(Number(quote.take.amount));
        expect(stored.profile.payoutAddress).toEqual(expect.any(String));
    });

    it("carries the L1 half of an onchain send, which no covenant row holds", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "onchainSend");
        await h.client.accept(quote);

        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        expect(stored.kind).toBe("onchain_send");
        expect(stored.profile).toMatchObject({
            claimKey: expect.any(String),
            refundKey: expect.any(String),
            htlcLocktime: expect.any(Number),
            htlcAddress: expect.any(String),
            minConfirmations: expect.any(Number),
        });
    });

    it("writes at most one of the preimage and its salt", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningReceive");
        await h.client.accept(quote);

        const stored = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        const hashlock = stored.profile.hashlock as Record<string, unknown>;
        const both = hashlock.preimageHex !== undefined && hashlock.preimageSaltHex !== undefined;
        expect(both).toBe(false);
    });

    it("carries the market whole, so the swap it answers with needs no fabrication", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        const swap = await h.client.accept(quote);

        // Round-tripped through the record, not copied off the quote object:
        // the second accept reads it back off disk.
        const again = await h.client.accept(quote);
        expect(again.market).toEqual(quote.market);
        expect(swap.market).toEqual(quote.market);
    });

    it("stores every amount as a decimal string and reads it back as a bigint", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        const swap = await h.client.accept(quote);

        const stored = await h.repository.getSwapRecord(quote.id);
        expect(stored?.give.amount).toBe(quote.give.amount.toString());
        expect(stored?.take.amount).toBe(quote.take.amount.toString());
        // The record survives the two backends that JSON-serialize it.
        expect(() => JSON.stringify(stored)).not.toThrow();
        expect(swap.give.amount).toBe(quote.give.amount);
    });

    it("stamps both timestamps in seconds, the unit the record layer compares", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        await h.client.accept(quote);

        const stored = await h.repository.getSwapRecord(quote.id);
        // Milliseconds here would retire a terminal record after ~43 minutes.
        expect(stored?.createdAt).toBe(NOW);
        expect(stored?.updatedAt).toBe(NOW);
    });
});

describe("accept funding deadline", () => {
    it.each(FUNDING_ROUTES)(
        "preserves the recipient and caps the deadline on %s",
        async (route) => {
            const h = await setup();
            const quote = await quoteFor(h, route);
            const send = vi.spyOn(h.wallet.wallet, "send").mockResolvedValue(FUNDING_TXID);
            await h.client.accept(quote, { validUntil: quote.expiresAt + 100 });
            const sent = send.mock.calls[0]?.[0] as {
                recipients: { address: string; extensions?: unknown[] }[];
                validUntil: number;
            };
            expect(sent.validUntil).toBe(quote.expiresAt);
            expect(sent.recipients).toHaveLength(1);
            expect(sent.recipients[0]?.address).toBe(h.wallet.contracts[0]?.address);
            if (route === "spot") expect(sent.recipients[0]?.extensions).toHaveLength(1);
            await h.client[Symbol.asyncDispose]();
        },
    );

    it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "refuses invalid deadline %s before writing",
        async (validUntil) => {
            const h = await setup();
            const quote = await quoteFor(h, "spot");
            await expect(h.client.accept(quote, { validUntil })).rejects.toThrow(
                "positive safe integer",
            );
            expect(h.wallet.contracts).toHaveLength(0);
            expect(await collectSwapRecords(h.repository)).toHaveLength(0);
            await h.client[Symbol.asyncDispose]();
        },
    );

    it.each(FUNDING_ROUTES)(
        "persists proven unsent funding and survives restart on %s",
        async (route) => {
            vi.setSystemTime(NOW * 1000 + 537);
            const h = await setup();
            const quote = await quoteFor(h, route);
            const validUntil = NOW + 1;
            const send = vi.spyOn(h.wallet.wallet, "send").mockImplementation(async () => {
                await Promise.resolve();
                vi.setSystemTime((NOW + 2) * 1000);
                throw new SendDeadlineExceededError(validUntil);
            });
            await expect(h.client.accept(quote, { validUntil })).rejects.toBeInstanceOf(
                SendDeadlineExceededError,
            );
            const stored = await h.repository.getSwapRecord(quote.id);
            expect(stored?.fundingTxid).toBeUndefined();
            expect(stored?.fundingNotSubmitted).toEqual({ reason: "send_deadline", validUntil });
            expect(stored?.family === "offer" ? stored.status : stored?.state).toBe(
                route === "spot" ? "cancelled" : "failed",
            );
            expect(h.wallet.watched).toContainEqual([h.wallet.contracts[0]?.script, "retained"]);
            expect((await h.client.accept(quote)).outcome).toBe("cancelled");
            expect(send).toHaveBeenCalledTimes(1);
            await h.client[Symbol.asyncDispose]();
            const restarted = await setup({ repository: h.repository });
            expect(
                (await restarted.client.swaps()).find(
                    (swap) => swap.id === `${stored?.family}:${quote.id}`,
                )?.outcome,
            ).toBe("cancelled");
            expect((await restarted.client.accept(quote, { validUntil })).outcome).toBe(
                "cancelled",
            );
            expect(restarted.wallet.sent).toHaveLength(0);
            await restarted.client[Symbol.asyncDispose]();
        },
    );

    it("keeps a generic funding failure resumable and watched", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "spot");
        const send = vi
            .spyOn(h.wallet.wallet, "send")
            .mockRejectedValueOnce(new Error("provider disconnected"));
        await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toThrow(
            "provider disconnected",
        );
        const stored = await h.repository.getSwapRecord(quote.id);
        expect(stored?.fundingNotSubmitted).toBeUndefined();
        expect(stored?.family === "offer" && stored.status).toBe("pending");
        expect(h.wallet.watched).not.toContainEqual([h.wallet.contracts[0]?.script, "retained"]);
        send.mockResolvedValue(FUNDING_TXID);
        await h.client.accept(quote, { validUntil: NOW + 2 });
        await h.client.accept(quote, { validUntil: NOW + 2 });
        expect(send).toHaveBeenCalledTimes(2);
        await h.client[Symbol.asyncDispose]();
    });

    it("reconciles an observed deposit before applying a retry deadline", async () => {
        const h = await setup({ failSend: () => new Error("lost response") });
        const quote = await quoteFor(h, "spot");
        await expect(h.client.accept(quote)).rejects.toThrow("lost response");
        const stored = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        h.wallet.deposits.set(stored.swapPkScript, [
            { txid: FUNDING_TXID, value: Number(stored.give.amount) },
        ]);
        vi.setSystemTime((quote.expiresAt + 1) * 1000);
        const swap = await h.client.accept(quote, { validUntil: NOW + 1 });
        expect(swap.fundingTxid).toBe(FUNDING_TXID);
        expect((await h.repository.getSwapRecord(quote.id))?.fundingNotSubmitted).toBeUndefined();
        await h.client[Symbol.asyncDispose]();
    });
});

describe("unsent funding coverage", () => {
    it("retains a same-script liability including externally funded generic failure after restart", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        vi.spyOn(h.wallet.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
        await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
            SendDeadlineExceededError,
        );
        const stopped = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        const { fundingNotSubmitted: _proof, ...origin } = stopped;
        const liability: CorridorSwapRecord = {
            ...origin,
            id: "external",
            rfqId: "external-rfq",
            fundingTxid: FUNDING_TXID,
        };
        await h.repository.saveSwapRecord(liability);
        h.wallet.watched.length = 0;
        await retireUnsubmittedFunding(h.wallet.wallet, h.repository, stopped);
        expect(h.wallet.watched).toHaveLength(0);
        await h.client[Symbol.asyncDispose]();
        const restarted = await setup({ repository: h.repository });
        expect(
            (await restarted.client.swaps()).find((swap) => swap.id === "rfq:external")?.outcome,
        ).toBe("failed");
        expect(restarted.wallet.watched).not.toContainEqual([stopped.lockupPkScript, "retained"]);
        await restarted.client[Symbol.asyncDispose]();
    });

    it("does not retire before the proof is durable", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "spot");
        const save = h.repository.saveSwapRecord.bind(h.repository);
        vi.spyOn(h.repository, "saveSwapRecord").mockImplementation(async (record) => {
            if (record.fundingNotSubmitted) throw new Error("proof write failed");
            await save(record);
        });
        vi.spyOn(h.wallet.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
        await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toThrow(
            "proof write failed",
        );
        const row = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(row.status).toBe("pending");
        expect(row.fundingNotSubmitted).toBeUndefined();
        expect(h.wallet.watched).not.toContainEqual([row.swapPkScript, "retained"]);
        await h.client[Symbol.asyncDispose]();
    });

    it("validates persisted proof instead of inferring it from failed or absent txid", async () => {
        const h = await setup();
        const quote = await quoteFor(h, "lightningSend");
        vi.spyOn(h.wallet.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
        await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
            SendDeadlineExceededError,
        );
        const row = (await h.repository.getSwapRecord(quote.id)) as CorridorSwapRecord;
        for (const change of [
            { fundingNotSubmitted: undefined },
            { fundingNotSubmitted: { reason: "other", validUntil: NOW + 1 } },
            { fundingNotSubmitted: { reason: "send_deadline", validUntil: "1700000001" } },
            { fundingNotSubmitted: { reason: "send_deadline", validUntil: 0 } },
            { fundingNotSubmitted: { reason: "send_deadline", validUntil: quote.expiresAt + 1 } },
            { fundingTxid: FUNDING_TXID },
            { state: "pending" },
            { expiresAt: Infinity },
            {
                route: {
                    ...row.route,
                    give: {
                        ...row.route.give,
                        instrument: { kind: "address", address: row.lockupAddress },
                    },
                },
            },
        ]) {
            expect(fundingWasNotSubmitted({ ...row, ...change } as CorridorSwapRecord)).toBe(false);
        }
        expect(fundingWasNotSubmitted(JSON.parse(JSON.stringify(row)) as CorridorSwapRecord)).toBe(
            true,
        );
        await h.client[Symbol.asyncDispose]();
    });
});

it.each(["lightningSend", "onchainSend"] as const)(
    "promotes a corridor contract before sending funding on %s",
    async (route) => {
        const h = await setup();
        const quote = await quoteFor(h, route);
        vi.spyOn(h.wallet.wallet, "send").mockImplementation(async () => {
            expect(h.wallet.watched).toContainEqual([h.wallet.contracts[0]?.script, "watched"]);
            return FUNDING_TXID;
        });
        await h.client.accept(quote, { validUntil: NOW + 1 });
        await h.client[Symbol.asyncDispose]();
    },
);

it.each([false, true])(
    "retains an earlier uncertain submission after a later unsent attempt (restart %s)",
    async (restart) => {
        const h = await setup();
        const quote = await quoteFor(h, "spot");
        vi.spyOn(h.wallet.wallet, "send").mockRejectedValueOnce(
            new Error("submission outcome unknown"),
        );
        await expect(h.client.accept(quote)).rejects.toThrow("submission outcome unknown");
        if (restart) await h.client[Symbol.asyncDispose]();
        const resumed = restart ? await setup({ repository: h.repository }) : h;
        vi.spyOn(resumed.wallet.wallet, "send").mockRejectedValueOnce(
            new SendDeadlineExceededError(NOW + 1),
        );
        await expect(resumed.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
            SendDeadlineExceededError,
        );
        const row = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
        expect(row.status).toBe("pending");
        expect(row.fundingNotSubmitted).toBeUndefined();
        expect(resumed.wallet.watched).not.toContainEqual([row.swapPkScript, "retained"]);
        await resumed.client[Symbol.asyncDispose]();
    },
);

it("publishes a freshly persisted unsent outcome to the current drive", async () => {
    const h = await setup();
    const quote = await quoteFor(h, "spot");
    const outcomes: string[] = [];
    const unsubscribe = h.client.onUpdate((update) => outcomes.push(update.outcome));
    vi.spyOn(h.wallet.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
    await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
        SendDeadlineExceededError,
    );
    expect(outcomes).toContain("cancelled");
    expect((await h.client.swaps())[0]?.outcome).toBe("cancelled");
    unsubscribe();
    await h.client[Symbol.asyncDispose]();
});

it.each(["spot", "lightningSend"] as const)(
    "keeps a newer identical-script issuance after unsent %s funding",
    async (route) => {
        vi.setSystemTime(NOW * 1000 + 537);
        const h = await setup();
        const quote = await quoteFor(h, route);
        vi.spyOn(h.wallet.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
        await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
            SendDeadlineExceededError,
        );
        const stopped = (await h.repository.getSwapRecord(quote.id))!;
        const script = stopped.family === "offer" ? stopped.swapPkScript : stopped.lockupPkScript;
        await promoteOfferContract(await h.wallet.wallet.getContractManager(), script, Date.now(), {
            coverageId: "newer-quote",
        });
        if (stopped.family === "offer") {
            await restoreOfferCoverage(h.wallet.wallet, [
                { ...offerFactsOf(stopped), status: "pending" },
            ]);
        }
        h.wallet.watched.length = 0;
        await retireUnsubmittedFunding(h.wallet.wallet, h.repository, stopped);
        expect(h.wallet.watched).toEqual([]);
        await h.client[Symbol.asyncDispose]();
    },
);

it("keeps unsent coverage when its fresh repository scan fails", async () => {
    const h = await setup();
    const quote = await quoteFor(h, "spot");
    vi.spyOn(h.wallet.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
    await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
        SendDeadlineExceededError,
    );
    const stopped = (await h.repository.getSwapRecord(quote.id))!;
    h.wallet.watched.length = 0;
    vi.spyOn(h.repository, "getSwapRecordsPage").mockRejectedValue(
        new Error("record store offline"),
    );
    await retireUnsubmittedFunding(h.wallet.wallet, h.repository, stopped);
    expect(h.wallet.watched).toEqual([]);
    await h.client[Symbol.asyncDispose]();
});

it("retires a successfully fulfilled native offer through its watcher facts", async () => {
    vi.setSystemTime(NOW * 1000 + 537);
    const h = await setup();
    const quote = await quoteFor(h, "spot");
    await h.client.accept(quote);
    const funded = (await h.repository.getSwapRecord(quote.id)) as OfferSwapRecord;
    const settled = { ...funded, status: "fulfilled" as const };
    await h.repository.saveSwapRecord(settled);
    h.wallet.watched.length = 0;
    await retireOfferContract(
        await h.wallet.wallet.getContractManager(),
        [offerFactsOf(settled)],
        settled.swapPkScript,
    );
    expect(h.wallet.watched).toEqual([[settled.swapPkScript, "retained"]]);
    await h.client[Symbol.asyncDispose]();
});

it("retires first-attempt unsent funding under the real millisecond clock", async () => {
    vi.useRealTimers();
    const now = Math.floor(Date.now() / 1000);
    const h = await setup({ solverClock: clockAt(now) });
    const quote = await h.client.quote({ to: invoiceFor(PAYMENT_HASH, clockAt(now)) });
    const validUntil = now + 1;
    let issued = 0;
    vi.spyOn(h.wallet.wallet, "send").mockImplementation(async () => {
        issued = Date.now();
        throw new SendDeadlineExceededError(validUntil);
    });
    await expect(h.client.accept(quote, { validUntil })).rejects.toBeInstanceOf(
        SendDeadlineExceededError,
    );
    const row = await h.repository.getSwapRecord(quote.id);
    expect(issued).toBeGreaterThanOrEqual(row!.createdAt * 1000);
    expect(h.wallet.watched).toContainEqual([h.wallet.contracts[0]?.script, "retained"]);
    await h.client[Symbol.asyncDispose]();
});
