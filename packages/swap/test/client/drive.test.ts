/**
 * The drive: the record bridge it stands on, the lifecycle, and the stream.
 *
 * The first test in this file is the one that fails outright if the bridge is
 * skipped — `restoreFromRepository` reads `getAllRfqSwaps()`, while `accept()`
 * writes into a keyspace ruled disjoint from it, so without the adapter every
 * v2 swap is invisible to the thing meant to drive it. Everything after it
 * assumes that read works.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { SingleKey } from "@arkade-os/sdk";
import { createSwapDrive, SwapDriveRefusedError, type SwapDrive } from "../../src/client/drive";
import type { SwapUpdate } from "../../src/client/outcome";
import type { CorridorSwapRecord, OfferSwapRecord, SwapRecord } from "../../src/client/record";
import { RFQ_CONFIGURATION_REFUSAL, RFQ_CONFIGURATION_REFUSALS } from "../../src/swapManager";
import { REFUND_MTP_LAG_SECONDS } from "../../src/refund";
import { RefundNotLocallyPossibleError } from "../../src/refundBlocked";
import type { AssetSwapRepository } from "../../src/repository";
import {
    AFTER,
    BEFORE,
    OFFER_SCRIPT,
    RECEIVE_LOCKUP,
    REFUND_LOCKTIME,
    SEND_LOCKUP,
    addressOf,
    corridorRecord,
    fakeContracts,
    fakeCorridors,
    fakeIndexer,
    fakeOperator,
    fakeWallet,
    memoryRepository,
    offerDeposit,
    offerFunding,
    offerRecord,
    type FakeContracts,
    type FakeFunded,
    type FakeVtxo,
} from "./driveFixtures";

/** A wallet that can sign the send lockup's refund, and the descriptor naming
 * it. A real `SingleKey`, so `contractSigner` runs its real key comparison
 * rather than a stub's — a fake that always agreed would prove nothing about
 * whether the refund key is resolved through the bridge at all. */
const SENDER = SingleKey.fromRandomBytes();
const SENDER_DESCRIPTOR = `tr(${hex.encode(await SENDER.xOnlyPublicKey())})`;

/** The default record, with a signer this wallet can actually resolve. */
const signable = (over: Partial<CorridorSwapRecord> = {}): CorridorSwapRecord =>
    corridorRecord({
        profile: {
            signer: { signingDescriptor: SENDER_DESCRIPTOR },
            hashlock: { paymentHash: hex.encode(new Uint8Array(32)) },
        },
        ...over,
    });

const LOCKUP_OUTPOINT = { txid: "99".repeat(32), vout: 0 };
/** An unspent output at the lockup — the shape `readLockupFate` reads as `open`. */
const unspent = (): FakeVtxo[] => [{ ...LOCKUP_OUTPOINT, spentBy: "" }];
const funded = (over: Partial<FakeFunded> = {}): FakeFunded[] => [
    { ...LOCKUP_OUTPOINT, value: 100_000, ...over },
];

interface Harness {
    readonly drive: SwapDrive;
    readonly repository: AssetSwapRepository;
    readonly contracts: FakeContracts;
    /** Which corridors had their deps resolved. */
    readonly resolved: string[];
    readonly seen: SwapUpdate[];
    readonly recoveries: number[];
    outcomes(id: string): string[];
    settle(): Promise<void>;
}

