#!/usr/bin/env node
// The ts-sdk e2e groups, read straight out of the CI matrix.
//
// CI is the only place the grouping is defined; this reader exists so the local
// runner (`scripts/regtest.sh ts-sdk groups`) executes exactly what CI executes,
// and so `--check` can fail when a new e2e file belongs to no group. Running all
// files in one process against one long-lived arkd is NOT the supported shape:
// the groups exist because each gets its own fresh stack.
//
//   node scripts/e2e-groups.mjs           # "<group>\t<file> <file> ..." per line
//   node scripts/e2e-groups.mjs --check   # assert every e2e file is in exactly one group
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(ROOT, "packages", "ts-sdk", "test", "e2e");

/** Group name -> test files, for matrix entries whose `package` is ts-sdk. */
export function readGroups() {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const groups = [];
    // Matrix entries are `- package: <pkg>` blocks; `test_files` is either an
    // inline path or a `>-` folded scalar holding one path per line.
    for (const entry of ci.split(/^\s*- package:/m).slice(1)) {
        const [, pkg] = entry.match(/^\s*(\S+)/) ?? [];
        if (pkg !== "ts-sdk") continue;
        const [, name] = entry.match(/^\s*group:\s*(\S+)/m) ?? [];
        const files = entry.match(/test\/e2e\/\S+\.test\.ts/g) ?? [];
        if (!name || files.length === 0) {
            throw new Error(`e2e-groups: unparsable ts-sdk matrix entry near "${name ?? "?"}"`);
        }
        groups.push({ name, files });
    }
    if (groups.length === 0) {
        throw new Error("e2e-groups: found no ts-sdk groups in .github/workflows/ci.yml");
    }
    return groups;
}

const groups = readGroups();

if (process.argv.includes("--check")) {
    const onDisk = readdirSync(E2E_DIR)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => `test/e2e/${f}`);
    const seen = new Map();
    for (const g of groups) {
        for (const f of g.files) seen.set(f, [...(seen.get(f) ?? []), g.name]);
    }
    const errors = [];
    for (const f of onDisk) {
        if (!seen.has(f)) errors.push(`${f} is in no CI group — it never runs in CI`);
    }
    for (const [f, names] of seen) {
        if (names.length > 1) errors.push(`${f} is in ${names.length} groups: ${names.join(", ")}`);
        if (!onDisk.includes(f)) errors.push(`${f} is in group ${names[0]} but does not exist`);
    }
    if (errors.length > 0) {
        console.error("e2e group guard:");
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }
    console.log(`e2e group guard: ${onDisk.length} files across ${groups.length} groups.`);
} else {
    for (const g of groups) console.log(`${g.name}\t${g.files.join(" ")}`);
}
