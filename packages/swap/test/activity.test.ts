import { describe, it, expect } from "vitest";
import type { ArkTransaction } from "@arkade-os/sdk";
import {
    rfqSwapActivityInputs,
    swapActivityResolver,
    type SwapActivityInput,
} from "../src/activity";
import { InMemoryAssetSwapRepository } from "../src/repository";
import type { LockupSpendIndexer } from "../src/refund";
import type { RfqSwapRecord } from "../src/rfqRecord";
import { lightningSendContract } from "../src/rfq";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

const tx = (txid: string): ArkTransaction =>
    ({
        key: { arkTxid: txid, boardingTxid: "", commitmentTxid: "" },
        type: "SENT",
        amount: 1000,
        settled: true,
        createdAt: 1,
    }) as unknown as ArkTransaction;

/** Builds a resolver and runs prepare() — resolve() only sees data after this. */
const preparedResolver = async (swaps: SwapActivityInput[]) => {
    const resolver = swapActivityResolver({ listSwaps: async () => swaps });
    await resolver.prepare!();
    return resolver;
};

describe("swapActivityResolver", () => {
    it("resolves a swap's transaction to its groupId, label, outcome and metadata", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("fund"))).toEqual([
            {
                groupId: "swap:r1",
                label: "Lightning send",
                kind: "swap",
                outcome: "settled",
                metadata: { rfqId: "r1", swapKind: "lightning_send" },
            },
        ]);
    });

    it("indexes every txid of a swap to the same groupId", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "refunded", txids: ["fund", "refund"] },
        ]);

        const funding = resolver.resolve(tx("fund"));
        const refund = resolver.resolve(tx("refund"));

        expect(funding?.[0].groupId).toBe("swap:r1");
        expect(refund?.[0].groupId).toBe(funding?.[0].groupId);
    });

    it("reports the swap's state as the membership outcome", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "failed", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("fund"))).toEqual([
            expect.objectContaining({ outcome: "failed", kind: "swap" }),
        ]);
    });

    it("gives a lightning_receive refund a different outcome than a lightning_send refund", async () => {
        // RfqSwapState's `refunded` case (swapManager.ts): a send-leg refund is
        // money coming back, but a receive-leg refund is a LOSS — the trader's
        // incoming payment never arrived. The two must not render as the same
        // token.
        const send = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "refunded", txids: ["a"] },
        ]);
        const receive = await preparedResolver([
            { rfqId: "r2", kind: "lightning_receive", state: "refunded", txids: ["b"] },
        ]);

        const sendOutcome = send.resolve(tx("a"))?.[0].outcome;
        const receiveOutcome = receive.resolve(tx("b"))?.[0].outcome;

        expect(sendOutcome).toBe("refunded");
        expect(receiveOutcome).toBe("lost");
        expect(receiveOutcome).not.toBe(sendOutcome);
    });

    it("labels each leg by its corridor", async () => {
        const send = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["a"] },
        ]);
        const receive = await preparedResolver([
            { rfqId: "r2", kind: "lightning_receive", state: "settled", txids: ["b"] },
        ]);
        const onchainSend = await preparedResolver([
            { rfqId: "r3", kind: "onchain_send", state: "settled", txids: ["c"] },
        ]);

        expect(send.resolve(tx("a"))).toEqual([
            expect.objectContaining({ label: "Lightning send" }),
        ]);
        expect(receive.resolve(tx("b"))).toEqual([
            expect.objectContaining({ label: "Lightning receive" }),
        ]);
        expect(onchainSend.resolve(tx("c"))).toEqual([
            expect.objectContaining({ label: "Onchain send" }),
        ]);
    });

    it("leaves an unrelated transaction plain", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "pending", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("other"))).toBeUndefined();
    });

    it("leaves the index empty when listSwaps rejects, so resolve contributes nothing", async () => {
        const resolver = swapActivityResolver({
            listSwaps: async () => {
                throw new Error("store unavailable");
            },
        });

        await expect(resolver.prepare!()).rejects.toThrow("store unavailable");
        expect(resolver.resolve(tx("fund"))).toBeUndefined();
    });

    it("a swap with no transactions yet contributes nothing", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "pending", txids: [] },
        ]);

        expect(resolver.resolve(tx("other"))).toBeUndefined();
    });

    it("resolve() before prepare() returns undefined rather than throwing", () => {
        const resolver = swapActivityResolver({ listSwaps: async () => [] });

        expect(resolver.resolve(tx("fund"))).toBeUndefined();
    });
});

