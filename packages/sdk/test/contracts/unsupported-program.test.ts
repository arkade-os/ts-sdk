import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    ArkadeContractHandler,
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    UnannotatableInputError,
    UnsupportedProgramVersionError,
    type Contract,
    type IndexerProvider,
} from "../../src";
import { collectVtxos } from "../../src/repositories/walletRepository";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
} from "./helpers";

// Not 144 blocks: that is byte-for-byte the default VTXO script.
function multisigProgram(exitBlocks = 150n): arkade.Program {
    return {
        version: 1,
        params: [
            { name: "server", type: "pubkey" },
            { name: "user", type: "pubkey" },
        ],
        functions: {
            cooperative: { tapscript: { signers: ["$user", "$server"] } },
            exit: {
                tapscript: { signers: ["$user"], csv: { type: "blocks", value: exitBlocks } },
            },
        },
    };
}

function v1Params(exitBlocks?: bigint): Record<string, string> {
    return ArkadeContractHandler.serializeParams({
        program: multisigProgram(exitBlocks),
        args: { server: TEST_SERVER_PUB_KEY, user: TEST_PUB_KEY },
        serverKey: TEST_SERVER_PUB_KEY,
        userKey: TEST_PUB_KEY,
    });
}

/** The row an SDK that wrote Program v0 left behind; v0 and v1 lock the same script here. */
function v0Params(): Record<string, string> {
    const params = v1Params();
    const program = JSON.parse(params.program);
    return { ...params, program: JSON.stringify({ ...program, version: 0 }) };
}

const SCRIPT = hex.encode(ArkadeContractHandler.createScript(v1Params()).pkScript);

function v0Row(overrides: Partial<Contract> = {}): Contract {
    return {
        type: "arkade",
        params: v0Params(),
        script: SCRIPT,
        address: "ark1v0",
        state: "active",
        createdAt: 1,
        label: "old",
        metadata: { kind: "old-kind", genericallySpendable: false },
        ...overrides,
    };
}

