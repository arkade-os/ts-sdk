import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Regression guard for a Windows-only bug that made both lint guards useless.
//
// Each script compares `relative(pkgRoot, file)` against a forward-slash
// ALLOWLIST. On Windows `relative()` returns backslashes, so the comparison
// never matched:
//   - check-virtual-status.mjs flagged all 7 allowlisted files and failed lint
//   - check-provider-boundary.mjs skipped EVERY file via its "src/" prefix test
//     and reported success having inspected zero (measured: 0 before, 194 after)
//
// Both pass on Linux CI, so nothing caught it. These assertions are on the
// source text rather than behaviour because the failure only reproduces when
// node:path is in win32 mode, which cannot be toggled at runtime in-process.
const SCRIPTS_DIR = join(import.meta.dirname, "..", "scripts");

const read = (name: string) => readFileSync(join(SCRIPTS_DIR, name), "utf8");

/** Both scripts mention `relative()` in prose; only real call sites matter. */
const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("lint guards normalize path separators", () => {
    for (const script of ["check-virtual-status.mjs", "check-provider-boundary.mjs"]) {
        describe(script, () => {
            it("imports `sep` from node:path", () => {
                expect(read(script)).toMatch(/import\s*\{[^}]*\bsep\b[^}]*\}\s*from\s*"node:path"/);
            });

            it("normalizes every relative() result to POSIX separators", () => {
                const src = stripComments(read(script));
                const relativeCalls = src.match(/relative\([^)]+\)[^\n;]*/g) ?? [];

                expect(relativeCalls.length).toBeGreaterThan(0);
                for (const call of relativeCalls) {
                    expect(call).toContain('.split(sep).join("/")');
                }
            });

            it("assigns the normalized path to `rel` and compares that", () => {
                // Normalizing into a variable nobody reads would satisfy the test
                // above while leaving the bug intact, so pin the whole chain:
                // normalize -> assign to rel -> compare rel.
                const src = stripComments(read(script));

                expect(src).toMatch(
                    /const\s+rel\s*=\s*relative\([^)]+\)\s*\.split\(sep\)\s*\.join\("\/"\)/,
                );
                expect(src).toMatch(/ALLOWLIST\.includes\(rel\)/);
            });

            it("keeps every allowlist entry forward-slash separated", () => {
                const src = read(script);
                const body = src.slice(src.indexOf("const ALLOWLIST"));
                const entries = body.slice(0, body.indexOf("]")).match(/"[^"]+"/g) ?? [];

                expect(entries.length).toBeGreaterThan(0);
                for (const entry of entries) {
                    // A backslash here would mean someone "fixed" the Windows bug
                    // by rewriting the data instead of normalizing the path.
                    expect(entry).not.toContain("\\");
                    expect(entry).toMatch(/^"src\//);
                }
            });
        });
    }
});
