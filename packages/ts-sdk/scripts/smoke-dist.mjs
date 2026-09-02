#!/usr/bin/env node
// Post-build smoke for dist/. Run after `pnpm build`.
//
// Catches what `vitest` cannot: export-map regressions, missing or
// mis-pathed .d.ts/.d.cts files, CJS/ESM dual-package hazards, and
// tsup code-splitting breaking the contractHandlers singleton.
//
// Exits 0 on success; non-zero if any check fails.
//
// Layout:
//   1. Walk package.json `exports` (+ legacy main/module/types); every
//      referenced file must exist.
//   2. Walk dist/**/*.d.{ts,cts}; every relative `from "..."` import
//      must resolve to a sibling .d.ts/.d.cts. Runtime resolution is
//      covered by sections 3–5 (Node require/import probes).
//   3. CJS singleton: spawn `node -e ...` from the repo root, require
//      ./dist/index.cjs and ./dist/contracts/handlers/index.cjs by
//      relative path, assert object identity for `contractHandlers`
//      and that the registered handler types are exactly
//      arkade,boarding,default,delegate,vhtlc,vhtlc-v2.
//   4. ESM singleton: same but via `await import("...")` with
//      --input-type=module.
//   5. Public package-name resolution: build a consumer dir with
//      node_modules/@arkade-os/sdk → symlink to repo root, spawn
//      Node CJS and ESM probes for each Node-safe public subpath.
//   6. Compile a strict consumer of the boarding and service-worker
//      declaration surface. This catches truncated declaration bundles.
//   7. wallet/expo/background is validated structurally only — it
//      eagerly imports optional Expo peers so it cannot be Node-imported
//      without them installed.

import {
    readFileSync,
    existsSync,
    readdirSync,
    symlinkSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    mkdtempSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "dist");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

let failures = 0;
const fail = (msg) => {
    failures++;
    console.error("FAIL: " + msg);
};
const ok = (msg) => console.log("ok  : " + msg);
const section = (msg) => console.log("\n== " + msg + " ==");
const require = createRequire(import.meta.url);

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

const relImport = /(?:from\s+|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g;
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
        // Strip .js/.cjs if present in the specifier; tsup writes the JS
        // path in declarations and TypeScript matches the sibling .d.ts.
        // Runtime siblings are deliberately not checked: tsup gives
        // declaration chunks (e.g. ark-Da7zYanl.d.ts) different hashed
        // names than the runtime chunks (chunk-XYZ.js), so the .js path
        // in a .d.ts only exists for TS extension-swap resolution.
        // Runtime resolution is covered by the Node probes below.
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

// ── 3 + 4. singleton smoke (CJS + ESM) — direct file-path requires ────
section("contractHandlers singleton: CJS + ESM");

const runNode = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

const expectedTypes = "arkade,boarding,default,delegate,vhtlc,vhtlc-v2";

const cjsSingleton = `
const root = require("./dist/index.cjs");
const handlerEntry = require("./dist/contracts/handlers/index.cjs");
if (root.contractHandlers !== handlerEntry.contractHandlers) {
    throw new Error("contractHandlers identity differs across CJS entries");
}
const got = root.contractHandlers.getRegisteredTypes().slice().sort().join(",");
if (got !== ${JSON.stringify(expectedTypes)}) {
    throw new Error("registered types " + got + " !== " + ${JSON.stringify(expectedTypes)});
}
`;
{
    const r = runNode(["-e", cjsSingleton], repoRoot);
    if (r.status === 0) ok("CJS singleton + registered types");
    else fail("CJS singleton: " + (r.stderr || r.stdout).trim());
}

const esmSingleton = `
const root = await import("./dist/index.js");
const handlerEntry = await import("./dist/contracts/handlers/index.js");
if (root.contractHandlers !== handlerEntry.contractHandlers) {
    throw new Error("contractHandlers identity differs across ESM entries");
}
const got = root.contractHandlers.getRegisteredTypes().slice().sort().join(",");
if (got !== ${JSON.stringify(expectedTypes)}) {
    throw new Error("registered types " + got + " !== " + ${JSON.stringify(expectedTypes)});
}
`;
{
    const r = runNode(["--input-type=module", "-e", esmSingleton], repoRoot);
    if (r.status === 0) ok("ESM singleton + registered types");
    else fail("ESM singleton: " + (r.stderr || r.stdout).trim());
}

// ── 5. public package-name resolution ─────────────────────────────────
section("public subpaths: Node package-name resolution");

const tmp = mkdtempSync(join(tmpdir(), "smoke-dist-"));
const consumer = join(tmp, "consumer");
mkdirSync(join(consumer, "node_modules", "@arkade-os"), { recursive: true });
symlinkSync(repoRoot, join(consumer, "node_modules", "@arkade-os", "sdk"), "dir");
writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "smoke-consumer", type: "module", private: true }),
);