const build = async (
    over: {
        records?: SwapRecord[];
        mode?: "auto" | "manual" | "readonly";
        now?: number;
        vtxos?: FakeVtxo[];
        funded?: FakeFunded[];
        indexerFails?: boolean;
        identity?: unknown;
        chain?: unknown | null;
        claim?: unknown;
        history?: { type: string; arkTxid: string; createdAt: number }[];
        contracts?: FakeContracts;
        noVtxoManager?: boolean;
        subscribe?: boolean;
        ready?: boolean;
        /** Holds the operator's info read — and so any refund push — open. */
        gate?: Promise<void>;
    } = {},
): Promise<Harness> => {
    const repository = memoryRepository();
    for (const record of over.records ?? []) await repository.saveSwapRecord(record);
    const corridors = fakeCorridors({
        ...(over.chain === undefined ? {} : { chain: over.chain }),
        ...(over.claim === undefined ? {} : { claim: over.claim }),
    });
    const contracts = over.contracts ?? fakeContracts([SEND_LOCKUP, RECEIVE_LOCKUP]);
    const { wallet, recoveries } = fakeWallet({
        contracts,
        identity: over.identity ?? SENDER,
        ...(over.history === undefined ? {} : { history: over.history }),
        ...(over.noVtxoManager ? { noVtxoManager: true } : {}),
    });
    const drive = createSwapDrive({
        wallet,
        repository,
        corridors,
        operator: fakeOperator(over.gate),
        indexer: fakeIndexer({
            ...(over.vtxos === undefined ? {} : { vtxos: over.vtxos }),
            ...(over.funded === undefined ? {} : { funded: over.funded }),
            ...(over.indexerFails ? { fail: true } : {}),
        }),
        contracts,
        ...(over.mode === undefined ? {} : { mode: over.mode }),
        now: () => over.now ?? BEFORE,
        // Long enough that the timer never re-fires inside a test: every pass
        // these tests observe is one they asked for.
        pollIntervalMs: 10 * 60 * 1000,
    });

    const seen: SwapUpdate[] = [];
    // Subscribed BEFORE the restore, which is the ordering the replay/stream
    // seam is about: a transition that lands between the two must not vanish.
    if (over.subscribe !== false) drive.onUpdate((update) => seen.push(update));
    if (over.ready !== false) {
        await drive.ready;
        await drive.idle();
    }

    return {
        drive,
        repository,
        contracts,
        resolved: corridors.resolved,
        seen,
        recoveries,
        outcomes: (id) => seen.filter((u) => u.swap.id === id).map((u) => u.outcome),
        settle: () => drive.idle(),
    };
};

describe("the record bridge", () => {
    it("finds a v2-accepted swap through the construction restore and drives it", async () => {
        // The one test that fails outright if the bridge is skipped: without it
        // `getAllRfqSwaps()` answers empty and this swap is never seen.
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], vtxos: unspent() });

        // The lockup is funded and unspent, before the refund window: the swap
        // is live and the trader's money is at the covenant.
        expect(h.drive.swap("q1")?.outcome).toBe("funded");
        expect(h.outcomes("q1")).toContain("funded");
        await h.drive.dispose();
    });

    it("writes the manager's state back onto the v2 record, not a v1 one", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], vtxos: unspent() });

        const stored = (await h.repository.getSwapRecord("q1")) as CorridorSwapRecord;
        // Still the v2 record — route, market and obligations intact — with the
        // manager's mutable half merged in.
        expect(stored.family).toBe("rfq");
        expect(stored.market).toEqual(record.market);
        expect(stored.give).toEqual(record.give);
        // And nothing leaked into v1's keyspace, which is ruled disjoint.
        expect(await h.repository.getAllRfqSwaps()).toEqual([]);
        await h.drive.dispose();
    });

    it("refunds across the bridge rather than reporting needs_recovery", async () => {
        // The `rfqId -> QuoteId` index is what makes this pass: the manager keys
        // its callbacks on `rfqId`, the store on `QuoteId`, and an unbridged
        // `arkadeRefunder` misses its record and throws the ONE refusal the
        // manager reads as permanent — leaving a funded lockup blocked for its
        // whole refund window.
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({
            records: [record],
            now: AFTER,
            vtxos: unspent(),
            // An empty lockup: the refunder answers `null` without signing, and
            // the manager settles the swap `refunded`. What is under test is
            // that the record was FOUND, not how the push was built.
            funded: [],
        });

        expect(h.drive.swap("q1")?.outcome).toBe("refunded");
        expect(h.outcomes("q1")).not.toContain("needs_recovery");
        await h.drive.dispose();
    });

    it("keeps v1 retention from deleting a v2 record before ready resolves", async () => {
        // `restoreFromRepository` runs `dropRetired` BEFORE the rebuild. Under
        // v1's thirty-day window a terminal v2 record would be hard-deleted on
        // the way past — settling a retention question M6 has open, by side
        // effect, before the caller ever saw the swap.
        const aged = signable({
            state: "settled",
            fundingTxid: "aa".repeat(32),
            updatedAt: 1,
        });
        const h = await build({ records: [aged], now: AFTER + 400 * 24 * 3600 });

        expect(await h.repository.getSwapRecord("q1")).toBeDefined();
        await h.drive.dispose();
    });
});