describe("rfqSwapActivityInputs", () => {
    const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
    const p2tr = (program: Uint8Array) => Uint8Array.from([0x51, 0x20, ...program]);
    /** A real lockup address: the helper decodes it to ask the indexer, so a
     * made-up one would exercise the wrong branch. */
    const LOCKUP_ADDRESS = lightningSendContract({
        solverPubkey: key(1),
        operatorPubkey: key(3),
        paymentHash: hex.encode(sha256(new Uint8Array(32).fill(7))),
        refundLocktime: 1_800_000_000,
        claimDelay: 4096,
        emulatorPubkey: key(9),
        refundPkScript: p2tr(key(5)),
        senderPubkey: key(13),
        receiverPkScript: p2tr(key(1)),
    })
        .address("tark", key(3))
        .encode();

    const record = (over: Partial<RfqSwapRecord> = {}): RfqSwapRecord => ({
        rfqId: "r1",
        kind: "lightning_send",
        state: "settled",
        lockupAddress: LOCKUP_ADDRESS,
        profile: {
            signer: { signingDescriptor: `tr(${"a7".repeat(32)})` },
            hashlock: { paymentHash: "d4".repeat(32) },
        },
        createdAt: 1,
        updatedAt: 1,
        ...over,
    });

    const storeOf = async (...records: RfqSwapRecord[]) => {
        const repository = new InMemoryAssetSwapRepository();
        for (const r of records) await repository.saveRfqSwap(r);
        return repository;
    };

    /** Everything at the lockup, as the fate read shapes it. */
    const fakeIndexer = (
        vtxos: { txid: string; arkTxId?: string }[],
        over: { fail?: boolean } = {},
    ) =>
        ({
            async getVtxos() {
                if (over.fail) throw new Error("indexer unreachable");
                return { vtxos };
            },
        }) as unknown as LockupSpendIndexer;

    it("flattens a send record's own txids without asking anyone", async () => {
        const repository = await storeOf(
            record({ state: "refunded", fundingTxid: "fund", refundTxid: "refund" }),
        );
        expect(await rfqSwapActivityInputs({ repository })).toEqual([
            { rfqId: "r1", kind: "lightning_send", state: "refunded", txids: ["fund", "refund"] },
        ]);
    });

    it("answers from a record written under the old txid names, without the indexer", async () => {
        // The record fields shipped in `0.0.8` and a consumer's store still
        // holds them; read under the current names they are `undefined`, and
        // every activity query falls back to a lockup read it does not need.
        const { fundingTxid: _f, refundTxid: _r, ...base } = record({ state: "refunded" });
        const repository = await storeOf({
            ...base,
            fundingArkTxid: "fund",
            refundArkTxid: "refund",
        } as unknown as RfqSwapRecord);

        expect(await rfqSwapActivityInputs({ repository })).toEqual([
            { rfqId: "r1", kind: "lightning_send", state: "refunded", txids: ["fund", "refund"] },
        ]);
    });

    it("takes each corridor's own claim txid from its handler", async () => {
        const repository = await storeOf(
            record({
                rfqId: "receive",
                kind: "lightning_receive",
                fundingTxid: "fund",
                profile: {
                    signer: { signingDescriptor: `tr(${"a7".repeat(32)})` },
                    hashlock: { paymentHash: "d4".repeat(32) },
                    expectedAmount: 1000,
                    payoutAddress: "tark1qpayout",
                    claimTxid: "claim",
                },
            }),
        );
        const [input] = await rfqSwapActivityInputs({ repository });
        expect(input.txids).toEqual(["fund", "claim"]);
    });

    it("reads the counterparty's spend off the lockup when no refund of ours ended it", async () => {
        // `settled` means the SOLVER claimed: the transaction that closed the
        // swap is one no record of ours carries.
        const repository = await storeOf(record({ fundingTxid: "fund" }));
        const [input] = await rfqSwapActivityInputs({
            repository,
            indexer: fakeIndexer([{ txid: "fund", arkTxId: "solver-claim" }]),
        });
        expect(input.txids).toEqual(["fund", "solver-claim"]);
    });

    it("recovers the funding txid of a record written before the field existed", async () => {
        const repository = await storeOf(record({ state: "pending" }));
        const [input] = await rfqSwapActivityInputs({
            repository,
            indexer: fakeIndexer([{ txid: "fund" }]),
        });
        expect(input.txids).toEqual(["fund"]);
    });

    it("asks nobody when the record answers on its own", async () => {
        let calls = 0;
        const counting = {
            async getVtxos() {
                calls += 1;
                return { vtxos: [] };
            },
        } as unknown as LockupSpendIndexer;
        const repository = await storeOf(
            record({ state: "refunded", fundingTxid: "fund", refundTxid: "refund" }),
        );
        await rfqSwapActivityInputs({ repository, indexer: counting });
        expect(calls).toBe(0);
    });

    it("takes the counterparty's spend off the record with no indexer wired at all", async () => {
        // The offline-first case `lockupSpendTxids` exists for: the manager
        // stamped the solver's claim when it ended the swap, so the txid that
        // closed it is already stored and nothing has to go to the network.
        const repository = await storeOf(
            record({ fundingTxid: "fund", lockupSpendTxids: ["solver-claim"] }),
        );
        const [input] = await rfqSwapActivityInputs({ repository });
        expect(input.txids).toEqual(["fund", "solver-claim"]);
    });

    it("asks nobody when the record's own stamp names the spend that ended it", async () => {
        let calls = 0;
        const counting = {
            async getVtxos() {
                calls += 1;
                return { vtxos: [] };
            },
        } as unknown as LockupSpendIndexer;
        const repository = await storeOf(
            record({ fundingTxid: "fund", lockupSpendTxids: ["solver-claim"] }),
        );
        await rfqSwapActivityInputs({ repository, indexer: counting });
        expect(calls).toBe(0);
    });

    it("still reads the lockup when the stamp is absent, which is what makes it a fallback", async () => {
        // A record written before the manager owned persistence carries no
        // stamp, so the indexer is still the only source for its spend.
        const repository = await storeOf(record({ fundingTxid: "fund" }));
        const [input] = await rfqSwapActivityInputs({
            repository,
            indexer: fakeIndexer([{ txid: "fund", arkTxId: "solver-claim" }]),
        });
        expect(input.txids).toEqual(["fund", "solver-claim"]);
    });

    it("degrades to fewer txids when the indexer is unreachable, never to a throw", async () => {
        const repository = await storeOf(record({ fundingTxid: "fund" }));
        const [input] = await rfqSwapActivityInputs({
            repository,
            indexer: fakeIndexer([], { fail: true }),
        });
        expect(input.txids).toEqual(["fund"]);
    });

    it("groups what it produced, which is the whole point", async () => {
        const repository = await storeOf(
            record({ state: "refunded", fundingTxid: "fund", refundTxid: "refund" }),
        );
        const resolver = await preparedResolver(await rfqSwapActivityInputs({ repository }));
        expect(resolver.resolve(tx("fund"))?.[0].groupId).toBe("swap:r1");
        expect(resolver.resolve(tx("refund"))?.[0].groupId).toBe("swap:r1");
    });
});
