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
import { decodeArtifact } from "../src/arkade/template/abi";
import { ExecutorRequestError } from "../src/providers/executor";
import { createMockIndexerProvider, TEST_PUB_KEY, TEST_SERVER_PUB_KEY } from "./contracts/helpers";
import locktime from "./fixtures/template-v1/locktime.json";

const document = locktime.template;
const { variables } = locktime.bindings;
const definition = document.inputs[0].contract.definition;
const artifact = definition as unknown as arkade.ContractArtifact;
const utf8 = new TextEncoder();

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
        const walletRepository = new SQLiteWalletRepository(sql, {
            walletStateTransactions: true,
            persistentWalletState: true,
        });
        manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: new SQLiteContractRepository(sql),
            walletRepository,
        });
        const client = await arkade.Arkade.connect({
            arkade: {
                getInfo: async () =>
                    ({
                        signerPubkey: `02${hex.encode(serverKey)}`,
                        dust: 330n,
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
            walletRepository,
            native: new arkade.NativeExecutor(client, wallet as unknown as IWallet),
        };
    }

    const rows = () => db!.prepare("SELECT * FROM ark_contracts").all();
    const importTemplate = (session: Awaited<ReturnType<typeof open>>, doc: unknown = document) =>
        session.native.importTemplate(doc, { variables });

    /** A coin at the execution's contract whose creating tx the indexer serves. */
    function position(
        session: Awaited<ReturnType<typeof open>>,
        execution: arkade.NativeExecution,
    ) {
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
        return { coin, submit };
    }

    it("captures queued receipt callbacks and recovers the native queue after storage failure", async () => {
        const session = await open();
        const execution = await importTemplate(session);
        const { coin, submit } = position(session, execution);
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
            session.native.execute(execution, coin, { beforeEmulatorSubmit: firstReceipt }),
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
    });

    it("executes a coin read back from the wallet repository with its stored expiry", async () => {
        const session = await open();
        const deadline = 4_102_444_800;
        const doc = structuredClone(document) as any;
        doc.inputs[0].contract.definition.functions[1].arkade.asm = [
            "OP_PUSHEXPIRY",
            `${deadline}`,
            "OP_NUMEQUAL",
        ];
        const execution = await importTemplate(session, doc);
        const { coin, submit } = position(session, execution);
        vi.mocked(execution.contract.getUtxos).mockRestore();
        const leaf = execution.contract.leafScript(1);
        await session.walletRepository.saveVtxos(execution.contract.address, [
            {
                ...coin,
                expiresAt: new Date(deadline * 1000),
                tapTree: execution.contract.tapTree,
                forfeitTapLeafScript: leaf,
                proofTapLeafScript: leaf,
            },
        ]);
        const [stored] = await execution.contract.getUtxos();
        expect(stored.expiresAt).toEqual(new Date(deadline * 1000));
        const result = await session.native.execute(execution, coin);
        expect(submit).toHaveBeenCalledOnce();
        expect(result.txid).toBe(Transaction.fromPSBT(base64.decode(submit.mock.calls[0][0])).id);
    });

    it("lets the execution journal admit the exact request native execution dispatches", async () => {
        const session = await open();
        const execution = await importTemplate(session);
        const { coin, submit } = position(session, execution);
        const journal = new arkade.NativeExecutionJournal(session.walletRepository);
        const result = await session.native.execute(execution, coin, {
            beforeEmulatorSubmit: async (proposal) => {
                await journal.admit(coin, proposal);
            },
        });
        const record = await journal.get(coin);
        expect(record).toMatchObject({
            operationId: result.txid,
            payout: { script: `5120${variables.dest}`, value: "50000" },
        });
        expect(submit).toHaveBeenCalledExactlyOnceWith(record!.proposal.arkTx, [
            ...record!.proposal.checkpointTxs,
        ]);
    });

    it("executes a restored template after reopen with its stored variables", async () => {
        const first = await open();
        const imported = await importTemplate(first);
        const script = hex.encode(imported.contract.pkScript);
        await close();
        const session = await open();
        const execution = await session.native.restore(script);
        const { coin, submit } = position(session, execution);
        const result = await session.native.execute(execution, coin);
        const sent = Transaction.fromPSBT(base64.decode(submit.mock.calls[0][0]));
        expect(result.txid).toBe(sent.id);
        expect(hex.encode(sent.getOutput(0).script!)).toBe(`5120${variables.dest}`);
        expect(sent.getOutput(0).amount).toBe(50_000n);
    });

    it.each(["inline", "reference"])(
        "restores a %s import after key changes and delegates it without re-import",
        async (kind) => {
            const id = decodeArtifact(utf8.encode(JSON.stringify(definition))).id;
            const doc =
                kind === "inline"
                    ? document
                    : {
                          ...document,
                          inputs: [
                              {
                                  ...document.inputs[0],
                                  contract: {
                                      ...document.inputs[0].contract,
                                      definition: { artifact: id },
                                  },
                              },
                          ],
                      };
            const first = await open();
            const original = await first.native.importTemplate(doc, {
                artifacts: { [id]: definition },
                variables,
            });
            const script = hex.encode(original.contract.pkScript);
            const before = rows();
            await close();

            const next = await open(
                TEST_PUB_KEY,
                TEST_SERVER_PUB_KEY,
                SingleKey.fromHex("02".repeat(32)),
            );
            const create = vi.spyOn(manager!, "createContract");
            const refresh = vi.spyOn(manager!, "refreshVtxos");
            const fetches = vi.mocked(next.indexer.getVtxos).mock.calls.length;
            const restored = await next.native.restore(script);
            expect(restored.contract.pkScript).toEqual(original.contract.pkScript);
            expect(restored.contract.address).toBe(original.contract.address);
            expect(restored.contract.keys).toEqual(original.contract.keys);
            expect(restored.contract.keys.serverKey).not.toEqual(next.client.serverKey);
            expect(restored).toMatchObject({
                functionName: "release",
                templateId: original.templateId,
                spendId: original.spendId,
                type: "virtual",
            });
            expect(create).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            expect(vi.mocked(next.indexer.getVtxos).mock.calls.length).toBe(fetches);
            expect(rows()).toEqual(before);

            const provider = {
                getInfo: vi.fn(async () => ({
                    version: "test",
                    network: "regtest",
                    cosignerPubkey: `02${hex.encode(TEST_SERVER_PUB_KEY)}`,
                    serverPubkey: `02${hex.encode(original.contract.keys.serverKey)}`,
                    emulatorPubkey: hex.encode(original.contract.keys.emulatorKey!),
                })),
                listTemplates: vi.fn(),
                getDelegation: vi.fn(),
                getTemplate: vi.fn(async () => {
                    throw new ExecutorRequestError("Failed to get Executor template (404)", 404);
                }),
                registerArtifact: vi.fn(async () => ({ id, document: "" })),
                registerTemplate: vi.fn(async () => ({
                    id: original.templateId,
                    status: "active",
                    document: "",
                    artifactIds: [],
                    params: [],
                    type: "virtual",
                })),
                registerDelegation: vi.fn(async () => ({
                    id: 1,
                    templateId: original.templateId,
                    variables,
                    status: "active" as const,
                    inputs: [
                        {
                            name: "coin",
                            onchain: false,
                            script,
                            address: original.contract.address,
                        },
                    ],
                })),
            };
            await next.native.delegate(restored, provider);
            expect(provider.registerArtifact).toHaveBeenCalledTimes(kind === "inline" ? 0 : 1);
            expect(provider.registerDelegation).toHaveBeenCalledExactlyOnceWith(
                original.templateId,
                variables,
                { expiresAt: undefined },
            );
        },
    );

    it("preserves a first-writer plan when a later import changes the payout", async () => {
        const session = await open();
        const original = await importTemplate(session);
        const before = rows();
        await expect(
            session.native
                .importTemplate(document, { variables: { ...variables, dest: "44".repeat(32) } })
                .then((execution) => session.native.fund(execution, 50_000)),
        ).rejects.toThrow(/conflicting native execution plan/);
        expect(session.wallet.send).not.toHaveBeenCalled();
        expect(rows()).toEqual(before);
        const script = hex.encode(original.contract.pkScript);
        const [row] = await manager!.getContracts({ script });
        expect((row.metadata!.nativeExecution as any).variables.dest).toBe(variables.dest);
        await session.native.restore(script);
    });

    it("refuses to fund an import when the retained SQLite row has another address", async () => {
        const session = await open();
        const execution = await importTemplate(session);
        await manager!.updateContract(hex.encode(execution.contract.pkScript), {
            address: "tark1wrong",
        });
        const before = rows();
        await expect(
            importTemplate(session).then((handle) => session.native.fund(handle, 50_000)),
        ).rejects.toThrow(/does not match/);
        expect(session.wallet.send).not.toHaveBeenCalled();
        expect(rows()).toEqual(before);
    });

    it("persists the plan onto a contract registered before the import", async () => {
        const session = await open();
        const execution = await importTemplate(session);
        const script = hex.encode(execution.contract.pkScript);
        await manager!.updateContract(script, { metadata: { custom: 1 } });
        await expect(session.native.restore(script)).rejects.toThrow(
            /no persisted native execution plan/,
        );
        await importTemplate(session);
        await close();
        const next = await open();
        await next.native.restore(script);
        const [row] = await manager!.getContracts({ script });
        expect(row.metadata).toMatchObject({ custom: 1, genericallySpendable: false });
    });

    it("refuses a pre-release plan on restore until the template is re-imported", async () => {
        const session = await open();
        const execution = await importTemplate(session);
        const script = hex.encode(execution.contract.pkScript);
        const [row] = await manager!.getContracts({ script });
        await manager!.updateContract(script, {
            metadata: {
                ...row.metadata,
                nativeExecution: {
                    document,
                    variables,
                    plan: {
                        version: 1,
                        functionName: "release",
                        destinationHex: `5120${"11".repeat(32)}`,
                    },
                },
            },
        });
        await expect(session.native.restore(script)).rejects.toThrow(
            /pre-release format; re-import the template/,
        );
        await importTemplate(session);
        const restored = await session.native.restore(script);
        expect(restored.templateId).toBe(execution.templateId);
        const [updated] = await manager!.getContracts({ script });
        expect((updated.metadata!.nativeExecution as any).version).toBe(2);
    });

    it.each([
        ["unknown version", (row: any) => (row.metadata.nativeExecution.version = 3)],
        ["extra plan field", (row: any) => (row.metadata.nativeExecution.fee = 0)],
        [
            "foreign template id",
            (row: any) => (row.metadata.nativeExecution.templateId = "ab".repeat(32)),
        ],
        [
            "edited document",
            (row: any) => {
                const saved = row.metadata.nativeExecution;
                saved.document = saved.document.replace("5120<dest>", "5121<dest>");
            },
        ],
        ["non-hex variable", (row: any) => (row.metadata.nativeExecution.variables.dest = "zz")],
        ["other variables", (row: any) => (row.metadata.nativeExecution.variables.lock = "c900")],
        ["open spend gate", (row: any) => (row.metadata.genericallySpendable = true)],
        ["wrong contract type", (row: any) => (row.type = "default")],
        ["address mismatch", (row: any) => (row.address = "tark1wrong")],
        [
            "script mismatch",
            (row: any) => {
                const args = JSON.parse(row.params.args);
                args.lock = "201";
                row.params.args = JSON.stringify(args);
            },
        ],
    ])("rejects %s without rewriting the stored row or fetching coins", async (_, mutate) => {
        const session = await open();
        const execution = await importTemplate(session);
        const script = hex.encode(execution.contract.pkScript);
        const [stored] = await manager!.getContracts({ script });
        const row = structuredClone(stored);
        mutate(row);
        await manager!.updateContract(script, row);
        const before = rows();
        const fetches = vi.mocked(session.indexer.getVtxos).mock.calls.length;
        const create = vi.spyOn(manager!, "createContract");
        await expect(session.native.restore(script)).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
        expect(session.wallet.send).not.toHaveBeenCalled();
        expect(vi.mocked(session.indexer.getVtxos).mock.calls.length).toBe(fetches);
        expect(rows()).toEqual(before);
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
            const legacy = first.client.contract(arkade.programFromArtifact(artifact), {
                owner: hex.decode(variables.owner).subarray(1),
                lock: arkade.BigNum.decode(hex.decode(variables.lock)),
            });
            const original = await legacy.register({
                label: "existing application contract",
                metadata: {
                    app: { position: "legacy-1" },
                    ...(gate === undefined ? {} : { genericallySpendable: gate }),
                },
            });
            const before = rows();
            await close();

            const upgraded = await open();
            const imported = importTemplate(upgraded);
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
            const after = rows();
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
                        nativeExecution: expect.objectContaining({ version: 2, variables }),
                    },
                });
                await reopened.native.restore(original.script);
            }
            const restored = arkade.ArkadeContract.fromContract(reopened.client, stored);
            expect(restored.pkScript).toEqual(legacy.pkScript);
            expect(restored.address).toBe(legacy.address);
            expect(rows()).toEqual(after);
        },
    );
});
