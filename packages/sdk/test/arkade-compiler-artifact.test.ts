import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

import { programFromArtifact, type ContractArtifact } from "../src/arkade/artifact";
import {
    ArkadeProgramScript,
    parseArtifact,
    stringifyArtifact,
    type ArkadeParamValue,
} from "../src/arkade/program";
import { ArkadeScript } from "../src/arkade/script";
import { computeArkadeScriptPublicKey } from "../src/arkade/tweak";
import { VtxoScript } from "../src/script/base";
import { CSVMultisigTapscript, MultisigTapscript } from "../src/script/tapscript";
import { networks } from "../src/networks";

const artifact: ContractArtifact = JSON.parse(
    readFileSync(new URL("./fixtures/arkadec/escrow.artifact.json", import.meta.url), "utf8"),
);

const key = (byte: number) => new Uint8Array(32).fill(byte);
const SERVER_KEY = key(0x01);
const EMULATOR_KEY = hex.decode(`02${"02".repeat(32)}`);
const ARGS: Record<string, ArkadeParamValue> = {
    partyAPk: key(0x04),
    partyBPk: key(0x05),
    oraclePk: key(0x06),
    oracleMessageHash: key(0x7a),
    partyAScript: key(0xa1),
    partyBScript: key(0xb2),
    settlementAmount: 500_000n,
    timeoutHeight: 900_000n,
    exit: 1_008n,
    server: SERVER_KEY,
};

const collab = (name: string, prefix: string[] = []) => ({
    name,
    asm: [
        ...prefix,
        "<SERVER_KEY>",
        "OP_CHECKSIGVERIFY",
        `<EMULATOR_KEY:${name.split("/")[0]}>`,
        "OP_CHECKSIG",
    ],
});

function assemble(tokens: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
    return ArkadeScript.encode(
        tokens.map((token) => {
            if (token.startsWith("OP_")) {
                const base = token.slice(3);
                return base === "0" || /^([1-9]|1[0-6])$/.test(base) ? token : base;
            }
            if (token.startsWith("<") && token.endsWith(">")) {
                const value = extra[token.slice(1, -1)] ?? ARGS[token.slice(1, -1)];
                if (value === undefined) throw new Error(`unbound ${token}`);
                return value instanceof Uint8Array ? value : BigInt(value);
            }
            return token.startsWith("0x") ? hex.decode(token.slice(2)) : BigInt(token);
        }) as never,
    );
}

const demo = (extra: Record<string, unknown> = {}): ContractArtifact =>
    ({
        contractName: "T",
        constructorInputs: [],
        functions: [
            { name: "spend", leaves: [{ name: "spend", asm: ["<SERVER_KEY>", "OP_CHECKSIG"] }] },
        ],
        ...extra,
    }) as ContractArtifact;

