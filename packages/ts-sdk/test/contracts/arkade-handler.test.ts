import { describe, it, expect, beforeEach, vi } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    contractHandlers,
    ArkadeContractHandler,
    ContractManager,
    CSVMultisigTapscript,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    PathContext,
    type Contract,
    type EmulatorInfo,
    type EmulatorProvider,
} from "../../src";
import {
    createMockIndexerProvider,
    createMockVtxo,
    TEST_PUB_KEY,
    TEST_PUB_KEY_HEX,
    TEST_SERVER_PUB_KEY,
    TEST_SERVER_PUB_KEY_HEX,
    TEST_DELEGATE_PUB_KEY,
} from "./helpers";

const HASH = new Uint8Array(20).fill(7);
const EMULATOR_KEY = TEST_DELEGATE_PUB_KEY;

const payTo = [
    "DUP",
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "$receiver",
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "$amount",
    "EQUAL",
] as arkade.AsmToken[];

/** Multisig + CSV-exit program: the "default vtxo" shape expressed as a Program. */
function multisigProgram() {
    return {
        version: 0,
        functions: {
            cooperative: {
                tapscript: { signers: ["user", "server"] },
            },
            exit: {
                tapscript: {
                    signers: ["user"],
                    csv: { type: "blocks", value: 144n },
                },
            },
        },
    } satisfies arkade.Program;
}

/** Covenant HTLC program (same shape as the PR's own tests). */
function htlcProgram() {
    return {
        version: 0,
        params: ["hash", "receiver", "amount"],
        functions: {
            claim: {
                inputs: [{ name: "preimage", type: "bytes" }] as const,
                tapscript: {
                    signers: ["server"],
                    asm: ["HASH160", "$hash", "EQUALVERIFY"],
                    witness: ["preimage"],
                },
                arkadeScript: { asm: payTo, witness: [0] },
            },
            exit: {
                tapscript: {
                    signers: ["user"],
                    csv: { type: "blocks", value: 144n },
                },
            },
        },
    } satisfies arkade.Program;
}

function htlcArgs() {
    return { hash: HASH, receiver: TEST_PUB_KEY, amount: 10_000n };
}

function stubProviders() {
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [TEST_SERVER_PUB_KEY],
        }).script,
    );
    const arkProvider = {
        async getInfo() {
            return {
                signerPubkey: "02" + TEST_SERVER_PUB_KEY_HEX,
                checkpointTapscript,
            } as any;
        },
        async submitTx(): Promise<never> {
            throw new Error("not used");
        },
        async finalizeTx() {},
    };
    const emulator: EmulatorProvider = {
        async getInfo(): Promise<EmulatorInfo> {
            return { signerPubkey: hex.encode(EMULATOR_KEY) };
        },
        async submitTx(arkTx: string, checkpointTxs: string[]) {
            return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
        },
        async submitIntent(): Promise<never> {
            throw new Error("x");
        },
        async submitFinalization(): Promise<never> {
            throw new Error("x");
        },
        async submitOnchainTx(): Promise<never> {
            throw new Error("x");
        },
    };
    const identity = {
        async xOnlyPublicKey() {
            return TEST_PUB_KEY;
        },
        async sign(tx: any) {
            return tx;
        },
        async signerSession(): Promise<never> {
            throw new Error("not used");
        },
    } as any;
    return { arkProvider, emulator, identity };
}

async function connectArkade(contractManager?: any) {
    const { arkProvider, emulator, identity } = stubProviders();
    return arkade.Arkade.connect({
        arkade: arkProvider,
        emulator,
        identity,
        network: networks.regtest,
        contractManager,
    });
}

function handlerKeys() {
    return {
        serverKey: TEST_SERVER_PUB_KEY,
        userKey: TEST_PUB_KEY,
        emulatorKey: EMULATOR_KEY,
    };
}

