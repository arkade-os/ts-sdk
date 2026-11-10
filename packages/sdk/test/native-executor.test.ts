import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    SingleKey,
    Transaction,
    Extension,
    UnknownPacket,
    type Contract,
    type IWallet,
} from "../src";
import { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } from "../src/extension/asset";
import {
    NativeExecutor,
    type Arkade,
    type ArkadeContract,
    type ContractArtifact,
} from "../src/arkade";

const artifact: ContractArtifact = {
    contractName: "Return",
    constructorInputs: [{ name: "payout", type: "bytes32" }],
    functions: [
        {
            name: "release",
            arkade: { inputs: [], asm: ["OP_1"] },
            leaves: [
                {
                    name: "release",
                    asm: [
                        "<SERVER_KEY>",
                        "OP_CHECKSIGVERIFY",
                        "<EMULATOR_KEY:release>",
                        "OP_CHECKSIG",
                    ],
                },
            ],
        },
    ],
};
const payout = "11".repeat(32);
const template = () => ({
    format: "delegateed-template/v1",
    type: "offchain",
    inputs: [
        {
            name: "funds",
            contract: { definition: { artifact: "artifact-id" }, arguments: { payout } },
            spend: { function: "release", leaf: "release" },
        },
    ],
    outputs: [{ name: "payout", index: 0, value: { from: "funds" }, locking: `5120${payout}` }],
    packets: { output_index: 1 },
});

async function setup() {
    const manager = {
        refreshOutpoints: vi.fn(),
        refreshVtxos: vi.fn(),
        updateContract: vi.fn(async (_script: string, updates: Partial<Contract>) =>
            Object.assign(registered, updates),
        ),
    };
    const coin = { txid: "aa".repeat(32), vout: 0, value: 50_000, isSpent: false, assets: [] };
    const source = new Transaction();
    source.addInput({ txid: "99".repeat(32), index: 0 });
    source.addOutput({ script: hex.decode(`5120${payout}`), amount: 50_000n });
    coin.txid = source.id;
    const indexer = {
        getVirtualTxs: vi.fn(async () => ({ txs: [base64.encode(source.toPSBT())] })),
    };
    let unspent = true;
    const send = vi.fn(async () => {
        unspent = false;
        return { txid: "bb".repeat(32) };
    });
    const builder = { from: vi.fn().mockReturnThis(), to: vi.fn().mockReturnThis(), send };
    const registered: Contract = {
        script: `5120${payout}`,
        address: "independent-address",
        type: "arkade",
        params: {},
        state: "active",
        createdAt: 1,
        metadata: { genericallySpendable: false },
    };
    const key = await SingleKey.fromHex("01".repeat(32)).compressedPublicKey();
    const contract = {
        address: "independent-address",
        pkScript: hex.decode(`5120${payout}`),
        keys: { serverKey: key.slice(1), emulatorKey: key },
        register: vi.fn(async () => registered),
        getUtxos: vi.fn(async () => (unspent ? [coin] : [])),
        functions: { release: vi.fn(() => builder) },
    };
    const arkade = {
        contractManager: manager,
        contract: vi.fn(() => contract as unknown as ArkadeContract),
        serverKey: key.slice(1),
        emulatorKey: key,
        indexer,
    } as unknown as Arkade;
    const wallet = {
        getContractManager: vi.fn(async () => manager),
        send: vi.fn(async () => "funding"),
    };
    const executor = new NativeExecutor(arkade, wallet as unknown as IWallet);
    const importTemplate = (doc: unknown = template()) =>
        executor.importTemplate(doc, { "artifact-id": artifact });
    return {
        executor,
        manager,
        coin,
        source,
        indexer,
        send,
        builder,
        contract,
        registered,
        arkade,
        wallet,
        key: hex.encode(key),
        importTemplate,
    };
}

async function twoPositions() {
    const s = await setup();
    s.source.addOutput({ script: hex.decode(`5120${payout}`), amount: 50_000n });
    s.coin.txid = s.source.id;
    const other = { ...s.coin, vout: 1 };
    s.contract.getUtxos.mockImplementation(async () =>
        [s.coin, other].filter((coin) => !coin.isSpent),
    );
    return { ...s, other };
}

