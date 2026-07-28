#!/usr/bin/env node
// Shared post-build smoke for a package's dist/. Run after `pnpm build`, from
// the package directory: `node ../../config/smoke-dist.mjs`.
//
// Catches what `vitest` cannot: export-map regressions, missing or
// mis-pathed .d.ts/.d.cts files, CJS/ESM dual-package hazards.
//
// Unlike the per-package copies in packages/ts-sdk and packages/boltz-swap,
// this resolves the target package from process.cwd(), so every package that
// needs only the generic checks can share it.
//
// Exits 0 on success; non-zero if any check fails.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const distRoot = join(repoRoot, "dist");
const manifestPath = join(repoRoot, "package.json");

if (!existsSync(manifestPath)) {
    console.error(
        `smoke-dist: no package.json at ${repoRoot}. Run this from a package directory.`,
    );
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));

let failures = 0;
const fail = (msg) => {
    failures++;
    console.error("FAIL: " + msg);
};
const ok = (msg) => console.log("ok  : " + msg);
const section = (msg) => console.log("\n== " + msg + " ==");

console.log(`smoke-dist: ${pkg.name}`);

if (!existsSync(distRoot)) {
    console.error("smoke-dist: dist/ not found. Run `pnpm build` before this script.");
    process.exit(1);
}

// ── 1. exports map ────────────────────────────────────────────────────
section("exports map: every target file exists");

const walkExports = (node, label) => {
    if (typeof node === "string") {
        const target = resolve(repoRoot, node);
        if (!existsSync(target)) fail(`${label} → missing ${node}`);
        else ok(`${label}: ${node}`);
        return;
    }
    if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
            walkExports(v, `${label}.${k}`);
        }
    }
};
walkExports(pkg.exports, "exports");

for (const f of ["main", "module", "types"]) {
    if (pkg[f]) {
        const target = resolve(repoRoot, pkg[f]);
        if (!existsSync(target)) fail(`${f} → missing ${pkg[f]}`);
        else ok(`${f}: ${pkg[f]}`);
    }
}

// ── 2. declaration relative imports resolve ───────────────────────────
section("dist declarations: relative imports resolve");

function* walkDistFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) yield* walkDistFiles(p);
        else yield p;
    }
}

const relImport = /(?:from|import)\s+["'](\.[^"']+)["']/g;
const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
let dtsChecked = 0;
let dtsImports = 0;
for (const file of walkDistFiles(distRoot)) {
    const isCts = file.endsWith(".d.cts");
    const isDts = file.endsWith(".d.ts");
    if (!isCts && !isDts) continue;
    dtsChecked++;
    const text = stripComments(readFileSync(file, "utf8"));
    relImport.lastIndex = 0;
    let m;
    while ((m = relImport.exec(text))) {
        dtsImports++;
        const spec = m[1];
        const dtsExt = isCts ? ".d.cts" : ".d.ts";
        const stem = resolve(dirname(file), spec.replace(/\.c?js$/, ""));
        const candidates = [stem + dtsExt, join(stem, "index" + dtsExt)];
        if (!candidates.some(existsSync)) {
            fail(
                `${relative(repoRoot, file)} → "${spec}" resolves to no declaration: ${candidates
                    .map((c) => relative(repoRoot, c))
                    .join(", ")}`,
            );
        }
    }
}
ok(`declarations scanned: ${dtsChecked}, relative imports verified: ${dtsImports}`);

// ── 3. root entry CJS + ESM load ──────────────────────────────────────
// Validates the dual-package layout and that the package can resolve its
// workspace deps via the local node_modules symlink.
section("root entry: CJS + ESM load");

const runNode = (args) => spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });

if (pkg.main) {
    const cjsProbe = `
const mod = require(${JSON.stringify("./" + pkg.main.replace(/^\.\//, ""))});
if (Object.keys(mod).length === 0) throw new Error("empty exports");
`;
    const r = runNode(["-e", cjsProbe]);
    if (r.status === 0) ok("CJS root require");
    else fail("CJS root require: " + (r.stderr || r.stdout).trim());
}

if (pkg.module) {
    const esmProbe = `
const mod = await import(${JSON.stringify("./" + pkg.module.replace(/^\.\//, ""))});
if (Object.keys(mod).length === 0) throw new Error("empty exports");
`;
    const r = runNode(["--input-type=module", "-e", esmProbe]);
    if (r.status === 0) ok("ESM root import");
    else fail("ESM root import: " + (r.stderr || r.stdout).trim());
}

console.log("");
if (failures > 0) {
    console.error(`smoke-dist: ${failures} failure(s)`);
    process.exit(1);
}
console.log("smoke-dist: all checks passed");