describe("the lifecycle", () => {
    it("resolves ready and arms nothing without a repository", async () => {
        const { wallet } = fakeWallet();
        const drive = createSwapDrive({
            wallet,
            operator: fakeOperator(),
            corridors: fakeCorridors(),
            indexer: fakeIndexer(),
            now: () => BEFORE,
        });
        await expect(drive.ready).resolves.toBeUndefined();
        // `start()` on a client with nothing to drive is a no-op rather than a
        // throw: no repository is legal and shipped, and `accept()` keeps its
        // own `MissingCorridorDep`.
        await expect(drive.start()).resolves.toBeUndefined();
        await drive.dispose();
    });

    it("rejects ready only when the repository itself is unreadable", async () => {
        const repository = memoryRepository();
        vi.spyOn(repository, "getAllSwapRecords").mockRejectedValue(new Error("store is gone"));
        const { wallet } = fakeWallet();
        const drive = createSwapDrive({
            wallet,
            operator: fakeOperator(),
            repository,
            corridors: fakeCorridors(),
            indexer: fakeIndexer(),
            now: () => BEFORE,
        });
        // A client that cannot read its own records cannot drive them safely.
        await expect(drive.ready).rejects.toThrow("store is gone");
        await drive.dispose();
    });

    it("resolves ready through a corrupt record, and drives the rest", async () => {
        const repository = memoryRepository();
        await repository.saveSwapRecord({ id: "junk" } as unknown as SwapRecord);
        await repository.saveSwapRecord(signable({ fundingTxid: "aa".repeat(32) }));
        const contracts = fakeContracts([SEND_LOCKUP]);
        const { wallet } = fakeWallet({ contracts });
        const drive = createSwapDrive({
            wallet,
            operator: fakeOperator(),
            repository,
            corridors: fakeCorridors(),
            indexer: fakeIndexer({ vtxos: unspent() }),
            contracts,
            now: () => BEFORE,
            pollIntervalMs: 10 * 60 * 1000,
        });
        await expect(drive.ready).resolves.toBeUndefined();
        await drive.idle();
        // Per-swap problems are outcomes; a corrupt row is filtered and costs
        // nothing else.
        expect(drive.swap("q1")).toBeDefined();
        expect(drive.swap("junk")).toBeUndefined();
        await drive.dispose();
    });

    it("does not arm when the restore finds no live work", async () => {
        // Inside retention: an AGED terminal record is a different case — the
        // restore skips rebuilding it, which the bridge test above covers.
        const settled = signable({
            state: "settled",
            fundingTxid: "aa".repeat(32),
            updatedAt: BEFORE - 10,
        });
        const h = await build({ records: [settled], vtxos: unspent() });
        // A terminal record is loaded so a caller can read it, and nothing is
        // driven: the manager is not running and the watcher was never built.
        expect(h.drive.swap("q1")?.outcome).toBe("paid");
        await h.drive.dispose();
    });

    it("reports terminal records off their stored state without rebuilding them", async () => {
        // The restore deliberately does not hand terminal records to the
        // manager — rebuilding each one is a covenant derivation and a
        // contract row lookup for a swap the manager would only file in
        // `finished`. They stay readable and answer off their own state,
        // through the same table cell the live path reads.
        const records = [
            signable({ id: "q1", rfqId: "rfq-1", state: "settled", fundingTxid: "aa".repeat(32) }),
            signable({ id: "q2", rfqId: "rfq-2", state: "refunded", fundingTxid: "bb".repeat(32) }),
            signable({
                id: "q3",
                rfqId: "rfq-3",
                kind: "lightning_receive",
                state: "refunded",
                fundingTxid: "cc".repeat(32),
            }),
            signable({ id: "q4", rfqId: "rfq-4", state: "failed", fundingTxid: "dd".repeat(32) }),
            // No contract row, no profile: nothing here could be rebuilt, so
            // a `paid` below proves the rebuild was never attempted rather
            // than merely survived.
            signable({
                id: "q5",
                rfqId: "rfq-5",
                state: "settled",
                fundingTxid: "ee".repeat(32),
                lockupAddress: "bogus",
                profile: {},
            }),
        ];
        const h = await build({ records, vtxos: unspent() });

        expect(h.drive.swap("q1")?.outcome).toBe("paid");
        expect(h.drive.swap("q2")?.outcome).toBe("refunded");
        // The inversion: the wire calls both `refunded`, but on the receive
        // leg the lockup was the solver's, so the payment never arrived.
        expect(h.drive.swap("q3")?.outcome).toBe("lapsed");
        expect(h.drive.swap("q4")?.outcome).toBe("failed");
        expect(h.drive.swap("q5")?.outcome).toBe("paid");
        await h.drive.dispose();
    });

    it("arms on the first accept, which M4 deliberately did not do", async () => {
        const h = await build({ vtxos: unspent() });
        const record = signable({ fundingTxid: "aa".repeat(32) });
        await h.repository.saveSwapRecord(record);

        // `adopt` is synchronous and answers immediately: `accept()` does not
        // wait on the first pass.
        const swap = h.drive.adopt(record);
        expect(swap.outcome).toBe("funding");

        await h.settle();
        expect(h.drive.swap("q1")?.outcome).toBe("funded");
        await h.drive.dispose();
    });

    it("makes a double arm a no-op", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], mode: "manual", vtxos: unspent() });
        await h.drive.start();
        const first = h.seen.length;
        await h.drive.start();
        await h.settle();
        // Nothing re-armed, nothing re-emitted: `start()` returns without
        // re-arming when it is already running, which is what makes a React
        // double-mount safe.
        expect(h.seen.length).toBe(first);
        await h.drive.dispose();
    });

    it("waits for start() under manual, then drives", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], mode: "manual", vtxos: unspent() });
        // Restored and reported, not driven: the manager holds the swap but no
        // pass has run, so the record and the clock are still the whole answer.
        expect(h.drive.swap("q1")?.outcome).toBe("funding");
        await h.drive.start();
        await h.settle();
        expect(h.drive.swap("q1")?.outcome).toBe("funded");
        await h.drive.dispose();
    });

    it("leaves the store and the wallet's rows untouched under readonly", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const contracts = fakeContracts([SEND_LOCKUP]);
        const h = await build({
            records: [record],
            mode: "readonly",
            contracts,
            vtxos: unspent(),
        });

        // It reports what the read found and discovers nothing new.
        expect(h.drive.swap("q1")?.outcome).toBe("funding");
        expect(await h.repository.getSwapRecord("q1")).toEqual(record);
        expect(contracts.watchStates).toEqual([]);
        expect(contracts.rows).toHaveLength(1);

        await expect(h.drive.start()).rejects.toBeInstanceOf(SwapDriveRefusedError);
        await expect(h.drive.recover("q1")).rejects.toMatchObject({ reason: "readonly" });
        await h.drive.dispose();
    });

    it("keeps records and contract registrations across dispose", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const contracts = fakeContracts([SEND_LOCKUP]);
        const h = await build({ records: [record], contracts, vtxos: unspent() });
        await h.drive.dispose();

        // Durable state survives: a new client restores and resumes from it.
        // Dropping a registration would unwatch a funded lockup.
        expect(await h.repository.getSwapRecord("q1")).toBeDefined();
        expect(contracts.rows).toHaveLength(1);
        // And the instance is terminal.
        expect(() => h.drive.onUpdate(() => {})).toThrow("disposed");
    });
});

