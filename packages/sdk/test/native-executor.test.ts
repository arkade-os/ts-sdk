import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import {
    ContractManager,
    CSVMultisigTapscript,
    Extension,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    Transaction,
    UnknownPacket,
    type ArkadeInfo,
    type IWallet,
    type VirtualCoin,
} from "../src";
import { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } from "../src/extension/asset";
import { Arkade, NativeExecutor, type NativeExecution } from "../src/arkade";
import { decode } from "../src/arkade/template";
import { decodeArtifact } from "../src/arkade/template/abi";
import { ExecutorRequestError, type ExecutorTemplateDetails } from "../src/providers/executor";
import { open } from "../src/arkade/template/ecies";
import { createMockIndexerProvider } from "./contracts/helpers";
import locktime from "./fixtures/template-v1/locktime.json";
import onchainVector from "./fixtures/template-v1/onchain.json";
import plainLeaf from "./fixtures/template-v1/virtual-plain-leaf.json";
import proofVector from "./fixtures/template-v1/proof-plain-leaf.json";
import suppliedTaptree from "./fixtures/template-v1/supplied-taptree-undelegated.json";
import vhtlc from "./fixtures/template-v1/vhtlc-claim-plaintext.json";
import witnessOrder from "./fixtures/template-v1/witness-order.json";

const { keys, variables } = locktime.bindings;
const utf8 = new TextEncoder();
const DEADLINE = "4102444800"; // 2100-01-01
const managers: ContractManager[] = [];

afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** The locktime vector's template with the spent covenant replaced. */
function document(covenant = ["1"], edit?: (doc: any) => void) {
    const doc: any = structuredClone(locktime.template);
    doc.inputs[0].contract.definition.functions[1].arkade.asm = covenant;
    edit?.(doc);
    return doc;
}

async function setup() {
    const indexer = createMockIndexerProvider();
    const manager = await ContractManager.create({
        indexerProvider: indexer,
        contractRepository: new InMemoryContractRepository(),
        walletRepository: new InMemoryWalletRepository(),
    });
    managers.push(manager);
    vi.spyOn(manager, "refreshOutpoints").mockResolvedValue(undefined);
    vi.spyOn(manager, "refreshVtxos").mockResolvedValue(undefined);
    const coins: VirtualCoin[] = [];
    const spent = new Set<string>();
    const sources = new Map<string, Transaction>();
    const submitTx = vi.fn(async (arkTx: string, checkpointTxs: string[]) => {
        for (const encoded of checkpointTxs) {
            const input = Transaction.fromPSBT(base64.decode(encoded)).getInput(0);
            spent.add(`${hex.encode(input.txid!)}:${input.index}`);
        }
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
    });
    vi.mocked(indexer.getVirtualTxs).mockImplementation(async (txids: string[]) => ({
        txs: txids.flatMap((id) =>
            sources.has(id) ? [base64.encode(sources.get(id)!.toPSBT())] : [],
        ),
    }));
    const server = hex.decode(keys.server).subarray(1);
    const arkade = await Arkade.connect({
        arkade: {
            getInfo: async () =>
                ({
                    signerPubkey: keys.server,
                    dust: 330n,
                    checkpointTapscript: hex.encode(
                        CSVMultisigTapscript.encode({
                            timelock: { type: "blocks", value: 10n },
                            pubkeys: [server],
                        }).script,
                    ),
                }) as ArkadeInfo,
        },
        emulator: { submitTx } as never,
        emulatorPubkey: keys.emulator,
        network: networks.regtest,
        indexer,
        contractManager: manager,
    });
    const wallet = {
        getContractManager: vi.fn(async () => manager),
        send: vi.fn(async () => "funding"),
        onchainProvider: { getChainTip: vi.fn(async () => ({ height: 100 })) },
    };
    const executor = new NativeExecutor(arkade, wallet as unknown as IWallet);
    /** Serves the coins of every funded position to the execution's contract. */
    const track = (execution: NativeExecution) =>
        vi
            .spyOn(execution.contract, "getUtxos")
            .mockImplementation(async () => coins.filter((c) => !spent.has(`${c.txid}:${c.vout}`)));
    /** One transaction paying `values` to the contract, and its coins. */
    const fund = (
        execution: NativeExecution,
        values = [50_000],
        edit?: (tx: Transaction) => void,
    ) => {
        const source = new Transaction();
        source.addInput({ txid: "99".repeat(32), index: coins.length });
        for (const value of values) {
            source.addOutput({ script: execution.contract.pkScript, amount: BigInt(value) });
        }
        edit?.(source);
        sources.set(source.id, source);
        const funded = values.map(
            (value, vout): VirtualCoin => ({
                txid: source.id,
                vout,
                value,
                script: hex.encode(execution.contract.pkScript),
                createdAt: new Date(0),
                isUnrolled: false,
                status: { confirmed: false },
            }),
        );
        coins.push(...funded);
        track(execution);
        return funded;
    };
    const importTemplate = (doc: unknown = document(), vars: Record<string, string> = variables) =>
        executor.importTemplate(doc, { variables: vars });
    return { indexer, manager, submitTx, arkade, wallet, executor, track, fund, importTemplate };
}