describe("reading an arkadec artifact", () => {
    it("parseArtifact points at the reader for the array shape", () => {
        expect(() => parseArtifact(artifact as never)).toThrow(/programFromArtifact/);
    });

    it("reads the escrow artifact into the same program and the same bytes", () => {
        const program = programFromArtifact(artifact);
        expect(program.version).toBe(1);
        expect(Object.keys(program.functions)).toEqual(["complete", "cancel", "unilateral"]);
        expect(program.functions.unilateral.tapscript).toMatchObject({
            signers: ["$partyAPk", "$partyBPk"],
            csv: { type: "sequence", value: "$exit" },
        });
        const script = new ArkadeProgramScript(program, ARGS, {
            serverKey: SERVER_KEY,
            emulatorKey: EMULATOR_KEY,
        });
        for (const compiled of script.compiled) {
            const found = artifact.functions.find((g) => g.name === compiled.def.group)!;
            const extra: Record<string, Uint8Array> = { SERVER_KEY };
            if (compiled.arkadeScript) {
                extra[`EMULATOR_KEY:${compiled.def.group}`] = computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    compiled.arkadeScript,
                );
                expect(hex.encode(compiled.arkadeScript)).toBe(
                    hex.encode(assemble(found.arkade!.asm)),
                );
            }
            expect(hex.encode(compiled.leafScript)).toBe(
                hex.encode(assemble(found.leaves[0].asm, extra)),
            );
        }
        expect(script.address(networks.bitcoin.hrp, SERVER_KEY).encode()).toBe(
            "ark1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqykuzqulnz07mglnukt7crj22pg7t8vey9lyqdxq2dr5w5y003ew4flny",
        );
    });

    it("keeps every leaf in a multi-leaf covenant group", () => {
        const program = programFromArtifact(
            demo({
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [
                            collab("spend"),
                            {
                                ...collab("spend", ["10", "OP_CHECKSEQUENCEVERIFY", "OP_DROP"]),
                                name: "late",
                            },
                        ],
                    },
                ],
            }),
        );
        expect(Object.keys(program.functions)).toEqual(["spend", "late"]);
        expect(program.functions.late.tapscript.csv).toEqual({
            type: "blocks",
            value: 10n,
        });
    });

    const csvLeaf = (literal: string) => [
        literal,
        "OP_CHECKSEQUENCEVERIFY",
        "OP_DROP",
        "<SERVER_KEY>",
        "OP_CHECKSIG",
    ];
    const csvDemo = (literal: string) =>
        demo({ functions: [{ name: "exit", leaves: [{ name: "exit", asm: csvLeaf(literal) }] }] });

    const csvParamDemo = demo({
        constructorInputs: [{ name: "exitDelay", type: "int" }],
        functions: [{ name: "exit", leaves: [{ name: "exit", asm: csvLeaf("<exitDelay>") }] }],
    });

    it.each([0n, 144n, 65_535n, 4_194_304n, 4_194_472n, 4_259_839n])(
        "binds canonical CSV sequence %s without changing the leaf or address",
        (exitDelay) => {
            const program = programFromArtifact(csvParamDemo);
            expect(program.functions.exit.tapscript.csv).toEqual({
                type: "sequence",
                value: "$exitDelay",
            });
            const script = new ArkadeProgramScript(
                program,
                { exitDelay, server: SERVER_KEY },
                { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
            );
            const expectedLeaf = assemble(csvLeaf(exitDelay.toString()), { SERVER_KEY });
            expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expectedLeaf));
            expect(script.address(networks.bitcoin.hrp, SERVER_KEY).encode()).toBe(
                new VtxoScript([expectedLeaf]).address(networks.bitcoin.hrp, SERVER_KEY).encode(),
            );
        },
    );

    it.each([-1n, 65_536n, 86_016n, 0x800000n, 0x80000000n, 0x100000000n])(
        "refuses noncanonical bound CSV sequence %s with parameter context",
        (exitDelay) => {
            expect(
                () =>
                    new ArkadeProgramScript(
                        programFromArtifact(csvParamDemo),
                        { exitDelay, server: SERVER_KEY },
                        { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
                    ),
            ).toThrow(/\$exitDelay.*canonical BIP68 sequence/);
        },
    );

    it("preserves the two-owner compiler exit leaf and its address for an encoded seconds delay", () => {
        const exitAsm = [
            "<exitDelay>",
            "OP_CHECKSEQUENCEVERIFY",
            "OP_DROP",
            "<senderKey>",
            "OP_CHECKSIGVERIFY",
            "<operatorSignerKey>",
            "OP_CHECKSIG",
        ];
        const program = programFromArtifact(
            demo({
                constructorInputs: [
                    { name: "exitDelay", type: "int" },
                    { name: "senderKey", type: "pubkey" },
                    { name: "operatorSignerKey", type: "pubkey" },
                ],
                functions: [{ name: "exit", leaves: [{ name: "exit", asm: exitAsm }] }],
            }),
        );
        const senderKey = key(0x04);
        const operatorSignerKey = key(0x05);
        const script = new ArkadeProgramScript(
            program,
            { exitDelay: 4_194_472n, senderKey, operatorSignerKey, server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        );
        const expectedLeaf = assemble(
            exitAsm.map((token) => (token === "<exitDelay>" ? "4194472" : token)),
            { senderKey, operatorSignerKey },
        );
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expectedLeaf));
        expect(script.address(networks.bitcoin.hrp, SERVER_KEY).encode()).toBe(
            new VtxoScript([expectedLeaf]).address(networks.bitcoin.hrp, SERVER_KEY).encode(),
        );
    });

    it.each([
        ["a block count", "144"],
        ["512-second units (bit 22 set)", "4194314"],
    ])("builds the artifact's own bytes for a CSV literal in %s", (_, literal) => {
        const program = programFromArtifact(csvDemo(literal));
        const keys = { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY };
        const script = new ArkadeProgramScript(program, { server: SERVER_KEY }, keys);
        expect(hex.encode(script.compiled[0].leafScript)).toBe(
            hex.encode(assemble(csvLeaf(literal), { SERVER_KEY })),
        );
    });

    it("refuses a CSV literal that is not a canonical BIP68 sequence", () => {
        expect(() => programFromArtifact(csvDemo("70000"))).toThrow(/'exit'.*70000/);
    });

    const OWNER = key(0x07);
    const csvOwnerParamDemo = demo({
        constructorInputs: [
            { name: "exitDelay", type: "int" },
            { name: "owner", type: "pubkey" },
        ],
        functions: [
            {
                name: "exit",
                leaves: [
                    {
                        name: "exit",
                        asm: [
                            "<exitDelay>",
                            "OP_CHECKSEQUENCEVERIFY",
                            "OP_DROP",
                            "<owner>",
                            "OP_CHECKSIG",
                        ],
                    },
                ],
            },
        ],
    });
    const csvParamLeaf = (exitDelay: bigint) =>
        new ArkadeProgramScript(
            programFromArtifact(csvOwnerParamDemo),
            { exitDelay, owner: OWNER, server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        ).compiled[0].leafScript;

    it("binds a $param CSV as the BIP68 sequence the compiler pushes", () => {
        const leaf = hex.encode(csvParamLeaf(4_194_472n));
        expect(leaf).toBe(
            hex.encode(
                CSVMultisigTapscript.encode({
                    timelock: { type: "seconds", value: 86_016n },
                    pubkeys: [OWNER],
                }).script,
            ),
        );
        // A third party assembling the artifact's raw operand derives the same address.
        expect(leaf).toBe(
            hex.encode(
                assemble(
                    ["4194472", "OP_CHECKSEQUENCEVERIFY", "OP_DROP", "<owner>", "OP_CHECKSIG"],
                    { owner: OWNER },
                ),
            ),
        );
    });

    it.each([0n, 144n, 65_535n])(
        "keeps the bytes a blocks-domain CSV parameter of %s already built",
        (blocks) => {
            expect(hex.encode(csvParamLeaf(blocks))).toBe(
                hex.encode(
                    CSVMultisigTapscript.encode({
                        timelock: { type: "blocks", value: blocks },
                        pubkeys: [OWNER],
                    }).script,
                ),
            );
        },
    );

    it.each([
        ["bits outside the value field", 86_016n],
        ["the disable flag", 0x80000000n],
    ])("refuses a CSV parameter sequence carrying %s", (_, sequence) => {
        expect(() => csvParamLeaf(sequence)).toThrow(/exitDelay.*canonical BIP68 sequence/);
    });

    it("reads hash conditions and flattens structs, natives, arrays, and child outputs", () => {
        const hash = programFromArtifact(
            demo({
                constructorInputs: [
                    { name: "owner", type: "pubkey" },
                    { name: "hash", type: "bytes32" },
                ],
                functions: [
                    {
                        name: "claim",
                        leaves: [
                            {
                                name: "claim",
                                witness: [
                                    { name: "preimage", type: "bytes" },
                                    { name: "ownerSig", type: "signature" },
                                ],
                                asm: [
                                    "OP_SHA256",
                                    "<hash>",
                                    "OP_EQUAL",
                                    "OP_VERIFY",
                                    "<owner>",
                                    "OP_CHECKSIG",
                                ],
                            },
                        ],
                    },
                ],
            }),
        ).functions.claim;
        expect(hash.inputs).toEqual([{ name: "preimage", type: "bytes" }]);
        expect(hash.tapscript).toMatchObject({
            asm: ["SHA256", "$hash", "EQUAL"],
            witness: ["preimage"],
        });

        const program = programFromArtifact(
            demo({
                constructorInputs: [
                    { name: "policy", type: "Policy" },
                    { name: "point", type: "ECPoint" },
                    { name: "votes", type: "bool[2]" },
                    { name: "exit", type: "int" },
                ],
                structs: [
                    {
                        name: "Policy",
                        fields: [
                            { name: "owner", type: "pubkey" },
                            { name: "threshold", type: "int" },
                        ],
                    },
                ],
                functions: [
                    {
                        name: "spend",
                        arkade: {
                            inputs: [{ name: "request", type: "Policy" }],
                            asm: ["<CONTRACT:SingleSig(<policy.owner>,<exit>)>", "OP_DROP"],
                        },
                        leaves: [collab("spend")],
                    },
                ],
            }),
        );
        expect(program.params).toEqual([
            { name: "policy.owner", type: "pubkey" },
            { name: "policy.threshold", type: "int" },
            { name: "point.x", type: "int" },
            { name: "point.y", type: "int" },
            { name: "votes.0", type: "int", boolean: true },
            { name: "votes.1", type: "int", boolean: true },
            { name: "exit", type: "int" },
            { name: "server", type: "pubkey" },
            { name: "contract_SingleSig_policy_owner_exit", type: "hash", encoding: "raw-32" },
        ]);
        expect(program.functions.spend.arkadeScript?.witness).toEqual([
            "request.threshold",
            "request.owner",
        ]);
    });

    it.each(
        ["OP_SHA256", "OP_HASH160", "OP_HASH256", "OP_RIPEMD160"].flatMap((hash) =>
            [20, 32].flatMap((width) => [false, true].map((csv) => [hash, width, csv] as const)),
        ),
    )("preserves %s fixed-width %i hashlocks (CSV: %s)", (hash, width, csv) => {
        const asm = [
            "OP_SIZE",
            `${width}`,
            "OP_EQUALVERIFY",
            hash,
            "<hash>",
            "OP_EQUAL",
            "OP_VERIFY",
            ...(csv ? ["144", "OP_CHECKSEQUENCEVERIFY", "OP_DROP"] : []),
            "<SERVER_KEY>",
            "OP_CHECKSIG",
        ];
        const program = programFromArtifact(
            demo({
                formatVersion: 1,
                constructorInputs: [{ name: "hash", type: "bytes32" }],
                functions: [
                    {
                        name: "claim",
                        leaves: [
                            {
                                name: "claim",
                                asm,
                                witness: [{ name: "preimage", type: `bytes${width}` }],
                            },
                        ],
                    },
                ],
            }),
        );
        const script = new ArkadeProgramScript(
            program,
            { hash: ARGS.oracleMessageHash, server: SERVER_KEY },
            { serverKey: SERVER_KEY },
        );
        expect(script.compiled[0].leafScript).toEqual(
            assemble(asm, { hash: ARGS.oracleMessageHash as Uint8Array, SERVER_KEY }),
        );
    });

    it("recursively flattens master native layouts and arrays of structs", () => {
        const program = programFromArtifact(
            demo({
                constructorInputs: [
                    { name: "entries", type: "AssetEntry[2]" },
                    { name: "lookup", type: "AssetLookup" },
                    { name: "spk", type: "ScriptPubKey" },
                    { name: "g2", type: "G2Point" },
                    { name: "group", type: "AssetGroup" },
                    { name: "policies", type: "Policy[2]" },
                ],
                structs: [{ name: "Policy", fields: [{ name: "owners", type: "Outpoint[2]" }] }],
                functions: [
                    {
                        name: "spend",
                        arkade: {
                            inputs: [{ name: "entries", type: "AssetEntry[2]" }],
                            asm: ["OP_1"],
                        },
                        leaves: [collab("spend")],
                    },
                ],
            }),
        );
        const names = program.params!.map((p) => (typeof p === "string" ? p : p.name));
        expect(names).toEqual([
            "entries.0.assetId.txid",
            "entries.0.assetId.gidx",
            "entries.0.amount",
            "entries.1.assetId.txid",
            "entries.1.assetId.gidx",
            "entries.1.amount",
            "lookup.amount",
            "lookup.found",
            "spk.program",
            "spk.version",
            "g2.xC1",
            "g2.xC0",
            "g2.yC1",
            "g2.yC0",
            "group",
            "policies.0.owners.0.txid",
            "policies.0.owners.0.vout",
            "policies.0.owners.1.txid",
            "policies.0.owners.1.vout",
            "policies.1.owners.0.txid",
            "policies.1.owners.0.vout",
            "policies.1.owners.1.txid",
            "policies.1.owners.1.vout",
            "server",
        ]);
        expect(program.functions.spend.arkadeScript!.witness).toEqual(names.slice(0, 6).reverse());
    });

    it.each([
        [demo({ formatVersion: 2 }), /unsupported artifact format version/],
        [
            demo({
                functions: [
                    {
                        name: "exit",
                        leaves: [
                            {
                                name: "exit",
                                witness: [{ name: "owner", type: "pubkey" }],
                                asm: ["<owner>", "OP_CHECKSIG"],
                            },
                        ],
                    },
                ],
            }),
            /call input 'owner' is a script operand/,
        ],
        [demo({ constructorInputs: [{ name: "x", type: "int[1e2]" }] }), /invalid array/],
        [
            demo({
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [collab("spend"), collab("spend")],
                    },
                ],
            }),
            /duplicate function/,
        ],
        [
            demo({
                functions: [
                    {
                        name: "spend",
                        leaves: [{ name: "spend", asm: ["<SERVER_KEY>", "OP_CHECKSIGVERIFY"] }],
                    },
                ],
            }),
            /final signer/,
        ],
        [
            demo({
                functions: [
                    {
                        name: "spend",
                        leaves: [
                            {
                                name: "spend",
                                witness: [{ name: "p", type: "bytes32", encoding: "raw-20" }],
                                asm: ["<SERVER_KEY>", "OP_CHECKSIG"],
                            },
                        ],
                    },
                ],
            }),
            /encoding/,
        ],
        [
            demo({
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [collab("other")],
                    },
                ],
            }),
            /must match group/,
        ],
        [demo({ structs: [{}] }), /struct needs/],
        [
            demo({
                structs: [
                    {
                        name: "S",
                        fields: [
                            { name: "x", type: "int" },
                            { name: "x", type: "int" },
                        ],
                    },
                ],
            }),
            /duplicate struct field/,
        ],
        [
            demo({ functions: [{ name: "f", leaves: [{ name: "f", asm: [1] }] }] }),
            /string assembly/,
        ],
        [demo({ functions: [{ name: "f", arkade: {}, leaves: [collab("f")] }] }), /covenant needs/],
        [
            demo({
                constructorInputs: [{ name: "s", type: "S[2]" }],
                structs: [{ name: "S", fields: [{ name: "s", type: "S[1]" }] }],
            }),
            /recursive struct/,
        ],
    ])("validates artifact boundaries %#", (artifact, error) => {
        expect(() => programFromArtifact(artifact as ContractArtifact)).toThrow(error as RegExp);
    });

    it("tweaks a constructor pubkey by the named covenant", () => {
        const insurer = schnorr.getPublicKey(new Uint8Array(32).fill(0x09));
        const program = programFromArtifact(
            demo({
                constructorInputs: [{ name: "insurer", type: "pubkey" }],
                functions: [
                    {
                        name: "claim",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [collab("claim")],
                    },
                    {
                        name: "race",
                        leaves: [
                            {
                                name: "race",
                                asm: [
                                    "<SERVER_KEY>",
                                    "OP_CHECKSIGVERIFY",
                                    "<TWEAK:insurer:claim>",
                                    "OP_CHECKSIG",
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        expect(program.functions.race.tapscript.signers).toEqual([
            "$server",
            { tweak: "$insurer", fn: "claim" },
        ]);
        const script = new ArkadeProgramScript(
            program,
            { insurer, server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        );
        const tweaked = computeArkadeScriptPublicKey(
            insurer,
            script.functionByName("claim")!.arkadeScript!,
        );
        expect(hex.encode(script.functionByName("race")!.leafScript)).toBe(
            hex.encode(MultisigTapscript.encode({ pubkeys: [SERVER_KEY, tweaked] }).script),
        );
    });

    it("refuses a tweak of a function that has no covenant", () => {
        const insurer = schnorr.getPublicKey(new Uint8Array(32).fill(0x09));
        const program = programFromArtifact(
            demo({
                constructorInputs: [{ name: "insurer", type: "pubkey" }],
                functions: [
                    {
                        name: "race",
                        leaves: [{ name: "race", asm: ["<TWEAK:insurer:claim>", "OP_CHECKSIG"] }],
                    },
                ],
            }),
        );
        expect(
            () =>
                new ArkadeProgramScript(
                    program,
                    { insurer, server: SERVER_KEY },
                    { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
                ),
        ).toThrow(/tweaks 'claim', which has no arkade script/);
    });

    it("keeps a constructor tweak beside the emulator leaf of the same covenant", () => {
        const insurer = schnorr.getPublicKey(new Uint8Array(32).fill(0x09));
        const program = programFromArtifact(
            demo({
                constructorInputs: [{ name: "insurer", type: "pubkey" }],
                functions: [
                    {
                        name: "claim",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [
                            collab("claim"),
                            {
                                name: "race",
                                asm: [
                                    "<SERVER_KEY>",
                                    "OP_CHECKSIGVERIFY",
                                    "<TWEAK:insurer:claim>",
                                    "OP_CHECKSIG",
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        expect(Object.keys(program.functions)).toEqual(["claim", "race"]);
        expect(program.functions.claim.tapscript.emulator).toBe("claim");
        expect(program.functions.race.tapscript).toMatchObject({
            signers: ["$server", { tweak: "$insurer", fn: "claim" }],
            emulator: null,
        });
        expect(program.functions.race.arkadeScript).toEqual(program.functions.claim.arkadeScript);

        const script = new ArkadeProgramScript(
            program,
            { insurer, server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        );
        const covenant = script.functionByName("claim")!.arkadeScript!;
        const tweaked = computeArkadeScriptPublicKey(insurer, covenant);
        const emulator = computeArkadeScriptPublicKey(EMULATOR_KEY, covenant);
        expect(hex.encode(script.functionByName("race")!.leafScript)).toBe(
            hex.encode(MultisigTapscript.encode({ pubkeys: [SERVER_KEY, tweaked] }).script),
        );
        expect(hex.encode(script.functionByName("claim")!.leafScript)).toBe(
            hex.encode(MultisigTapscript.encode({ pubkeys: [SERVER_KEY, emulator] }).script),
        );

        const roundTrip = parseArtifact(JSON.parse(stringifyArtifact(program)));
        expect(roundTrip.functions.race.tapscript.emulator).toBeNull();
        expect(
            hex.encode(
                new ArkadeProgramScript(
                    roundTrip,
                    { insurer, server: SERVER_KEY },
                    { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
                ).functionByName("race")!.leafScript,
            ),
        ).toBe(hex.encode(MultisigTapscript.encode({ pubkeys: [SERVER_KEY, tweaked] }).script));
    });

    it.each([0, 1, 2])("preserves the emulator signer at position %i", (position) => {
        const operands = ["<SERVER_KEY>", "<owner>"];
        operands.splice(position, 0, "<EMULATOR_KEY:claim>");
        const asm = operands.flatMap((operand, i) => [
            operand,
            i === 2 ? "OP_CHECKSIG" : "OP_CHECKSIGVERIFY",
        ]);
        const program = programFromArtifact(
            demo({
                constructorInputs: [{ name: "owner", type: "pubkey" }],
                functions: [
                    {
                        name: "claim",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [{ name: "claim", asm }],
                    },
                ],
            }),
        );
        const args = { server: SERVER_KEY, owner: key(0x04) };
        const keys = { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY };
        const script = new ArkadeProgramScript(program, args, keys);
        expect(program.functions.claim.tapscript.emulatorIndex).toBe(position);
        expect(program.functions.claim.tapscript.signers).toEqual(["$server", "$owner"]);
        expect(script.compiled[0].leafScript).toEqual(
            assemble(asm, {
                SERVER_KEY,
                owner: args.owner,
                "EMULATOR_KEY:claim": computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    script.compiled[0].arkadeScript!,
                ),
            }),
        );
        const restored = new ArkadeProgramScript(
            parseArtifact(JSON.parse(stringifyArtifact(program))),
            args,
            keys,
        );
        expect(restored.pkScript).toEqual(script.pkScript);
    });

    it("selects leaves by source name while retaining author order and group tweaks", () => {
        const insurer = schnorr.getPublicKey(new Uint8Array(32).fill(0x09));
        const leaves = [
            { name: "late", asm: ["<TWEAK:insurer:claim>", "OP_CHECKSIG"] },
            collab("claim"),
        ];
        const convert = (leaves: ContractArtifact["functions"][number]["leaves"]) =>
            programFromArtifact(
                demo({
                    constructorInputs: [{ name: "insurer", type: "pubkey" }],
                    functions: [{ name: "claim", arkade: { inputs: [], asm: ["OP_1"] }, leaves }],
                }),
            );
        const program = convert(leaves);
        expect(Object.keys(program.functions)).toEqual(["late", "claim"]);
        expect(Object.keys(convert([...leaves].reverse()).functions)).toEqual(["claim", "late"]);
        const args = { insurer, server: SERVER_KEY };
        const script = new ArkadeProgramScript(program, args, {
            serverKey: SERVER_KEY,
            emulatorKey: EMULATOR_KEY,
        });
        const covenant = script.functionByName("claim")!.arkadeScript!;
        expect(script.functionByName("late")!.leafScript).toEqual(
            MultisigTapscript.encode({ pubkeys: [computeArkadeScriptPublicKey(insurer, covenant)] })
                .script,
        );
        const onlyTweak = new ArkadeProgramScript(convert([leaves[0]]), args, {
            serverKey: SERVER_KEY,
        });
        expect(onlyTweak.compiled[0].leafScript).toEqual(script.compiled[0].leafScript);
    });

    it("constructs an emulator-only CSV leaf without changing SignerRef", () => {
        const asm = [
            "10",
            "OP_CHECKSEQUENCEVERIFY",
            "OP_DROP",
            "<EMULATOR_KEY:claim>",
            "OP_CHECKSIG",
        ];
        const program = programFromArtifact(
            demo({
                functions: [
                    {
                        name: "claim",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [{ name: "claim", asm }],
                    },
                ],
            }),
        );
        expect(program.functions.claim.tapscript.signers).toEqual([]);
        const script = new ArkadeProgramScript(
            program,
            { server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        );
        expect(script.compiled[0].leafScript).toEqual(
            assemble(asm, {
                "EMULATOR_KEY:claim": computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    script.compiled[0].arkadeScript!,
                ),
            }),
        );
    });

    it("retains caller signature metadata without making signatures condition inputs", () => {
        const program = programFromArtifact(
            demo({
                functions: [
                    {
                        name: "spend",
                        leaves: [
                            {
                                name: "spend",
                                witness: [
                                    {
                                        name: "serverSig",
                                        type: "signature",
                                        encoding: "schnorr-64",
                                        injected: true,
                                    },
                                    { name: "userSig", type: "signature", encoding: "schnorr-64" },
                                ],
                                asm: ["<SERVER_KEY>", "OP_CHECKSIG"],
                            },
                        ],
                    },
                ],
            }),
        );
        expect(program.functions.spend.inputs).toBeUndefined();
        expect(program.functions.spend.tapscript.signatures).toEqual([
            { name: "userSig", type: "sig" },
        ]);
        expect(parseArtifact(JSON.parse(stringifyArtifact(program)))).toEqual(program);
    });

    it.each([
        ["an incomplete artifact", { functions: [] }, /complete arkadec artifact/],
        [
            "a constructor input without a type",
            demo({ constructorInputs: [{ name: "amount" }] }),
            /parameter needs a name and a type/,
        ],
        [
            "a constructor `server`",
            {
                ...artifact,
                constructorInputs: [
                    ...artifact.constructorInputs,
                    { name: "server", type: "pubkey" },
                ],
            },
            /duplicate program parameter 'server'/,
        ],
        [
            "a struct named pubkey",
            demo({ structs: [{ name: "pubkey", fields: [{ name: "x", type: "int" }] }] }),
            /shadows a built-in type/,
        ],
        [
            "a struct named ECPoint",
            demo({ structs: [{ name: "ECPoint", fields: [{ name: "x", type: "int" }] }] }),
            /shadows a built-in type/,
        ],
        [
            "a tweak with no function",
            demo({
                constructorInputs: [{ name: "insurer", type: "pubkey" }],
                functions: [
                    {
                        name: "race",
                        leaves: [{ name: "race", asm: ["<TWEAK:insurer>", "OP_CHECKSIG"] }],
                    },
                ],
            }),
            /malformed tweak/,
        ],
        [
            "a covenant leaf with neither emulator nor tweak",
            demo({
                constructorInputs: [{ name: "user", type: "pubkey" }],
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [{ name: "spend", asm: ["<user>", "OP_CHECKSIG"] }],
                    },
                ],
            }),
            /emulator or a tweaked constructor key/,
        ],
        [
            "two child outputs that sanitize to one name",
            demo({
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["<CONTRACT:A-B>", "<CONTRACT:A_B>"] },
                        leaves: [collab("spend")],
                    },
                ],
            }),
            /instantiations 'A-B' and 'A_B' both map to parameter 'contract_A_B'/,
        ],
        [
            "the old <VTXO:...> placeholder",
            demo({
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["<VTXO:SingleSig(<owner>)>", "OP_DROP"] },
                        leaves: [collab("spend")],
                    },
                ],
            }),
            /compiler emits <CONTRACT:/,
        ],
        [
            "an unknown opcode",
            {
                ...artifact,
                functions: [
                    {
                        ...artifact.functions[0],
                        arkade: { inputs: [], asm: ["OP_NOT_A_REAL_OPCODE"] },
                    },
                ],
            },
            /not in this SDK's table/,
        ],
    ] as [string, unknown, RegExp][])("refuses %s", (_label, art, pattern) => {
        expect(() => programFromArtifact(art as never)).toThrow(pattern);
    });
});
