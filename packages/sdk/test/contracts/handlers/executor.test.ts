import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import {
    contractHandlers,
    ContractManager,
    DelegatedContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    watchDelegatedContracts,
    type Contract,
    type ExecutorDefault,
} from "../../../src";
import { resolveUnilateralPath } from "../../../src/wallet/exit/path";
import { defaultVariables, instantiate } from "../../../src/script/executor/executorTemplate";
import { ArkadeScript } from "../../../src/arkade/script";
import { computeArkadeScriptPublicKey } from "../../../src/arkade/tweak";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { ArkAddress } from "../../../src/script/address";
import vectors from "../../fixtures/executor/vectors.json";
import { createMockIndexerProvider, createMockVtxo } from "../helpers";

const keys = {
    cosignerPubkey: vectors.cosignerPubkey,
    serverPubkey: vectors.serverPubkey,
    emulatorPubkey: vectors.emulatorPubkey,
};
const serverXOnly = hex.decode(vectors.serverPubkey).subarray(1);
// the variables of the vectors: 512 s and 1024 s in BIP 68, a day, 500 sats
const delegation = {
    exitDelay: 0x400001,
    renewalWindow: 86400,
    maxFee: 500,
    boardingExitDelay: 0x400002,
};

const params = (template: ExecutorDefault): Record<string, string> => ({
    template,
    owner: vectors.owner,
    exitDelay: String(delegation.exitDelay),
    renewalWindow: String(delegation.renewalWindow),
    maxFee: String(delegation.maxFee),
    ...(template === "boarding" ? { boardingExitDelay: String(delegation.boardingExitDelay) } : {}),
    cosignerPubKey: vectors.cosignerPubkey,
    serverPubKey: vectors.serverPubkey,
    emulatorPubKey: vectors.emulatorPubkey,
});

const contractOf = (template: ExecutorDefault): Contract => {
    const script = DelegatedContractHandler.createScript(params(template));
    return {
        type: "delegated",
        params: params(template),
        script: hex.encode(script.pkScript),
        address: script.address("tark", serverXOnly).encode(),
        state: "active",
        createdAt: 0,
    };
};

const leaves = (template: ExecutorDefault) =>
    vectors[template].tapscripts.map((s) => hex.decode(s));
const script = (leaf: [unknown, Uint8Array]) => leaf[1].subarray(0, -1);