describe("the record-and-clock projections", () => {
    it("reports a record with no funding txid as accepted", async () => {
        // A receive leg funds nothing from this wallet, and a send leg that has
        // not broadcast yet has nothing at its lockup: either way the record is
        // the whole answer, and no raw machine holds this word.
        const h = await build({ records: [signable()], vtxos: unspent() });
        expect(h.outcomes("q1")[0]).toBe("accepted");
        await h.drive.dispose();
    });

    it("reports a funded record the drive holds no state for as funding", async () => {
        const h = await build({ ready: false });
        expect(h.drive.outcomeOf(corridorRecord({ fundingTxid: "aa".repeat(32) }))).toBe("funding");
        await h.drive.dispose();
    });

    it("reports a send leg with a push in flight as refunding", async () => {
        // `refunding` appears in neither raw machine: it is the clock plus the
        // fact that a push is out, and the raw state under it is still
        // `pending`. The operator's info read is held open, which is what a
        // refund push awaits first.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = await build({
            records: [signable({ fundingTxid: "aa".repeat(32) })],
            now: AFTER,
            vtxos: unspent(),
            funded: funded(),
            gate,
            ready: false,
        });
        const settling = h.drive.ready.then(() => h.drive.idle());
        // Let the pass reach the push and stop there.
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(h.outcomes("q1")).toContain("refunding");
        const refunding = h.seen.find((u) => u.outcome === "refunding");
        // The raw word is still `pending`: `detail` carries the machine's
        // answer, never the projection's.
        expect(refunding?.detail).toMatchObject({ family: "rfq", state: "pending" });

        release();
        await settling;
        await h.drive.dispose();
    });
});

