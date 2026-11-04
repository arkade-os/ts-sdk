import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { NativeExecutionJournal } from "../src/arkade/executionJournal";
import { buildOffchainTx, type EmulatorSubmitProposal } from "../src/utils/arkTransaction";
import { Transaction } from "../src/utils/transaction";
import { VtxoScript } from "../src/script/base";
import {
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
} from "../src/script/tapscript";
import type { VirtualCoin } from "../src/wallet";
import { Extension, UnknownPacket } from "../src/extension";
import { EmulatorPacket } from "../src/extension/emulator";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { RealmWalletRepository } from "../src/repositories/realm/walletRepository";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import type { WalletRepository } from "../src/repositories/walletRepository";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";

const key = schnorr.getPublicKey(new Uint8Array(32).fill(7));
const source = { txid: "a1".repeat(32), vout: 3 };
const initial = { lastSyncTime: 123, settings: { hasPendingTx: true, other: { keep: 7 } } };
const options = { walletStateTransactions: true, persistentWalletState: true } as const;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

function graph() {
    const script = new VtxoScript([MultisigTapscript.encode({ pubkeys: [key] }).script]);
    return buildOffchainTx(
        [{ ...source, value: 50_000, tapLeafScript: script.leaves[0], tapTree: script.encode() }],
        [{ script: script.pkScript, amount: 50_000n }],
        CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 10n }, pubkeys: [key] }),
    );
}
function proposal(tx = graph()): EmulatorSubmitProposal {
    return {
        txid: tx.arkTx.id,
        arkTx: base64.encode(tx.arkTx.toPSBT()),
        checkpointTxs: tx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    };
}
function sqlite() {
    return new SQLiteWalletRepository(createNodeSQLExecutor(), options);
}
function idb(name = `native-journal-${crypto.randomUUID()}`, persistent = true) {
    const repo = new IndexedDBWalletRepository(name, { persistentWalletState: persistent });
    cleanups.push(() => repo[Symbol.asyncDispose]());
    return repo;
}

async function observationFixture(conditional = false, repo = sqlite()) {
    const secrets = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
    const pubkeys = secrets.map((s) => schnorr.getPublicKey(s));
    const leaf = conditional
        ? ConditionMultisigTapscript.encode({ conditionScript: new Uint8Array([0x51]), pubkeys })
        : CLTVMultisigTapscript.encode({ absoluteTimelock: 100n, pubkeys });
    const script = new VtxoScript([
        leaf.script,
        MultisigTapscript.encode({ pubkeys: [key] }).script,
    ]);
    const tx = buildOffchainTx(
        [{ ...source, value: 50_000, tapLeafScript: script.leaves[0], tapTree: script.encode() }],
        [{ script: script.pkScript, amount: 50_000n }],
        CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 10n }, pubkeys: [key] }),
    );
    const request = proposal(tx);
    const journal = new NativeExecutionJournal(repo);
    const record = await journal.admit(source, request);
    for (const item of [tx.arkTx, tx.checkpoints[0]])
        for (const secret of secrets) item.signIdx(secret, 0);
    const signed = proposal(tx);
    const coins: VirtualCoin[] = [
        {
            ...source,
            script: record.source.script,
            value: 50_000,
            isSpent: true,
            spentBy: tx.checkpoints[0].id,
            arkTxId: record.operationId,
            createdAt: new Date(0),
            isUnrolled: false,
            status: { confirmed: false },
        },
        {
            txid: record.operationId,
            vout: 0,
            script: record.payout.script,
            value: 50_000,
            createdAt: new Date(0),
            isUnrolled: false,
            status: { confirmed: false },
        },
    ];
    const txs = [signed.arkTx, signed.checkpointTxs[0]];
    const indexer = {
        getVtxos: vi.fn(async () => ({ vtxos: coins })),
        getVirtualTxs: vi.fn(async () => ({ txs })),
    };
    return { repo, journal, record, request, tx, txs, coins, indexer, script };
}