// Subpaths that must Node-import cleanly without optional Expo peers.
// wallet/expo/background is intentionally absent — see section 6.
const nodeSafe = [
    ".",
    "./adapters/expo",
    "./adapters/localStorage",
    "./adapters/fileSystem",
    "./adapters/indexedDB",
    "./adapters/asyncStorage",
    "./repositories/sqlite",
    "./repositories/realm",
    "./worker/expo",
    "./wallet/expo",
];

const cjsProbe = `
const subpaths = ${JSON.stringify(nodeSafe)};
const failures = [];
for (const sp of subpaths) {
    const spec = sp === "." ? "@arkade-os/sdk" : "@arkade-os/sdk/" + sp.slice(2);
    try {
        const mod = require(spec);
        if (Object.keys(mod).length === 0) failures.push(spec + ": no exports");
    } catch (err) {
        failures.push(spec + ": " + err.message);
    }
}
if (failures.length) {
    console.error(failures.join("\\n"));
    process.exit(1);
}
`;
{
    const r = runNode(["-e", cjsProbe], consumer);
    if (r.status === 0) ok(`CJS require resolves all ${nodeSafe.length} subpaths`);
    else {
        const out = (r.stderr || r.stdout).trim();
        for (const line of out.split("\n")) fail(`CJS require → ${line}`);
    }
}

const esmProbe = `
const subpaths = ${JSON.stringify(nodeSafe)};
const failures = [];
for (const sp of subpaths) {
    const spec = sp === "." ? "@arkade-os/sdk" : "@arkade-os/sdk/" + sp.slice(2);
    try {
        const mod = await import(spec);
        if (Object.keys(mod).length === 0) failures.push(spec + ": no exports");
    } catch (err) {
        failures.push(spec + ": " + err.message);
    }
}
if (failures.length) {
    console.error(failures.join("\\n"));
    process.exit(1);
}
`;
{
    const r = runNode(["--input-type=module", "-e", esmProbe], consumer);
    if (r.status === 0) ok(`ESM import resolves all ${nodeSafe.length} subpaths`);
    else {
        const out = (r.stderr || r.stdout).trim();
        for (const line of out.split("\n")) fail(`ESM import → ${line}`);
    }
}

// ── 6. declaration consumer: Vault boarding + worker surface ─────────
section("declaration surface: Vault boarding + worker consumer");

const declarationProbe = `
import {
    ServiceWorkerWallet,
    VtxoScript,
    WalletMessageHandler,
    createBoardingProgramScript,
    type BoardingPreparationResult,
    type BoardingSigningAdapter,
    type IntentFeeConfig,
    type PreparedBoardingRegistration,
    type SettlementConfig,
    type TapLeafScript,
    type ValidatedBoardingBatch,
} from "@arkade-os/sdk";

class VaultBoardScript extends VtxoScript {
    leaf(scriptHex: string): TapLeafScript {
        return this.findLeaf(scriptHex);
    }

    exits() {
        return this.exitPaths();
    }
}

declare const adapter: BoardingSigningAdapter;
declare const feeConfig: IntentFeeConfig;
declare const ready: PreparedBoardingRegistration;
declare const validated: ValidatedBoardingBatch;
declare const worker: ServiceWorkerWallet;

const preparation: Promise<BoardingPreparationResult> = adapter.prepareRegistration({
    inputs: [],
    recipients: [],
});
const createBoarding: typeof createBoardingProgramScript = createBoardingProgramScript;
const createWorker: typeof ServiceWorkerWallet.create = ServiceWorkerWallet.create;
const stopWorker: typeof ServiceWorkerWallet.stop = ServiceWorkerWallet.stop;
const disposeWorker: Promise<void> = worker.dispose();
const workerOwnedIdentity: Pick<
    Parameters<typeof ServiceWorkerWallet.create>[0],
    "workerOwnedIdentity"
> = { workerOwnedIdentity: true };
const settlementConfig: Pick<SettlementConfig, "autoRenewVtxos"> = { autoRenewVtxos: false };
const Handler: typeof WalletMessageHandler = WalletMessageHandler;
const Script: typeof VaultBoardScript = VaultBoardScript;

void [
    preparation,
    feeConfig,
    createBoarding,
    createWorker,
    stopWorker,
    disposeWorker,
    workerOwnedIdentity,
    settlementConfig,
    Handler,
    Script,
    ready,
    validated,
];
`;
const declarationProbePath = join(consumer, "declaration-probe.ts");
writeFileSync(declarationProbePath, declarationProbe);
const compileDeclarationProbe = (probePath, label) => {
    const tscPath = require.resolve("typescript/bin/tsc");
    const r = runNode(
        [
            tscPath,
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--target",
            "ES2022",
            "--lib",
            "ES2022,DOM,WebWorker",
            probePath,
        ],
        consumer,
    );
    if (r.status === 0) ok(`${label} compiles against public declarations`);
    else fail(`${label}: ` + (r.stderr || r.stdout).trim());
};
compileDeclarationProbe(declarationProbePath, "strict ESM TypeScript consumer");

