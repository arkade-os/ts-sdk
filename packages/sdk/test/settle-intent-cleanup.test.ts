import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64, hex } from "@scure/base";
import { ArkError, Transaction, Wallet, type ExtendedVirtualCoin } from "../src";
import { SQLiteIntentRepository, type SQLExecutor } from "../src/repositories/sqlite";
import { collectIntents } from "../src/repositories/intentRepository";
import { reconcileIntents } from "../src/wallet/intentReconciliation";

const input = {
    txid: "aa".repeat(32),
    vout: 0,
    value: 10_000,
    script: `5120${"11".repeat(32)}`,
    status: { confirmed: true },
    isSpent: false,
    isSwept: false,
    isUnrolled: false,
    isPreconfirmed: false,
} as ExtendedVirtualCoin;
const outpoint = { txid: input.txid, vout: input.vout };
const deleteMessage = { type: "delete", expire_at: 0 } as const;
const noMatch = () =>
    new ArkError(23, "no matching intents found for intent proof", "INVALID_INTENT_PROOF");

describe("Wallet settlement cleanup with SQLite intent locks", () => {
    const directory = mkdtempSync(join(tmpdir(), "ark-intent-cleanup-"));
    const file = join(directory, "wallet.sqlite");
    let db: DatabaseSync;
    let repository: SQLiteIntentRepository;

    function open() {
        db = new DatabaseSync(file);
        const sql: SQLExecutor = {
            run: async (query, params) => {
                db.prepare(query).run(...((params ?? []) as []));
            },
            get: async (query, params) => db.prepare(query).get(...((params ?? []) as [])) as never,
            all: async (query, params) => db.prepare(query).all(...((params ?? []) as [])) as never,
        };
        repository = new SQLiteIntentRepository(sql);
    }

    beforeEach(() => {
        open();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        db.close();
        unlinkSync(file);
        vi.restoreAllMocks();
    });
    afterAll(() => rmdirSync(directory));

    function setup(lostAck = false) {
        const failure = new Error(lostAck ? "registration response lost" : "event stream failed");
        const stream = {
            next: vi.fn().mockRejectedValue(failure),
            return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        const proof = new Transaction();
        proof.addInput({ txid: input.txid, index: input.vout });
        proof.addOutput({ script: hex.decode(input.script), amount: BigInt(input.value) });
        let serverAccepted = false;
        const provider = {
            getEventStream: vi.fn(() => stream),
            createBatchRegistration: vi.fn(async () => {
                serverAccepted = true;
                if (lostAck) throw failure;
                return "server-intent";
            }),
            deleteBatchRegistration: vi.fn().mockRejectedValue(new Error("delete response lost")),
        };
        const wallet: any = {
            network: "mutinynet",
            arkProvider: provider,
            intentRepository: repository,
            _addPendingSpends: vi.fn(),
            _removePendingSpends: vi.fn(),
            _settlingOutpoints: new Set<string>(),
            getAddress: vi
                .fn()
                .mockResolvedValue(
                    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                ),
            makeBatchRegistrationProof: vi.fn().mockResolvedValue({
                proof: base64.encode(proof.toPSBT()),
                message: { type: "register", expire_at: 0 },
            }),
            makeDeleteBatchRegistrationProof: vi.fn().mockResolvedValue({
                proof: "stored-delete-proof",
                message: deleteMessage,
            }),
            logUngatedInputs: vi.fn(),
            getContractManager: vi.fn().mockResolvedValue({ assertAnnotatable: vi.fn() }),
            safeCreateBatchRegistration: Wallet.prototype.safeCreateBatchRegistration,
            createBatchHandler: vi.fn().mockReturnValue({}),
            persistIntentSnapshot: (Wallet.prototype as any).persistIntentSnapshot,
        };
        return {
            wallet,
            provider,
            failure,
            stream,
            accepted: () => serverAccepted,
            settle: () =>
                (Wallet.prototype as any)._settleImpl.call(wallet, {
                    inputs: [input],
                    outputs: [],
                }),
        };
    }

    it.each([false, true])(
        "retains ambiguous cleanup across reopen and releases only after retry (lost ack: %s)",
        async (lostAck) => {
            const s = setup(lostAck);
            await expect(s.settle()).rejects.toBe(s.failure);
            expect(s.accepted()).toBe(true);
            expect(s.provider.deleteBatchRegistration).toHaveBeenCalledOnce();
            expect(s.wallet._settlingOutpoints.size).toBe(0);
            expect(s.stream.return).toHaveBeenCalledOnce();
            const state = lostAck ? "waiting_to_submit" : "waiting_for_batch";
            const [persisted] = await collectIntents(repository);
            expect(persisted.state).toBe(state);
            expect(persisted.intentId).toBe(lostAck ? undefined : "server-intent");
            expect(await repository.getLockedVtxoOutpoints()).toEqual([outpoint]);

            db.close();
            open();
            const deleteIntent = vi.fn().mockRejectedValue(new Error("still disconnected"));
            const deps = {
                intentRepository: repository,
                indexerProvider: { getVtxos: vi.fn().mockResolvedValue({ vtxos: [input] }) },
                deleteIntent,
            };
            await reconcileIntents(deps);
            expect(await collectIntents(repository)).toEqual([persisted]);
            expect(await repository.getLockedVtxoOutpoints()).toEqual([outpoint]);
            expect(deleteIntent).toHaveBeenCalledWith({
                proof: persisted.deleteProof,
                message: JSON.parse(persisted.deleteProofMessage),
            });

            deleteIntent.mockResolvedValue(undefined);
            await reconcileIntents(deps);
            expect((await collectIntents(repository))[0].state).toBe("cancelled");
            expect(await repository.getLockedVtxoOutpoints()).toEqual([]);
            expect(deleteIntent).toHaveBeenCalledTimes(2);
        },
    );

    it("cancels when registration was never attempted", async () => {
        const s = setup();
        s.provider.getEventStream.mockImplementation(() => {
            throw s.failure;
        });
        await expect(s.settle()).rejects.toBe(s.failure);
        expect(s.provider.createBatchRegistration).not.toHaveBeenCalled();
        expect(s.provider.deleteBatchRegistration).not.toHaveBeenCalled();
        expect((await collectIntents(repository))[0].state).toBe("cancelled");
        expect(await repository.getLockedVtxoOutpoints()).toEqual([]);
        expect(s.wallet._settlingOutpoints.size).toBe(0);
    });

    it.each([undefined, noMatch()])(
        "cancels for acknowledged deletion or the existing no-match response: %s",
        async (reply) => {
            const s = setup(true);
            if (reply) s.provider.deleteBatchRegistration.mockRejectedValue(reply);
            else s.provider.deleteBatchRegistration.mockResolvedValue(undefined);
            await expect(s.settle()).rejects.toBe(s.failure);
            expect((await collectIntents(repository))[0].state).toBe("cancelled");
            expect(await repository.getLockedVtxoOutpoints()).toEqual([]);
        },
    );
});
