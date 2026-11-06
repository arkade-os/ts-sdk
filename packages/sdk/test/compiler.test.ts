import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { compile as compileRaw } from "@arkade-os/compiler";

import { compile, CompileError } from "../src/compiler";
import { programFromArtifact } from "../src/arkade/artifact";
import { ArkadeProgramScript } from "../src/arkade/program";

const ENTRY = "contracts/vault.ark";
const FILES = {
    [ENTRY]: `pragma arkade ^0.1.0;
import "../shared/limits.ark";

contract Vault(pubkey owner, int minimum, int unused) {
  function withdraw(int amount) {
    require(Limits.atLeast(amount, minimum));
    require(tx.outputs[0].value >= amount, "output below amount");
  }
  function ownerWithdraw(signature ownerSig) tapscript {
    require(older(serverExitDelay));
    require(checkSig(ownerSig, tweak(owner, withdraw)));
  }
  function unilateral(signature ownerSig) tapscript {
    require(older(serverExitDelay));
    require(checkSig(ownerSig, owner));
  }
}`,
    "shared/limits.ark": `library Limits {
  function atLeast(int a, int b) bool { return a >= b; }
}`,
};

const key = (byte: number) => schnorr.getPublicKey(new Uint8Array(32).fill(byte));

describe("@arkade-os/sdk/compiler", () => {
    it("compiles a multi-file project into the Program programFromArtifact reads", async () => {
        const { program, artifact, debug, diagnostics } = await compile({
            entry: ENTRY,
            files: FILES,
        });
        const raw = await compileRaw({ entry: ENTRY, files: FILES });

        expect(program).toEqual(programFromArtifact(raw.artifact!, raw.debug!));
        expect(debug).toEqual(raw.debug);
        const sourceMap = raw.debug!.functions.withdraw.sourceMap;
        expect(sourceMap).toContainEqual(
            expect.objectContaining({ message: "output below amount" }),
        );
        expect(program.functions.withdraw.arkadeScript?.sourceMap).toEqual(sourceMap);
        expect(program.functions.ownerWithdraw.arkadeScript?.sourceMap).toEqual(sourceMap);
        expect(artifact.source?.files).toEqual(FILES);
        expect(artifact.functions.map((g) => [g.name, g.leaves.map((l) => l.name)])).toEqual([
            ["withdraw", ["withdraw", "ownerWithdraw"]],
            ["unilateral", ["unilateral"]],
        ]);
        expect(diagnostics).toEqual([
            expect.objectContaining({
                severity: "warning",
                message: expect.stringContaining("'unused'"),
            }),
        ]);

        const script = new ArkadeProgramScript(
            program,
            {
                owner: key(0x04),
                minimum: 1_000n,
                unused: 0n,
                server: key(0x01),
                SERVER_EXIT_DELAY: 144n,
            },
            { serverKey: key(0x01), emulatorKey: hex.decode(`02${"02".repeat(32)}`) },
        );
        expect(script.compiled.map((f) => f.name)).toEqual([
            "withdraw",
            "ownerWithdraw",
            "unilateral",
        ]);
    });

    it("leaves the debug file out with debug: false", async () => {
        const { program, debug } = await compile({ entry: ENTRY, files: FILES }, { debug: false });
        const raw = await compileRaw({ entry: ENTRY, files: FILES });

        expect(debug).toBeUndefined();
        expect(program).toEqual(programFromArtifact(raw.artifact!));
        expect(program.functions.withdraw.arkadeScript?.sourceMap).toBeUndefined();
    });

    it("rejects invalid source with every located diagnostic", async () => {
        const files = { [ENTRY]: "contract X() { function f() { require(missing); } }" };
        const error = await compile({ entry: ENTRY, files }).catch((e) => e);

        expect(error).toBeInstanceOf(CompileError);
        expect(error.name).toBe("CompileError");
        expect(error.diagnostics).toEqual([
            expect.objectContaining({
                severity: "error",
                file: ENTRY,
                start: { line: 1, column: 39 },
            }),
        ]);
        expect(error.message).toBe(`${ENTRY}:1:39: ${error.diagnostics[0].message}`);
    });
});
