import { expectTypeOf, it } from "vitest";
import type { ArtifactWitnessElement, ContractArtifact } from "../src/arkade/artifact";

const artifact = {
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
                            injected: true,
                        },
                    ],
                    asm: ["<owner>", "OP_CHECKSIG"],
                },
            ],
        },
    ],
} satisfies ContractArtifact;

it("types an arkadec signature witness with its encoding", () => {
    expectTypeOf<ArtifactWitnessElement["encoding"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf(artifact).toExtend<ContractArtifact>();
});