describe("NativeExecutionJournal receipts", () => {
    it("commits a small immutable receipt bound to exact canonical proposal bytes and preserves the slot", async () => {
        const f = await observationFixture();
        const existing = (await f.repo.getWalletState())!;
        await f.repo.saveWalletState({
            ...initial,
            settings: { ...initial.settings, ...existing.settings },
        });
        const before = (await f.repo.getWalletState())!;
        const update = vi.spyOn(f.repo.atomicWalletState!, "update");
        expect(await f.journal.reconcile(source, f.indexer)).toEqual({
            state: "reconciled",
            record: f.record,
        });
        expect(update).toHaveBeenCalledOnce();
        const receipt = await f.journal.getReceipt(source);
        const expected = {
            version: 1,
            state: "reconciled",
            operationId: f.record.operationId,
            source,
            proposalHash: createHash("sha256")
                .update(
                    JSON.stringify({
                        txid: f.request.txid,
                        arkTx: f.request.arkTx,
                        checkpointTxs: f.request.checkpointTxs,
                    }),
                )
                .digest("hex"),
        };
        expect(receipt).toEqual(expected);
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(Object.isFrozen(receipt?.source)).toBe(true);
        expect(Reflect.set(receipt!.source, "vout", 99)).toBe(false);
        expect(await f.repo.getWalletState()).toEqual({
            ...before,
            settings: { ...before.settings, nativeExecutionReceipt: expected },
        });
        expect(await f.journal.getReceipt({ ...source, vout: 99 })).toBeUndefined();
        await expect(f.journal.admit(source, f.request)).rejects.toThrow("occupied");
    });

    it("returns persisted historical reconciliation without RPC while observe remains fresh", async () => {
        const f = await observationFixture();
        await f.journal.reconcile(source, f.indexer);
        const reopened = new NativeExecutionJournal(f.repo);
        const update = vi.spyOn(f.repo.atomicWalletState!, "update");
        const offline = {
            getVtxos: vi.fn().mockRejectedValue(new Error("offline")),
            getVirtualTxs: vi.fn().mockRejectedValue(new Error("offline")),
        };
        expect((await reopened.reconcile(source, offline))?.state).toBe("reconciled");
        expect(offline.getVtxos).not.toHaveBeenCalled();
        expect(offline.getVirtualTxs).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect((await reopened.observe(source, offline))?.state).toBe("unknown");
        expect(await reopened.getReceipt(source)).toBeDefined();
    });

    it("does not update for unknown or absent observations and propagates snapshot errors", async () => {
        const f = await observationFixture();
        const update = vi.spyOn(f.repo.atomicWalletState!, "update");
        f.indexer.getVtxos.mockRejectedValueOnce(new Error("offline"));
        expect((await f.journal.reconcile(source, f.indexer))?.state).toBe("unknown");
        expect(update).not.toHaveBeenCalled();
        expect(await f.journal.getReceipt(source)).toBeUndefined();
        f.indexer.getVtxos.mockClear();
        f.indexer.getVirtualTxs.mockClear();
        expect(await f.journal.reconcile({ ...source, vout: 99 }, f.indexer)).toBeUndefined();
        expect(f.indexer.getVtxos).not.toHaveBeenCalled();
        const error = new Error("snapshot failure");
        vi.spyOn(f.repo, "getWalletState").mockRejectedValue(error);
        await expect(f.journal.reconcile(source, f.indexer)).rejects.toBe(error);
        await expect(f.journal.getReceipt(source)).rejects.toBe(error);
        expect(update).not.toHaveBeenCalled();
    });

    it.each([
        "orphan",
        "future",
        "unknown shape",
        "wrong source",
        "wrong operation",
        "wrong hash",
        "null",
        "malformed slot",
    ])("rejects %s receipt before filtering an unrelated source", async (kind) => {
        const f = await observationFixture();
        await f.journal.reconcile(source, f.indexer);
        const state = (await f.repo.getWalletState())!;
        const receipt = state.settings!.nativeExecutionReceipt;
        if (kind === "orphan") delete state.settings!.nativeExecutionJournal;
        if (kind === "future") receipt.version = 2;
        if (kind === "unknown shape") receipt.extra = true;
        if (kind === "wrong source") receipt.source.vout = 99;
        if (kind === "wrong operation") receipt.operationId = "a2".repeat(32);
        if (kind === "wrong hash") receipt.proposalHash = "a2".repeat(32);
        if (kind === "null") state.settings!.nativeExecutionReceipt = null;
        if (kind === "malformed slot") state.settings!.nativeExecutionJournal = {};
        await f.repo.saveWalletState(state);
        f.indexer.getVtxos.mockClear();
        f.indexer.getVirtualTxs.mockClear();
        await expect(f.journal.getReceipt({ ...source, vout: 99 })).rejects.toThrow();
        await expect(f.journal.reconcile({ ...source, vout: 99 }, f.indexer)).rejects.toThrow();
        expect(f.indexer.getVtxos).not.toHaveBeenCalled();
        expect(f.indexer.getVirtualTxs).not.toHaveBeenCalled();
        expect(await f.repo.getWalletState()).toEqual(state);
    });

    it.each([
        "same txid ark bytes",
        "same txid checkpoint bytes",
        "missing slot",
        "conflicting receipt",
    ])("rejects changed captured state before receipt commit: %s", async (kind) => {
        const f = await observationFixture();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        f.indexer.getVirtualTxs.mockImplementationOnce(async () => {
            await gate;
            return { txs: f.txs };
        });
        const pending = f.journal.reconcile(source, f.indexer);
        const rejected = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(f.indexer.getVirtualTxs).toHaveBeenCalledOnce());
        const state = (await f.repo.getWalletState())!;
        if (kind === "same txid ark bytes")
            state.settings!.nativeExecutionJournal.proposal.arkTx = f.txs[0];
        if (kind === "same txid checkpoint bytes")
            state.settings!.nativeExecutionJournal.proposal.checkpointTxs[0] = f.txs[1];
        if (kind === "missing slot") delete state.settings!.nativeExecutionJournal;
        if (kind === "conflicting receipt") state.settings!.nativeExecutionReceipt = { version: 2 };
        await f.repo.saveWalletState(state);
        release();
        await rejected;
        expect(await f.repo.getWalletState()).toEqual(state);
    });

    it("commits concurrent identical receipts idempotently without public-method authorization", async () => {
        const f = await observationFixture();
        const failure = () => {
            throw new Error("public method must not authorize receipts");
        };
        vi.spyOn(f.journal, "observe").mockImplementation(failure);
        vi.spyOn(f.journal, "get").mockImplementation(failure);
        vi.spyOn(f.journal, "getReceipt").mockImplementation(failure);
        const results = await Promise.all([
            f.journal.reconcile(source, f.indexer),
            new NativeExecutionJournal(f.repo).reconcile(source, f.indexer),
        ]);
        expect(results.map((r) => r?.state)).toEqual(["reconciled", "reconciled"]);
        expect(await new NativeExecutionJournal(f.repo).getReceipt(source)).toBeDefined();
    });

    it("does not erase a receipt committed while an older observation becomes unknown", async () => {
        const f = await observationFixture();
        const update = vi.spyOn(f.repo.atomicWalletState!, "update");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const uncertain = {
            getVtxos: vi.fn(async () => {
                await gate;
                return { vtxos: [] };
            }),
            getVirtualTxs: f.indexer.getVirtualTxs,
        };
        const pending = f.journal.reconcile(source, uncertain);
        await vi.waitFor(() => expect(uncertain.getVtxos).toHaveBeenCalledOnce());
        expect((await f.journal.reconcile(source, f.indexer))?.state).toBe("reconciled");
        const receipt = await f.journal.getReceipt(source);
        release();
        expect((await pending)?.state).toBe("unknown");
        expect(await f.journal.getReceipt(source)).toEqual(receipt);
        expect(update).toHaveBeenCalledOnce();
    });

    it("rolls back real SQLite receipt write errors and awaits atomic completion before acknowledging", async () => {
        const db = createNodeSQLExecutor();
        const f = await observationFixture(false, new SQLiteWalletRepository(db, options));
        const before = await f.repo.getWalletState();
        const run = db.run.bind(db);
        const error = new Error("receipt insert failed");
        vi.spyOn(db, "run").mockImplementation(async (sql, params) => {
            if (sql.includes("INSERT OR REPLACE INTO ark_wallet_state")) throw error;
            return run(sql, params);
        });
        await expect(f.journal.reconcile(source, f.indexer)).rejects.toBe(error);
        expect(await f.repo.getWalletState()).toEqual(before);
        vi.restoreAllMocks();
        const update = f.repo.atomicWalletState!.update.bind(f.repo.atomicWalletState);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        f.repo.atomicWalletState!.update = async (fn) => {
            await update(fn);
            await gate;
        };
        let resolved = false;
        const pending = f.journal.reconcile(source, f.indexer).then((r) => {
            resolved = true;
            return r;
        });
        await vi.waitFor(async () => expect(await f.journal.getReceipt(source)).toBeDefined());
        expect(resolved).toBe(false);
        release();
        expect((await pending)?.state).toBe("reconciled");
    });

    it("captures source and provider methods before the single snapshot await", async () => {
        const f = await observationFixture();
        const get = f.repo.getWalletState.bind(f.repo);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const read = vi.spyOn(f.repo, "getWalletState").mockImplementation(async () => {
            await gate;
            return get();
        });
        const mutable = { ...source };
        const pending = f.journal.reconcile(mutable, f.indexer);
        mutable.vout = 99;
        f.indexer.getVtxos = vi.fn().mockRejectedValue(new Error("replaced"));
        f.indexer.getVirtualTxs = vi.fn().mockRejectedValue(new Error("replaced"));
        release();
        expect((await pending)?.state).toBe("reconciled");
        expect(read).toHaveBeenCalledOnce();
        expect(f.indexer.getVtxos).not.toHaveBeenCalled();
        expect(f.indexer.getVirtualTxs).not.toHaveBeenCalled();
        const query = { ...source };
        let resume!: () => void;
        const secondGate = new Promise<void>((resolve) => {
            resume = resolve;
        });
        read.mockImplementationOnce(async () => {
            await secondGate;
            return get();
        });
        const receipt = f.journal.getReceipt(query);
        query.vout = 99;
        resume();
        expect((await receipt)?.source).toEqual(source);
    });
});

