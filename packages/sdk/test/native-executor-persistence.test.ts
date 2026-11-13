import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64, hex } from "@scure/base";
import {
    arkade,
    ContractManager,
    CSVMultisigTapscript,
    networks,
    RestEmulatorProvider,
    SingleKey,
    Transaction,
    type ArkadeInfo,
    type IWallet,
} from "../src";
import {
    SQLiteContractRepository,
    SQLiteWalletRepository,
    type SQLExecutor,
} from "../src/repositories/sqlite";
import artifactJson from "./proof/native-executor/timed-savings.json";
import { createMockIndexerProvider, TEST_PUB_KEY, TEST_SERVER_PUB_KEY } from "./contracts/helpers";

const artifact = artifactJson as arkade.ContractArtifact;
const bindings = {
    owner: hex.encode(TEST_PUB_KEY),
    payout: "11".repeat(32),
    releaseAt: hex.encode(arkade.BigNum.encode(1_700_000_000n)),
    exitSequence: hex.encode(arkade.BigNum.encode(144n)),
};
const document = {
    format: "delegateed-template/v1",
    type: "offchain",
    inputs: [
        {
            name: "funds",
            contract: { definition: artifact, arguments: bindings },
            spend: { function: "release", leaf: "release" },
        },
    ],
    outputs: [
        {
            name: "payout",
            index: 0,
            value: { from: "funds" },
            locking: `5120${bindings.payout}`,
        },
    ],
    packets: { output_index: 1 },
};

