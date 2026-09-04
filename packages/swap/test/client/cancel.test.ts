/**
 * `cancel()`: the record ordering, the fill race, and the refusals that answer
 * from the record.
 *
 * These run `cancelSwap` against a REAL drive rather than a stub, because the
 * delivery half is the thing M6 adds: both edges — the `cancelling` gate and
 * the settlement — reach a listener through the drive's own registry, whether
 * or not the drive ever armed. A stub with an `ingest` spy would prove the call
 * was made and nothing about what a consumer sees.
 *
 * The covenant underneath is real too. Only the network seam is mocked
 * (`Arkade.connect` for the current server key, `ArkadeContract` for the vtxo
 * lookup and the send), so the rebuild that pins the funding-time operator key
 * and the leaf-based spend classification both run for real — which is the only
 * way the rotated-key diagnosis and the fill race prove anything.
 */
import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { ArkAddress, Transaction, type IWallet } from "@arkade-os/sdk";
import { cancelSwap } from "../../src/client/cancel";
import { createSwapDrive, type SwapDrive } from "../../src/client/drive";
import type { SwapUpdate } from "../../src/client/outcome";
import type { OfferSwapRecord } from "../../src/client/record";
import { OfferCovenantMismatchError, encodeOffer, offerContract } from "../../src/offer";
import { InMemoryAssetSwapRepository } from "../../src/repository";
import {
    HRP,
    OFFER,
    OFFER_SCRIPT,
    OPERATOR,
    PAYOUT,
    WALLET_ADDRESS,
    fakeContracts,
    fakeCorridors,
    fakeIndexer,
    fakeOperator,
    fakeWallet,
    key,
    offerRecord,
    type FakeContracts,
    type FakeVtxo,
} from "./driveFixtures";

const FUNDING_TXID = "ab".repeat(32);
const CANCEL_TXID = "cc".repeat(32);
const NOW = 1_700_000_000;

// Only the network seam. The covenant derivation, the leaf lookup and the spend
// classification underneath are the production ones.
const state = vi.hoisted(() => ({
    serverKey: new Uint8Array(0) as Uint8Array,
    utxos: [] as { txid: string; vout: number; value: number }[],
    sends: 0,
    sendError: undefined as Error | undefined,
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        arkade: {
            ...mod.arkade,
            Arkade: { connect: async () => ({ serverKey: state.serverKey }) },
            ArkadeContract: class {
                getUtxos = async () => state.utxos;
                functions = {
                    cancel: () => {
                        const chain = {
                            from: () => chain,
                            to: () => chain,
                            withAsset: () => chain,
                            send: async () => {
                                state.sends += 1;
                                if (state.sendError) throw state.sendError;
                                return { txid: CANCEL_TXID };
                            },
                        };
                        return chain;
                    },
                };
            },
        },
    };
});

const OFFER_HEX = hex.encode(encodeOffer(OFFER));

/** A spend of the deposit through one of the covenant's own leaves — what the
 * classifier reads, and the only thing that tells a fill from a cancel. */