describe("ArkadeContractHandler", () => {
    it("is registered in the global handler registry under type 'arkade'", () => {
        expect(ArkadeContractHandler).toBeDefined();
        expect(contractHandlers.get("arkade")).toBe(ArkadeContractHandler);
    });

    it("round-trips program, args and keys through serializeParams/deserializeParams", () => {
        const params = ArkadeContractHandler.serializeParams({
            program: htlcProgram(),
            args: htlcArgs(),
            ...handlerKeys(),
        });

        // Every value must be a string (Contract.params contract).
        for (const v of Object.values(params)) {
            expect(typeof v).toBe("string");
        }

        const typed = ArkadeContractHandler.deserializeParams(params);
        expect(typed.serverKey).toEqual(TEST_SERVER_PUB_KEY);
        expect(typed.userKey).toEqual(TEST_PUB_KEY);
        expect(typed.emulatorKey).toEqual(EMULATOR_KEY);
        expect(typed.args.amount).toBe(10_000n);
        expect(typed.args.hash).toEqual(HASH);

        const claim = typed.program.functions.claim;
        expect(claim.tapscript.signers).toEqual(["server"]);
        expect(claim.tapscript.asm?.[0]).toBe("HASH160");
        expect(claim.tapscript.asm?.[1]).toBe("$hash");
        expect(claim.arkadeScript?.asm).toBeDefined();
        const exit = typed.program.functions.exit;
        expect(exit.tapscript.csv).toEqual({ type: "blocks", value: 144n });
    });

    it("createScript derives the exact same taproot script as Arkade.contract()", async () => {
        const ark = await connectArkade();
        const contract = ark.contract(htlcProgram(), htlcArgs());

        const params = ArkadeContractHandler.serializeParams({
            program: htlcProgram(),
            args: htlcArgs(),
            ...handlerKeys(),
        });
        const script = ArkadeContractHandler.createScript(params);

        expect(hex.encode(script.pkScript)).toBe(hex.encode(contract.pkScript));
        expect(script.address(networks.regtest.hrp, TEST_SERVER_PUB_KEY).encode()).toBe(
            contract.address,
        );
    });

    it("stringifyArtifact emits parseArtifact-compatible JSON (0x-hex bytes)", () => {
        const json = arkade.stringifyArtifact(htlcProgram());
        const parsed = arkade.parseArtifact(JSON.parse(json));
        // bytes come back as Uint8Array, bigints as bigint
        const claim = parsed.functions.claim;
        expect(claim.tapscript.signers).toEqual(["server"]);
        expect(claim.tapscript.witness).toEqual(["preimage"]);
        expect(parsed.functions.exit.tapscript.csv?.value).toBe(144n);
    });

    describe("path selection", () => {
        const baseContext: PathContext = {
            collaborative: true,
            currentTime: Date.now(),
            walletPubKey: TEST_PUB_KEY_HEX,
        };

        function makeContract(program: arkade.Program, args = {}): Contract {
            const params = ArkadeContractHandler.serializeParams({
                program,
                args,
                ...handlerKeys(),
            });
            const script = ArkadeContractHandler.createScript(params);
            return {
                type: "arkade",
                params,
                script: hex.encode(script.pkScript),
                address: script.address(networks.regtest.hrp, TEST_SERVER_PUB_KEY).encode(),
                state: "active",
                createdAt: Date.now(),
            };
        }

        it("selects the collaborative multisig leaf when collaborative", () => {
            const contract = makeContract(multisigProgram());
            const script = ArkadeContractHandler.createScript(contract.params);
            const path = ArkadeContractHandler.selectPath(script, contract, baseContext);
            expect(path).not.toBeNull();
            expect(path!.sequence).toBeUndefined();
        });

        it("gates the CSV exit path on the timelock in unilateral context", () => {
            const contract = makeContract(multisigProgram());
            const script = ArkadeContractHandler.createScript(contract.params);

            const young: PathContext = {
                ...baseContext,
                collaborative: false,
                blockHeight: 150,
                vtxo: createMockVtxo({
                    status: { confirmed: true, block_height: 100 },
                }),
            };
            expect(ArkadeContractHandler.selectPath(script, contract, young)).toBeNull();

            const mature: PathContext = {
                ...young,
                blockHeight: 100 + 144,
            };
            const path = ArkadeContractHandler.selectPath(script, contract, mature);
            expect(path).not.toBeNull();
            expect(path!.sequence).toBeDefined();
        });

        it("never selects covenant (arkadeScript) paths", () => {
            const contract = makeContract(htlcProgram(), htlcArgs());
            const script = ArkadeContractHandler.createScript(contract.params);

            // Collaborative: the only collaborative-capable function is the
            // covenant claim, which must NOT be offered by the generic handler.
            const path = ArkadeContractHandler.selectPath(script, contract, baseContext);
            expect(path).toBeNull();

            const all = ArkadeContractHandler.getAllSpendingPaths(script, contract, baseContext);
            for (const p of all) {
                // exit leaf only — never the covenant claim leaf
                expect(p.leaf).toBe(script.compiled[1].tapLeafScript);
            }
        });

        it("skips condition paths whose witness needs call arguments", () => {
            const program = {
                version: 0,
                params: ["hash"],
                functions: {
                    claim: {
                        inputs: [{ name: "preimage", type: "bytes" }] as const,
                        tapscript: {
                            signers: ["user", "server"],
                            asm: ["HASH160", "$hash", "EQUALVERIFY"],
                            witness: ["preimage"],
                        },
                    },
                },
            } satisfies arkade.Program;
            const contract = makeContract(program, { hash: HASH });
            const script = ArkadeContractHandler.createScript(contract.params);
            expect(ArkadeContractHandler.selectPath(script, contract, baseContext)).toBeNull();
        });

        it("resolves literal condition witness into extraWitness", () => {
            const preimage = new Uint8Array(32).fill(0x42);
            const program = {
                version: 0,
                params: ["hash", "preimage"],
                functions: {
                    claim: {
                        tapscript: {
                            signers: ["user", "server"],
                            asm: ["HASH160", "$hash", "EQUALVERIFY"],
                            witness: ["$preimage"],
                        },
                    },
                },
            } satisfies arkade.Program;
            const contract = makeContract(program, { hash: HASH, preimage });
            const script = ArkadeContractHandler.createScript(contract.params);
            const path = ArkadeContractHandler.selectPath(script, contract, baseContext);
            expect(path).not.toBeNull();
            expect(path!.extraWitness).toEqual([preimage]);
        });
    });
});