describe("the stream", () => {
    it("replays the current outcome of every swap on subscribe", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], vtxos: unspent(), subscribe: false });

        const late: SwapUpdate[] = [];
        h.drive.onUpdate((u) => late.push(u));
        // A subscriber that arrives after the work does not get an empty world.
        expect(late.map((u) => u.outcome)).toEqual(["funded"]);
        await h.drive.dispose();
    });

    it("emits once across the claimed -> claimable backslide", async () => {
        // The legal backslide: a receive lockup topped up after a claim is a new
        // claimable event. Both states project to `funded`, so the derived key
        // collapses them — which is exactly why the key is the DERIVED outcome
        // and not the raw state.
        const record = corridorRecord({
            id: "r1",
            kind: "lightning_receive",
            rfqId: "rfq-r1",
            state: "claimable",
            lockupAddress: addressOf(RECEIVE_LOCKUP),
            lockupPkScript: hex.encode(RECEIVE_LOCKUP.pkScript),
        });
        const h = await build({
            records: [record],
            vtxos: unspent(),
            funded: funded({ value: 99_000 }),
        });

        // `claimable -> claimed -> claimable` all read `funded`, delivered once.
        expect(h.outcomes("r1").filter((o) => o === "funded")).toHaveLength(1);
        await h.drive.dispose();
    });

    it("emits the needs_recovery -> funded backslide rather than swallowing it", async () => {
        // `unblock` drives `needs_counterparty -> pending`, i.e.
        // `needs_recovery -> funded` at the outcome level, and re-entry into
        // `funded` has to be delivered: the pair is what M7's projection onto a
        // terminal `PaymentStatus` has to answer for.
        const record = signable({
            fundingTxid: "aa".repeat(32),
            state: "needs_counterparty",
            blockedReason: "the wallet that signs this refund is not attached",
        });
        const h = await build({ records: [record], vtxos: unspent() });

        // Restored blocked, then the probe answers yes and the pass unblocks it.
        expect(h.outcomes("q1")).toEqual(["needs_recovery", "funded"]);
        expect(h.drive.swap("q1")?.blockedReason).toBeUndefined();
        await h.drive.dispose();
    });

    it("carries the refusal reason on the swap, not on detail", async () => {
        // `detail` is `RawState` — the raw machine word and nothing else — so a
        // consumer told `needs_recovery` reads WHY off `update.swap`. The
        // fixture's own descriptor names a key this wallet cannot derive, which
        // is what produces the refusal.
        const record = corridorRecord({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], vtxos: unspent() });

        const blocked = h.seen.find((u) => u.outcome === "needs_recovery");
        expect(blocked?.swap.blockedReason).toEqual(expect.any(String));
        expect(blocked?.detail).toMatchObject({ family: "rfq", state: "needs_counterparty" });
        expect(blocked?.detail).not.toHaveProperty("blockedReason");
        await h.drive.dispose();
    });
});