const scriptOf = (execution: NativeExecution) => hex.encode(execution.contract.pkScript);

function remote(execution: NativeExecution) {
    return {
        getInfo: vi.fn(async () => ({
            version: "test",
            network: "regtest",
            cosignerPubkey: keys.cosigner,
            serverPubkey: keys.server,
            emulatorPubkey: keys.emulator,
            encryptionPubkey: undefined as string | undefined,
        })),
        listTemplates: vi.fn(),
        getDelegation: vi.fn(),
        getArtifact: vi.fn(),
        getTemplate: vi.fn(async (_id: string): Promise<ExecutorTemplateDetails> => {
            throw new ExecutorRequestError("Failed to get Executor template (404)", 404);
        }),
        registerArtifact: vi.fn(async (document: string | object) => ({
            id: decodeArtifact(utf8.encode(document as string)).id,
            document: document as string,
        })),
        registerTemplate: vi.fn(async (document: string | object) => ({
            id: decode(utf8.encode(document as string)).id,
            status: "active",
            document: document as string,
            artifactIds: [],
            params: [],
            type: "virtual",
        })),
        registerDelegation: vi.fn(
            async (templateId: string, vars: Record<string, string>, _options?: object) => ({
                id: 1,
                templateId,
                variables: vars,
                status: "active" as const,
                inputs: [
                    {
                        name: "coin",
                        onchain: false,
                        script: scriptOf(execution),
                        address: execution.contract.address,
                    },
                ],
            }),
        ),
    };
}

