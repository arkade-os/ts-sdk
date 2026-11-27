import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { RawWitness, Script } from "@scure/btc-signer";
import { ConditionWitness, getArkPsbtFields } from "../src/utils/unknownFields";
import {
    arkade,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    Extension,
    networks,
    Transaction,
    VtxoScript,
    type EmulatorInfo,
    type EmulatorProvider,
    type IContractManager,
    type Identity,
    type RelativeTimelock,
} from "../src";
import { getVirtualTxs, mintCoin } from "./helpers/prevArkTx";
import { compile, type CompileInput } from "../src/compiler";

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}

const COIN = mintCoin(10_000);
const HASH = new Uint8Array(20).fill(7);
const AMOUNT = 10_000n;

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

// `satisfies arkade.Program` (not `: arkade.Program`) preserves the literal
// type, and `inputs: [...] as const` keeps it a tuple — so the contract's
// `functions.claim` is typed `({ tapscript: [preimage: Uint8Array] }) => ...`
// with exact arity, rather than falling back to the loose `({ tapscript?, arkadeScript? })`.
function htlcProgram() {
    return {
        version: 1,
        params: [
            { name: "hash", type: "bytes20" },
            { name: "receiver", type: "pubkey" },
            { name: "amount", type: "int" },
            { name: "server", type: "pubkey" },
        ],
        functions: {
            claim: {
                tapscript: {
                    signers: ["$server"],
                    asm: ["HASH160", "$hash", "EQUALVERIFY"],
                    inputs: [{ name: "preimage", type: "bytes" }] as const,
                    witness: ["preimage"],
                },
                arkadeScript: { asm: payTo, witness: [0] },
            },
        },
    } satisfies arkade.Program;
}

// Compile-time guard for the strong typing — never executed; exists only so
// `tsc --noEmit` fails if the input-descriptor → argument-type inference breaks.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function _typecheckStrongInputs(ark: arkade.Arkade) {
    const c = ark.contract(htlcProgram(), {});
    c.functions.claim({ tapscript: [new Uint8Array(32)] }); // ok: `preimage` is a Uint8Array
    // @ts-expect-error preimage must be Uint8Array, not a number
    c.functions.claim({ tapscript: [123] });
    // @ts-expect-error claim takes its tapscript argument
    c.functions.claim();
    // @ts-expect-error claim's arkadeScript declares no inputs
    c.functions.claim({ tapscript: [new Uint8Array(32)], arkadeScript: [0n] });
    // @ts-expect-error no such function
    c.functions.nope();
}

// Pure-tapscript program (no arkadeScript) — the non-covenant branch, which is
// the only one that reaches `arkProvider.submitTx`/`finalizeTx`.
function exitProgram() {
    return {
        version: 1,
        params: [
            { name: "server", type: "pubkey" },
            { name: "user", type: "pubkey" },
        ],
        functions: { exit: { tapscript: { signers: ["$server", "$user"] } } },
    } satisfies arkade.Program;
}

const stubIdentity = (key: Uint8Array) =>
    ({ xOnlyPublicKey: async () => key, sign: async (tx: any) => tx }) as any;

function stubProviders(server: Uint8Array, emulatorKey: Uint8Array, indexerVtxos?: unknown[]) {
    const checkpointTapscript = hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [server],
        }).script,
    );
    const arkProvider = {
        async getInfo() {
            return { signerPubkey: "02" + hex.encode(server), checkpointTapscript } as any;
        },
        async submitTx() {
            throw new Error("not used");
        },
        async finalizeTx() {},
    };
    const indexer = {
        async getVtxos() {
            return { vtxos: (indexerVtxos ?? [{ ...COIN }]) as any[] };
        },
        getVirtualTxs,
    };
    const captured: { arkTx?: string } = {};
    const emulator: EmulatorProvider = {
        async getInfo(): Promise<EmulatorInfo> {
            return { signerPubkey: hex.encode(emulatorKey) };
        },
        async submitTx(arkTx: string, checkpointTxs: string[]) {
            captured.arkTx = arkTx;
            return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
        },
        async submitIntent() {
            throw new Error("x");
        },
        async submitFinalization() {
            throw new Error("x");
        },
        async submitOnchainTx() {
            throw new Error("x");
        },
    };
    return { arkProvider, indexer, emulator, captured };
}

/**
 * Minimal `IContractManager` that reports every script it is asked about as
 * registered, holding `vtxos`. The test builds exactly one contract, so echoing
 * the queried script is enough to put `getUtxos` on the manager-backed branch.
 */
function stubManager(vtxos: unknown[]): IContractManager {
    return {
        async getContracts(filter?: { script?: string }) {
            return [{ script: filter?.script }];
        },
        async getContractsWithVtxos(filter?: { script?: string }) {
            return [{ contract: { script: filter?.script }, vtxos }];
        },
    } as unknown as IContractManager;
}

