#!/usr/bin/env node
// Asserts every workspace package under packages/ declares the scripts that CI
// and the pre-commit hook invoke via `pnpm -r`.
//
// This guard exists because `pnpm -r <script>` SKIPS packages that lack the
// script rather than failing. Without it, a package that forgets `test:unit`
// or `lint` looks green in CI while running nothing at all.
//
// Exits 0 on success; non-zero listing every missing script.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIRED = ["build", "typecheck", "lint", "test", "test:unit", "smoke:dist"];

// snap's dist/bundle.js is a webpack bundle for the MetaMask platform, not an
// importable library surface, so the generic smoke-dist checks do not apply.
const EXEMPT = { snap: ["smoke:dist"] };

const pkgRoot = resolve(process.cwd(), "packages");

if (!existsSync(pkgRoot)) {
    console.error(`check-package-scripts: no packages/ directory at ${pkgRoot}.`);
    console.error("Run this from the repository root.");
    process.exit(1);
}

let failures = 0;
let checked = 0;

for (const dir of readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifest = join(pkgRoot, dir.name, "package.json");
    if (!existsSync(manifest)) continue;

    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const scripts = pkg.scripts ?? {};
    const exempt = EXEMPT[dir.name] ?? [];
    const required = REQUIRED.filter((s) => !exempt.includes(s));

    checked++;
    for (const script of required) {
        if (!scripts[script]) {
            console.error(`FAIL: packages/${dir.name} is missing script "${script}"`);
            failures++;
        }
    }
    for (const script of exempt) {
        if (scripts[script]) {
            console.error(
                `FAIL: packages/${dir.name} declares "${script}" but is listed as exempt. ` +
                    `Remove the exemption or the script.`,
            );
            failures++;
        }
    }
}

if (checked === 0) {
    console.error("check-package-scripts: no packages found. Refusing to pass vacuously.");
    process.exit(1);
}

if (failures > 0) {
    console.error(`\ncheck-package-scripts: ${failures} failure(s) across ${checked} package(s)`);
    process.exit(1);
}

console.log(`check-package-scripts: ${checked} package(s) declare all required scripts`);