describe("NativeExecutor import", () => {
    it("imports a virtual template/v1 spend and registers its contract closed with a v2 plan", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const doc = decode(utf8.encode(JSON.stringify(document())));
        expect(execution).toEqual({
            contract: execution.contract,
            functionName: "release",
            templateId: locktime.expected.template_id,
            spendId: locktime.expected.spend_id,
            type: "virtual",
        });
        expect(Object.isFrozen(execution)).toBe(true);
        const [row] = await s.manager.getContracts({ script: scriptOf(execution) });
        expect(row).toMatchObject({ type: "arkade", address: execution.contract.address });
        expect(row.metadata).toEqual({
            genericallySpendable: false,
            nativeExecution: {
                version: 2,
                document: new TextDecoder().decode(doc.canonical),
                artifacts: {},
                variables,
                templateId: doc.id,
                spendId: doc.spendId,
            },
        });
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it("captures the document, artifacts and variables as they were at the call", async () => {
        const s = await setup();
        const definition = structuredClone(locktime.template.inputs[0].contract.definition);
        const id = decodeArtifact(utf8.encode(JSON.stringify(definition))).id;
        const doc = document(["1"], (d) => (d.inputs[0].contract.definition = { artifact: id }));
        const artifacts = { [id]: definition };
        const vars = { ...variables };
        const pending = s.executor.importTemplate(doc, { artifacts, variables: vars });
        doc.outputs[0].locking = `5120${"22".repeat(32)}`;
        definition.functions[1].arkade!.asm = ["0"];
        vars.dest = "33".repeat(32);
        const execution = await pending;
        const [row] = await s.manager.getContracts({ script: scriptOf(execution) });
        const saved = row.metadata!.nativeExecution as Record<string, any>;
        expect(saved.variables).toEqual(variables);
        expect(JSON.parse(saved.artifacts[id]).functions[1].arkade.asm).toEqual(["1"]);
        expect(JSON.parse(saved.document).outputs[0].locking).toBe("5120<dest>");
    });

    const proofTemplate = () => proofVector.template;
    it.each([
        ["a proof template", proofTemplate, {}, /proof templates are built .* not proven natively/],
        ["an onchain template", () => onchainVector.template, {}, /onchain templates/],
        [
            "a second input",
            () =>
                document(["1"], (d) => {
                    d.inputs.push({ ...structuredClone(d.inputs[0]), name: "more" });
                    d.outputs.push({ ...structuredClone(d.outputs[0]), name: "more", index: 1 });
                    d.outputs[1].value.from = "more";
                    d.packets.output_index = 2;
                }),
            variables,
            /exactly one input/,
        ],
        [
            "a leaf with an uninjected signature",
            () => document(["1"], (d) => (d.inputs[0].spend = { function: "exit", leaf: "exit" })),
            variables,
            /inject/,
        ],
        [
            "a leaf the owner must sign",
            () =>
                document(["1"], (d) => {
                    const leaf = d.inputs[0].contract.definition.functions[1].leaves[0];
                    leaf.asm.splice(3, 0, "<owner>", "OP_CHECKSIGVERIFY");
                    leaf.witness.push({
                        name: "ownerSig",
                        type: "signature",
                        encoding: "schnorr-64",
                        injected: true,
                    });
                }),
            variables,
            /signer <owner> is not available offline/,
        ],
        [
            "a leaf with a relative timelock",
            () =>
                document(["1"], (d) => {
                    const leaf = d.inputs[0].contract.definition.functions[1].leaves[0];
                    leaf.asm.unshift("144", "OP_CHECKSEQUENCEVERIFY", "OP_DROP");
                }),
            variables,
            /CSV leaf/,
        ],
        ["a leaf without a covenant", () => plainLeaf.template, {}, /no covenant/],
        [
            "the Executor's cosigner key",
            () => document(["<COSIGNER_KEY>", "OP_DROP", "1"]),
            variables,
            /cosigner key/,
        ],
        [
            "a supplied taptree",
            () => suppliedTaptree.template,
            suppliedTaptree.bindings.variables,
            /supplied taptree/,
        ],
        [
            "a leaf the arkade contract handler cannot express",
            () => witnessOrder.template,
            {},
            /programFromArtifact/,
        ],
        ["a variable that is not lowercase hex", document, { ...variables, dest: "AB" }, /hex/],
        ["an undeclared variable", document, { ...variables, extra: "00" }, /variables/],
    ])("refuses %s before registering or funding", async (_, doc, vars, error) => {
        const s = await setup();
        const create = vi.spyOn(s.manager, "createContract");
        await expect(s.importTemplate(doc(), vars as Record<string, string>)).rejects.toThrow(
            error,
        );
        expect(create).not.toHaveBeenCalled();
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it("re-imports the same plan and refuses another plan over the same contract", async () => {
        const s = await setup();
        const first = await s.importTemplate();
        const again = await s.importTemplate();
        expect(again.contract.pkScript).toEqual(first.contract.pkScript);
        await expect(
            s.importTemplate(document(), { ...variables, dest: "44".repeat(32) }),
        ).rejects.toThrow(/conflicting native execution plan/);
    });

    it.each([
        [
            "a different address",
            { address: "tark1different" },
            /does not match derived script or address/,
        ],
        ["an open spend gate", { metadata: { genericallySpendable: true } }, /generic spending/],
    ])("refuses an existing row with %s", async (_, update, error) => {
        const s = await setup();
        const execution = await s.importTemplate();
        await s.manager.updateContract(scriptOf(execution), update);
        await expect(s.importTemplate()).rejects.toThrow(error);
    });

    it("imports the VHTLC non-interactive claim with its sealed preimage as plaintext", async () => {
        const s = await setup();
        const execution = await s.importTemplate(vhtlc.template, vhtlc.bindings.variables);
        expect(execution.functionName).toBe("nonInteractiveClaim");
        expect(execution.templateId).toBe(vhtlc.expected.template_id);
    });
});

describe("NativeExecutor fund", () => {
    it("pays through the wallet once the covenant passes its dry run", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        await expect(s.executor.fund(execution, 50_000)).resolves.toBe("funding");
        expect(s.wallet.send).toHaveBeenCalledExactlyOnceWith({
            address: execution.contract.address,
            amount: 50_000,
        });
    });

    it("refuses a covenant that fails every probe, naming the opcode and position", async () => {
        const s = await setup();
        const execution = await s.importTemplate(document(["0", "OP_VERIFY", "1"]));
        const clock = Date.now;
        await expect(s.executor.fund(execution, 50_000)).rejects.toThrow(
            /no probed time or expiry lets the covenant pass: OP_VERIFY at position 1/,
        );
        expect(Date.now).toBe(clock);
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it("funds a covenant that passes only in the future, which execute refuses today", async () => {
        const s = await setup();
        const execution = await s.importTemplate(document([DEADLINE, "OP_CHECKTIME"]));
        const clock = Date.now;
        await s.executor.fund(execution, 50_000);
        expect(Date.now).toBe(clock);
        expect(s.wallet.send).toHaveBeenCalledOnce();
        const [coin] = s.fund(execution);
        const hook = vi.fn();
        await expect(
            s.executor.execute(execution, coin, { beforeEmulatorSubmit: hook }),
        ).rejects.toThrow(/fails its dry run/);
        expect(hook).not.toHaveBeenCalled();
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it("refuses a covenant that only passes once the coin has expired", async () => {
        const s = await setup();
        const execution = await s.importTemplate(document(["OP_PUSHEXPIRY", "OP_CHECKTIME"]));
        await expect(s.executor.fund(execution, 50_000)).rejects.toThrow(
            /no probed time or expiry lets the covenant pass/,
        );
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it("funds a covenant open only in a live coin's last 1024 seconds", async () => {
        const s = await setup();
        const execution = await s.importTemplate(
            document(["OP_PUSHEXPIRY", "1024", "OP_SUB", "OP_CHECKTIME"]),
        );
        await expect(s.executor.fund(execution, 50_000)).resolves.toBe("funding");
    });

    it("refuses an amount the template cannot pay out", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        await expect(s.executor.fund(execution, 100)).rejects.toThrow(/no probed time/);
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
        "refuses the invalid amount %s",
        async (amount) => {
            const s = await setup();
            const execution = await s.importTemplate();
            await expect(s.executor.fund(execution, amount)).rejects.toThrow(/invalid amount/);
            expect(s.wallet.send).not.toHaveBeenCalled();
        },
    );
});

describe("NativeExecutor execute", () => {
    it("submits through the emulator without a wallet signature and refreshes the coin", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        const hook = vi.fn();
        const result = await s.executor.execute(execution, coin, { beforeEmulatorSubmit: hook });
        const [arkTx, checkpointTxs] = s.submitTx.mock.calls[0];
        const ark = Transaction.fromPSBT(base64.decode(arkTx));
        expect(result.txid).toBe(ark.id);
        expect(hook).toHaveBeenCalledExactlyOnceWith({ txid: ark.id, arkTx, checkpointTxs });
        expect(hex.encode(ark.getOutput(0).script!)).toBe(`5120${variables.dest}`);
        expect(ark.getOutput(0).amount).toBe(50_000n);
        expect(ark.getInput(0).tapScriptSig ?? []).toEqual([]);
        expect(s.manager.refreshOutpoints).toHaveBeenLastCalledWith([
            { txid: coin.txid, vout: coin.vout },
        ]);
        expect(s.wallet.onchainProvider.getChainTip).not.toHaveBeenCalled();
    });

    it.each([
        ["a timestamp", { expiresAt: new Date(Number(DEADLINE) * 1000) }, true],
        ["a height", { expiresAtHeight: Number(DEADLINE) }, true],
        ["no expiry", {}, false],
    ])("hands the emulator the coin's expiry as %s", async (_, expiry, passes) => {
        const s = await setup();
        const execution = await s.importTemplate(
            document(["OP_PUSHEXPIRY", DEADLINE, "OP_NUMEQUAL"]),
        );
        const [coin] = s.fund(execution);
        Object.assign(coin, expiry);
        const run = s.executor.execute(execution, coin);
        if (passes) await expect(run).resolves.toBeDefined();
        else await expect(run).rejects.toThrow(/fails its dry run: .*not found/);
        expect(s.submitTx).toHaveBeenCalledTimes(passes ? 1 : 0);
    });

    it.each([
        ["below the chain tip", 99, undefined],
        ["at the chain tip", 100, /expired/],
        ["without a reachable chain tip", undefined, /spendability could not be established/],
    ])("judges a height-expiring coin %s", async (_, height, refusal) => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        Object.assign(coin, { expiresAtHeight: 100 });
        if (height === undefined) {
            s.wallet.onchainProvider.getChainTip.mockRejectedValue(new Error("esplora down"));
            vi.spyOn(console, "warn").mockImplementation(() => {});
        } else s.wallet.onchainProvider.getChainTip.mockResolvedValue({ height });
        const hook = vi.fn();
        const run = s.executor.execute(execution, coin, { beforeEmulatorSubmit: hook });
        if (refusal) {
            await expect(run).rejects.toThrow(refusal);
            expect(hook).not.toHaveBeenCalled();
        } else await expect(run).resolves.toBeDefined();
        expect(s.submitTx).toHaveBeenCalledTimes(refusal ? 0 : 1);
    });

    it("refuses a height-expiring coin on a wallet with no chain tip source", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        Object.assign(coin, { expiresAtHeight: 100 });
        delete (s.wallet as { onchainProvider?: unknown }).onchainProvider;
        await expect(s.executor.execute(execution, coin)).rejects.toThrow(
            /spendability could not be established/,
        );
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it("refuses a coin that expires while its spend is being prepared", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        const expiresAt = new Date(Date.now() + 60_000);
        Object.assign(coin, { expiresAt });
        const serve = vi.mocked(s.indexer.getVirtualTxs).getMockImplementation()!;
        vi.mocked(s.indexer.getVirtualTxs).mockImplementation(async (...args) => {
            vi.setSystemTime(expiresAt.getTime());
            return serve(...args);
        });
        const hook = vi.fn();
        await expect(
            s.executor.execute(execution, coin, { beforeEmulatorSubmit: hook }),
        ).rejects.toThrow(/expired while its spend was prepared/);
        expect(hook).not.toHaveBeenCalled();
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it("refuses a coin whose height expiry passes while its spend is being prepared", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        Object.assign(coin, { expiresAtHeight: 100 });
        s.wallet.onchainProvider.getChainTip
            .mockResolvedValueOnce({ height: 99 })
            .mockResolvedValue({ height: 100 });
        const hook = vi.fn();
        await expect(
            s.executor.execute(execution, coin, { beforeEmulatorSubmit: hook }),
        ).rejects.toThrow(/expired while its spend was prepared/);
        expect(hook).not.toHaveBeenCalled();
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it.each(["refreshOutpoints", "refreshVtxos"] as const)(
        "returns the accepted result when post-submit %s fails",
        async (method) => {
            const s = await setup();
            const execution = await s.importTemplate();
            const [coin] = s.fund(execution);
            const failure = new Error("indexer unavailable after acceptance");
            if (method === "refreshOutpoints") {
                vi.mocked(s.manager.refreshOutpoints)
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(failure);
            } else vi.mocked(s.manager.refreshVtxos).mockRejectedValueOnce(failure);
            const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
            const result = await s.executor.execute(execution, coin);
            expect(result.txid).toHaveLength(64);
            expect(warning).toHaveBeenCalledOnce();
            await expect(s.executor.execute(execution, coin)).rejects.toThrow(/spent/);
            expect(s.submitTx).toHaveBeenCalledOnce();
        },
    );

    it("propagates pre-submit refresh and submission failures unchanged", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        const refreshFailure = new Error("refresh before dispatch failed");
        vi.mocked(s.manager.refreshOutpoints).mockRejectedValueOnce(refreshFailure);
        await expect(s.executor.execute(execution, coin)).rejects.toBe(refreshFailure);
        expect(s.submitTx).not.toHaveBeenCalled();
        const submitFailure = new Error("response lost");
        s.submitTx.mockRejectedValueOnce(submitFailure);
        await expect(s.executor.execute(execution, coin)).rejects.toBe(submitFailure);
        expect(s.manager.refreshVtxos).not.toHaveBeenCalled();
    });

    it("captures a queued source before an earlier pre-submit hook fails without dispatch", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin, other] = s.fund(execution, [50_000, 50_000]);
        const point = { txid: coin.txid, vout: coin.vout };
        const original = { ...point };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const failure = new Error("receipt storage failed");
        const hook = vi.fn(async () => {
            await gate;
            throw failure;
        });
        const first = s.executor.execute(execution, original, { beforeEmulatorSubmit: hook });
        const firstResult = expect(first).rejects.toBe(failure);
        await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
        const second = s.executor.execute(execution, point);
        point.vout = other.vout;
        release();
        await firstResult;
        await second;
        const spent = Transaction.fromPSBT(base64.decode(s.submitTx.mock.calls[0][1][0])).getInput(
            0,
        );
        expect(s.submitTx).toHaveBeenCalledOnce();
        expect({ txid: hex.encode(spent.txid!), vout: spent.index }).toEqual(original);
        expect(point).toEqual({ ...original, vout: other.vout });
    });

    it.each(["manager lookup", "submit"])(
        "retains the original immutable refresh point during %s",
        async (stage) => {
            const s = await setup();
            const execution = await s.importTemplate();
            const [coin, other] = s.fund(execution, [50_000, 50_000]);
            const point = { txid: coin.txid, vout: coin.vout, label: "caller-owned" };
            const original = { txid: point.txid, vout: point.vout };
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            s.wallet.getContractManager.mockClear();
            const submit = s.submitTx.getMockImplementation()!;
            if (stage === "manager lookup") {
                s.wallet.getContractManager.mockImplementationOnce(async () => {
                    await gate;
                    return s.manager;
                });
            } else {
                s.submitTx.mockImplementationOnce(async (...args) => {
                    await gate;
                    return submit(...args);
                });
            }
            const pending = s.executor.execute(execution, point);
            await vi.waitFor(() =>
                expect(
                    stage === "manager lookup" ? s.wallet.getContractManager : s.submitTx,
                ).toHaveBeenCalledOnce(),
            );
            point.vout = other.vout;
            release();
            await pending;
            const refresh = vi.mocked(s.manager.refreshOutpoints);
            expect(refresh).toHaveBeenCalledTimes(2);
            for (const [points] of refresh.mock.calls) {
                expect(points).toEqual([original]);
                expect(Object.isFrozen(points[0])).toBe(true);
                expect(points[0]).not.toBe(point);
            }
            expect(point).toEqual({ ...original, vout: other.vout, label: "caller-owned" });
        },
    );

    it.each([
        null,
        undefined,
        {},
        { txid: 1, vout: 0 },
        { txid: "AA".repeat(32), vout: 0 },
        { txid: "a".repeat(63), vout: 0 },
        { txid: "gg".repeat(32), vout: 0 },
        ...[-1, 1.5, 0x100000000, NaN, Infinity, "0", undefined].map((vout) => ({
            txid: "aa".repeat(32),
            vout,
        })),
    ])("rejects invalid source %j as a Promise before touching the wallet", async (point) => {
        const s = await setup();
        const execution = await s.importTemplate();
        s.wallet.getContractManager.mockClear();
        let pending!: ReturnType<typeof s.executor.execute>;
        expect(() => {
            pending = s.executor.execute(execution, point as never);
        }).not.toThrow();
        await expect(pending).rejects.toThrow("invalid source outpoint");
        expect(s.wallet.getContractManager).not.toHaveBeenCalled();
        expect(s.manager.refreshOutpoints).not.toHaveBeenCalled();
        expect(s.indexer.getVirtualTxs).not.toHaveBeenCalled();
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it("rejects a throwing source getter immediately without poisoning a pending execution", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(s.manager.refreshOutpoints).mockImplementationOnce(() => gate);
        const valid = s.executor.execute(execution, coin);
        await vi.waitFor(() => expect(s.manager.refreshOutpoints).toHaveBeenCalledOnce());
        const failure = new Error("source getter failed");
        const point = {
            get txid(): string {
                throw failure;
            },
            vout: 0,
        };
        let invalid!: ReturnType<typeof s.executor.execute>;
        expect(() => {
            invalid = s.executor.execute(execution, point);
        }).not.toThrow();
        await expect(invalid).rejects.toBe(failure);
        await expect(s.executor.execute(execution, { txid: "bad", vout: 0 })).rejects.toThrow(
            "invalid source outpoint",
        );
        expect(s.manager.refreshOutpoints).toHaveBeenCalledOnce();
        release();
        await valid;
        expect(s.submitTx).toHaveBeenCalledOnce();
    });

    it("serializes competing attempts and never selects a replacement coin", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution, [50_000, 50_000]);
        const results = await Promise.allSettled([
            s.executor.execute(execution, coin),
            s.executor.execute(execution, coin),
        ]);
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
        expect(s.submitTx).toHaveBeenCalledOnce();
        expect(s.indexer.getVirtualTxs).toHaveBeenCalledOnce();
    });

    it("serializes executors sharing one wallet before re-reading the same position", async () => {
        const s = await setup();
        const other = new NativeExecutor(s.arkade, s.wallet as unknown as IWallet);
        const first = await s.importTemplate();
        const second = await other.importTemplate(document(), { variables });
        const [coin] = s.fund(first);
        s.track(second);
        const results = await Promise.allSettled([
            s.executor.execute(first, coin),
            other.execute(second, coin),
        ]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        expect(results[1]).toMatchObject({
            reason: expect.objectContaining({
                message: expect.stringMatching(/position is missing/),
            }),
        });
        expect(s.submitTx).toHaveBeenCalledOnce();
    });

    it("lets another wallet execute while one wallet is waiting for its position refresh", async () => {
        const first = await setup();
        const second = await setup();
        const firstExecution = await first.importTemplate();
        const secondExecution = await second.importTemplate();
        const [firstCoin] = first.fund(firstExecution);
        const [secondCoin] = second.fund(secondExecution);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(first.manager.refreshOutpoints).mockImplementationOnce(() => gate);
        const pending = first.executor.execute(firstExecution, firstCoin);
        await second.executor.execute(secondExecution, secondCoin);
        expect(first.submitTx).not.toHaveBeenCalled();
        expect(second.submitTx).toHaveBeenCalledOnce();
        release();
        await pending;
        expect(first.submitTx).toHaveBeenCalledOnce();
    });

    it("continues the shared wallet queue after a pre-submit failure", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        const failure = new Error("creating transaction unavailable");
        vi.mocked(s.indexer.getVirtualTxs).mockRejectedValueOnce(failure);
        const results = await Promise.allSettled([
            s.executor.execute(execution, coin),
            s.executor.execute(execution, coin),
        ]);
        expect(results[0]).toMatchObject({ status: "rejected", reason: failure });
        expect(results[1].status).toBe("fulfilled");
        expect(s.submitTx).toHaveBeenCalledOnce();
    });

    it("refuses a second manager and another executor's imported handle", async () => {
        const s = await setup();
        const other = await setup();
        const execution = await other.importTemplate();
        await expect(s.executor.fund(execution, 50_000)).rejects.toThrow(/another executor/);
        s.wallet.getContractManager.mockResolvedValue({} as never);
        await expect(s.importTemplate()).rejects.toThrow(/existing contract manager/);
    });

    it("refuses a position the indexer reports with assets", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        coin.assets = [{ assetId: "ab", amount: 1 } as never];
        await expect(s.executor.execute(execution, coin)).rejects.toThrow(/contains assets/);
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it.each([
        [1, true],
        [0, false],
    ])("spends a position funded beside asset change at vout %i", async (assetVout, spends) => {
        const s = await setup();
        const execution = await s.importTemplate();
        const group = AssetGroup.create(
            AssetId.create("cc".repeat(32), 0),
            null,
            [AssetInput.create(0, 5n)],
            [AssetOutput.create(assetVout, 5n)],
            [],
        );
        const [coin] = s.fund(execution, [50_000], (tx) => {
            tx.addOutput({ script: hex.decode(`5120${"33".repeat(32)}`), amount: 1_000n });
            tx.addOutput(Extension.create([Packet.create([group])]).txOut());
        });
        const run = s.executor.execute(execution, coin);
        if (spends) await expect(run).resolves.toBeDefined();
        else await expect(run).rejects.toThrow(/carries assets/);
        expect(s.submitTx).toHaveBeenCalledTimes(spends ? 1 : 0);
    });

    it("refuses a source carrying a packet no template rule handles", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution, [50_000], (tx) => {
            tx.addOutput(Extension.create([new UnknownPacket(2, new Uint8Array([1]))]).txOut());
        });
        await expect(s.executor.execute(execution, coin)).rejects.toThrow(
            /carries packet 2 that no rule handles/,
        );
        expect(s.submitTx).not.toHaveBeenCalled();
    });

    it("verifies the tracked amount against the actual creating transaction", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const [coin] = s.fund(execution);
        coin.value++;
        await expect(s.executor.execute(execution, coin)).rejects.toThrow(/does not match/);
        expect(s.submitTx).not.toHaveBeenCalled();
    });
});

describe("NativeExecutor delegate", () => {
    it.each([
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ])("rejects the invalid expiry %s before any provider call", async (expiresAt) => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        await expect(s.executor.delegate(execution, provider, expiresAt)).rejects.toThrow(
            /invalid expiry/,
        );
        for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
    });

    it.each([undefined, 0, 4_102_444_800, Number.MAX_SAFE_INTEGER])(
        "forwards the valid expiry %s unchanged",
        async (expiresAt) => {
            const s = await setup();
            const execution = await s.importTemplate();
            const provider = remote(execution);
            await s.executor.delegate(execution, provider, expiresAt);
            expect(provider.registerDelegation).toHaveBeenCalledExactlyOnceWith(
                execution.templateId,
                variables,
                { expiresAt },
            );
        },
    );

    it("registers each artifact, then the canonical template, then the delegation", async () => {
        const s = await setup();
        const definition = locktime.template.inputs[0].contract.definition;
        const id = decodeArtifact(utf8.encode(JSON.stringify(definition))).id;
        const doc = document(["1"], (d) => (d.inputs[0].contract.definition = { artifact: id }));
        const execution = await s.executor.importTemplate(doc, {
            artifacts: { [id]: definition },
            variables,
        });
        const provider = remote(execution);
        const delegation = await s.executor.delegate(execution, provider);
        const canonical = new TextDecoder().decode(
            decode(utf8.encode(JSON.stringify(doc))).canonical,
        );
        expect(provider.registerArtifact).toHaveBeenCalledExactlyOnceWith(
            JSON.stringify(definition),
        );
        expect(provider.registerTemplate).toHaveBeenCalledExactlyOnceWith(canonical);
        const order = [
            provider.registerArtifact,
            provider.registerTemplate,
            provider.registerDelegation,
        ];
        expect(order.map((m) => m.mock.invocationCallOrder[0])).toEqual(
            order.map((m) => m.mock.invocationCallOrder[0]).sort((a, b) => a - b),
        );
        expect(delegation.templateId).toBe(execution.templateId);
    });

    it("refuses at import a document naming an artifact it was not given", async () => {
        const s = await setup();
        const definition = locktime.template.inputs[0].contract.definition;
        const id = decodeArtifact(utf8.encode(JSON.stringify(definition))).id;
        const doc = document(["1"], (d) => (d.inputs[0].contract.definition = { artifact: id }));
        await expect(s.executor.importTemplate(doc, { artifacts: {}, variables })).rejects.toThrow(
            `artifact ${id} not provided`,
        );
    });

    it.each([
        ["server", { serverPubkey: `02${"22".repeat(32)}` }],
        ["emulator", { emulatorPubkey: keys.cosigner }],
    ])("refuses an Executor with another %s key before registering anything", async (_, info) => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        provider.getInfo.mockResolvedValue({ ...(await provider.getInfo()), ...info });
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(/keys differ/);
        expect(provider.registerTemplate).not.toHaveBeenCalled();
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("refuses a provider that cannot look up templates", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const { getTemplate: _, ...provider } = remote(execution);
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(
            /cannot look up templates/,
        );
        expect(provider.getInfo).not.toHaveBeenCalled();
    });

    it("refuses a provider that cannot upload a template the Executor lacks", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const { registerArtifact: _, ...provider } = remote(execution);
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(
            /cannot register templates/,
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("delegates to a template the Executor already has, uploading nothing", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        provider.getTemplate.mockImplementationOnce(async (id: string) => ({
            id,
            status: "active",
            document: "",
            artifactIds: [],
            params: [],
            type: "virtual",
        }));
        const delegation = await s.executor.delegate(execution, provider);
        expect(provider.getTemplate).toHaveBeenCalledExactlyOnceWith(execution.templateId);
        expect(provider.registerArtifact).not.toHaveBeenCalled();
        expect(provider.registerTemplate).not.toHaveBeenCalled();
        expect(delegation.templateId).toBe(execution.templateId);
    });

    it("names the missing template when the Executor refuses uploads", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        provider.registerTemplate.mockRejectedValueOnce(
            new ExecutorRequestError("served on the admin port only", 403),
        );
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(
            new RegExp(`template ${execution.templateId} is not installed.*operator must install`),
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("refuses a template the Executor holds but has disabled", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        provider.getTemplate.mockImplementationOnce(async (id: string) => ({
            id,
            status: "disabled",
            document: "",
            artifactIds: [],
            params: [],
            type: "virtual",
        }));
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(/is disabled/);
        expect(provider.registerTemplate).not.toHaveBeenCalled();
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("refuses an Executor that files the template under another id", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        provider.registerTemplate.mockResolvedValueOnce({
            id: "ab".repeat(32),
            status: "active",
            document: "",
            artifactIds: [],
            params: [],
            type: "virtual",
        });
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(
            /registered template .* as abab/,
        );
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it.each([
        ["another script", { script: `5120${"55".repeat(32)}` }],
        ["another address", { address: "tark1other" }],
        ["an inactive status", { status: "cancelled" }],
        ["a second input", { second: true }],
    ])("refuses a delegation with %s", async (_, change) => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(execution);
        const base = await provider.registerDelegation(execution.templateId, {});
        const [input] = base.inputs;
        provider.registerDelegation.mockResolvedValueOnce({
            ...base,
            status: ("status" in change ? change.status : base.status) as never,
            inputs: "second" in change ? [input, input] : [{ ...input, ...change }],
        });
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(
            /another template, script or address, or an inactive delegation/,
        );
    });

    it("seals each sealed variable to the Executor's key, and refuses an Executor without one", async () => {
        const s = await setup();
        const execution = await s.importTemplate(vhtlc.template, vhtlc.bindings.variables);
        const secret = secp256k1.utils.randomSecretKey();
        const provider = remote(execution);
        await expect(s.executor.delegate(execution, provider)).rejects.toThrow(
            /cannot receive sealed variables/,
        );
        expect(provider.registerTemplate).not.toHaveBeenCalled();
        const info = await provider.getInfo();
        provider.getInfo.mockResolvedValue({
            ...info,
            encryptionPubkey: hex.encode(secp256k1.getPublicKey(secret, true)),
        });
        await s.executor.delegate(execution, provider);
        const [, sent] = provider.registerDelegation.mock.calls[0];
        const { preimage, ...rest } = vhtlc.bindings.variables;
        expect(sent).toMatchObject(rest);
        expect(sent.preimage).not.toBe(preimage);
        expect(hex.encode(open(secret, hex.decode(sent.preimage), execution.templateId))).toBe(
            preimage,
        );
    });
});