function remote(s: Awaited<ReturnType<typeof setup>>) {
    return {
        getInfo: vi.fn(async () => ({ serverPubkey: s.key, emulatorPubkey: s.key })),
        registerArtifact: vi.fn(async (_document: unknown) => ({ id: "artifact-id" })),
        registerTemplate: vi.fn(async (_document: unknown) => ({ id: "renew-template" })),
        registerDelegation: vi.fn(async (_id: string, _variables?: Record<string, string>) => ({
            address: s.contract.address,
            status: "active",
        })),
    };
}

describe("SDK native template execution", () => {
    it("requires an explicit packet policy before constructing or registering a contract", async () => {
        const s = await setup();
        const doc: Record<string, unknown> = template();
        delete doc.packets;
        await expect(s.importTemplate(doc)).rejects.toThrow("NativeExecutor: missing 'packets'");
        expect(s.arkade.contract).not.toHaveBeenCalled();
        expect(s.contract.register).not.toHaveBeenCalled();
    });

    it.each([
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ])(
        "rejects invalid delegation expiry %s before any custom provider call",
        async (expiresAt) => {
            const s = await setup();
            const execution = await s.importTemplate();
            const provider = remote(s);
            await expect(
                s.executor.delegate(execution, provider as never, "renew-template", {}, expiresAt),
            ).rejects.toThrow(/invalid expiry/);
            for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
        },
    );

    it.each([undefined, 0, 4_102_444_800, Number.MAX_SAFE_INTEGER])(
        "forwards valid delegation expiry %s unchanged",
        async (expiresAt) => {
            const s = await setup();
            const execution = await s.importTemplate();
            const provider = remote(s);
            await s.executor.delegate(
                execution,
                provider as never,
                "renew-template",
                {},
                expiresAt,
            );
            expect(provider.registerDelegation).toHaveBeenCalledExactlyOnceWith(
                "renew-template",
                {},
                expiresAt ?? 0,
            );
        },
    );

    it("rejects a different template ID even when its watch has the same input address", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(s);
        await expect(
            s.executor.delegate(execution, provider as never, "other-payout-template"),
        ).rejects.toThrow(/template.*match/);
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it("rejects different payout variables before creating a remote watch", async () => {
        const s = await setup();
        const doc = { ...template(), variables: { destination: "bytes" } };
        doc.outputs[0].locking = "<destination>";
        const variables = { destination: `5120${payout}` };
        const execution = await s.executor.importTemplate(
            doc,
            { "artifact-id": artifact },
            variables,
        );
        const provider = remote(s);
        await expect(
            s.executor.delegate(execution, provider as never, "renew-template", {
                destination: `5120${"22".repeat(32)}`,
            }),
        ).rejects.toThrow(/variables.*match/);
        expect(provider.registerDelegation).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "delegates only captured documents, artifacts and variables (inline: %s)",
        async (inline) => {
            const s = await setup();
            const capturedArtifact = structuredClone(artifact);
            const doc: any = { ...template(), variables: { destination: "bytes" } };
            doc.outputs[0].locking = "<destination>";
            if (inline) doc.inputs[0].contract.definition = capturedArtifact;
            const expected = structuredClone(doc);
            const variables = { destination: `5120${payout}` };
            const pending = s.executor.importTemplate(
                doc,
                { "artifact-id": capturedArtifact },
                variables,
            );
            doc.outputs[0].locking = `5120${"22".repeat(32)}`;
            capturedArtifact.functions[0].arkade!.asm = ["OP_0"];
            variables.destination = `5120${"33".repeat(32)}`;
            const execution = await pending;
            const provider = remote(s);
            provider.registerArtifact.mockResolvedValue({ id: "registered-artifact" });
            if (!inline) expected.inputs[0].contract.definition.artifact = "registered-artifact";
            const supplied = { destination: `5120${payout}` };
            const delegated = s.executor.delegate(
                execution,
                provider as never,
                "renew-template",
                supplied,
            );
            supplied.destination = `5120${"44".repeat(32)}`;
            await delegated;
            if (inline) expect(provider.registerArtifact).not.toHaveBeenCalled();
            else expect(provider.registerArtifact).toHaveBeenCalledExactlyOnceWith(artifact);
            expect(provider.registerTemplate).toHaveBeenCalledExactlyOnceWith(expected);
            expect(provider.registerDelegation).toHaveBeenCalledWith(
                "renew-template",
                { destination: `5120${payout}` },
                0,
            );
            expect(hex.encode(execution.destination)).toBe(`5120${payout}`);
        },
    );

    it("keeps imported payout bytes private across exposed and builder mutations", async () => {
        const s = await twoPositions();
        const execution = await s.importTemplate();
        const expected = hex.decode(`5120${payout}`);
        execution.destination.fill(0);
        const received: Uint8Array[] = [];
        s.builder.to.mockImplementation((script: Uint8Array) => {
            received.push(script.slice());
            script.fill(1);
            return s.builder;
        });
        await s.executor.execute(execution, s.coin);
        execution.destination.fill(2);
        await s.executor.execute(execution, s.other);
        expect(received).toEqual([expected, expected]);
        expect(s.contract.pkScript).toEqual(expected);
    });

    it.each(["refreshOutpoints", "refreshVtxos"] as const)(
        "returns the accepted result when post-submit %s fails",
        async (method) => {
            const s = await setup();
            const execution = await s.importTemplate();
            const failure = new Error("indexer unavailable after acceptance");
            if (method === "refreshOutpoints") {
                s.manager.refreshOutpoints
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(failure);
            } else s.manager.refreshVtxos.mockRejectedValueOnce(failure);
            const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await expect(s.executor.execute(execution, s.coin)).resolves.toEqual({
                    txid: "bb".repeat(32),
                });
                expect(s.send).toHaveBeenCalledOnce();
                await expect(s.executor.execute(execution, s.coin)).rejects.toThrow(/spent/);
                expect(s.send).toHaveBeenCalledOnce();
            } finally {
                warning.mockRestore();
            }
        },
    );

    it("propagates pre-submit refresh and submission failures unchanged", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const refreshFailure = new Error("refresh before dispatch failed");
        s.manager.refreshOutpoints.mockRejectedValueOnce(refreshFailure);
        await expect(s.executor.execute(execution, s.coin)).rejects.toBe(refreshFailure);
        expect(s.send).not.toHaveBeenCalled();
        const submitFailure = new Error("response lost");
        s.send.mockRejectedValueOnce(submitFailure);
        await expect(s.executor.execute(execution, s.coin)).rejects.toBe(submitFailure);
        expect(s.manager.refreshVtxos).not.toHaveBeenCalled();
    });

    it("captures a queued source before an earlier pre-submit hook fails without dispatch", async () => {
        const s = await twoPositions();
        const execution = await s.importTemplate();
        const point = { txid: s.coin.txid, vout: s.coin.vout };
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
        const dispatch = vi.fn();
        s.send.mockImplementation(async (...args: unknown[]) => {
            const options = args[0] as {
                beforeEmulatorSubmit?: (proposal: unknown) => Promise<void>;
            };
            await options.beforeEmulatorSubmit?.({
                txid: s.source.id,
                arkTx: base64.encode(s.source.toPSBT()),
                checkpointTxs: [],
            });
            const input = s.builder.from.mock.lastCall![0];
            const coin = [s.coin, s.other].find(
                (coin) => coin.txid === input.txid && coin.vout === input.vout,
            )!;
            dispatch({ txid: coin.txid, vout: coin.vout });
            coin.isSpent = true;
            return { txid: "bb".repeat(32) };
        });
        const first = s.executor.execute(execution, original, { beforeEmulatorSubmit: hook });
        const firstResult = expect(first).rejects.toBe(failure);
        await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
        const second = s.executor.execute(execution, point);
        point.vout = s.other.vout;
        release();
        await firstResult;
        await second;
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(original);
        expect(s.coin.isSpent).toBe(true);
        expect(s.other.isSpent).toBe(false);
        expect(point).toEqual({ ...original, vout: s.other.vout });
        expect(Object.isFrozen(point)).toBe(false);
    });

    it.each(["manager lookup", "send"])(
        "retains the original immutable refresh point during %s",
        async (stage) => {
            const s = await twoPositions();
            const execution = await s.importTemplate();
            const point = { txid: s.coin.txid, vout: s.coin.vout, label: "caller-owned" };
            const original = { txid: point.txid, vout: point.vout };
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            s.wallet.getContractManager.mockClear();
            if (stage === "manager lookup")
                s.wallet.getContractManager.mockImplementationOnce(async () => {
                    await gate;
                    return s.manager;
                });
            else
                s.send.mockImplementationOnce(async () => {
                    await gate;
                    return { txid: "bb".repeat(32) };
                });
            const pending = s.executor.execute(execution, point);
            await vi.waitFor(() =>
                expect(
                    stage === "manager lookup" ? s.wallet.getContractManager : s.send,
                ).toHaveBeenCalledOnce(),
            );
            point.vout = s.other.vout;
            release();
            await pending;
            expect(s.builder.from).toHaveBeenCalledWith(expect.objectContaining(original));
            expect(s.manager.refreshOutpoints).toHaveBeenCalledTimes(2);
            for (const [points] of s.manager.refreshOutpoints.mock.calls) {
                expect(points).toEqual([original]);
                expect(Object.isFrozen(points[0])).toBe(true);
                expect(points[0]).not.toBe(point);
            }
            expect(point).toEqual({ ...original, vout: s.other.vout, label: "caller-owned" });
            expect(Object.isFrozen(point)).toBe(false);
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
        expect(s.contract.getUtxos).not.toHaveBeenCalled();
        expect(s.indexer.getVirtualTxs).not.toHaveBeenCalled();
        expect(s.send).not.toHaveBeenCalled();
    });

    it("rejects a throwing source getter immediately without poisoning a pending execution", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        s.manager.refreshOutpoints.mockImplementationOnce(() => gate);
        const valid = s.executor.execute(execution, s.coin);
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
        let rejected = false;
        const rejection = invalid.catch((error) => {
            expect(error).toBe(failure);
            rejected = true;
        });
        try {
            await vi.waitFor(() => expect(rejected).toBe(true));
            await expect(s.executor.execute(execution, { txid: "bad", vout: 0 })).rejects.toThrow(
                "invalid source outpoint",
            );
            expect(s.manager.refreshOutpoints).toHaveBeenCalledOnce();
        } finally {
            release();
            await Promise.all([valid, rejection]);
        }
        expect(s.send).toHaveBeenCalledOnce();
        expect(s.manager.refreshOutpoints).toHaveBeenCalledTimes(2);
    });

    it.each(["address", "script"] as const)(
        "refuses funding when the registered %s differs from the derived contract",
        async (field) => {
            const s = await setup();
            s.registered[field] =
                field === "address" ? "different-address" : `5120${"22".repeat(32)}`;
            const before = structuredClone(s.registered);
            await expect(
                s.importTemplate().then((execution) => s.executor.fund(execution, 50_000)),
            ).rejects.toThrow(/registered contract does not match derived script or address/);
            expect(s.wallet.send).not.toHaveBeenCalled();
            expect(s.registered).toEqual(before);
        },
    );

    it("refuses to fund a template whose existing contract permits generic spending", async () => {
        const s = await setup();
        s.registered.metadata = { genericallySpendable: true, legacy: "keep" };
        const before = structuredClone(s.registered);
        await expect(
            s.importTemplate().then((execution) => s.executor.fund(execution, 50_000)),
        ).rejects.toThrow(/existing contract permits generic spending/);
        expect(s.wallet.send).not.toHaveBeenCalled();
        expect(s.registered).toEqual(before);
    });

    it.each([undefined, false])("keeps the existing closed spend gate %s", async (gate) => {
        const s = await setup();
        s.registered.metadata = gate === undefined ? undefined : { genericallySpendable: gate };
        await s.executor.fund(await s.importTemplate(), 50_000);
        expect(s.wallet.send).toHaveBeenCalledOnce();
        expect(s.registered.metadata?.genericallySpendable).toBe(false);
    });

    it("rejects an application packet rather than silently dropping its state", async () => {
        const s = await setup();
        s.source.addOutput(Extension.create([new UnknownPacket(2, new Uint8Array([1]))]).txOut());
        s.coin.txid = s.source.id;
        await expect(s.executor.execute(await s.importTemplate(), s.coin)).rejects.toThrow(
            /unsupported packet 2/,
        );
        expect(s.send).not.toHaveBeenCalled();
    });

    it.each([
        [1, true],
        [0, false],
    ])("spends a position funded beside asset change at vout %i", async (assetVout, spends) => {
        const s = await setup();
        const group = AssetGroup.create(
            AssetId.create("cc".repeat(32), 0),
            null,
            [AssetInput.create(0, 5n)],
            [AssetOutput.create(assetVout, 5n)],
            [],
        );
        s.source.addOutput({ script: hex.decode(`5120${"33".repeat(32)}`), amount: 1_000n });
        s.source.addOutput(Extension.create([Packet.create([group])]).txOut());
        s.coin.txid = s.source.id;
        const run = s.executor.execute(await s.importTemplate(), s.coin);
        if (spends) {
            await run;
            expect(s.send).toHaveBeenCalledOnce();
        } else {
            await expect(run).rejects.toThrow(/carries assets/);
            expect(s.send).not.toHaveBeenCalled();
        }
    });

    it("verifies the tracked amount against the actual creating transaction", async () => {
        const s = await setup();
        s.coin.value++;
        await expect(s.executor.execute(await s.importTemplate(), s.coin)).rejects.toThrow(
            /does not match/,
        );
        expect(s.send).not.toHaveBeenCalled();
    });
    it("rejects a CSV covenant before locking funds in an offchain-only template", async () => {
        const s = await setup();
        const csvArtifact = structuredClone(artifact);
        csvArtifact.functions[0].leaves[0].asm.unshift("1", "OP_CHECKSEQUENCEVERIFY", "OP_DROP");
        await expect(
            s.executor.importTemplate(template(), { "artifact-id": csvArtifact }),
        ).rejects.toThrow(/CSV/);
        expect(s.contract.register).not.toHaveBeenCalled();
    });

    it.each([
        ["hash condition", ["OP_SHA256", "<lock>", "OP_EQUAL", "OP_VERIFY"]],
        ["CLTV", ["500", "OP_CHECKLOCKTIMEVERIFY", "OP_DROP"]],
    ])("rejects a %s leaf without witness metadata before funding", async (_, prefix) => {
        const s = await setup();
        const guarded = structuredClone(artifact);
        guarded.constructorInputs.push({ name: "lock", type: "bytes32" });
        guarded.functions[0].leaves[0].asm.unshift(...prefix);
        const doc = template();
        Object.assign(doc.inputs[0].contract.arguments, { lock: "22".repeat(32) });
        await expect(s.executor.importTemplate(doc, { "artifact-id": guarded })).rejects.toThrow(
            /conditions/,
        );
        expect(s.contract.register).not.toHaveBeenCalled();
    });

    it("rejects an external signer before allowing funding", async () => {
        const s = await setup();
        const signed = structuredClone(artifact);
        signed.constructorInputs.push({ name: "owner", type: "pubkey" });
        signed.functions[0].leaves[0].asm.unshift("<owner>", "OP_CHECKSIGVERIFY");
        const doc = template();
        Object.assign(doc.inputs[0].contract.arguments, { owner: s.key });
        await expect(s.executor.importTemplate(doc, { "artifact-id": signed })).rejects.toThrow(
            /signers/,
        );
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it("uses the existing wallet for funding and refreshes the exact consumed outpoint", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        await s.executor.fund(execution, 50_000);
        expect(s.wallet.send).toHaveBeenCalledWith({
            address: "independent-address",
            amount: 50_000,
        });
        expect(s.contract.register).toHaveBeenCalledWith({
            metadata: {
                genericallySpendable: false,
                nativeExecution: {
                    document: template(),
                    variables: {},
                    plan: { version: 1, functionName: "release", destinationHex: `5120${payout}` },
                },
            },
        });
        await s.executor.execute(execution, s.coin);
        expect(s.manager.refreshOutpoints).toHaveBeenCalledWith([
            { txid: s.coin.txid, vout: s.coin.vout },
        ]);
    });

    it("serializes competing attempts and never selects a replacement coin", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const results = await Promise.allSettled([
            s.executor.execute(execution, s.coin),
            s.executor.execute(execution, s.coin),
        ]);
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
        expect(s.send).toHaveBeenCalledTimes(1);
        expect(s.indexer.getVirtualTxs).toHaveBeenCalledTimes(1);
        expect(s.builder.to).toHaveBeenCalledWith(hex.decode(`5120${payout}`), 50_000n);
    });

    it("serializes executors sharing one wallet before re-reading the same position", async () => {
        const s = await setup();
        const other = new NativeExecutor(s.arkade, s.wallet as unknown as IWallet);
        const first = await s.importTemplate();
        const second = await other.importTemplate(template(), { "artifact-id": artifact });
        const results = await Promise.allSettled([
            s.executor.execute(first, s.coin),
            other.execute(second, s.coin),
        ]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        expect(results[1]).toMatchObject({
            reason: expect.objectContaining({
                message: expect.stringMatching(/position is missing/),
            }),
        });
        expect(s.send).toHaveBeenCalledOnce();
        expect(s.indexer.getVirtualTxs).toHaveBeenCalledOnce();
        expect(s.contract.getUtxos).toHaveBeenCalledTimes(2);
    });

    it("lets another wallet execute while one wallet is waiting for its position refresh", async () => {
        const first = await setup();
        const second = await setup();
        const firstExecution = await first.importTemplate();
        const secondExecution = await second.importTemplate();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        first.manager.refreshOutpoints.mockImplementationOnce(() => gate);
        const pending = first.executor.execute(firstExecution, first.coin);
        let completed = false;
        const independent = second.executor.execute(secondExecution, second.coin).then(() => {
            completed = true;
        });
        try {
            await vi.waitFor(() => expect(completed).toBe(true));
            expect(first.send).not.toHaveBeenCalled();
            expect(second.send).toHaveBeenCalledOnce();
        } finally {
            release();
            await Promise.all([pending, independent]);
        }
        expect(first.send).toHaveBeenCalledOnce();
    });

    it("continues the shared wallet queue after a pre-submit failure", async () => {
        const s = await setup();
        const other = new NativeExecutor(s.arkade, s.wallet as unknown as IWallet);
        const first = await s.importTemplate();
        const second = await other.importTemplate(template(), { "artifact-id": artifact });
        const failure = new Error("creating transaction unavailable");
        s.indexer.getVirtualTxs.mockRejectedValueOnce(failure);
        const results = await Promise.allSettled([
            s.executor.execute(first, s.coin),
            other.execute(second, s.coin),
        ]);
        expect(results[0]).toMatchObject({ status: "rejected", reason: failure });
        expect(results[1].status).toBe("fulfilled");
        expect(s.send).toHaveBeenCalledOnce();
        expect(s.indexer.getVirtualTxs).toHaveBeenCalledTimes(2);
    });

    it("refuses a second manager and another executor's imported handle", async () => {
        const s = await setup();
        const other = await setup();
        const execution = await other.importTemplate();
        await expect(s.executor.fund(execution, 50_000)).rejects.toThrow(/another executor/);
        s.wallet.getContractManager.mockResolvedValue({} as never);
        await expect(s.importTemplate()).rejects.toThrow(/existing contract manager/);
    });

    it("rejects asset-bearing positions instead of dropping assets", async () => {
        const s = await setup();
        s.coin.assets.push({ assetId: "ab", amount: 1n } as never);
        await expect(s.executor.execute(await s.importTemplate(), s.coin)).rejects.toThrow(
            /contains assets/,
        );
        expect(s.send).not.toHaveBeenCalled();
    });

    it.each([
        [
            "intent transaction",
            (t: any) => {
                t.type = "intent";
            },
        ],
        [
            "secret",
            (t: any) => {
                t.secrets = { preimage: {} };
            },
        ],
        [
            "trigger",
            (t: any) => {
                t.trigger = {};
            },
        ],
        [
            "expiry schedule",
            (t: any) => {
                t.inputs[0].schedule = { before_expiry_seconds: 1024 };
            },
        ],
        [
            "second input",
            (t: any) => {
                t.inputs.push(t.inputs[0]);
            },
        ],
        [
            "asset route",
            (t: any) => {
                t.outputs[0].assets = [];
            },
        ],
        [
            "amount expression",
            (t: any) => {
                t.outputs[0].value.amount = "$(funds.value - 1)";
            },
        ],
        [
            "fees",
            (t: any) => {
                t.fees = { from: "funds", max: 1 };
            },
        ],
        [
            "packet advertisement",
            (t: any) => {
                t.packets.advertise = [];
            },
        ],
        [
            "packet location",
            (t: any) => {
                t.packets.output_index = 2;
            },
        ],
    ])("fails closed on %s before persisting or funding", async (_, mutate) => {
        const s = await setup();
        const doc = template();
        mutate(doc);
        await expect(s.importTemplate(doc)).rejects.toThrow();
        expect(s.contract.register).not.toHaveBeenCalled();
        expect(s.wallet.send).not.toHaveBeenCalled();
    });

    it("checks pinned keys and the independently derived address before funding", async () => {
        const s = await setup();
        const execution = await s.importTemplate();
        const provider = remote(s);
        provider.registerDelegation.mockResolvedValue({
            address: "wrong-address",
            status: "active",
        });
        await expect(
            s.executor.delegate(execution, provider as never, "renew-template"),
        ).rejects.toThrow(/different address/);
        provider.getInfo.mockResolvedValue({
            serverPubkey: `02${"22".repeat(32)}`,
            emulatorPubkey: s.key,
        });
        await expect(
            s.executor.delegate(execution, provider as never, "renew-template"),
        ).rejects.toThrow(/keys differ/);
        expect(provider.registerDelegation).toHaveBeenCalledTimes(1);
        expect(s.wallet.send).not.toHaveBeenCalled();
    });
});
