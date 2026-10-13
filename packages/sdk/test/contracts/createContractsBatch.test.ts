import { beforeEach, describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    DefaultContractHandler,
    DefaultVtxo,
    type IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import type { ContractRepository } from "../../src/repositories";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    TEST_DELEGATE_PUB_KEY,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
} from "./helpers";

const scriptFor = (pubKey: Uint8Array) => {
    const s = new DefaultVtxo.Script({
        pubKey,
        serverPubKey: TEST_SERVER_PUB_KEY,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    });
    return {
        script: hex.encode(s.pkScript),
        params: DefaultContractHandler.serializeParams({
            pubKey,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
        }),
    };
};

/** `createContract` hydrates per row, so N covenants cost N round trips. */
describe("ContractManager.createContracts", () => {
    let manager: ContractManager;
    let indexer: IndexerProvider;
    let repository: ContractRepository;

    const a = scriptFor(TEST_PUB_KEY);
    const b = scriptFor(TEST_DELEGATE_PUB_KEY);

    beforeEach(async () => {
        indexer = createMockIndexerProvider();
        repository = new InMemoryContractRepository();
        manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: repository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 1000, reconnectDelayMs: 500 },
        });
    });

    it("registers every contract in the set", async () => {
        const contracts = await manager.createContracts!([
            { type: "default", params: a.params, script: a.script, address: "addr-a" },
            { type: "default", params: b.params, script: b.script, address: "addr-b" },
        ]);

        expect(contracts.map((c) => c.script).sort()).toEqual([a.script, b.script].sort());
        for (const c of contracts) expect(c.state).toBe("active");
        expect((await manager.getContracts()).map((c) => c.script).sort()).toEqual(
            [a.script, b.script].sort(),
        );
    });

    it("hydrates the whole set in fewer indexer calls than one-at-a-time", async () => {
        const rows = [
            { type: "default", params: a.params, script: a.script, address: "addr-a" },
            { type: "default", params: b.params, script: b.script, address: "addr-b" },
        ];

        (indexer.getVtxos as any).mockClear();
        await manager.createContracts!(rows);
        const batched = (indexer.getVtxos as any).mock.calls.length;

        const sequentialIndexer = createMockIndexerProvider();
        const sequential = await ContractManager.create({
            indexerProvider: sequentialIndexer,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 1000, reconnectDelayMs: 500 },
        });
        (sequentialIndexer.getVtxos as any).mockClear();
        for (const row of rows) await sequential.createContract(row);
        const oneAtATime = (sequentialIndexer.getVtxos as any).mock.calls.length;

        // exact, not `>`: N−1 calls would satisfy a comparison and save nothing
        expect(batched).toBe(1);
        expect(oneAtATime).toBe(rows.length);
    });

    it("watches what it already persisted when a later row fails", async () => {
        const failing = new InMemoryContractRepository();
        const save = failing.saveContract.bind(failing);
        failing.saveContract = async (c) => {
            if (c.script === b.script) throw new Error("disk full");
            return save(c);
        };
        const m = await ContractManager.create({
            indexerProvider: createMockIndexerProvider(),
            contractRepository: failing,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 1000, reconnectDelayMs: 500 },
        });
        const rows = [
            { type: "default", params: a.params, script: a.script, address: "addr-a" },
            { type: "default", params: b.params, script: b.script, address: "addr-b" },
        ];

        await expect(m.createContracts!(rows)).rejects.toThrow("disk full");

        const watched = (m as any).watcher.getAllContracts().map((c: any) => c.script);
        expect(watched).toEqual([a.script]);
        expect((await m.getContracts()).map((c) => c.script)).toEqual([a.script]);

        await expect(m.createContracts!(rows)).rejects.toThrow("disk full");
        expect((m as any).watcher.getAllContracts().map((c: any) => c.script)).toEqual([a.script]);
    });

    it("is a no-op for an empty set", async () => {
        (indexer.getVtxos as any).mockClear();
        expect(await manager.createContracts!([])).toEqual([]);
        expect((indexer.getVtxos as any).mock.calls.length).toBe(0);
    });
});
