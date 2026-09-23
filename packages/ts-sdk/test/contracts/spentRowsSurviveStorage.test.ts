import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaprootControlBlock } from "@scure/btc-signer";
import {
    type Contract,
    type ExtendedVirtualCoin,
    IndexedDBWalletRepository,
    InMemoryWalletRepository,
    type TapLeafScript,
} from "../../src";
import { SQLiteWalletRepository } from "../../src/repositories/sqlite/walletRepository";
import type { WalletRepository } from "../../src/repositories";
import {
    getVtxosForContract,
    resetRecordedSpends,
    saveVtxosForContract,
} from "../../src/contracts/vtxoOwnership";
import { createMockSQLExecutor } from "../helpers/mockSqlExecutor";
import { TEST_DEFAULT_SCRIPT } from "./helpers";

const CHECKPOINT = "cc".repeat(32);
const ARK_TX = "dd".repeat(32);
const COMMITMENT = "ee".repeat(32);

const contract: Pick<Contract, "script" | "address"> = {
    script: TEST_DEFAULT_SCRIPT,
    address: "contract-address",
};

function tapLeaf(): TapLeafScript {
    const controlBlock = TaprootControlBlock.decode(new Uint8Array([0xc0, ...new Uint8Array(32)]));
    return [controlBlock, new Uint8Array(20).fill(2)];
}

/** A deposit the sync has already seen spent. */
const spentDeposit = (): ExtendedVirtualCoin => ({
    txid: "ab".repeat(32),
    vout: 0,
    value: 10_000,
    status: { confirmed: true },
    virtualStatus: { state: "spent" },
    createdAt: new Date("2024-01-15T12:00:00Z"),
    isUnrolled: false,
    isSpent: true,
    spentBy: CHECKPOINT,
    arkTxId: ARK_TX,
    script: TEST_DEFAULT_SCRIPT,
    forfeitTapLeafScript: tapLeaf(),
    intentTapLeafScript: tapLeaf(),
    tapTree: new Uint8Array(32).fill(3),
});

const backends: { name: string; make: () => WalletRepository }[] = [
    { name: "InMemoryWalletRepository", make: () => new InMemoryWalletRepository() },
    { name: "IndexedDBWalletRepository", make: () => new IndexedDBWalletRepository() },
    {
        name: "SQLiteWalletRepository",
        make: () => new SQLiteWalletRepository(createMockSQLExecutor()),
    },
];

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

/** Let queued microtasks run, so a chain step has had a chance to start. */
const flush = async (turns = 8) => {
    for (let i = 0; i < turns; i++) await Promise.resolve();
};

/**
 * `getContractsWithVtxos` delegates straight to `getVtxosForContract`, so this
 * is the read behind every consumer asking a contract what became of its
 * deposits — and it fails silently: a backend that pruned spent rows, or dropped
 * their txids in its serializer, leaves them finding nothing, suite still green.
 */
