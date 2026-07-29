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

            it("compares against a forward-slash allowlist", () => {
                const src = read(script);
                const allowlist = src.slice(src.indexOf("const ALLOWLIST"));
                expect(allowlist).toMatch(/"src\//);
                // A backslash in the allowlist would mean someone "fixed" this
                // by changing the data instead of normalizing the path.
                expect(allowlist.slice(0, allowlist.indexOf("]"))).not.toContain("\\\\");
            });
        });
    }
});