const spendPsbt = (via: "cancel" | "fulfill"): { psbt: string; txid: string } => {
    const leaf = offerContract(OFFER, OPERATOR).functionByName(via)?.tapLeafScript;
    const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    tx.addInput({ txid: hex.decode(FUNDING_TXID), index: 0, tapLeafScript: [leaf!] });
    tx.addOutput({ script: PAYOUT, amount: 9_000n });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

/** The deposit as the indexer shows it once a spend has landed. */
const spentDeposit = (spentTxid: string): FakeVtxo => ({
    txid: FUNDING_TXID,
    vout: 0,
    spentBy: spentTxid,
    arkTxId: spentTxid,
    script: OFFER_SCRIPT,
    value: 100_000,
});

const record = (over: Partial<OfferSwapRecord> = {}): OfferSwapRecord =>
    offerRecord({ offerHex: OFFER_HEX, fundingTxid: FUNDING_TXID, ...over });

interface Harness {
    readonly drive: SwapDrive;
    readonly repository: InMemoryAssetSwapRepository;
    readonly wallet: IWallet;
    readonly contracts: FakeContracts;
    readonly seen: SwapUpdate[];
    outcomes(): string[];
    stored(): Promise<OfferSwapRecord>;
    cancel(over?: Partial<OfferSwapRecord>): Promise<{ outcome: string }>;
}

const build = async (
    over: {
        record?: OfferSwapRecord;
        vtxos?: FakeVtxo[];
        txs?: { txid: string; psbt: string }[];
    } = {},
): Promise<Harness> => {
    state.serverKey = OPERATOR;
    state.utxos = [{ txid: FUNDING_TXID, vout: 0, value: 100_000 }];
    state.sends = 0;
    state.sendError = undefined;

    const stored = over.record ?? record();
    const repository = new InMemoryAssetSwapRepository();
    await repository.saveSwapRecord(stored);

    const contracts = fakeContracts([]);
    const base = fakeWallet({ contracts, identity: {} });
    const wallet = {
        ...(base.wallet as unknown as Record<string, unknown>),
        getArkadeInfo: async () => ({}),
        getArkadeBroadcaster: async () => ({
            submitTx: async () => ({}),
            finalizeTx: async () => {},
        }),
    } as unknown as IWallet;

    const indexer = fakeIndexer({
        ...(over.vtxos === undefined ? {} : { vtxos: over.vtxos }),
        ...(over.txs === undefined ? {} : { txs: over.txs }),
    });
    // `readonly`: the cancel path is an awaited call, not the loop, and this
    // keeps every emission these tests see one cancel produced.
    const drive = createSwapDrive({
        wallet,
        repository,
        contracts,
        corridors: fakeCorridors(),
        operator: fakeOperator(),
        indexer,
        mode: "readonly",
        now: () => NOW,
    });
    const seen: SwapUpdate[] = [];
    drive.onUpdate((update) => seen.push(update));
    await drive.ready;

    return {
        drive,
        repository,
        wallet,
        contracts,
        seen,
        outcomes: () => seen.map((u) => u.outcome),
        stored: async () => (await repository.getSwapRecord(stored.id)) as OfferSwapRecord,
        cancel: async (patch = {}) =>
            cancelSwap({
                wallet,
                repository,
                record: { ...stored, ...patch } as OfferSwapRecord,
                drive,
                indexer,
                now: () => NOW,
            }),
    };
};

describe("cancel() — the ordering", () => {
    it("gates on the cancelling write, then records the spend it broadcast", async () => {
        const h = await build();

        await expect(h.cancel()).resolves.toEqual({ outcome: "cancelled" });

        const stored = await h.stored();
        expect(stored.status).toBe("cancelled");
        expect(stored.spentTxid).toBe(CANCEL_TXID);
        // A completion time is a fill's, not a cancel's — the watcher's rule.
        expect(stored.completedAt).toBeUndefined();
        expect(state.sends).toBe(1);
        await h.drive.dispose();
    });

    it("emits at both edges, on a drive that never armed", async () => {
        // Between the gate and the settlement the record has no `spentTxid`, so
        // a crash mid-call leaves a `cancelling` a consumer was told about. The
        // delivery channel is the drive's registry whether or not it armed.
        const h = await build();
        await h.cancel();

        expect(h.outcomes()).toEqual(["open", "cancelling", "cancelled"]);
        await h.drive.dispose();
    });

    it("does not broadcast when the gate cannot be written", async () => {
        // The marker is what keeps a crash between submit and record from
        // leaving a swap that still looks pending. A lost write must stop the
        // broadcast, not warn past it.
        const h = await build();
        vi.spyOn(h.repository, "saveSwapRecord").mockRejectedValueOnce(new Error("quota exceeded"));

        await expect(h.cancel()).rejects.toThrow(/quota exceeded/);
        expect(state.sends).toBe(0);
        await h.drive.dispose();
    });

    it("retires the offer script only on a settlement the store took", async () => {
        const h = await build();
        await h.cancel();
        expect(h.contracts.watchStates).toEqual([[OFFER_SCRIPT, "retained"]]);

        // And the same cancel with a refused settlement write: the record still
        // reads `cancelling` to the next restore, so the script stays watched.
        const g = await build();
        const save = vi.spyOn(g.repository, "saveSwapRecord");
        save.mockImplementationOnce(save.getMockImplementation()!).mockRejectedValueOnce(
            new Error("quota exceeded"),
        );
        await expect(g.cancel()).resolves.toEqual({ outcome: "cancelled" });
        expect(g.contracts.watchStates).toEqual([]);
        await h.drive.dispose();
        await g.drive.dispose();
    });

    it("resumes a cancelling record that never broadcast", async () => {
        // The gate landed and the call died before `send()`. The deposit is
        // intact, so a second cancel rewrites an identical marker and goes on —
        // the same idempotence-absorbing retry `accept()` gives.
        const h = await build({ record: record({ status: "cancelling", updatedAt: NOW - 60 }) });

        await expect(h.cancel({ status: "cancelling" })).resolves.toEqual({ outcome: "cancelled" });
        expect((await h.stored()).spentTxid).toBe(CANCEL_TXID);
        expect(state.sends).toBe(1);
        await h.drive.dispose();
    });
});

describe("cancel() — the fill race", () => {
    // The deposit is gone from the spendable set: `prepareOfferCancel` throws
    // the v1 missing-VTXO error, which is where v1's trap was.
    const raced = () => {
        state.utxos = [];
    };

    it("reads a fill off the covenant's own leaf rather than throwing", async () => {
        const spend = spendPsbt("fulfill");
        const h = await build({ vtxos: [spentDeposit(spend.txid)], txs: [spend] });
        raced();

        await expect(h.cancel()).resolves.toEqual({ outcome: "filled" });

        const stored = await h.stored();
        expect(stored.status).toBe("fulfilled");
        expect(stored.spentTxid).toBe(spend.txid);
        // A completion time is a fill's.
        expect(stored.completedAt).toBe(NOW);
        expect(h.outcomes()).toEqual(["open", "cancelling", "filled"]);
        expect(state.sends).toBe(0);
        await h.drive.dispose();
    });

    it("reads a cancel that already landed as cancelled", async () => {
        const spend = spendPsbt("cancel");
        const h = await build({ vtxos: [spentDeposit(spend.txid)], txs: [spend] });
        raced();

        await expect(h.cancel()).resolves.toEqual({ outcome: "cancelled" });
        const stored = await h.stored();
        expect(stored.status).toBe("cancelled");
        expect(stored.completedAt).toBeUndefined();
        await h.drive.dispose();
    });

    it("answers needs_recovery for a spend it cannot name, and writes nothing terminal", async () => {
        // Neither leaf, so the classifier is `indeterminate`: value moved and
        // the local rebuild cannot say how. No terminal write on a guess — the
        // record stays `cancelling`, which is what `recover` drives.
        const foreign = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
        foreign.addInput({ txid: hex.decode(FUNDING_TXID), index: 0 });
        foreign.addOutput({ script: PAYOUT, amount: 9_000n });
        const spend = { psbt: base64.encode(foreign.toPSBT()), txid: foreign.id };
        const h = await build({ vtxos: [spentDeposit(spend.txid)], txs: [spend] });
        raced();

        await expect(h.cancel()).resolves.toEqual({ outcome: "needs_recovery" });
        expect((await h.stored()).status).toBe("cancelling");
        expect(h.contracts.watchStates).toEqual([]);
        await h.drive.dispose();
    });

    it("answers needs_recovery for a deposit the reader cannot see at all", async () => {
        // Indexer lag reads exactly like a spend nobody can classify, and must:
        // writing `cancelled` on a deposit that may still be live would retire
        // the script under it.
        const h = await build({ vtxos: [] });
        raced();

        await expect(h.cancel()).resolves.toEqual({ outcome: "needs_recovery" });
        expect((await h.stored()).status).toBe("cancelling");
        await h.drive.dispose();
    });
});

describe("cancel() — answering from the record", () => {
    it.each([
        ["cancelled", "cancelled"],
        ["fulfilled", "filled"],
    ] as const)("answers a %s record without re-broadcasting", async (status, outcome) => {
        const h = await build({ record: record({ status, spentTxid: CANCEL_TXID }) });
        await expect(h.cancel({ status, spentTxid: CANCEL_TXID })).resolves.toEqual({ outcome });
        expect(state.sends).toBe(0);
        await h.drive.dispose();
    });

    it("answers needs_recovery for a swept deposit rather than trying to spend it", async () => {
        // `recoverable` is the one status a cancel can never move: the value
        // left the covenant by a route no offchain spend reaches.
        const h = await build({ record: record({ status: "recoverable" }) });
        await expect(h.cancel({ status: "recoverable" })).resolves.toEqual({
            outcome: "needs_recovery",
        });
        expect(state.sends).toBe(0);
        await h.drive.dispose();
    });
});

describe("cancel() — the pinned operator key", () => {
    it("cancels across a rotation, because the record pins the funded address", async () => {
        // The client's CURRENT key is the rotated one. The v2 record carries
        // `swapAddress` as a required field pinned at accept, so #680's
        // fall-back-to-the-current-key case cannot arise here.
        const h = await build();
        state.serverKey = key(4);

        await expect(h.cancel()).resolves.toEqual({ outcome: "cancelled" });
        await h.drive.dispose();
    });

    it("names the rebuild mismatch rather than reporting a missing deposit", async () => {
        // The pinned address is not the one funded: a corrupt record, or a
        // wrong `swapAddress`. Typed, and before any broadcast.
        const wrong = new ArkAddress(key(4), key(21), HRP).encode();
        const h = await build({ record: record({ swapAddress: wrong }) });

        await expect(h.cancel({ swapAddress: wrong })).rejects.toBeInstanceOf(
            OfferCovenantMismatchError,
        );
        expect(state.sends).toBe(0);
        // The gate landed first, deliberately: the ordering does not depend on
        // what the rebuild will say.
        expect((await h.stored()).status).toBe("cancelling");
        await h.drive.dispose();
    });
});

describe("the swap address is what pins the key", () => {
    it("decodes the funded address to the covenant's own operator key", () => {
        expect(hex.encode(ArkAddress.decode(WALLET_ADDRESS).serverPubKey)).toBe(
            hex.encode(OPERATOR),
        );
    });
});
