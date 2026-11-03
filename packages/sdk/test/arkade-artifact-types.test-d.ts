import { expectTypeOf, it } from "vitest";

import type { ArtifactWitnessElement, ContractArtifact } from "../src/arkade/artifact";
import type { ArkadeArgType, ContractFunctions, Program } from "../src/arkade";

const nativeProgram = {
    version: 1,
    functions: {
        spend: {
            inputs: [
                { name: "key", type: "pubkey" },
                { name: "sig", type: "signature" },
                { name: "data", type: "bytes" },
                { name: "digest20", type: "bytes20" },
                { name: "digest32", type: "bytes32" },
                { name: "asset", type: "asset" },
                { name: "amount", type: "int" },
                { name: "flag", type: "bool" },
                { name: "group", type: "AssetGroup" },
            ] as const,
            tapscript: { signers: [] },
        },
    },
} satisfies Program;

it("uses native scalar names without changing JavaScript call values", () => {
    expectTypeOf<ArkadeArgType>().toEqualTypeOf<
        | "pubkey"
        | "signature"
        | "bytes"
        | "bytes20"
        | "bytes32"
        | "asset"
        | "int"
        | "bool"
        | "AssetGroup"
    >();
    expectTypeOf<Parameters<ContractFunctions<typeof nativeProgram>["spend"]>>().toEqualTypeOf<
        [
            Uint8Array,
            Uint8Array,
            Uint8Array,
            Uint8Array,
            Uint8Array,
            Uint8Array,
            bigint | number,
            bigint | number,
            bigint | number,
        ]
    >();
});

// Compiler format v1 records the encoding of every leaf witness item.
const artifact = {
    formatVersion: 1,
    contractName: "T",
    constructorInputs: [{ name: "owner", type: "pubkey" }],
    functions: [
        {
            name: "exit",
            leaves: [
                {
                    name: "exit",
                    witness: [
                        {
                            name: "ownerSig",
                            type: "signature",
                            encoding: "schnorr-64",
                        },
                    ],
                    asm: ["<owner>", "OP_CHECKSIG"],
                },
            ],
        },
    ],
} satisfies ContractArtifact;

it("reads an arkadec witness item that carries its encoding", () => {
    expectTypeOf<ArtifactWitnessElement["encoding"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf(artifact).toExtend<ContractArtifact>();
});