describe.each(backends)("spent rows survive $name", ({ make }) => {
    let repository: WalletRepository;

    beforeEach(() => {
        repository = make();
    });

    afterEach(async () => {
        await repository?.clear();
        await repository?.[Symbol.asyncDispose]();
    });

    it("returns the spent deposit, carrying both halves of its spend", async () => {
        await saveVtxosForContract(repository, contract, [spentDeposit()]);

        const vtxos = await getVtxosForContract(repository, contract);

        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({
            txid: "ab".repeat(32),
            vout: 0,
            isSpent: true,
            spentBy: CHECKPOINT,
            arkTxId: ARK_TX,
        });
    });

    it("keeps the spend when a stale sync re-reports the row unspent", async () => {
        await saveVtxosForContract(repository, contract, [spentDeposit()]);
        const stale: ExtendedVirtualCoin = {
            ...spentDeposit(),
            virtualStatus: { state: "settled" },
            isSpent: false,
            spentBy: "",
            arkTxId: undefined,
        };

        await saveVtxosForContract(repository, contract, [stale]);

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({
            isSpent: true,
            spentBy: CHECKPOINT,
            arkTxId: ARK_TX,
        });
    });

    // `updateDbAfterSettle` records a settle-spent input with `settledBy` alone.
    it("keeps a settle-spent row when a stale sync re-reports it unspent", async () => {
        const settled: ExtendedVirtualCoin = {
            ...spentDeposit(),
            spentBy: "",
            arkTxId: undefined,
            settledBy: COMMITMENT,
        };
        await saveVtxosForContract(repository, contract, [settled]);

        await saveVtxosForContract(repository, contract, [
            { ...settled, virtualStatus: { state: "settled" }, isSpent: false, settledBy: "" },
        ]);

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({ isSpent: true, settledBy: COMMITMENT });
    });

    // A sync for a fully-spent contract writes an all-spent batch, which may
    // carry none of the provenance the pin is keyed on.
    it("keeps the spend when an all-spent sync strips its provenance first", async () => {
        await saveVtxosForContract(repository, contract, [spentDeposit()]);
        const bare = { ...spentDeposit(), spentBy: "", arkTxId: undefined, settledBy: "" };

        await saveVtxosForContract(repository, contract, [bare]);
        await saveVtxosForContract(repository, contract, [
            { ...bare, virtualStatus: { state: "settled" } as const, isSpent: false },
        ]);

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({ isSpent: true, spentBy: CHECKPOINT, arkTxId: ARK_TX });
    });

    it("fills missing provenance when the indexer confirms the spend", async () => {
        const other: ExtendedVirtualCoin = {
            ...spentDeposit(),
            txid: "ef".repeat(32),
            virtualStatus: { state: "settled" },
            isSpent: false,
            spentBy: "",
            arkTxId: undefined,
        };
        await saveVtxosForContract(repository, contract, [spentDeposit(), other]);

        await saveVtxosForContract(repository, contract, [
            { ...spentDeposit(), spentBy: "", arkTxId: undefined },
            other,
        ]);

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(2);
        expect(vtxos.find((v) => v.txid === "ab".repeat(32))).toMatchObject({
            isSpent: true,
            spentBy: CHECKPOINT,
            arkTxId: ARK_TX,
        });
        expect(vtxos.find((v) => v.txid === "ef".repeat(32))?.isSpent).toBe(false);
    });

    const staleRow = (): ExtendedVirtualCoin => ({
        ...spentDeposit(),
        virtualStatus: { state: "settled" },
        isSpent: false,
        spentBy: "",
        arkTxId: undefined,
    });

    it("lets the indexer correct the spend once the record outlives its TTL", async () => {
        const now = vi.spyOn(Date, "now");
        try {
            now.mockReturnValue(1_000_000);
            await saveVtxosForContract(repository, contract, [spentDeposit()]);
            now.mockReturnValue(1_000_000 + 60_000);
            await saveVtxosForContract(repository, contract, [staleRow()]);
        } finally {
            now.mockRestore();
        }

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]?.isSpent).toBe(false);
        // Provenance must go too: `hasTerminalSpend` hides on it alone.
        expect(vtxos[0]?.spentBy).toBeFalsy();
        expect(vtxos[0]?.arkTxId).toBeFalsy();
    });

    it("lets the indexer correct a spend recorded before a restart", async () => {
        await saveVtxosForContract(repository, contract, [spentDeposit()]);
        // A restart keeps storage but loses the records; the row must not stay pinned.
        resetRecordedSpends(repository);

        await saveVtxosForContract(repository, contract, [staleRow()]);

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]?.isSpent).toBe(false);
        expect(vtxos[0]?.spentBy).toBeFalsy();
    });

    it("keeps the spent row alongside an unspent one at the same script", async () => {
        const unspent: ExtendedVirtualCoin = {
            ...spentDeposit(),
            txid: "ef".repeat(32),
            virtualStatus: { state: "settled" },
            isSpent: false,
            spentBy: "",
            arkTxId: undefined,
        };
        await saveVtxosForContract(repository, contract, [spentDeposit(), unspent]);

        const vtxos = await getVtxosForContract(repository, contract);

        expect(vtxos.map((v) => v.txid).sort()).toEqual(["ab".repeat(32), "ef".repeat(32)].sort());
        expect(vtxos.find((v) => v.txid === "ab".repeat(32))?.spentBy).toBe(CHECKPOINT);
    });

    /**
     * The guard is read before its write, so a batch read *before* a spend
     * registered could still land *after* it and undo the spend — the poll that
     * overtakes a send. Both writers are in this thread and both write through
     * `saveVtxosForContract`, so ordering the guard-and-write section is what
     * closes it; this parks the first write to hold that interleaving open.
     */
    it("does not let a write already in flight land on top of a newer spend", async () => {
        const held = deferred();
        const realSave = repository.saveVtxos.bind(repository);
        let first = true;
        repository.saveVtxos = async (address, vtxos) => {
            if (first) {
                first = false;
                await held.promise;
            }
            return realSave(address, vtxos);
        };

        // A poll's view, taken before the send: this outpoint reads unspent.
        const poll = saveVtxosForContract(repository, contract, [staleRow()]);
        await flush();

        // The send overtakes it while that write is still parked.
        const send = saveVtxosForContract(repository, contract, [spentDeposit()]);

        held.resolve();
        await Promise.all([poll, send]);

        const vtxos = await getVtxosForContract(repository, contract);
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]?.isSpent).toBe(true);
        expect(vtxos[0]?.spentBy).toBe(CHECKPOINT);
    });
});