describe("configuration, not recovery", () => {
    it("names exactly the sites that describe configuration rather than a swap", () => {
        // Five messages from three block sites: no claim callback, no L1 claim
        // callback, and no refund callback or auto-actions off. Every other
        // block site says something about the SWAP — an exited lockup, an
        // underfunded one, a key this wallet does not hold — and stays
        // `needs_recovery` in every mode.
        expect(RFQ_CONFIGURATION_REFUSALS).toHaveLength(5);
        for (const reason of RFQ_CONFIGURATION_REFUSALS) {
            expect(reason).toMatch(/wired|disabled/);
        }
    });

    it("does not read a configuration refusal back as needs_recovery under readonly", async () => {
        // A client told never to actuate reporting every live swap as needing
        // recovery would be reporting its own configuration at the caller. The
        // swap keeps its pre-action outcome and the reason stays legible.
        const record = signable({
            fundingTxid: "aa".repeat(32),
            state: "needs_counterparty",
            blockedReason: RFQ_CONFIGURATION_REFUSAL.noCallbacksForRefund,
        });
        const h = await build({ records: [record], mode: "readonly", vtxos: unspent() });
        expect(h.drive.swap("q1")?.outcome).toBe("funding");
        expect(h.drive.swap("q1")?.blockedReason).toBe(
            RFQ_CONFIGURATION_REFUSAL.noCallbacksForRefund,
        );
        await h.drive.dispose();
    });

    it("lifts a stored configuration refusal once the callbacks are wired", async () => {
        // The other half of the same rule: under `auto` this client CAN act, so
        // the refusal a previous session recorded is re-checked and cleared
        // rather than reported — `needs_counterparty` is documented as
        // re-evaluated every pass, and this is that.
        const record = signable({
            fundingTxid: "aa".repeat(32),
            state: "needs_counterparty",
            blockedReason: RFQ_CONFIGURATION_REFUSAL.noCallbacksForRefund,
        });
        const h = await build({ records: [record], vtxos: unspent() });
        expect(h.outcomes("q1")).toEqual(["needs_recovery", "funded"]);
        expect(h.drive.swap("q1")?.blockedReason).toBeUndefined();
        await h.drive.dispose();
    });

    it("still reports a real refusal under readonly", async () => {
        const record = signable({
            fundingTxid: "aa".repeat(32),
            state: "needs_counterparty",
            blockedReason: "the lockup was unilaterally exited (1 output(s) onchain)",
        });
        const h = await build({ records: [record], mode: "readonly", vtxos: unspent() });
        expect(h.drive.swap("q1")?.outcome).toBe("needs_recovery");
        await h.drive.dispose();
    });
});

describe("the onchain seam", () => {
    it("never resolves the chain source for a client that drives no onchain swap", async () => {
        // A deliberate `onchain: { chain: null }` must not be a construction
        // failure, or even a drive failure — `CorridorPass.seams` is what
        // decides, and a lightning send declares only `indexer`. The refusal is
        // never reached, so the swap drives normally.
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], chain: null, vtxos: unspent() });
        expect(h.drive.swap("q1")?.outcome).toBe("funded");
        expect(h.resolved).not.toContain("onchain");
        await h.drive.dispose();
    });

    it("leaves an onchain swap undriven rather than failing it terminally", async () => {
        // The manager fails an onchain-send swap on its first pass without a
        // `ChainSource`, deliberately — watching that corridor blind lets the
        // claim window pass in silence. A record the client cannot drive is kept
        // out of the manager instead, so the refusal does not become a terminal
        // label on a funded swap.
        const record = signable({
            kind: "onchain_send",
            fundingTxid: "aa".repeat(32),
        });
        const h = await build({ records: [record], chain: null, vtxos: unspent() });
        expect(h.drive.swap("q1")?.outcome).toBe("funding");
        expect(h.drive.swap("q1")?.failure).toBeUndefined();
        await h.drive.dispose();
    });
});