describe("NativeExecutionJournal observation", () => {
    it.each(
        (["observe", "reconcile"] as const).flatMap((method) =>
            (["vtxos", "txs"] as const).flatMap((field) =>
                [
                    { current: 99, next: 0, total: 1 },
                    { current: 1, next: 0, total: 0 },
                ].map((page) => ({ method, field, page })),
            ),
        ),
    )(
        "leaves inconsistent $field page $page unknown through $method",
        async ({ method, field, page }) => {
            const f = await observationFixture();
            const indexer = {
                getVtxos: async () => ({ vtxos: f.coins, ...(field === "vtxos" ? { page } : {}) }),
                getVirtualTxs: async () => ({ txs: f.txs, ...(field === "txs" ? { page } : {}) }),
            };
            expect((await f.journal[method](source, indexer))?.state).toBe("unknown");
            expect(await f.journal.getReceipt(source)).toBeUndefined();
            expect(await f.journal.get(source)).toEqual(f.record);
            await expect(f.journal.admit(source, f.request)).rejects.toThrow("occupied");
        },
    );

    it.each(["observe", "reconcile"] as const)(
        "accepts unpaged wire envelopes with page:null through %s",
        async (method) => {
            const f = await observationFixture();
            const coins = { vtxos: f.coins, page: null, authToken: "" };
            const transactions = { txs: f.txs, page: null, authToken: "" };
            const before = structuredClone({ coins, transactions });
            const indexer = {
                getVtxos: vi.fn(async () => coins),
                getVirtualTxs: vi.fn(async () => transactions),
            };
            expect((await f.journal[method](source, indexer as never))?.state).toBe("reconciled");
            expect({ coins, transactions }).toEqual(before);
            expect(await f.journal.get(source)).toEqual(f.record);
            if (method === "reconcile") {
                expect(await f.journal.getReceipt(source)).toBeDefined();
                indexer.getVtxos.mockClear();
                indexer.getVirtualTxs.mockClear();
                expect(
                    (await new NativeExecutionJournal(f.repo).reconcile(source, indexer as never))
                        ?.state,
                ).toBe("reconciled");
                expect(indexer.getVtxos).not.toHaveBeenCalled();
                expect(indexer.getVirtualTxs).not.toHaveBeenCalled();
            } else expect(await f.journal.getReceipt(source)).toBeUndefined();
            await expect(f.journal.admit(source, f.request)).rejects.toThrow("occupied");
        },
    );

    it.each([false, 0, "", {}, []])(
        "keeps malformed non-null pagination %j unknown",
        async (page) => {
            const f = await observationFixture();
            const indexer = {
                getVtxos: vi.fn(async () => ({ vtxos: f.coins, page, authToken: "" })),
                getVirtualTxs: vi.fn(async () => ({ txs: f.txs, page, authToken: "" })),
            };
            expect((await f.journal.reconcile(source, indexer as never))?.state).toBe("unknown");
            expect(await f.journal.getReceipt(source)).toBeUndefined();
        },
    );

    it("reconciles signed CLTV history in any reply order without changing or releasing the slot", async () => {
        const f = await observationFixture();
        f.coins.reverse();
        f.coins[0].isSpent = true;
        f.coins[0].spentBy = "b2".repeat(32);
        const before = await f.repo.getWalletState();
        const result = await f.journal.observe(source, f.indexer);
        expect(result).toEqual({ state: "reconciled", record: f.record });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result?.record.proposal.checkpointTxs)).toBe(true);
        expect(f.indexer.getVtxos).toHaveBeenCalledExactlyOnceWith({
            outpoints: [source, { txid: f.record.operationId, vout: 0 }],
            pageIndex: 0,
            pageSize: 2,
            maxResponseBytes: 4 * 1024 * 1024,
        });
        expect(f.indexer.getVirtualTxs).toHaveBeenCalledExactlyOnceWith(
            [f.tx.checkpoints[0].id, f.record.operationId],
            { pageIndex: 0, pageSize: 2, maxResponseBytes: 4 * 1024 * 1024 },
        );
        expect(await f.repo.getWalletState()).toEqual(before);
        await expect(f.journal.admit(source, f.request)).rejects.toThrow("occupied");
    });

    it("returns absence without RPC and propagates storage or corrupted-slot failures", async () => {
        const repo = sqlite();
        const journal = new NativeExecutionJournal(repo);
        const indexer = { getVtxos: vi.fn(), getVirtualTxs: vi.fn() };
        expect(await journal.observe(source, indexer)).toBeUndefined();
        const error = new Error("storage unavailable");
        vi.spyOn(repo, "getWalletState").mockRejectedValueOnce(error);
        await expect(journal.observe(source, indexer)).rejects.toBe(error);
        await repo.saveWalletState({ settings: { nativeExecutionJournal: { version: 99 } } });
        await expect(journal.observe(source, indexer)).rejects.toThrow();
        expect(indexer.getVtxos).not.toHaveBeenCalled();
        expect(indexer.getVirtualTxs).not.toHaveBeenCalled();
    });

    it("captures source and bound provider methods before storage awaits", async () => {
        const f = await observationFixture();
        const get = f.repo.getWalletState.bind(f.repo);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(f.repo, "getWalletState").mockImplementation(async () => {
            await gate;
            return get();
        });
        const provider = {
            coins: f.coins,
            txs: f.txs,
            async getVtxos() {
                return { vtxos: this.coins };
            },
            async getVirtualTxs() {
                return { txs: this.txs };
            },
        };
        const mutable = { ...source };
        const pending = f.journal.observe(mutable, provider);
        mutable.vout = 99;
        provider.getVtxos = vi.fn().mockRejectedValue(new Error("replaced"));
        provider.getVirtualTxs = vi.fn().mockRejectedValue(new Error("replaced"));
        release();
        expect((await pending)?.state).toBe("reconciled");
        expect(provider.getVtxos).not.toHaveBeenCalled();
        expect(provider.getVirtualTxs).not.toHaveBeenCalled();
    });

    it.each([
        "unspent",
        "foreign ark",
        "foreign checkpoint",
        "source value",
        "source script",
        "payout value",
        "payout script",
        "duplicate coins",
        "unrelated coin",
        "missing coin",
        "malformed coins",
        "duplicate tx",
        "missing tx",
        "foreign tx",
        "oversized tx",
        "malformed tx",
        "rpc coins",
        "rpc tx",
        "unsigned ark",
        "unsigned checkpoint",
        "witness amount",
    ])("returns unknown for %s and never follows a remote spentBy", async (kind) => {
        const f = await observationFixture();
        if (kind === "unspent") f.coins[0].isSpent = false;
        if (kind === "foreign ark") f.coins[0].arkTxId = "b1".repeat(32);
        if (kind === "foreign checkpoint") f.coins[0].spentBy = "b2".repeat(32);
        if (kind === "source value") f.coins[0].value--;
        if (kind === "source script") f.coins[0].script = "51";
        if (kind === "payout value") f.coins[1].value--;
        if (kind === "payout script") f.coins[1].script = "51";
        if (kind === "duplicate coins") f.coins[1] = f.coins[0];
        if (kind === "unrelated coin") f.coins[1].vout = 1;
        if (kind === "missing coin") f.coins.pop();
        if (kind === "malformed coins") f.coins[1].value = Number.NaN;
        if (kind === "duplicate tx") f.txs[1] = f.txs[0];
        if (kind === "missing tx") f.txs.pop();
        if (kind === "foreign tx") f.txs[1] = proposal().arkTx;
        if (kind === "oversized tx") f.txs[1] = "A".repeat(4 * 1024 * 1024 + 4);
        if (kind === "malformed tx") f.txs[1] = "not PSBT";
        if (kind === "rpc coins") f.indexer.getVtxos.mockRejectedValueOnce(new Error("offline"));
        if (kind === "rpc tx") f.indexer.getVirtualTxs.mockRejectedValueOnce(new Error("offline"));
        if (kind === "unsigned ark") f.txs[0] = f.request.arkTx;
        if (kind === "unsigned checkpoint") f.txs[1] = f.request.checkpointTxs[0];
        if (kind === "witness amount") {
            const cp = Transaction.fromPSBT(base64.decode(f.request.checkpointTxs[0]));
            cp.updateInput(0, { witnessUtxo: { ...cp.getInput(0).witnessUtxo!, amount: 49999n } });
            f.txs[1] = base64.encode(cp.toPSBT());
        }
        const before = await f.repo.getWalletState();
        expect(await f.journal.observe(source, f.indexer)).toEqual({
            state: "unknown",
            record: f.record,
        });
        expect(f.indexer.getVtxos).toHaveBeenCalledOnce();
        expect(f.indexer.getVirtualTxs).toHaveBeenCalledExactlyOnceWith(
            [f.tx.checkpoints[0].id, f.record.operationId],
            { pageIndex: 0, pageSize: 2, maxResponseBytes: 4 * 1024 * 1024 },
        );
        expect(await f.repo.getWalletState()).toEqual(before);
        await expect(f.journal.admit(source, f.request)).rejects.toThrow("occupied");
    });

    it.each([63, 64, 65, 66])(
        "rejects malformed %i-byte signatures without verifier truncation",
        async (size) => {
            const f = await observationFixture();
            const bytes = base64.decode(f.txs[0]);
            const signature = f.tx.arkTx.getInput(0).tapScriptSig![0][1];
            const start = hex.encode(bytes).indexOf(hex.encode(signature)) / 2;
            expect(start).toBeGreaterThan(0);
            const changed = new Uint8Array(bytes.length + size - signature.length);
            changed.set(bytes.subarray(0, start - 1));
            changed[start - 1] = size;
            changed.set(signature.subarray(0, Math.min(size, signature.length)), start);
            if (size === 64) changed[start] ^= 1;
            changed.set(bytes.subarray(start + signature.length), start + size);
            f.txs[0] = base64.encode(changed);
            expect((await f.journal.observe(source, f.indexer))?.state).toBe("unknown");
        },
    );

    it("rejects valid signatures from only a subset of the saved policy", async () => {
        const f = await observationFixture();
        const tx = Transaction.fromPSBT(base64.decode(f.request.arkTx));
        tx.signIdx(new Uint8Array(32).fill(7), 0);
        f.txs[0] = base64.encode(tx.toPSBT());
        expect((await f.journal.observe(source, f.indexer))?.state).toBe("unknown");
    });

    it("leaves an unsupported conditional policy unknown even with all signatures", async () => {
        const f = await observationFixture(true);
        expect(f.tx.arkTx.getInput(0).tapScriptSig).toHaveLength(2);
        expect(f.tx.checkpoints[0].getInput(0).tapScriptSig).toHaveLength(2);
        expect((await f.journal.observe(source, f.indexer))?.state).toBe("unknown");
    });

    it.each(["missing", "ambiguous", "remote alternative"])(
        "refuses %s leaf policy instead of trusting remote signers",
        async (kind) => {
            const f = await observationFixture();
            const cp = Transaction.fromPSBT(base64.decode(f.request.checkpointTxs[0]));
            const changed = new Transaction({ version: cp.version, lockTime: cp.lockTime });
            const { tapLeafScript, ...input } = cp.getInput(0);
            changed.addInput({
                ...input,
                tapLeafScript:
                    kind === "missing"
                        ? undefined
                        : kind === "ambiguous"
                          ? [...tapLeafScript!, f.script.leaves[1]]
                          : [f.script.leaves[1]],
            });
            for (let i = 0; i < cp.outputsLength; i++) changed.addOutput(cp.getOutput(i));
            expect(changed.id).toBe(cp.id);
            if (kind === "remote alternative") {
                changed.signIdx(new Uint8Array(32).fill(7), 0);
                f.txs[1] = base64.encode(changed.toPSBT());
            } else {
                const state = (await f.repo.getWalletState())!;
                state.settings!.nativeExecutionJournal.proposal.checkpointTxs[0] = base64.encode(
                    changed.toPSBT(),
                );
                await f.repo.saveWalletState(state);
            }
            expect((await f.journal.observe(source, f.indexer))?.state).toBe("unknown");
        },
    );

    it.each([
        "coin page",
        "transaction page",
        "too many coins",
        "too many transactions",
        "oversized coin reply",
        "synchronous RPC failure",
    ])("bounds public replies: %s", async (kind) => {
        const f = await observationFixture();
        if (kind === "coin page")
            f.indexer.getVtxos.mockResolvedValueOnce({
                vtxos: f.coins,
                page: { current: 0, next: 1, total: 2 },
            } as any);
        if (kind === "transaction page")
            f.indexer.getVirtualTxs.mockResolvedValueOnce({
                txs: f.txs,
                page: { current: 0, next: 1, total: 2 },
            } as any);
        if (kind === "too many coins") f.coins.push(f.coins[0]);
        if (kind === "too many transactions") f.txs.push(f.txs[0]);
        if (kind === "oversized coin reply") f.coins[0].script = "51".repeat(2 * 1024 * 1024);
        if (kind === "synchronous RPC failure")
            f.indexer.getVtxos.mockImplementationOnce(() => {
                throw new Error("synchronous unavailable");
            });
        expect((await f.journal.observe(source, f.indexer))?.state).toBe("unknown");
        expect(f.indexer.getVtxos).toHaveBeenCalledOnce();
        expect(f.indexer.getVirtualTxs).toHaveBeenCalledOnce();
    });
});