describe("NativeExecutor with existing SQLite contracts", () => {
    const directory = mkdtempSync(join(tmpdir(), "ark-native-persistence-"));
    const file = join(directory, "wallet.sqlite");
    let db: DatabaseSync | undefined;
    let manager: ContractManager | undefined;

    async function close() {
        await manager?.dispose();
        manager = undefined;
        db?.close();
        db = undefined;
    }

    afterEach(async () => {
        await close();
        unlinkSync(file);
    });

    afterAll(() => rmdirSync(directory));

    async function open(
        serverKey = TEST_SERVER_PUB_KEY,
        emulatorKey = TEST_PUB_KEY,
        identity = SingleKey.fromHex("01".repeat(32)),
        exitDelay = 144n,
    ) {
        db = new DatabaseSync(file);
        const sql: SQLExecutor = {
            run: async (query, params) => {
                db!.prepare(query).run(...((params ?? []) as []));
            },
            get: async (query, params) =>
                db!.prepare(query).get(...((params ?? []) as [])) as never,
            all: async (query, params) =>
                db!.prepare(query).all(...((params ?? []) as [])) as never,
        };
        const indexer = createMockIndexerProvider();
        manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: new SQLiteContractRepository(sql),
            walletRepository: new SQLiteWalletRepository(sql),
        });
        const client = await arkade.Arkade.connect({
            arkade: {
                getInfo: async () =>
                    ({
                        signerPubkey: `02${hex.encode(serverKey)}`,
                        unilateralExitDelay: exitDelay,
                        checkpointTapscript: hex.encode(
                            CSVMultisigTapscript.encode({
                                timelock: { type: "blocks", value: 10n },
                                pubkeys: [serverKey],
                            }).script,
                        ),
                    }) as ArkadeInfo,
            },
            emulator: new RestEmulatorProvider("http://unused.invalid"),
            emulatorPubkey: `02${hex.encode(emulatorKey)}`,
            identity,
            network: networks.regtest,
            indexer,
            contractManager: manager,
        });
        const wallet = { getContractManager: async () => manager!, send: vi.fn() };
        return {
            client,
            wallet,
            indexer,
            native: new arkade.NativeExecutor(client, wallet as unknown as IWallet),
        };
    }

    it("captures queued receipt callbacks and recovers the native queue after storage failure", async () => {
        const session = await open();
        const execution = await session.native.importTemplate(document);
        const source = new Transaction();
        source.addInput({ txid: "99".repeat(32), index: 0 });
        source.addOutput({ script: execution.contract.pkScript, amount: 50_000n });
        const coin = {
            txid: source.id,
            vout: 0,
            value: 50_000,
            isSpent: false,
            isUnrolled: false,
            createdAt: new Date(0),
            script: hex.encode(execution.contract.pkScript),
            status: { confirmed: false },
        };
        vi.spyOn(execution.contract, "getUtxos").mockResolvedValue([coin]);
        vi.spyOn(manager!, "refreshOutpoints").mockResolvedValue(undefined);
        vi.spyOn(manager!, "refreshVtxos").mockResolvedValue(undefined);
        vi.mocked(session.indexer.getVirtualTxs).mockResolvedValue({
            txs: [base64.encode(source.toPSBT())],
        });
        const submit = vi
            .spyOn(session.client.emulator!, "submitTx")
            .mockImplementation(async (arkTx, checkpointTxs) => ({
                signedArkTx: arkTx,
                signedCheckpointTxs: checkpointTxs,
            }));
        const failure = new Error("receipt write failed");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const firstReceipt = vi.fn(async () => {
            await gate;
            throw failure;
        });
        const failed = expect(
            session.native.execute(execution, coin, {
                beforeEmulatorSubmit: firstReceipt,
            }),
        ).rejects.toBe(failure);
        await vi.waitFor(() => expect(firstReceipt).toHaveBeenCalledOnce());
        expect(submit).not.toHaveBeenCalled();
        const receipt = vi.fn((_proposal: arkade.EmulatorSubmitProposal) => {
            expect(submit).not.toHaveBeenCalled();
        });
        const options: arkade.EmulatorSubmitOptions = { beforeEmulatorSubmit: receipt };
        const pending = session.native.execute(execution, coin, options);
        options.beforeEmulatorSubmit = undefined;
        release();
        await failed;
        const result = await pending;
        expect(receipt).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledExactlyOnceWith(receipt.mock.calls[0][0].arkTx, [
            ...receipt.mock.calls[0][0].checkpointTxs,
        ]);
        expect(result.txid).toBe(receipt.mock.calls[0][0].txid);
        expect(Transaction.fromPSBT(base64.decode(receipt.mock.calls[0][0].arkTx)).id).toBe(
            result.txid,
        );
    });

    it("uses the stored payout after reopen even when the exposed bytes change during assembly", async () => {
        const first = await open();
        const imported = await first.native.importTemplate(document);
        const script = hex.encode(imported.contract.pkScript);
        await close();
        const session = await open();
        const execution = await session.native.restore(script);
        const source = new Transaction();
        source.addInput({ txid: "99".repeat(32), index: 0 });
        source.addOutput({ script: execution.contract.pkScript, amount: 50_000n });
        const coin = {
            txid: source.id,
            vout: 0,
            value: 50_000,
            isSpent: false,
            isUnrolled: false,
            createdAt: new Date(0),
            script,
            status: { confirmed: false },
        };
        vi.spyOn(execution.contract, "getUtxos").mockResolvedValue([coin]);
        vi.spyOn(manager!, "refreshOutpoints").mockResolvedValue(undefined);
        vi.spyOn(manager!, "refreshVtxos").mockResolvedValue(undefined);
        vi.mocked(session.indexer.getVirtualTxs).mockImplementation(async () => {
            execution.destination.fill(1);
            return { txs: [base64.encode(source.toPSBT())] };
        });
        const submit = vi
            .spyOn(session.client.emulator!, "submitTx")
            .mockImplementation(async (arkTx, checkpointTxs) => ({
                signedArkTx: arkTx,
                signedCheckpointTxs: checkpointTxs,
            }));
        execution.destination.fill(0);
        const result = await session.native.execute(execution, coin);
        const sent = Transaction.fromPSBT(base64.decode(submit.mock.calls[0][0]));
        expect(result.txid).toBe(sent.id);
        expect(hex.encode(sent.getOutput(0).script!)).toBe(document.outputs[0].locking);
        expect(sent.getOutput(0).amount).toBe(50_000n);
        expect(hex.encode((await session.native.restore(script)).destination)).toBe(
            document.outputs[0].locking,
        );
    });

    it.each(["inline", "reference"])(
        "restores a %s import without artifacts after key changes",
        async (definition) => {
            const first = await open();
            const doc =
                definition === "inline"
                    ? document
                    : {
                          ...document,
                          inputs: [
                              {
                                  ...document.inputs[0],
                                  contract: {
                                      ...document.inputs[0].contract,
                                      definition: { artifact: "compiler-id" },
                                  },
                              },
                          ],
                      };
            const original = await first.native.importTemplate(doc, { "compiler-id": artifact });
            const script = hex.encode(original.contract.pkScript);
            const before = db!.prepare("SELECT * FROM ark_contracts").all();
            await close();

            const next = await open(
                TEST_PUB_KEY,
                TEST_SERVER_PUB_KEY,
                SingleKey.fromHex("02".repeat(32)),
                288n,
            );
            const create = vi.spyOn(manager!, "createContract");
            const refresh = vi.spyOn(manager!, "refreshVtxos");
            const fetches = vi.mocked(next.indexer.getVtxos).mock.calls.length;
            const restored = await next.native.restore(script);
            expect(restored.contract.pkScript).toEqual(original.contract.pkScript);
            expect(restored.contract.address).toBe(original.contract.address);
            expect(restored.contract.keys).toEqual(original.contract.keys);
            expect(restored.contract.args).toEqual(original.contract.args);
            expect(restored.contract.keys.serverKey).not.toEqual(next.client.serverKey);
            expect(restored.contract.keys.userKey).not.toEqual(next.client.userKey);
            expect(restored.functionName).toBe("release");
            expect(hex.encode(restored.destination)).toBe(document.outputs[0].locking);
            expect(create).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            expect(vi.mocked(next.indexer.getVtxos).mock.calls.length).toBe(fetches);
            expect(db!.prepare("SELECT * FROM ark_contracts").all()).toEqual(before);

            const provider = {
                getInfo: vi.fn(async () => ({
                    serverPubkey: `02${hex.encode(original.contract.keys.serverKey)}`,
                    emulatorPubkey: hex.encode(original.contract.keys.emulatorKey!),
                })),
                registerDelegation: vi.fn(async () => ({
                    address: original.contract.address,
                    status: "active",
                })),
            };
            await expect(
                next.native.delegate(restored, provider as never, "release"),
            ).rejects.toThrow(/re-import.*delegat/);
            expect(provider.getInfo).not.toHaveBeenCalled();
            expect(provider.registerDelegation).not.toHaveBeenCalled();
        },
    );

    it("preserves a first-writer plan when a later import changes the payout", async () => {
        const session = await open();
        const original = await session.native.importTemplate(document);
        const before = db!.prepare("SELECT * FROM ark_contracts").all();
        const changed = {
            ...document,
            outputs: [{ ...document.outputs[0], locking: `5120${"44".repeat(32)}` }],
        };
        await expect(
            session.native
                .importTemplate(changed)
                .then((execution) => session.native.fund(execution, 50_000)),
        ).rejects.toThrow(/conflicting native execution plan/);
        expect(session.wallet.send).not.toHaveBeenCalled();
        expect(db!.prepare("SELECT * FROM ark_contracts").all()).toEqual(before);
        const restored = await session.native.restore(hex.encode(original.contract.pkScript));
        expect(hex.encode(restored.destination)).toBe(document.outputs[0].locking);
    });

    it("refuses to fund an import when the retained SQLite row has another address", async () => {
        const session = await open();
        const execution = await session.native.importTemplate(document);
        await manager!.updateContract(hex.encode(execution.contract.pkScript), {
            address: "tark1wrong",
        });
        const before = db!.prepare("SELECT * FROM ark_contracts").all();
        await expect(
            session.native
                .importTemplate(document)
                .then((handle) => session.native.fund(handle, 50_000)),
        ).rejects.toThrow(/does not match/);
        expect(session.wallet.send).not.toHaveBeenCalled();
        expect(db!.prepare("SELECT * FROM ark_contracts").all()).toEqual(before);
    });

    it("persists the plan onto a contract registered before the import", async () => {
        const session = await open();
        const execution = await session.native.importTemplate(document);
        const script = hex.encode(execution.contract.pkScript);
        await manager!.updateContract(script, { metadata: { custom: 1 } });
        await expect(session.native.restore(script)).rejects.toThrow(
            /no persisted native execution plan/,
        );

        await session.native.importTemplate(document);
        await close();
        const next = await open();
        const restored = await next.native.restore(script);
        expect(hex.encode(restored.destination)).toBe(document.outputs[0].locking);
        const [row] = await manager!.getContracts({ script });
        expect(row.metadata).toMatchObject({ custom: 1, genericallySpendable: false });
    });

    it.each([
        [
            "unknown version",
            (row: any) => {
                row.metadata.nativeExecution.plan.version = 2;
            },
        ],
        [
            "extra plan field",
            (row: any) => {
                row.metadata.nativeExecution.plan.fee = 0;
            },
        ],
        [
            "unknown function",
            (row: any) => {
                row.metadata.nativeExecution.plan.functionName = "absent";
            },
        ],
        [
            "non-covenant leaf",
            (row: any) => {
                row.metadata.nativeExecution.plan.functionName = "unilateral";
            },
        ],
        [
            "invalid destination",
            (row: any) => {
                row.metadata.nativeExecution.plan.destinationHex = "6a";
            },
        ],
        [
            "open spend gate",
            (row: any) => {
                row.metadata.genericallySpendable = true;
            },
        ],
        [
            "wrong contract type",
            (row: any) => {
                row.type = "default";
            },
        ],
        [
            "address mismatch",
            (row: any) => {
                row.address = "tark1wrong";
            },
        ],
        [
            "script mismatch",
            (row: any) => {
                const args = JSON.parse(row.params.args);
                args.payout = `0x${"44".repeat(32)}`;
                row.params.args = JSON.stringify(args);
            },
        ],
    ])("rejects %s without rewriting the stored row or fetching coins", async (_, mutate) => {
        const session = await open();
        const execution = await session.native.importTemplate(document);
        const script = hex.encode(execution.contract.pkScript);
        const [stored] = await manager!.getContracts({ script });
        const row = structuredClone(stored);
        row.metadata!.nativeExecution = {
            document,
            variables: {},
            plan: {
                version: 1,
                functionName: "release",
                destinationHex: document.outputs[0].locking,
            },
        };
        mutate(row);
        await manager!.updateContract(script, row);
        const before = db!.prepare("SELECT * FROM ark_contracts").all();
        const fetches = vi.mocked(session.indexer.getVtxos).mock.calls.length;
        const create = vi.spyOn(manager!, "createContract");
        await expect(session.native.restore(script)).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
        expect(session.wallet.send).not.toHaveBeenCalled();
        expect(vi.mocked(session.indexer.getVtxos).mock.calls.length).toBe(fetches);
        expect(db!.prepare("SELECT * FROM ark_contracts").all()).toEqual(before);
    });

    it("refuses a missing row and an invalid lookup script", async () => {
        const session = await open();
        await expect(session.native.restore(`5120${"55".repeat(32)}`)).rejects.toThrow(/not found/);
        await expect(session.native.restore("6a")).rejects.toThrow(/Taproot/);
        expect(session.wallet.send).not.toHaveBeenCalled();
    });

    it.each([true, false, undefined])(
        "keeps an existing %s gate and application metadata across import and reopen",
        async (gate) => {
            const first = await open();
            const args = Object.fromEntries(
                artifact.constructorInputs.map((input) => {
                    const value = hex.decode(bindings[input.name as keyof typeof bindings]);
                    return [input.name, input.type === "int" ? arkade.BigNum.decode(value) : value];
                }),
            );
            const legacy = first.client.contract(arkade.programFromArtifact(artifact), args);
            const original = await legacy.register({
                label: "existing application contract",
                metadata: {
                    app: { position: "legacy-1" },
                    ...(gate === undefined ? {} : { genericallySpendable: gate }),
                },
            });
            const before = db!.prepare("SELECT * FROM ark_contracts").all();
            await close();

            const upgraded = await open();
            const imported = upgraded.native.importTemplate(document);
            if (gate === true) {
                await expect(
                    imported.then((execution) => upgraded.native.fund(execution, 50_000)),
                ).rejects.toThrow(/generic spending/);
            } else {
                const execution = await imported;
                expect(execution.contract.pkScript).toEqual(legacy.pkScript);
                expect(execution.contract.address).toBe(legacy.address);
            }
            expect(upgraded.wallet.send).not.toHaveBeenCalled();
            const after = db!.prepare("SELECT * FROM ark_contracts").all();
            if (gate === true) expect(after).toEqual(before);
            await close();

            const reopened = await open(TEST_PUB_KEY);
            const [stored] = await manager!.getContracts({ script: original.script });
            if (gate === true) expect(stored).toEqual(original);
            else {
                expect(stored).toEqual({
                    ...original,
                    metadata: {
                        app: { position: "legacy-1" },
                        genericallySpendable: false,
                        nativeExecution: expect.objectContaining({
                            plan: expect.objectContaining({ functionName: "release" }),
                        }),
                    },
                });
                await reopened.native.restore(original.script);
            }
            const restored = arkade.ArkadeContract.fromContract(reopened.client, stored);
            expect(restored.pkScript).toEqual(legacy.pkScript);
            expect(restored.address).toBe(legacy.address);
            expect(db!.prepare("SELECT * FROM ark_contracts").all()).toEqual(after);
        },
    );
});