describe("Program v0 rows", () => {
    let repository: InMemoryContractRepository;
    let walletRepository: InMemoryWalletRepository;
    let indexer: IndexerProvider;
    let manager: ContractManager | undefined;
    let warn: ReturnType<typeof vi.spyOn>;
    const vtxos = [
        createMockVtxo({ txid: "aa".repeat(32), script: SCRIPT, value: 1000 }),
        createMockVtxo({ txid: "bb".repeat(32), script: TEST_DEFAULT_SCRIPT, value: 2000 }),
    ];

    beforeEach(() => {
        repository = new InMemoryContractRepository();
        walletRepository = new InMemoryWalletRepository();
        indexer = createMockIndexerProvider();
        (indexer.getVtxos as ReturnType<typeof vi.fn>).mockImplementation(
            async (opts: { scripts?: string[] }) => ({
                vtxos: vtxos.filter((v) => !opts?.scripts || opts.scripts.includes(v.script)),
            }),
        );
        warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(async () => {
        await manager?.dispose();
        manager = undefined;
        warn.mockRestore();
    });

    async function seededManager(row: Contract = v0Row()): Promise<ContractManager> {
        await repository.saveContract(row);
        manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: repository,
            walletRepository,
        });
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "ark1default",
        });
        return manager;
    }

    const unsupportedWarnings = () =>
        warn.mock.calls.filter((args: unknown[]) =>
            String(args[0]).includes("unsupported program version"),
        );

    it("throws the typed error for a v0 artifact", () => {
        const artifact = { ...JSON.parse(v1Params().program), version: 0 };
        expect(() => arkade.parseArtifact(artifact)).toThrow(UnsupportedProgramVersionError);
        try {
            arkade.parseArtifact(artifact);
        } catch (err) {
            expect((err as UnsupportedProgramVersionError).version).toBe(0);
        }
    });

    it("skips a v0 row without degrading sync, and warns once", async () => {
        const m = await seededManager();

        await m.refreshVtxos();
        await m.refreshVtxos();

        expect(m.getSyncState().mode).toBe("online");
        expect((await collectVtxos(walletRepository, "ark1default")).map((v) => v.txid)).toEqual([
            vtxos[1].txid,
        ]);
        expect(await collectVtxos(walletRepository, "ark1v0")).toEqual([]);
        expect((await m.getUnsupportedContracts()).map((c) => c.script)).toEqual([SCRIPT]);
        expect(unsupportedWarnings()).toHaveLength(1);
    });

    it("reports a v0 row before any sync", async () => {
        await repository.saveContract(v0Row());
        manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: repository,
            walletRepository,
        });

        expect(await manager.getUnsupportedContracts()).toEqual([v0Row()]);
    });

    it("still degrades sync for a row that fails for another reason", async () => {
        const m = await seededManager(v0Row({ params: { ...v1Params(), program: "{" } }));

        await m.refreshVtxos();

        expect(m.getSyncState().mode).not.toBe("online");
        expect(await m.getUnsupportedContracts()).toEqual([]);
    });

    it("refuses to spend a v0 row's vtxo", async () => {
        const m = await seededManager();
        await m.refreshVtxos();

        await expect(
            m.assertAnnotatable([{ txid: vtxos[0].txid, vout: 0, script: SCRIPT }]),
        ).rejects.toThrow(UnannotatableInputError);
    });

    it("replaces a v0 row created over with current params", async () => {
        const retained = v0Row({ state: "inactive", watch: "retained" });
        const m = await seededManager(retained);
        await m.refreshVtxos({ includeInactive: true });

        const replaced = await m.createContract({
            type: "arkade",
            params: v1Params(),
            script: SCRIPT,
            address: "ark1v0",
            label: "new",
            metadata: { kind: "new-kind", genericallySpendable: false },
        });

        expect(replaced).toEqual({
            ...retained,
            params: v1Params(),
            label: "new",
            metadata: { kind: "new-kind", genericallySpendable: false },
        });
        expect(await m.getContracts({ script: SCRIPT })).toEqual([replaced]);
        expect(await m.getUnsupportedContracts()).toEqual([]);
        expect((await collectVtxos(walletRepository, "ark1v0")).map((v) => v.txid)).toEqual([
            vtxos[0].txid,
        ]);
        await expect(
            m.assertAnnotatable([{ txid: vtxos[0].txid, vout: 0, script: SCRIPT }]),
        ).resolves.toBeUndefined();
    });

    it("keeps the row's label and metadata when the caller passes none", async () => {
        const row = v0Row({ metadata: { kind: "app", genericallySpendable: true } });
        const m = await seededManager(row);

        // the shape `ArkadeContract.register()` sends without options
        const replaced = await m.createContract({
            type: "arkade",
            params: v1Params(),
            script: SCRIPT,
            address: "ark1v0",
            label: undefined,
            metadata: undefined,
        });

        expect(replaced).toEqual({ ...row, params: v1Params() });
    });

    it("keeps the first writer's closed generic-spend gate on replacement", async () => {
        const m = await seededManager();

        const replaced = await m.createContract({
            type: "arkade",
            params: v1Params(),
            script: SCRIPT,
            address: "ark1v0",
            metadata: { genericallySpendable: true },
        });

        expect(replaced.metadata).toEqual({ genericallySpendable: false });
    });

    it("rejects params that lock a different script and keeps the v0 row", async () => {
        const m = await seededManager();

        await expect(
            m.createContract({
                type: "arkade",
                params: v1Params(151n),
                script: SCRIPT,
                address: "ark1v0",
            }),
        ).rejects.toThrow(/mismatch/);
        expect(await m.getContracts({ script: SCRIPT })).toEqual([v0Row()]);
    });

    it("leaves a healthy row untouched on a repeat create", async () => {
        const m = await seededManager(v0Row({ params: v1Params() }));
        const save = vi.spyOn(repository, "saveContract");

        const result = await m.createContract({
            type: "arkade",
            params: v1Params(),
            script: SCRIPT,
            address: "ark1v0",
            label: "new",
        });

        expect(result).toEqual(v0Row({ params: v1Params() }));
        expect(save).not.toHaveBeenCalled();
    });
});