describe("NativeExecutionJournal", () => {
    it("stores exact request and derived graph metadata without changing existing wallet state", async () => {
        const repo = sqlite();
        await repo.saveWalletState(initial);
        const journal = new NativeExecutionJournal(repo);
        const request = proposal();
        const record = await journal.admit(source, request);
        const cp = Transaction.fromPSBT(base64.decode(request.checkpointTxs[0]));
        expect(record).toEqual({
            version: 1,
            state: "prepared",
            operationId: request.txid,
            source: {
                ...source,
                script: hex.encode(cp.getInput(0).witnessUtxo!.script),
                value: "50000",
            },
            payout: {
                script: hex.encode(
                    Transaction.fromPSBT(base64.decode(request.arkTx)).getOutput(0).script!,
                ),
                value: "50000",
            },
            proposal: request,
        });
        expect(await journal.get(source)).toEqual(record);
        expect(await journal.get({ ...source, vout: 4 })).toBeUndefined();
        expect(await repo.getWalletState()).toEqual({
            ...initial,
            settings: { ...initial.settings, nativeExecutionJournal: record },
        });
        for (const item of [
            record,
            record.source,
            record.payout,
            record.proposal,
            record.proposal.checkpointTxs,
        ])
            expect(Object.isFrozen(item)).toBe(true);
        expect(Reflect.set(record.source, "value", "1")).toBe(false);
        expect((await journal.get(source))?.source.value).toBe("50000");
    });

    it.each(["SQLite", "IndexedDB", "Realm mock"])(
        "admits only once across instances and reopens %s state",
        async (backend) => {
            const db = createNodeSQLExecutor();
            const name = `journal-reopen-${crypto.randomUUID()}`;
            const realm = createMockRealm({ ArkWalletState: "key" });
            const create = (): WalletRepository =>
                backend === "SQLite"
                    ? new SQLiteWalletRepository(db, options)
                    : backend === "IndexedDB"
                      ? idb(name)
                      : new RealmWalletRepository(realm, options);
            const repo = create();
            await repo.saveWalletState(initial);
            const request = proposal();
            const results = await Promise.allSettled([
                new NativeExecutionJournal(repo).admit(source, request),
                new NativeExecutionJournal(create()).admit(source, request),
            ]);
            expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
            expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
            const reopened = new NativeExecutionJournal(create());
            expect((await reopened.get(source))?.proposal).toEqual(request);
            await expect(reopened.admit(source, request)).rejects.toThrow("occupied");
            const other = { ...source, vout: 4 };
            const changed = graph();
            changed.checkpoints[0].updateInput(0, { index: other.vout });
            changed.arkTx.updateInput(0, { txid: changed.checkpoints[0].id });
            await expect(reopened.admit(other, proposal(changed))).rejects.toThrow("occupied");
        },
    );

    it("captures arguments and capability before awaiting storage and propagates commit failure unchanged", async () => {
        const repo = sqlite();
        const atomic = repo.atomicWalletState!;
        const update = atomic.update.bind(atomic);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const updater = vi.fn();
        atomic.update = async (fn) => {
            await gate;
            await update((state) => {
                updater();
                return fn(state);
            });
        };
        const journal = new NativeExecutionJournal(repo);
        const request = { ...proposal(), checkpointTxs: [...proposal().checkpointTxs] };
        const expected = structuredClone(request);
        const mutableSource = { ...source };
        const pending = journal.admit(mutableSource, request);
        request.arkTx = "bad";
        request.checkpointTxs[0] = "bad";
        mutableSource.vout = 99;
        Object.defineProperty(repo, "atomicWalletState", { value: undefined });
        release();
        expect((await pending).proposal).toEqual(expected);
        expect(updater).toHaveBeenCalledOnce();
        const failure = new Error("commit failed");
        const broken = sqlite();
        broken.atomicWalletState!.update = vi.fn(async () => {
            throw failure;
        });
        const save = vi.spyOn(broken, "saveWalletState");
        await expect(new NativeExecutionJournal(broken).admit(source, proposal())).rejects.toBe(
            failure,
        );
        expect(save).not.toHaveBeenCalled();
        expect(await broken.getWalletState()).toBeNull();
    });

    it.each([
        "memory",
        "sqlite default",
        "sqlite unasserted",
        "idb unasserted",
        "realm unasserted",
        "unknown version",
    ])("rejects a nonpersistent capability: %s", async (kind) => {
        const repo =
            kind === "memory"
                ? new InMemoryWalletRepository()
                : kind === "sqlite default"
                  ? new SQLiteWalletRepository(createNodeSQLExecutor(), {
                        persistentWalletState: true,
                    })
                  : kind === "sqlite unasserted"
                    ? new SQLiteWalletRepository(createNodeSQLExecutor(), {
                          walletStateTransactions: true,
                      })
                    : kind === "idb unasserted"
                      ? idb(undefined, false)
                      : kind === "realm unasserted"
                        ? new RealmWalletRepository(createMockRealm({ ArkWalletState: "key" }))
                        : sqlite();
        if (kind === "unknown version")
            Object.defineProperty(repo, "atomicWalletState", {
                value: { version: 2, persistent: true, update: vi.fn() },
            });
        const save = vi.spyOn(repo, "saveWalletState");
        await expect(async () =>
            new NativeExecutionJournal(repo).admit(source, proposal()),
        ).rejects.toThrow("persistent");
        expect(save).not.toHaveBeenCalled();
    });

    it.each([
        "source",
        "ark id",
        "ark input",
        "checkpoint count",
        "checkpoint input",
        "link id",
        "link index",
        "link script",
        "link amount",
        "checkpoint principal",
        "payout principal",
        "extra payment",
        "nonzero anchor",
        "unknown extension",
    ])("rejects invalid graph: %s before storage", async (kind) => {
        const tx = graph();
        const claimed = { ...source };
        if (kind === "source") claimed.vout++;
        if (kind === "ark input") tx.arkTx.addInput({ ...tx.arkTx.getInput(0), index: 1 });
        if (kind === "checkpoint count") tx.checkpoints.push(tx.checkpoints[0]);
        if (kind === "checkpoint input")
            tx.checkpoints[0].addInput({ ...tx.checkpoints[0].getInput(0), index: 4 });
        if (kind === "link id") tx.arkTx.updateInput(0, { txid: "01".repeat(32) });
        if (kind === "link index") tx.arkTx.updateInput(0, { index: 1 });
        if (kind === "link script") {
            tx.checkpoints[0].updateOutput(0, {
                script: tx.checkpoints[0].getInput(0).witnessUtxo!.script,
            });
            tx.arkTx.updateInput(0, { txid: tx.checkpoints[0].id });
        }
        if (kind === "link amount")
            tx.arkTx.updateInput(0, {
                witnessUtxo: { ...tx.arkTx.getInput(0).witnessUtxo!, amount: 49999n },
            });
        if (kind === "checkpoint principal") {
            tx.checkpoints[0].updateOutput(0, { amount: 49999n });
            tx.arkTx.updateInput(0, {
                txid: tx.checkpoints[0].id,
                witnessUtxo: { ...tx.arkTx.getInput(0).witnessUtxo!, amount: 49999n },
            });
        }
        if (kind === "payout principal") tx.arkTx.updateOutput(0, { amount: 49999n });
        if (kind === "extra payment") tx.arkTx.addOutput(tx.arkTx.getOutput(0));
        if (kind === "nonzero anchor") tx.arkTx.updateOutput(1, { amount: 1n });
        if (kind === "unknown extension")
            tx.arkTx.addOutput({
                amount: 0n,
                script: Extension.create([new UnknownPacket(99, new Uint8Array([1]))]).serialize(),
            });
        const request = { ...proposal(tx) };
        if (kind === "ark id") request.txid = "02".repeat(32);
        const repo = sqlite();
        const update = vi.spyOn(repo.atomicWalletState!, "update");
        await expect(new NativeExecutionJournal(repo).admit(claimed, request)).rejects.toThrow();
        expect(update).not.toHaveBeenCalled();
    });

    it("accepts a zero-value emulator extension and rejects a checkpoint extension", async () => {
        const tx = graph();
        const output = {
            amount: 0n,
            script: Extension.create([
                EmulatorPacket.create([{ vin: 0, script: new Uint8Array([0x51]) }]),
            ]).serialize(),
        };
        tx.arkTx.addOutput(output);
        await expect(
            new NativeExecutionJournal(sqlite()).admit(source, proposal(tx)),
        ).resolves.toMatchObject({ state: "prepared" });
        tx.checkpoints[0].addOutput(output);
        tx.arkTx.updateInput(0, { txid: tx.checkpoints[0].id });
        await expect(
            new NativeExecutionJournal(sqlite()).admit(source, proposal(tx)),
        ).rejects.toThrow();
    });

    it.each(["base64", "oversized", "aggregate", "bad outpoint"])(
        "rejects bounded input format %s before PSBT decoding",
        async (kind) => {
            const request = { ...proposal(), checkpointTxs: [...proposal().checkpointTxs] };
            const claimed = { ...source };
            if (kind === "base64") request.arkTx = "!!!!";
            if (kind === "oversized") request.arkTx = "A".repeat(4 * 1024 * 1024 + 4);
            if (kind === "aggregate") {
                request.arkTx = "A".repeat(2 * 1024 * 1024);
                request.checkpointTxs[0] = request.arkTx;
            }
            if (kind === "bad outpoint") claimed.vout = -1;
            const decode = vi.spyOn(Transaction, "fromPSBT");
            await expect(
                new NativeExecutionJournal(sqlite()).admit(claimed, request),
            ).rejects.toThrow();
            expect(decode).not.toHaveBeenCalled();
        },
    );

    it("checks the JSON budget boundary before decoding either PSBT", async () => {
        const request = { ...proposal(), arkTx: "" };
        const available = 4 * 1024 * 1024 - JSON.stringify(request).length;
        request.arkTx = "A".repeat(Math.floor(available / 4) * 4);
        expect(JSON.stringify(request).length).toBeLessThanOrEqual(4 * 1024 * 1024);
        const decode = vi.spyOn(Transaction, "fromPSBT");
        await expect(new NativeExecutionJournal(sqlite()).admit(source, request)).rejects.toThrow();
        expect(decode).toHaveBeenCalledOnce();
        decode.mockClear();
        request.arkTx += "AAAA";
        expect(JSON.stringify(request).length).toBeGreaterThan(4 * 1024 * 1024);
        await expect(new NativeExecutionJournal(sqlite()).admit(source, request)).rejects.toThrow(
            "budget",
        );
        expect(decode).not.toHaveBeenCalled();
    });

    it.each([
        null,
        {},
        { version: 2 },
        { version: 1, state: "complete" },
        { version: 1, state: "prepared", proposal: {} },
    ])(
        "fails closed for corrupt stored records even when the requested source differs: %j",
        async (record) => {
            const repo = sqlite();
            await repo.saveWalletState({
                ...initial,
                settings: { ...initial.settings, nativeExecutionJournal: record },
            });
            const journal = new NativeExecutionJournal(repo);
            await expect(journal.get({ ...source, vout: 99 })).rejects.toThrow();
            await expect(journal.admit(source, proposal())).rejects.toThrow();
            expect((await repo.getWalletState())?.settings?.nativeExecutionJournal).toEqual(record);
        },
    );

    it("rejects forged stored metadata and unknown fields without discarding the slot", async () => {
        const repo = sqlite();
        const journal = new NativeExecutionJournal(repo);
        await journal.admit(source, proposal());
        const state = (await repo.getWalletState())!;
        state.settings!.nativeExecutionJournal.payout.value = "1";
        await repo.saveWalletState(state);
        await expect(journal.get(source)).rejects.toThrow();
        state.settings!.nativeExecutionJournal.payout.value = "50000";
        state.settings!.nativeExecutionJournal.extra = true;
        await repo.saveWalletState(state);
        await expect(journal.get(source)).rejects.toThrow();
    });

    it("returns absence without initializing or writing a journal slot", async () => {
        const repo = sqlite();
        const journal = new NativeExecutionJournal(repo);
        expect(await journal.get(source)).toBeUndefined();
        expect(await repo.getWalletState()).toBeNull();
    });

    it("waits for atomic completion and retries after a real SQLite write rollback", async () => {
        const db = createNodeSQLExecutor();
        const repo = new SQLiteWalletRepository(db, options);
        await repo.saveWalletState(initial);
        const failure = new Error("SQLite write failure");
        const run = db.run.bind(db);
        vi.spyOn(db, "run").mockImplementation(async (sql, params) => {
            if (sql.includes("INSERT OR REPLACE INTO ark_wallet_state")) throw failure;
            return run(sql, params);
        });
        const journal = new NativeExecutionJournal(repo);
        await expect(journal.admit(source, proposal())).rejects.toBe(failure);
        expect(await repo.getWalletState()).toEqual(initial);
        vi.restoreAllMocks();
        const update = repo.atomicWalletState!.update.bind(repo.atomicWalletState);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        repo.atomicWalletState!.update = async (fn) => {
            await update(fn);
            await gate;
        };
        let resolved = false;
        const pending = journal.admit(source, proposal()).then((record) => {
            resolved = true;
            return record;
        });
        await vi.waitFor(async () =>
            expect((await repo.getWalletState())?.settings?.nativeExecutionJournal).toBeDefined(),
        );
        expect(resolved).toBe(false);
        release();
        expect((await pending).state).toBe("prepared");
    });

    it("captures the requested source before a pending get and returns a fresh immutable copy", async () => {
        const repo = sqlite();
        const journal = new NativeExecutionJournal(repo);
        const admitted = await journal.admit(source, proposal());
        const get = repo.getWalletState.bind(repo);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(repo, "getWalletState").mockImplementation(async () => {
            await gate;
            return get();
        });
        const mutable = { ...source };
        const pending = journal.get(mutable);
        mutable.vout = 99;
        release();
        const record = await pending;
        expect(record).toEqual(admitted);
        expect(record).not.toBe(admitted);
        expect(Object.isFrozen(record?.proposal.checkpointTxs)).toBe(true);
    });
});