const commonJsDeclarationProbe = `
import sdk = require("@arkade-os/sdk");

class VaultBoardScript extends sdk.VtxoScript {
    leaf(scriptHex: string): sdk.TapLeafScript {
        return this.findLeaf(scriptHex);
    }

    exits() {
        return this.exitPaths();
    }
}

declare const adapter: sdk.BoardingSigningAdapter;
declare const feeConfig: sdk.IntentFeeConfig;
declare const ready: sdk.PreparedBoardingRegistration;
declare const validated: sdk.ValidatedBoardingBatch;
declare const worker: sdk.ServiceWorkerWallet;

const preparation: Promise<sdk.BoardingPreparationResult> = adapter.prepareRegistration({
    inputs: [],
    recipients: [],
});
const createBoarding: typeof sdk.createBoardingProgramScript = sdk.createBoardingProgramScript;
const createWorker: typeof sdk.ServiceWorkerWallet.create = sdk.ServiceWorkerWallet.create;
const stopWorker: typeof sdk.ServiceWorkerWallet.stop = sdk.ServiceWorkerWallet.stop;
const disposeWorker: Promise<void> = worker.dispose();
const workerOwnedIdentity: Pick<
    Parameters<typeof sdk.ServiceWorkerWallet.create>[0],
    "workerOwnedIdentity"
> = { workerOwnedIdentity: true };
const settlementConfig: Pick<sdk.SettlementConfig, "autoRenewVtxos"> = {
    autoRenewVtxos: false,
};
const Handler: typeof sdk.WalletMessageHandler = sdk.WalletMessageHandler;
const Script: typeof VaultBoardScript = VaultBoardScript;

void [
    preparation,
    feeConfig,
    createBoarding,
    createWorker,
    stopWorker,
    disposeWorker,
    workerOwnedIdentity,
    settlementConfig,
    Handler,
    Script,
    ready,
    validated,
];
`;
const commonJsDeclarationProbePath = join(consumer, "declaration-probe.cts");
writeFileSync(commonJsDeclarationProbePath, commonJsDeclarationProbe);
compileDeclarationProbe(commonJsDeclarationProbePath, "strict CommonJS TypeScript consumer");

// ── 7. wallet/expo/background: structural only ────────────────────────
section("wallet/expo/background: structural files exist");

const bg = pkg.exports["./wallet/expo/background"];
if (!bg) fail("exports map missing ./wallet/expo/background");
else {
    for (const cond of ["import", "require"]) {
        for (const key of ["types", "default"]) {
            const p = bg[cond]?.[key];
            if (!p) fail(`./wallet/expo/background.${cond}.${key} not set`);
            else if (!existsSync(resolve(repoRoot, p)))
                fail(`./wallet/expo/background ${cond}.${key} missing: ${p}`);
            else ok(`./wallet/expo/background ${cond}.${key}: ${p}`);
        }
    }
}

// ── cleanup ───────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures > 0) {
    console.error(`smoke-dist: ${failures} failure(s)`);
    process.exit(1);
}
console.log("smoke-dist: all checks passed");