describe("arkade.Arkade / ArkadeContract", () => {
    const server = xOnly();
    const emulatorKey = xOnly();
    const receiver = xOnly(); // 32-byte witness program
    const args = { hash: HASH, receiver, amount: AMOUNT };

    async function connect(
        opts: {
            identity?: Identity;
            contractManager?: IContractManager;
            indexerVtxos?: unknown[];
        } = {},
    ) {
        const { arkProvider, indexer, emulator, captured } = stubProviders(
            server,
            emulatorKey,
            opts.indexerVtxos,
        );
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer,
            identity: opts.identity,
            contractManager: opts.contractManager,
            network: networks.regtest,
            // connect() takes the co-signer key from the network, not from the
            // emulator's own getInfo, so this fixture key has to come in as the
            // override or the tree below would be built against regtest's
            // pinned key instead. "02"-prefixed like the operator key above.
            emulatorPubkey: "02" + hex.encode(emulatorKey),
        });
        return { ark, captured };
    }

    it("derives the same address as the hand-built VtxoScript tree", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);

        const conditionScript = arkade.resolveAsm(["HASH160", "$hash", "EQUALVERIFY"], args);
        const arkadeScript = arkade.resolveAsm(payTo, args);
        // Independently rebuild the covenant leaf: operator + emulator-key tweaked
        // by the arkade-script hash, in a ConditionMultisig.
        const tweaked = arkade.computeArkadeScriptPublicKey(emulatorKey, arkadeScript);
        const leaf = ConditionMultisigTapscript.encode({
            conditionScript,
            pubkeys: [server, tweaked],
        }).script;
        const raw = new VtxoScript([leaf]);

        expect(contract.address).toBe(raw.address(networks.regtest.hrp, server).encode());
        expect(hex.encode(contract.pkScript)).toBe(hex.encode(raw.pkScript));
    });

    it("getBalance sums spendable coins", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);
        expect(await contract.getBalance()).toBe(BigInt(COIN.value));
    });

    it("getUtxos drops exited and spent coins, keeping the healthy sibling", async () => {
        const { ark: probe } = await connect();
        const script = hex.encode(probe.contract(htlcProgram(), args).pkScript);

        const healthy = { ...mintCoin(7_000), script, isSpent: false };
        const exited = { ...mintCoin(3_000), script, isSpent: false, isUnrolled: true };
        const spent = { ...mintCoin(1_000), script, isSpent: true };

        const { ark } = await connect({ contractManager: stubManager([healthy, exited, spent]) });
        const contract = ark.contract(htlcProgram(), args);

        // The value also proves the manager branch ran: the fallback indexer
        // would have answered with COIN (10_000) instead.
        expect((await contract.getUtxos()).map((u) => u.txid)).toEqual([healthy.txid]);
        expect(await contract.getBalance()).toBe(7_000n);
    });

    // Paired with the manager-branch test above: the two branches must answer
    // the same about an exited coin, so neither may be narrowed alone.
    it("drops them in the no-manager fallback too, whatever spendableOnly returns", async () => {
        // A spent coin too: `spendableOnly` is the operator's answer, and a stale
        // or proxying indexer that returns one must not reach the caller either.
        const healthy = { ...mintCoin(7_000), isSpent: false };
        const exited = { ...mintCoin(3_000), isSpent: false, isUnrolled: true };
        const spent = { ...mintCoin(1_000), isSpent: true };

        const { ark } = await connect({ indexerVtxos: [healthy, exited, spent] });
        const contract = ark.contract(htlcProgram(), args);

        expect((await contract.getUtxos()).map((u) => u.txid)).toEqual([healthy.txid]);
        expect(await contract.getBalance()).toBe(7_000n);
    });

    it("send() resolves the covenant + encodes the witness ([0] → empty push)", async () => {
        const { ark, captured } = await connect();
        const contract = ark.contract(htlcProgram(), args);

        const preimage = new Uint8Array(32).fill(0x42);
        // a valid 34-byte p2tr output for the `.to(...)`
        const out = new Uint8Array([0x51, 0x20, ...receiver]);
        const { txid } = await contract.functions
            .claim({ tapscript: [preimage] })
            .to(out, AMOUNT)
            .send();
        expect(txid).toBeTruthy();

        const tx = Transaction.fromPSBT(base64.decode(captured.arkTx!));
        let packet: ReturnType<Extension["getEmulatorPacket"]> = null;
        for (let i = 0; i < tx.outputsLength; i++) {
            const o = tx.getOutput(i);
            if (o?.script && Extension.isExtension(o.script)) {
                packet = Extension.fromBytes(o.script).getEmulatorPacket();
                break;
            }
        }
        expect(packet).not.toBeNull();
        expect(packet!.entries[0].vin).toBe(0);
        expect(hex.encode(packet!.entries[0].script)).toBe(
            hex.encode(arkade.resolveAsm(payTo, args)),
        );
        expect(Array.from(packet!.entries[0].witness!)).toEqual([0x01, 0x00]);
    });

    it("validates the function arity", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);
        expect(() => (contract.functions.claim as any)()).toThrow(/expected 1 argument/);
    });

    it("rejects a call argument that is not one segment-keyed object", async () => {
        const { ark } = await connect();
        const contract = ark.contract(htlcProgram(), args);
        const claim = contract.functions.claim as (...a: unknown[]) => unknown;
        const preimage = new Uint8Array(32);
        for (const call of [
            [preimage],
            [{ tapscript: preimage }],
            [{ tapscrpt: [preimage] }],
            [{ tapscript: [preimage] }, preimage],
            [null],
        ]) {
            expect(() => claim(...call)).toThrow(/expected one \{ arkadeScript\?/);
        }
        const exit = ark.contract(exitProgram(), { user: xOnly() });
        expect(() => (exit.functions.exit as (...a: unknown[]) => unknown)(1n)).toThrow(
            /expected one \{ arkadeScript\?/,
        );
        expect(() => contract.functions.claim({ tapscript: [preimage] })).not.toThrow();
    });

    it("defaults declared 'server'/'user' params to the client keys", async () => {
        const userKey = xOnly();
        const { ark } = await connect({ identity: stubIdentity(userKey) });
        const program = exitProgram();
        const defaulted = ark.contract(program);
        const explicit = ark.contract(program, { server, user: userKey });
        expect(defaulted.address).toBe(explicit.address);
        expect(() => ark.contract(program, { server: xOnly(), user: userKey })).toThrow(
            /reserved server/,
        );
    });

    it("requires explicit direct-constructor bindings and validates call arguments", async () => {
        const { ark } = await connect({ identity: stubIdentity(receiver) });
        expect(() => new arkade.ArkadeContract(ark, exitProgram())).toThrow(/not bound/);
        const contract = ark.contract(htlcProgram(), args);
        expect(() => (contract.functions.claim as any)({ tapscript: [123n] })).toThrow(
            /expects bytes/,
        );
    });

    it("rejects an external leaf signer before signing", async () => {
        const signed: number[][] = [];
        const identity = {
            ...stubIdentity(receiver),
            sign: async (tx: Transaction, indexes: number[]) => {
                signed.push(indexes);
                return tx;
            },
        };
        const { ark } = await connect({ identity });
        const storedUser = xOnly();
        const args = { server, user: storedUser };
        const contract = new arkade.ArkadeContract(ark, exitProgram(), args, {
            serverKey: server,
            userKey: storedUser,
        });
        expect({ ...contract.args }).toEqual(args);
        await expect(
            contract.functions
                .exit()
                .from(COIN)
                .to(new Uint8Array([0x51, 0x20, ...receiver]), AMOUNT)
                .send(),
        ).rejects.toThrow(/external leaf signatures/);
        expect(signed).toEqual([]);
    });

    it.each([undefined, xOnly()])(
        "signs restored contract inputs with the connected identity when stored userKey is %s",
        async (storedUser) => {
            const signed: number[][] = [];
            const identity = {
                ...stubIdentity(receiver),
                sign: async (tx: Transaction, indexes: number[]) => {
                    signed.push(indexes);
                    return tx;
                },
            };
            const { ark } = await connect({ identity });
            const original = new arkade.ArkadeContract(
                ark,
                {
                    ...exitProgram(),
                    functions: {
                        spend: {
                            tapscript: { signers: ["$server", "$user"] },
                            arkadeScript: { asm: [1] },
                        },
                    },
                },
                { server, user: receiver },
                { serverKey: server, userKey: storedUser, emulatorKey },
            );
            const restored = arkade.ArkadeContract.fromContract(
                ark,
                original.toContractParams() as any,
            );
            expect(restored.pkScript).toEqual(original.pkScript);
            expect(restored.keys.userKey).toEqual(storedUser);
            await restored.functions
                .spend()
                .from(COIN)
                .to(new Uint8Array([0x51, 0x20, ...receiver]), AMOUNT)
                .send();
            expect(signed).toEqual([[0], [0]]);
        },
    );

    const compilerExit = () =>
        arkade.programFromArtifact({
            formatVersion: 1,
            contractName: "SingleSig",
            constructorInputs: [{ name: "user", type: "pubkey" }],
            functions: [
                {
                    name: "unilateral",
                    leaves: [
                        {
                            name: "unilateral",
                            asm: [
                                "<SERVER_EXIT_DELAY>",
                                "OP_CHECKSEQUENCEVERIFY",
                                "OP_DROP",
                                "<user>",
                                "OP_CHECKSIG",
                            ],
                        },
                    ],
                },
            ],
        });

    async function compilerClient(delay: bigint | undefined) {
        const providers = stubProviders(server, emulatorKey);
        const info = await providers.arkProvider.getInfo();
        return arkade.Arkade.connect({
            arkade: { getInfo: async () => ({ ...info, unilateralExitDelay: delay }) },
            identity: stubIdentity(receiver),
            network: networks.regtest,
        });
    }

    it.each([undefined, -1n, 0n])("rejects unusable server exit delay %s", async (delay) => {
        const ark = await compilerClient(delay);
        expect(() => ark.contract(compilerExit())).toThrow(/positive unilateral exit delay/);
    });

    it.each([
        [144n, 144n],
        [86_016n, 4_194_472n],
    ])("binds server delay %s to sequence %s", async (delay, sequence) => {
        const ark = await compilerClient(delay);
        const program = compilerExit();
        const contract = ark.contract(program);
        expect(contract.args.OPERATOR_EXIT_DELAY).toBe(sequence);
        expect(contract.args.user).toEqual(receiver);
        expect(contract.args.operatorKey).toEqual(server);
        const decoded = CSVMultisigTapscript.decode(contract.vtxoScript.compiled[0].leafScript);
        expect(decoded.params.timelock).toEqual(
            delay < 512n ? { type: "blocks", value: delay } : { type: "seconds", value: delay },
        );
        const stored = arkade.serializeArkadeContractParams({
            program,
            args: contract.args,
            serverKey: server,
            userKey: receiver,
        });
        const changed = await compilerClient(86_400n);
        const restored = arkade.ArkadeContract.fromContract(changed, {
            type: "arkade",
            params: stored,
        } as any);
        expect(restored.pkScript).toEqual(contract.pkScript);
        expect(restored.address).toBe(contract.address);
    });

    it("rejects unaligned server seconds and conflicting reserved overrides", async () => {
        const invalid = await compilerClient(86_400n);
        expect(() => invalid.contract(compilerExit())).toThrow(/multiple of 512/);
        const ark = await compilerClient(144n);
        // The names SDK 0.5.15 and earlier used bind the reserved params too, and are checked.
        expect(() => ark.contract(compilerExit(), { server: receiver })).toThrow(
            /reserved operatorKey/,
        );
        expect(() => ark.contract(compilerExit(), { SERVER_EXIT_DELAY: 10n })).toThrow(
            /reserved OPERATOR_EXIT_DELAY/,
        );
        expect(() => ark.contract(compilerExit(), { OPERATOR_EXIT_DELAY: 10n })).toThrow(
            /reserved OPERATOR_EXIT_DELAY/,
        );
    });

    it("checks inherited exit delays and persists the server value as an own binding", async () => {
        const ark = await compilerClient(144n);
        const args = Object.assign(Object.create({ SERVER_EXIT_DELAY: 10n }), {
            server,
            user: receiver,
        });
        expect(() => ark.contract(compilerExit(), args)).toThrow(/reserved OPERATOR_EXIT_DELAY/);
        Object.getPrototypeOf(args).SERVER_EXIT_DELAY = 144n;
        const contract = ark.contract(compilerExit(), args);
        expect(Object.hasOwn(contract.args, "OPERATOR_EXIT_DELAY")).toBe(true);
        expect(contract.args.OPERATOR_EXIT_DELAY).toBe(144n);
    });

    it("restores a program stored with the old reserved names, and binds either name", async () => {
        const ark = await compilerClient(144n);
        const program = compilerExit();
        const contract = ark.contract(program);
        // What SDK 0.5.15 and earlier stored for the same artifact.
        const legacy = arkade.parseArtifact(
            JSON.parse(
                arkade
                    .stringifyArtifact(program)
                    .replaceAll("operatorKey", "server")
                    .replaceAll("OPERATOR_EXIT_DELAY", "SERVER_EXIT_DELAY"),
            ),
        );
        const legacyArgs = { user: receiver, server, SERVER_EXIT_DELAY: 144n };
        const stored = arkade.serializeArkadeContractParams({
            program: legacy,
            args: legacyArgs,
            serverKey: server,
            userKey: receiver,
        });
        expect(Object.keys(JSON.parse(stored.args)).sort()).toEqual(Object.keys(legacyArgs).sort());
        const restored = arkade.ArkadeContract.fromContract(ark, {
            type: "arkade",
            params: stored,
        } as any);
        expect(restored.address).toBe(contract.address);

        expect(ark.contract(legacy, { operatorKey: server }).address).toBe(contract.address);
        expect(ark.contract(program, { server }).address).toBe(contract.address);
        expect(() => ark.contract(program, { server, operatorKey: server })).toThrow(
            /pass 'operatorKey' or 'server', not both/,
        );
        // A new row stores the names its program declares, whichever name the caller passed.
        const saved = arkade.serializeArkadeContractParams({
            program,
            args: legacyArgs,
            serverKey: server,
        });
        expect(Object.keys(JSON.parse(saved.args)).sort()).toEqual([
            "OPERATOR_EXIT_DELAY",
            "operatorKey",
            "user",
        ]);
    });

    it("refuses CSV offchain spends before querying coins", async () => {
        const ark = await compilerClient(144n);
        await expect(ark.contract(compilerExit()).functions.unilateral().build()).rejects.toThrow(
            /aged onchain output/,
        );
    });

    it.each(["bytes32", "Request"])("keeps same-named inputs independent (%s)", async (type) => {
        const { ark } = await connect();
        const program = arkade.programFromArtifact({
            formatVersion: 1,
            contractName: "Hashlock",
            constructorInputs: [{ name: "digest", type: "bytes32" }],
            structs: [{ name: "Request", fields: [{ name: "value", type: "bytes32" }] }],
            functions: [
                {
                    name: "claim",
                    arkade: {
                        inputs: [
                            { name: "preimage", type },
                            { name: "flag", type: "bool" },
                        ],
                        asm: ["OP_1"],
                    },
                    leaves: [
                        {
                            name: "claim",
                            witness: [{ name: "preimage", type: "bytes32", encoding: "raw-32" }],
                            asm: [
                                "OP_SIZE",
                                "32",
                                "OP_EQUALVERIFY",
                                "OP_SHA256",
                                "<digest>",
                                "OP_EQUAL",
                                "OP_VERIFY",
                                "<SERVER_KEY>",
                                "OP_CHECKSIGVERIFY",
                                "<EMULATOR_KEY:claim>",
                                "OP_CHECKSIG",
                            ],
                        },
                    ],
                },
            ],
        });
        expect(() => ark.contract(program, { digest: new Uint8Array(31) })).toThrow(/32-byte/);
        const contract = ark.contract(program, { digest: new Uint8Array(32) });
        const covenantBytes = new Uint8Array(32).fill(1),
            condition = new Uint8Array(32).fill(2);
        const covenant = type === "bytes32" ? covenantBytes : { value: covenantBytes };
        const call = (flag: unknown, leaf: unknown) =>
            contract.functions.claim({ arkadeScript: [covenant, flag], tapscript: [leaf] } as any);
        expect(() => call(2n, condition)).toThrow(/boolean/);
        expect(() => call(Number.MAX_SAFE_INTEGER + 1, condition)).toThrow(/safe integer/);
        expect(() => call(1n, 3n)).toThrow(/bytes/);
        expect(() => call(1n, new Uint8Array(31))).toThrow(/32-byte/);
        const { arkTx, checkpoints } = await call(1n, condition)
            .from(COIN)
            .to(new Uint8Array([0x51, 0x20, ...receiver]), AMOUNT)
            .build();
        for (const tx of [arkTx, checkpoints[0]]) {
            expect(getArkPsbtFields(tx, 0, ConditionWitness)[0]).toEqual([condition]);
        }
        const packet = Array.from({ length: arkTx.outputsLength }, (_, i) => arkTx.getOutput(i))
            .filter((out) => out.script && Extension.isExtension(out.script))
            .map((out) => Extension.fromBytes(out.script!).getEmulatorPacket())[0]!;
        expect(RawWitness.decode(packet.entries[0].witness!)).toEqual([
            new Uint8Array([1]),
            covenantBytes,
        ]);
    });

    it("takes struct and array params whole by name, at deploy and at call", async () => {
        const { ark } = await connect();
        const program = arkade.programFromArtifact({
            formatVersion: 1,
            contractName: "Nested",
            constructorInputs: [
                { name: "policy", type: "Policy" },
                { name: "oracles", type: "pubkey[2]" },
            ],
            structs: [
                {
                    name: "Policy",
                    fields: [
                        { name: "owner", type: "pubkey" },
                        { name: "outs", type: "Outpoint[2]" },
                    ],
                },
            ],
            functions: [
                {
                    name: "spend",
                    arkade: {
                        inputs: [
                            { name: "request", type: "Policy" },
                            { name: "flag", type: "bool" },
                        ],
                        asm: ["OP_1"],
                    },
                    leaves: [
                        {
                            name: "spend",
                            asm: [
                                "<SERVER_KEY>",
                                "OP_CHECKSIGVERIFY",
                                "<EMULATOR_KEY:spend>",
                                "OP_CHECKSIG",
                            ],
                        },
                    ],
                },
            ],
        });
        const outs = [
            { txid: new Uint8Array(32).fill(1), vout: 0n },
            { txid: new Uint8Array(32).fill(2), vout: 1n },
        ];
        const oracles = [xOnly(), xOnly()];
        const flat = (prefix: string, owner: Uint8Array) => ({
            [`${prefix}.owner`]: owner,
            [`${prefix}.outs.0.txid`]: outs[0].txid,
            [`${prefix}.outs.0.vout`]: 0n,
            [`${prefix}.outs.1.txid`]: outs[1].txid,
            [`${prefix}.outs.1.vout`]: 1n,
        });
        const deployed = {
            ...flat("policy", receiver),
            "oracles.0": oracles[0],
            "oracles.1": oracles[1],
        };

        interface Policy {
            owner: Uint8Array;
            outs: { txid: Uint8Array; vout: bigint }[];
        }
        const policy: Policy = { owner: receiver, outs };
        const contract = ark.contract(program, { policy, oracles });
        expect({ ...contract.args }).toEqual({ ...deployed, operatorKey: server });
        expect({ ...ark.contract(program, deployed).args }).toEqual({
            ...deployed,
            operatorKey: server,
        });
        expect(() =>
            ark.contract(program, {
                policy: { owner: receiver, outs },
                oracles: [...oracles, receiver],
            }),
        ).toThrow(/undeclared argument 'oracles.2'/);
        expect(() => ark.contract(program, { ...deployed, policy: { owner: receiver } })).toThrow(
            /duplicate argument 'policy.owner'/,
        );

        const request: Policy = { owner: oracles[0], outs };
        expect({
            ...contract.unlock.spend({ arkadeScript: [request, 1n] }).args.arkadeScript,
        }).toEqual({
            ...flat("request", oracles[0]),
            flag: 1n,
        });
        const spend = (...covenant: unknown[]) =>
            contract.functions.spend({ arkadeScript: covenant } as any);
        expect(() => spend(oracles[0], outs[0].txid, 0n, outs[1].txid, 1n, 1n)).toThrow(
            /expected 2 argument/,
        );
        expect(() => spend({ owner: oracles[0], outs: [outs[0]] }, 1n)).toThrow(
            /missing input 'request.outs.1.txid'/,
        );
        expect(() => spend({ ...request, extra: 1n }, 1n)).toThrow(
            /unexpected input 'request.extra'/,
        );
        expect(() => spend({ ...request, owner: 1n }, 1n)).toThrow(/'request.owner' expects/);
        for (const empty of [{}, []]) {
            expect(() => ark.contract(program, { ...deployed, extra: empty })).toThrow(
                /argument 'extra' must not be an empty/,
            );
            expect(() => ark.contract(program, { ...deployed, "oracles.2": empty })).toThrow(
                /argument 'oracles.2' must not be an empty/,
            );
            expect(() => spend({ ...request, extra: empty }, 1n)).toThrow(
                /argument 'request.extra' must not be an empty/,
            );
            expect(() => spend({ ...request, outs: [...outs, empty] }, 1n)).toThrow(
                /argument 'request.outs.2' must not be an empty/,
            );
        }
        const sparseOracles = [...oracles];
        sparseOracles.length = 3;
        expect(() => ark.contract(program, { policy, oracles: sparseOracles })).toThrow(
            /argument 'oracles.2'.*sparse/,
        );
        const sparseOuts = [...outs];
        sparseOuts.length = 3;
        expect(() => spend({ ...request, outs: sparseOuts }, 1n)).toThrow(
            /argument 'request.outs.2'.*sparse/,
        );
        for (const opaque of [Promise.resolve(receiver), new ArrayBuffer(32), new Map()]) {
            expect(() => spend(opaque, 1n)).toThrow(
                /argument 'request' must be bytes, a number, a struct or an array/,
            );
        }
        class Owner {
            constructor(readonly owner: Uint8Array) {}
            readonly outs = outs;
        }
        expect({
            ...contract.unlock.spend({ arkadeScript: [new Owner(oracles[0]), 1n] }).args
                .arkadeScript,
        }).toEqual({
            ...flat("request", oracles[0]),
            flag: 1n,
        });
        const cyclic: Record<string, unknown> = { ...request };
        cyclic.self = cyclic;
        expect(() => spend(cyclic, 1n)).toThrow(/argument 'request.self' must not be cyclic/);
        const sharedOut = { txid: outs[0].txid, vout: 0n };
        expect(
            ark.contract(program, {
                policy: { owner: receiver, outs: [sharedOut, sharedOut] },
                oracles,
            }).args["policy.outs.1.vout"],
        ).toBe(0n);
    });

    it("binds a compiled contract's nested arrays and asset group records", async () => {
        const { ark } = await connect();
        const { program } = await compile({
            entry: "grid.ark",
            files: {
                "grid.ark": `pragma arkade ^0.1.0;
struct Board { pubkey owner; int[2][2] cells; }
contract Grid(int[2][3] grid, Board board, AssetGroupOutput expected) {
  function spend(int[2][2] m, AssetGroupInput record) {
    require(tx.outputs[0].value == grid[0][1] + grid[1][2] + board.cells[1][0] + expected.amount + m[1][0] + record.amount);
  }
}`,
            },
        });
        const deployed = {
            "grid.0.0": 1n,
            "grid.0.1": 2n,
            "grid.0.2": 3n,
            "grid.1.0": 4n,
            "grid.1.1": 5n,
            "grid.1.2": 6n,
            "board.owner": receiver,
            "board.cells.0.0": 7n,
            "board.cells.0.1": 8n,
            "board.cells.1.0": 9n,
            "board.cells.1.1": 10n,
            "expected.type": 11n,
            "expected.index": 12n,
            "expected.amount": 13n,
        };
        expect(program.params!.map((p) => p.name)).toEqual([
            ...Object.keys(deployed),
            "operatorKey",
        ]);
        const whole = {
            grid: [
                [1n, 2n, 3n],
                [4n, 5n, 6n],
            ],
            board: {
                owner: receiver,
                cells: [
                    [7n, 8n],
                    [9n, 10n],
                ],
            },
            expected: { type: 11n, index: 12n, amount: 13n },
        };
        const contract = ark.contract(program, whole);
        expect({ ...contract.args }).toEqual({ ...deployed, operatorKey: server });
        expect({ ...ark.contract(program, deployed).args }).toEqual({
            ...deployed,
            operatorKey: server,
        });
        // The covenant pushes grid[0][1], grid[1][2], board.cells[1][0] and expected.amount.
        const covenant = contract.vtxoScript.functionByName("spend")!.arkadeScript!;
        const pushes = arkade.ArkadeScript.decode(covenant).slice(2, 8);
        expect(pushes).toEqual([2, 6, "ADD", 9, "ADD", 13]);
        expect(() =>
            ark.contract(program, { ...whole, grid: [whole.grid[0], [...whole.grid[1], 7n]] }),
        ).toThrow(/undeclared argument 'grid.1.3'/);
        expect(() => ark.contract(program, { ...whole, grid: whole.grid.flat() })).toThrow(
            /'grid.0.0' is declared but not bound/,
        );

        const called = {
            "m.0.0": 1n,
            "m.0.1": 2n,
            "m.1.0": 3n,
            "m.1.1": 4n,
            "record.type": 0n,
            "record.index": 1n,
            "record.amount": 5n,
        };
        expect(program.functions.spend.arkadeScript!.witness).toEqual(
            Object.keys(called).reverse(),
        );
        const record = { type: 0n, index: 1n, amount: 5n };
        const m = [
            [1n, 2n],
            [3n, 4n],
        ];
        expect({
            ...contract.unlock.spend({ arkadeScript: [m, record] }).args.arkadeScript,
        }).toEqual(called);
        expect(() => contract.unlock.spend({ arkadeScript: [[m[0], [3n]], record] })).toThrow(
            /missing input 'm.1.1'/,
        );
    });

    it("fails locally when leaf signing needs another identity or a covenant tweak", async () => {
        const { ark, captured } = await connect({ identity: stubIdentity(receiver) });
        const external = ark.contract(
            {
                ...arkade.programFromArtifact({
                    contractName: "External",
                    constructorInputs: [
                        { name: "a", type: "pubkey" },
                        { name: "b", type: "pubkey" },
                    ],
                    functions: [
                        {
                            name: "spend",
                            leaves: [
                                {
                                    name: "spend",
                                    asm: [
                                        "<SERVER_KEY>",
                                        "OP_CHECKSIGVERIFY",
                                        "<a>",
                                        "OP_CHECKSIGVERIFY",
                                        "<b>",
                                        "OP_CHECKSIG",
                                    ],
                                },
                            ],
                        },
                    ],
                }),
            },
            { a: receiver, b: xOnly() },
        );
        await expect(external.functions.spend().send()).rejects.toThrow(/external leaf signatures/);
        const tweaked = ark.contract(
            arkade.programFromArtifact({
                contractName: "Tweaked",
                constructorInputs: [{ name: "user", type: "pubkey" }],
                functions: [
                    {
                        name: "claim",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [
                            {
                                name: "claim",
                                asm: [
                                    "<SERVER_KEY>",
                                    "OP_CHECKSIGVERIFY",
                                    "<EMULATOR_KEY:claim>",
                                    "OP_CHECKSIG",
                                ],
                            },
                            {
                                name: "race",
                                asm: [
                                    "<SERVER_KEY>",
                                    "OP_CHECKSIGVERIFY",
                                    "<TWEAK:user:claim>",
                                    "OP_CHECKSIG",
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        await expect(tweaked.functions.race().send()).rejects.toThrow(
            /covenant-tweaked leaf signing/,
        );
        expect(captured.arkTx).toBeUndefined();
    });

    // A client connected for derivation/registration alone — `getInfo` and
    // nothing else. This is the shape `@arkade-os/swap`'s createOffer uses now
    // that it sources the operator info from `wallet.getOperatorInfo()` instead of
    // building a provider from a URL.
    describe("a getInfo-only `arkade` provider", () => {
        const identity = stubIdentity(xOnly());
        // One provider, built once — only its `getInfo` ever crosses over.
        const { getInfo } = stubProviders(server, emulatorKey).arkProvider;

        const connectInfoOnly = (contractManager?: unknown) =>
            arkade.Arkade.connect({
                arkade: { getInfo },
                identity,
                network: networks.regtest,
                contractManager: contractManager as any,
            });

        it("derives the same contract as one connected with a full provider", async () => {
            const { ark: full } = await connect({ identity });
            const lean = await connectInfoOnly();

            expect(lean.contract(exitProgram()).address).toBe(full.contract(exitProgram()).address);
            expect(hex.encode(lean.serverKey)).toBe(hex.encode(full.serverKey));
        });

        it("registers through the contract manager without touching the network", async () => {
            const created: Record<string, unknown>[] = [];
            const ark = await connectInfoOnly({
                createContract: async (params: Record<string, unknown>) => {
                    created.push(params);
                    return params;
                },
            });
            const contract = ark.contract(exitProgram());
            await contract.register({ label: "lean" });

            expect(created).toHaveLength(1);
            expect(created[0]).toMatchObject({
                type: "arkade",
                script: hex.encode(contract.pkScript),
                address: contract.address,
                label: "lean",
            });
        });

        it("refuses to broadcast, before signing anything", async () => {
            const ark = await connectInfoOnly();
            const contract = ark.contract(exitProgram());
            const out = new Uint8Array([0x51, 0x20, ...receiver]);

            await expect(
                contract.functions
                    .exit()
                    .from({ txid: COIN.txid, vout: COIN.vout, value: COIN.value })
                    .to(out, AMOUNT)
                    .send(),
            ).rejects.toThrow(/submitTx.*finalizeTx/);
        });
    });

    describe("network resolution", () => {
        const program = {
            version: 1,
            params: [{ name: "server", type: "pubkey" }],
            functions: { exit: { tapscript: { signers: ["$server"] } } },
        } satisfies arkade.Program;

        function arkProviderReporting(
            serverKey: Uint8Array,
            network?: string,
            timelock: RelativeTimelock = { type: "seconds", value: 86_016n },
        ) {
            const checkpointTapscript = hex.encode(
                CSVMultisigTapscript.encode({ timelock, pubkeys: [serverKey] }).script,
            );
            return {
                async getInfo() {
                    return {
                        signerPubkey: "02" + hex.encode(serverKey),
                        checkpointTapscript,
                        network,
                    } as any;
                },
                async submitTx(): Promise<any> {
                    throw new Error("not used");
                },
                async finalizeTx() {},
            };
        }

        it("uses the server's network when none is passed", async () => {
            const ark = await arkade.Arkade.connect({
                arkade: arkProviderReporting(server, "signet"),
            });
            expect(ark.network.name).toBe("signet");
            expect(ark.contract(program).address.startsWith("tark1")).toBe(true);
        });

        it("lets an explicit network override the server's", async () => {
            const ark = await arkade.Arkade.connect({
                arkade: arkProviderReporting(server, "bitcoin"),
                network: networks.regtest,
            });
            expect(ark.contract(program).address.startsWith("tark1")).toBe(true);
        });

        it("keeps the SDK default when the server names no network", async () => {
            const ark = await arkade.Arkade.connect({
                arkade: arkProviderReporting(server, ""),
            });
            expect(ark.contract(program).address.startsWith("ark1")).toBe(true);
        });

        it("treats an inherited property name as no network", async () => {
            const ark = await arkade.Arkade.connect({
                arkade: arkProviderReporting(server, "constructor"),
            });
            expect(ark.contract(program).address.startsWith("ark1")).toBe(true);
        });

        it("checks the checkpoint delay against the resolved network", async () => {
            const tenBlocks: RelativeTimelock = { type: "blocks", value: 10n };
            await expect(
                arkade.Arkade.connect({
                    arkade: arkProviderReporting(server, "bitcoin", tenBlocks),
                }),
            ).rejects.toThrow(/checkpoint exit delay rejected/);
            const ark = await arkade.Arkade.connect({
                arkade: arkProviderReporting(server, "bitcoin", tenBlocks),
                network: networks.regtest,
            });
            expect(ark.checkpoint.params.timelock).toEqual(tenBlocks);
        });
    });

    describe("instantiated contracts", () => {
        // Compiled by arkadec v0.1.0 (4075d82c): htlc, single_sig and struct_vault from its
        // examples, and relay beside copies of the last two. Each bundles its source.
        const [HTLC, SINGLE_SIG, STRUCT_VAULT, RELAY] = [
            "htlc",
            "single_sig",
            "struct_vault",
            "relay",
        ].map(
            (name): arkade.ContractArtifact =>
                JSON.parse(
                    readFileSync(
                        new URL(`./fixtures/arkadec/${name}.artifact.json`, import.meta.url),
                        "utf8",
                    ),
                ),
        );
        type Args = Record<string, arkade.ArkadeNestedValue>;
        const htlcArgs = { sender: xOnly(), receiver, preimageHash: HASH, refundTime: 900_000n };
        const linked = () => arkade.programFromArtifact(HTLC, { contracts: [SINGLE_SIG] });
        const covenant = (contract: arkade.ArkadeContract, fn: string) =>
            hex.encode(contract.vtxoScript.functionByName(fn)!.arkadeScript!);
        const key = (contract: arkade.ArkadeContract) => hex.encode(contract.pkScript.slice(2));

        async function client() {
            const { arkProvider, emulator } = stubProviders(server, emulatorKey);
            const info = await arkProvider.getInfo();
            return arkade.Arkade.connect({
                arkade: { getInfo: async () => ({ ...info, unilateralExitDelay: 144n }) },
                emulator,
                network: networks.regtest,
                emulatorPubkey: "02" + hex.encode(emulatorKey),
            });
        }

        it("binds each one, matched by the compiler's code hash, to its witness program", async () => {
            const ark = await client();
            const build = (child: arkade.ContractArtifact, args: Args) =>
                ark.contract(arkade.programFromArtifact(child), args);

            expect(covenant(ark.contract(linked(), htlcArgs), "claim")).toContain(
                key(build(SINGLE_SIG, { user: receiver })),
            );
            const policy = {
                primary: { key: receiver, weight: 5n },
                limits: [2n, 3n],
                exitDelay: 144n,
            };
            const relay = covenant(
                ark.contract(
                    arkade.programFromArtifact(RELAY, { contracts: [STRUCT_VAULT, SINGLE_SIG] }),
                    { policy },
                ),
                "relay",
            );
            expect(relay).toContain(key(build(STRUCT_VAULT, { policy })));
            const literal = hex.decode(
                "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            );
            expect(relay).toContain(key(build(SINGLE_SIG, { user: literal })));
        });

        it("derives the key with the keys the contract is built against", async () => {
            const ark = await client();
            const keys = { serverKey: xOnly(), emulatorKey: ark.emulatorKey };
            const reserved = { server: keys.serverKey, SERVER_EXIT_DELAY: 144n };
            const parent = new arkade.ArkadeContract(
                ark,
                linked(),
                { ...htlcArgs, ...reserved },
                keys,
            );
            const child = new arkade.ArkadeContract(
                ark,
                arkade.programFromArtifact(SINGLE_SIG),
                { user: receiver, ...reserved },
                keys,
            );
            expect(covenant(parent, "claim")).toContain(key(child));
        });

        it("names the parent's param when a value it passes on is wrong", async () => {
            const ark = await client();
            const { receiver: _, ...unbound } = htlcArgs;
            expect(() => ark.contract(linked(), unbound)).toThrow(
                /'receiver' is declared but not bound/,
            );
            expect(() =>
                ark.contract(linked(), { ...htlcArgs, receiver: new Uint8Array(33) }),
            ).toThrow(/'receiver' expects a 32-byte pubkey/);
        });

        it.each([{}, { contracts: [] }])("reads %o as options, not as a debug file", (options) => {
            expect(arkade.programFromArtifact(SINGLE_SIG, options)).toEqual(
                arkade.programFromArtifact(SINGLE_SIG),
            );
        });

        it("compiles a parent with the artifacts of the contracts it instantiates", async () => {
            const ark = await client();
            const input = (HTLC as { source?: CompileInput }).source!;
            const child = await compile({ ...input, entry: "single_sig/single_sig.ark" });
            const { program } = await compile(input, { contracts: [child.artifact] });
            expect(ark.contract(program, htlcArgs).pkScript).toEqual(
                ark.contract(linked(), htlcArgs).pkScript,
            );
        });

        it.each([
            ["a missing artifact", HTLC, [], /HTLC instantiates SingleSig; pass its artifact/],
            [
                "an unpinned parent",
                { ...HTLC, contracts: undefined },
                [SINGLE_SIG],
                /HTLC pins no code hash for SingleSig; recompile HTLC/,
            ],
            [
                "code edited under its code hash",
                HTLC,
                [{ ...SINGLE_SIG, functions: [...SINGLE_SIG.functions].reverse() }],
                /SingleSig artifact .* does not have the code hash HTLC pins/,
            ],
            [
                "a wrong argument count",
                JSON.parse(JSON.stringify(HTLC).replace("(<receiver>)", "(<receiver>,<sender>)")),
                [SINGLE_SIG],
                /SingleSig takes 1 constructor argument\(s\); HTLC passes 2/,
            ],
            [
                "a loop",
                { ...HTLC, contractName: "SingleSig" },
                [SINGLE_SIG],
                /instantiation loop SingleSig → SingleSig/,
            ],
        ])("refuses %s", (_, parent, contracts, error) => {
            expect(() => arkade.programFromArtifact(parent, { contracts })).toThrow(error);
        });

        const hash = (artifact: object) =>
            `sha256:${createHash("sha256").update(JSON.stringify(artifact)).digest("hex")}`;
        // One covenant `go` over `asm`, pinning `children`.
        const covenantArtifact = (
            contractName: string,
            asm: string[],
            children: arkade.ContractArtifact[] = [],
        ): arkade.ContractArtifact => ({
            contractName,
            constructorInputs: [{ name: "k", type: "pubkey" }],
            functions: [
                {
                    name: "go",
                    arkade: { inputs: [], asm: [...asm, "OP_1"] },
                    leaves: [
                        {
                            name: "go",
                            asm: [
                                "<SERVER_KEY>",
                                "OP_CHECKSIGVERIFY",
                                "<EMULATOR_KEY:go>",
                                "OP_CHECKSIG",
                            ],
                        },
                    ],
                },
            ],
            contracts: Object.fromEntries(
                children.map((n) => [n.contractName, n.codeHash ?? hash(n)]),
            ),
        });
        const pay = (children: arkade.ContractArtifact[], args: string) =>
            children.flatMap((n) => [`<CONTRACT:${n.contractName}(${args})>`, "OP_DROP"]);

        it("derives the keys of children's children", async () => {
            const ark = await client();
            // Only the grandchild, SingleSig, uses the exit delay.
            const mid = covenantArtifact("Mid", pay([SINGLE_SIG], "<k>"), [SINGLE_SIG]);
            const top = covenantArtifact("Top", pay([mid], "<k>"), [mid]);
            const k = xOnly();
            const build = (artifact: arkade.ContractArtifact, args: Args) =>
                ark.contract(
                    arkade.programFromArtifact(artifact, { contracts: [mid, SINGLE_SIG] }),
                    args,
                );
            const child = build(mid, { k });
            expect(covenant(build(top, { k }), "go")).toContain(key(child));
            expect(covenant(child, "go")).toContain(key(build(SINGLE_SIG, { user: k })));
        });

        it("refuses a list whose shared children expand past the cap", () => {
            // Eight levels of two contracts, each instantiating both of the next: 510 paths.
            const all: arkade.ContractArtifact[] = [];
            let level: arkade.ContractArtifact[] = [];
            for (let depth = 8; depth >= 0; depth--) {
                const next = level;
                level = (depth ? [`A${depth}`, `B${depth}`] : ["Root"]).map((name) =>
                    covenantArtifact(name, pay(next, "<k>"), next),
                );
                all.push(...next);
            }
            expect(() => arkade.programFromArtifact(level[0], { contracts: all })).toThrow(
                /more than 256 instantiated contracts/,
            );
        });

        it("refuses instantiated programs that add up past the size cap", () => {
            // 255 paths to one child of 2,000 opcodes, each passing its own key.
            const heavy = covenantArtifact("H", [
                ...Array(1000).fill("OP_DUP"),
                ...Array(1000).fill("OP_DROP"),
            ]);
            const keys = Array.from(
                { length: 255 },
                (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`,
            );
            const root = covenantArtifact(
                "Root",
                keys.flatMap((key) => pay([heavy], key)),
                [heavy],
            );
            expect(() => arkade.programFromArtifact(root, { contracts: [heavy] })).toThrow(
                /instantiated programs exceed 1048576 characters/,
            );
        });

        it("derives the key in new ArkadeContract too, and refuses a hand-passed mismatch", async () => {
            const ark = await client();
            const args = { ...htlcArgs, server, SERVER_EXIT_DELAY: 144n };
            expect(new arkade.ArkadeContract(ark, linked(), args).pkScript).toEqual(
                ark.contract(linked(), htlcArgs).pkScript,
            );
            expect(
                () =>
                    new arkade.ArkadeContract(ark, linked(), {
                        ...args,
                        contract_SingleSig_receiver: xOnly(),
                    }),
            ).toThrow(/'contract_SingleSig_receiver' must be the SingleSig witness program/);
        });

        it("restores a saved contract without the instantiated artifacts", async () => {
            const ark = await client();
            const contract = ark.contract(linked(), htlcArgs);
            const { params } = contract.toContractParams();
            const restored = arkade.ArkadeContract.fromContract(ark, {
                type: "arkade",
                params,
            } as never);
            expect(restored.pkScript).toEqual(contract.pkScript);
        });
    });

    it("resolveAsm substitutes $params and passes opcodes through", () => {
        const bytes = arkade.resolveAsm(["HASH160", "$hash", "EQUAL"], { hash: HASH });
        // HASH160 (0xa9) <push20> <hash> EQUAL (0x87)
        const decoded = Script.decode(bytes);
        expect(decoded[0]).toBe("HASH160");
        expect(hex.encode(decoded[1] as Uint8Array)).toBe(hex.encode(HASH));
        expect(decoded[2]).toBe("EQUAL");
    });
});
