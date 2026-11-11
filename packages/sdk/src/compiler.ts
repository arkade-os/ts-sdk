/**
 * Compile Arkade source into an SDK {@link Program}. Needs the optional peer
 * `@arkade-os/compiler`, which is loaded on the first {@link compile} call.
 *
 * @module compiler
 */

import type {
    CompileInput,
    CompileOptions as CompilerOptions,
    CompilerArtifact,
    DebugInfo,
    Diagnostic,
} from "@arkade-os/compiler";

import { programFromArtifact } from "./arkade/artifact";
import type { Program } from "./arkade/program";

export type { CompileInput, CompilerArtifact, DebugInfo, Diagnostic };

export interface CompileOptions extends CompilerOptions {
    /** Return the debug file and put its source maps on `program`. Defaults to `true`. */
    debug?: boolean;
}

export interface CompileOutput {
    program: Program;
    /** The compiler's artifact, carrying the source bundle, compiler version and fingerprint. */
    artifact: CompilerArtifact;
    /** The debug file: each covenant's source map. Absent with `debug: false`. */
    debug?: DebugInfo;
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
    const { debug = true, ...compilerOptions } = options ?? {};
    const result = await compiler.compile(input, compilerOptions);
    if (result.artifact === null) throw new CompileError(result.diagnostics);
    // ponytail: the compiler always builds the debug file; it will take an option to skip it soon,
    // until then `debug: false` only drops it.
    const kept = debug ? result.debug : undefined;
    return {
        program: programFromArtifact(result.artifact, kept),
        artifact: result.artifact,
        ...(kept ? { debug: kept } : {}),
        diagnostics: result.diagnostics,
    };
}
