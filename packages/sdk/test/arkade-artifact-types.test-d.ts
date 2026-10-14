import { expectTypeOf, it } from "vitest";

import type { ArtifactWitnessElement, ContractArtifact } from "../src/arkade/artifact";

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