describe("ArkadeContract ↔ ContractManager integration", () => {
    let contractRepository: InMemoryContractRepository;
    let walletRepository: InMemoryWalletRepository;
    let indexerProvider: ReturnType<typeof createMockIndexerProvider>;
    let manager: ContractManager;

    beforeEach(async () => {
        contractRepository = new InMemoryContractRepository();
        walletRepository = new InMemoryWalletRepository();
        indexerProvider = createMockIndexerProvider();
        manager = await ContractManager.create({
            indexerProvider,
            contractRepository,
            walletRepository,
        });
    });

    it("createContract accepts handler-serialized arkade params (script validation passes)", async () => {
        const params = ArkadeContractHandler.serializeParams({
            program: multisigProgram(),
            args: {},
            ...handlerKeys(),
        });
        const script = ArkadeContractHandler.createScript(params);

        const contract = await manager.createContract({
            type: "arkade",
            params,
            script: hex.encode(script.pkScript),
            address: script.address(networks.regtest.hrp, TEST_SERVER_PUB_KEY).encode(),
        });

        expect(contract.type).toBe("arkade");
        const [persisted] = await manager.getContracts({ script: contract.script });
        expect(persisted).toBeDefined();
    });

    it("ArkadeContract.register persists the contract through the manager", async () => {
        const ark = await connectArkade(manager);
        const contract = ark.contract(multisigProgram());

        const row = await contract.register({ label: "my multisig" });

        expect(row.type).toBe("arkade");
        expect(row.label).toBe("my multisig");
        expect(row.script).toBe(hex.encode(contract.pkScript));
        const [persisted] = await manager.getContracts({ script: row.script });
        expect(persisted).toBeDefined();
        // Registering twice is idempotent (script-keyed upsert).
        await expect(contract.register()).resolves.toBeDefined();
    });

    it("getUtxos reads repository state through the manager once registered", async () => {
        const ark = await connectArkade(manager);
        const contract = ark.contract(multisigProgram());
        const scriptHex = hex.encode(contract.pkScript);

        // The indexer hydration path returns one VTXO for this contract.
        indexerProvider.getVtxos = vi
            .fn()
            .mockResolvedValue({ vtxos: [createMockVtxo({ script: scriptHex, value: 4321 })] });

        await contract.register();
        const utxos = await contract.getUtxos();
        expect(utxos).toHaveLength(1);
        expect(utxos[0].value).toBe(4321);
        expect(await contract.getBalance()).toBe(4321n);
    });

    it("fromContract rehydrates a callable contract from the persisted row", async () => {
        const ark = await connectArkade(manager);
        const original = ark.contract(htlcProgram(), htlcArgs());
        const row = await original.register({ label: "htlc" });

        const [persisted] = await manager.getContracts({ script: row.script });
        const restored = arkade.ArkadeContract.fromContract(ark, persisted);

        expect(restored.address).toBe(original.address);
        expect(hex.encode(restored.pkScript)).toBe(hex.encode(original.pkScript));
        expect(typeof restored.functions.claim).toBe("function");
        expect(typeof restored.functions.exit).toBe("function");
    });
});