describe("DelegatedContractHandler", () => {
    it("is registered under type 'delegated' and counts as generic spending", () => {
        expect(contractHandlers.get("delegated")).toBe(DelegatedContractHandler);
        expect(DelegatedContractHandler.isGenericallySpendable?.(contractOf("renewal"))).toBe(true);
    });

    it("derives the template variables of the Go engine, boarding needing its exit delay", () => {
        const owner = hex.decode(vectors.owner);
        expect(defaultVariables("renewal", owner, delegation)).toEqual(vectors.renewal.variables);
        expect(defaultVariables("boarding", owner, delegation)).toEqual(vectors.boarding.variables);
        const { boardingExitDelay: _, ...renewalOnly } = delegation;
        expect(() => defaultVariables("boarding", owner, renewalOnly)).toThrow(
            "boarding needs an exit delay",
        );
    });

    it("derives the renewal leaves and address of the Go engine", () => {
        const s = DelegatedContractHandler.createScript(params("renewal"));
        expect(s.scripts.map((l) => hex.encode(l))).toEqual(vectors.renewal.tapscripts);
        expect(hex.encode(s.pkScript)).toBe(vectors.renewal.pkScript);
        expect(s.address("tark", serverXOnly).encode()).toBe(vectors.renewal.address);
    });

    it("derives the boarding leaves and onchain address of the Go engine", () => {
        const s = DelegatedContractHandler.createScript(params("boarding"));
        expect(s.scripts.map((l) => hex.encode(l))).toEqual(vectors.boarding.tapscripts);
        expect(s.onchainAddress(networks.regtest)).toBe(vectors.boarding.address);
    });

    it("pushes a pubkey into an Arkade script x-only", () => {
        const owner = hex.decode(vectors.owner);
        const doc = {
            inputs: [
                {
                    contract: {
                        definition: {
                            constructorInputs: [{ name: "owner", type: "pubkey" }],
                            functions: [
                                {
                                    name: "pay",
                                    arkade: { asm: ["<owner>", "OP_DROP", "OP_1"] },
                                    leaves: [
                                        {
                                            asm: [
                                                "<SERVER_KEY>",
                                                "OP_CHECKSIGVERIFY",
                                                "<EMULATOR_KEY:pay>",
                                                "OP_CHECKSIG",
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                        arguments: { owner: "<owner>" },
                    },
                },
            ],
            outputs: [],
        };
        const covenant = concatBytes(
            ArkadeScript.encode([owner.subarray(1)]),
            new Uint8Array([0x75, 0x51]),
        );
        const tweaked = computeArkadeScriptPublicKey(hex.decode(vectors.emulatorPubkey), covenant);
        const [leaf] = instantiate(doc, doc.inputs[0].contract, { owner }, keys).scripts;
        expect(hex.encode(leaf)).toBe(
            `20${vectors.serverPubkey.slice(2)}ad20${hex.encode(tweaked)}ac`,
        );
    });

    it("reads the cosigner key of params stored under its former name", () => {
        const { cosignerPubKey, ...rest } = params("renewal");
        const typed = DelegatedContractHandler.deserializeParams({
            ...rest,
            delegatePubKey: cosignerPubKey,
        });
        expect(DelegatedContractHandler.serializeParams(typed)).toEqual(params("renewal"));
    });

    it("round-trips its params and refuses unknown templates, x-only keys and bad numbers", () => {
        for (const template of ["renewal", "boarding"] as const) {
            const p = params(template);
            const typed = DelegatedContractHandler.deserializeParams(p);
            expect(DelegatedContractHandler.serializeParams(typed)).toEqual(p);
        }
        const p = params("renewal");
        expect(() =>
            DelegatedContractHandler.deserializeParams({ ...p, template: "renewal_watch" }),
        ).toThrow(/unknown Executor template/);
        expect(() =>
            DelegatedContractHandler.deserializeParams({ ...p, owner: vectors.owner.slice(2) }),
        ).toThrow(/compressed/);
        expect(() => DelegatedContractHandler.deserializeParams({ ...p, maxFee: "-1" })).toThrow(
            /maxFee/,
        );
        expect(() =>
            DelegatedContractHandler.deserializeParams({
                ...params("boarding"),
                boardingExitDelay: "",
            }),
        ).toThrow(/boardingExitDelay/);
    });

    it.each(["renewal", "boarding"] as const)(
        "spends %s through forfeit with the operator and exit alone, never the emulator-enforced leaf",
        (template) => {
            const contract = contractOf(template);
            const s = DelegatedContractHandler.createScript(contract.params);
            const [forfeit, exit, covenant] = leaves(template);
            const all = (collaborative: boolean) =>
                DelegatedContractHandler.getAllSpendingPaths(s, contract, {
                    collaborative,
                    currentTime: 0,
                }).map((p) => script(p.leaf));

            expect(all(true)).toEqual([forfeit, exit]);
            expect(all(false)).toEqual([exit]);
            expect([...all(true), ...all(false)]).not.toContainEqual(covenant);
            const selected = DelegatedContractHandler.selectPath(s, contract, {
                collaborative: true,
                currentTime: 0,
            });
            expect(selected && script(selected.leaf)).toEqual(forfeit);
        },
    );

    it("gates the exit on its CSV", () => {
        const contract = contractOf("renewal");
        const s = DelegatedContractHandler.createScript(contract.params);
        const confirmedAt = 1_700_000_000;
        const at = (seconds: number) => ({
            collaborative: false,
            currentTime: (confirmedAt + seconds) * 1000,
            chainTime: confirmedAt + seconds,
            vtxo: createMockVtxo({
                status: { confirmed: true, block_time: confirmedAt, block_height: 100 },
            }),
        });
        expect(DelegatedContractHandler.selectPath(s, contract, at(10))).toBeNull();
        const path = DelegatedContractHandler.selectPath(s, contract, at(600));
        expect(path && script(path.leaf)).toEqual(leaves("renewal")[1]);
        expect(path?.sequence).toBe(delegation.exitDelay);
    });

    it("pre-signs an unroll of a delegated coin through the owner exit", async () => {
        const contract = contractOf("renewal");
        const repository = new InMemoryContractRepository();
        await repository.saveContract(contract);
        const resolved = await resolveUnilateralPath({
            vtxo: { txid: "00".repeat(32), vout: 0, tapTree: new Uint8Array() },
            scriptHex: contract.script,
            contractRepository: repository,
            currentTime: Date.now(),
        });
        expect(script(resolved.selection.leaf)).toEqual(leaves("renewal")[1]);
        expect(resolved.selection.sequence).toBe(delegation.exitDelay);
    });
});

describe("watchDelegatedContracts", () => {
    it("registers the wallet's renewal and boarding contracts, which then hold its virtual outputs", async () => {
        const indexerProvider = createMockIndexerProvider();
        const delegated = createMockVtxo({ script: vectors.renewal.pkScript, value: 4321 });
        indexerProvider.getVtxos = vi
            .fn()
            .mockImplementation(async ({ scripts }: { scripts?: string[] }) => ({
                vtxos: scripts?.includes(vectors.renewal.pkScript) ? [delegated] : [],
            }));
        const manager = await ContractManager.create({
            indexerProvider,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
        });
        const wallet = {
            identity: { compressedPublicKey: async () => hex.decode(vectors.owner) },
            getAddress: async () =>
                new ArkAddress(serverXOnly, new Uint8Array(32).fill(1), "tark").encode(),
            getContractManager: async () => manager,
        } as unknown as Parameters<typeof watchDelegatedContracts>[0];

        const contracts = await watchDelegatedContracts(wallet, keys, delegation);
        expect(contracts.map((c) => c.script)).toEqual([
            vectors.renewal.pkScript,
            vectors.boarding.pkScript,
        ]);
        expect(contracts[0].address).toBe(vectors.renewal.address);
        await expect(watchDelegatedContracts(wallet, keys, delegation)).resolves.toHaveLength(2);
        const { boardingExitDelay: _, ...renewalOnly } = delegation;
        await expect(watchDelegatedContracts(wallet, keys, renewalOnly)).resolves.toHaveLength(1);

        const held = await manager.getContractsWithVtxos({ script: vectors.renewal.pkScript });
        expect(held[0].vtxos.map((v) => v.value)).toEqual([4321]);
        expect(script(held[0].vtxos[0].forfeitTapLeafScript)).toEqual(leaves("renewal")[0]);
        manager.dispose();
    });
});
