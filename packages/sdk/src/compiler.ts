/**
 * Compile Arkade source into an SDK {@link Program}. Needs the optional peer
 * `@arkade-os/compiler`, which is loaded on the first {@link compile} call.
 *
 * @module compiler
 */

import type {
    CompileInput,
    CompileOptions,
    CompilerArtifact,
    Diagnostic,
} from "@arkade-os/compiler";

import { programFromArtifact } from "./arkade/artifact";
import type { Program } from "./arkade/program";

export type { CompileInput, CompileOptions, CompilerArtifact, Diagnostic };

export interface CompileOutput {
    program: Program;
    /** The compiler's artifact, carrying the source bundle, compiler version and fingerprint. */
    artifact: CompilerArtifact;
    /** Warnings; errors reject with {@link CompileError}. */
    diagnostics: Diagnostic[];
}

/** The source did not compile. `diagnostics` lists every error and warning. */
export class CompileError extends Error {
    override readonly name = "CompileError";
    constructor(readonly diagnostics: Diagnostic[]) {
        super(
            diagnostics
                .filter((d) => d.severity === "error")
                .map(
                    (d) =>
                        `${d.file}${d.start ? `:${d.start.line}:${d.start.column}` : ""}: ${d.message}`,
                )
                .join("\n") || "compilation failed",
        );
    }
}

const PEER = "@arkade-os/compiler";

/** Compile `input.entry` and its relative imports from `input.files` into a {@link Program}. */
export async function compile(
    input: CompileInput,
    options?: CompileOptions,
): Promise<CompileOutput> {
    let compiler: typeof import("@arkade-os/compiler");
    try {
        compiler = await import("@arkade-os/compiler");
    } catch (error) {
        // Only a missing peer gets the install hint; anything else keeps its own error.
        const code = (error as { code?: unknown } | null)?.code;
        if (
            (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
            String((error as Error).message).includes(`'${PEER}'`)
        ) {
            throw new Error(
                `@arkade-os/sdk/compiler needs the optional peer ${PEER}: npm install --save-exact ${PEER}`,
                { cause: error },
            );
        }
        throw error;
    }
    const result = await compiler.compile(input, options);
    if (result.artifact === null) throw new CompileError(result.diagnostics);
    return {
        program: programFromArtifact(result.artifact),
        artifact: result.artifact,
        diagnostics: result.diagnostics,
    };
}