describe("the offer half", () => {
    it("reaches needs_recovery for a swept deposit through the construction restore", async () => {
        // The only writer of `recoverable` is `restoreAssetSwaps`, which has no
        // call site in this package, and the watcher cannot stand in for it:
        // `spendUpdate` writes only `cancelled` or `fulfilled`, and a sweep is
        // not a spend, so no contract event ever names one. Without this wiring
        // a swept deposit reports `open` forever — the case `RETIRABLE` exists
        // to keep watched.
        const funding = offerFunding();
        const record = offerRecord({ fundingTxid: funding.txid, swapPkScript: OFFER_SCRIPT });
        const repository = memoryRepository();
        await repository.saveSwapRecord(record);
        const contracts = fakeContracts([]);
        const { wallet } = fakeWallet({
            contracts,
            history: [{ type: "SENT", arkTxid: funding.txid, createdAt: 1_700_000_000_000 }],
        });
        const drive = createSwapDrive({
            wallet,
            operator: fakeOperator(),
            repository,
            corridors: fakeCorridors(),
            indexer: fakeIndexer({
                txs: [funding],
                vtxos: [offerDeposit(funding.txid, "swept")],
            }),
            contracts,
            now: () => BEFORE,
            pollIntervalMs: 10 * 60 * 1000,
        });
        await drive.ready;
        await drive.idle();

        expect(drive.swap("o1")?.outcome).toBe("needs_recovery");
        // Written through, not merely reported: the record is what a later
        // client and `recover()` both read.
        const stored = (await repository.getSwapRecord("o1")) as OfferSwapRecord;
        expect(stored.status).toBe("recoverable");
        // And the script stays watched — a swept deposit is still the trader's
        // money at it, which is what `RETIRABLE` excludes `recoverable` for.
        expect(contracts.watchStates).toEqual([]);
        await drive.dispose();
    });

    it("re-reads a live offer's deposit rather than answering it once", async () => {
        // The scan's cursor answers each txid once, which is right when it is
        // REBUILDING records and wrong here: a deposit that reads `pending`
        // today can be swept tomorrow, and a txid marked answered is never
        // looked at again. So a still-live offer's funding txid is deliberately
        // left off the cursor.
        const funding = offerFunding();
        const record = offerRecord({ fundingTxid: funding.txid, swapPkScript: OFFER_SCRIPT });
        const repository = memoryRepository();
        await repository.saveSwapRecord(record);
        const contracts = fakeContracts([]);
        const { wallet } = fakeWallet({
            contracts,
            history: [{ type: "SENT", arkTxid: funding.txid, createdAt: 1_700_000_000_000 }],
        });
        const drive = createSwapDrive({
            wallet,
            operator: fakeOperator(),
            repository,
            corridors: fakeCorridors(),
            indexer: fakeIndexer({
                txs: [funding],
                vtxos: [offerDeposit(funding.txid, "settled")],
            }),
            contracts,
            now: () => BEFORE,
            pollIntervalMs: 10 * 60 * 1000,
        });
        await drive.ready;
        await drive.idle();

        expect(drive.swap("o1")?.outcome).toBe("open");
        expect(await repository.getScannedTxids()).toEqual(new Set());
        await drive.dispose();
    });

    it("reports a stored recoverable offer as needs_recovery", async () => {
        const record = offerRecord({ fundingTxid: "cc".repeat(32), status: "recoverable" });
        const h = await build({ records: [record] });
        expect(h.drive.swap("o1")?.outcome).toBe("needs_recovery");
        await h.drive.dispose();
    });

    it("reports an unfunded offer record as accepted", async () => {
        const h = await build({ records: [offerRecord()] });
        expect(h.drive.swap("o1")?.outcome).toBe("accepted");
        await h.drive.dispose();
    });
});

