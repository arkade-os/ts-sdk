// Fails when production SDK logic reintroduces a dependency on `virtualStatus`.
//
// The identifier is matched bare rather than as `virtualStatus.` — destructuring reads
// (`const { batchExpiry } = vtxo.virtualStatus`) and `"virtualStatus" in x` discriminators are
// exactly the forms that slipped through before, and a dotted pattern misses both.
//
// Behavior must read the canonical facts and capability predicates instead; see src/wallet/vtxo.ts.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcRoot = join(pkgRoot, "src");

// Only these may mention `virtualStatus`: the type declaration and its deprecation notices, the
// module that owns the compatibility projection, and the repository (de)serialization that has to
// keep reading and writing the legacy blob.
const ALLOWLIST = [
    "src/wallet/index.ts",
    "src/wallet/vtxo.ts",
    "src/repositories/serialization.ts",
    "src/repositories/sqlite/walletRepository.ts",
    "src/repositories/realm/walletRepository.ts",
    "src/repositories/realm/schemas.ts",
    "src/repositories/indexedDB/schema.ts",
];

// `toVirtualStatus(...)` is the sanctioned way to synthesize the projection on a write, so calling
// it is not a dependency on the legacy shape. Matching the bare identifier would flag every caller.
const SANCTIONED = /\btoVirtualStatus\b/;

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (p.endsWith(".ts")) yield p;
    }
}

const findings = [];
for (const file of walk(srcRoot)) {
    const rel = relative(pkgRoot, file);
    if (ALLOWLIST.includes(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (!/\bvirtualStatus\b/.test(line)) return;
        if (SANCTIONED.test(line)) return;
        findings.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
}

if (findings.length > 0) {
    console.error(
        `Found ${findings.length} virtualStatus reference(s) in production SDK logic.\n` +
            `VirtualStatus is deprecated: read the canonical facts (isSwept, isPreconfirmed,\n` +
            `isSpent, expiresAt, expiresAtHeight, commitmentTxIds, spentBy, settledBy) or a\n` +
            `capability predicate from src/wallet/vtxo.ts instead.\n`,
    );
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
}

console.log("virtualStatus guard: no references in production SDK logic.");