describe("recover()", () => {
    it("refuses a lockup still inside its refund window", async () => {
        // Refused up front rather than handed to a round that would drop it —
        // `recoverVtxos` settles EVERY recoverable output at once with no CLTV
        // awareness, so an early attempt can fail unrelated outputs too.
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({ records: [record], vtxos: unspent() });
        await expect(h.drive.recover("q1")).rejects.toMatchObject({
            reason: "refund-window-open",
        });
        expect(h.recoveries).toEqual([]);
        await h.drive.dispose();
    });

    it("refuses a swap with nothing swept", async () => {
        // Two of the three `needs_recovery` sources are `needs_counterparty`,
        // which has nothing to recover: the money is at the lockup and the
        // counterparty's move is what ends the swap.
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({
            records: [record],
            now: AFTER + REFUND_MTP_LAG_SECONDS,
            vtxos: unspent(),
            funded: funded(),
        });
        await expect(h.drive.recover("q1")).rejects.toMatchObject({ reason: "nothing-swept" });
        expect(h.recoveries).toEqual([]);
        await h.drive.dispose();
    });

    it("re-reads the named lockup rather than reading a settlement txid as success", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({
            records: [record],
            now: AFTER + REFUND_MTP_LAG_SECONDS,
            vtxos: unspent(),
            // Still swept after the round: the batch is capped and its overflow
            // deferred to the next cycle, so a txid says nothing about THIS
            // swap's outputs.
            funded: funded({ recoverable: true }),
        });
        const result = await h.drive.recover("q1");
        expect(h.recoveries).toHaveLength(1);
        expect(result.txid).toEqual(expect.any(String));
        expect(result.recovered).toBe(false);
        await h.drive.dispose();
    });

    it("refuses when the wallet exposes no VTXO manager", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({
            records: [record],
            now: AFTER + REFUND_MTP_LAG_SECONDS,
            vtxos: unspent(),
            funded: funded({ recoverable: true }),
            noVtxoManager: true,
        });
        await expect(h.drive.recover("q1")).rejects.toMatchObject({
            reason: "no-recovery-support",
        });
        await h.drive.dispose();
    });

    it("refuses an id it holds no record for", async () => {
        const h = await build();
        await expect(h.drive.recover("nope")).rejects.toMatchObject({ reason: "unknown-swap" });
        await h.drive.dispose();
    });
});

describe("the refusal that is permanent", () => {
    it("blocks rather than grinding when no local refund is possible", async () => {
        // `RefundNotLocallyPossibleError` is the only throw the manager reads as
        // permanent. It has to survive the bridge: a record whose descriptor
        // this wallet cannot derive is a capability it does not have, not a
        // failure to retry for the rest of the window.
        const record = corridorRecord({
            fundingTxid: "aa".repeat(32),
            profile: { signer: {}, hashlock: { paymentHash: hex.encode(new Uint8Array(32)) } },
        });
        const h = await build({
            records: [record],
            now: AFTER,
            vtxos: unspent(),
            funded: funded(),
        });
        const swap = h.drive.swap("q1");
        expect(swap?.outcome).toBe("needs_recovery");
        // The reason is the STORAGE error's own, not "no local refund is
        // possible": `rfqSignerOf` returns `undefined` for an absent signer and
        // THROWS for a corrupt one, and collapsing the two would report a
        // storage bug as a capability this wallet does not have.
        expect(swap?.blockedReason).toContain("signingDescriptor");
        expect(swap?.blockedReason).not.toContain("no local refund");
        // Not one of the three configuration refusals: this one is about the
        // record, so even a readonly client would report it.
        expect(RFQ_CONFIGURATION_REFUSALS).not.toContain(swap?.blockedReason);
        expect(new RefundNotLocallyPossibleError("no-secrets", "x").reason).toBe("no-secrets");
        await h.drive.dispose();
    });
});

describe("the drive's own record write", () => {
    it("does not let a swap past REFUND_LOCKTIME regress the record's origin half", async () => {
        const record = signable({ fundingTxid: "aa".repeat(32) });
        const h = await build({
            records: [record],
            now: AFTER,
            vtxos: unspent(),
            funded: [],
        });
        const stored = (await h.repository.getSwapRecord("q1")) as CorridorSwapRecord;
        expect(stored.fundingTxid).toBe("aa".repeat(32));
        expect(stored.refundLocktime).toBe(REFUND_LOCKTIME);
        expect(stored.lockupPkScript).toBe(hex.encode(SEND_LOCKUP.pkScript));
        await h.drive.dispose();
    });
});
