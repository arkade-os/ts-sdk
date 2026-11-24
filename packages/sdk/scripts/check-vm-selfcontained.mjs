// Fails when a file under src/arkade/vm imports anything but another vm/ file, @scure/* or
// @noble/*, so the VM stays liftable into its own package.
//
// Relative specifiers are resolved against the importing file: `../stack` from vm/ops/ stays
// inside vm/, `../opcodes` from vm/ itself does not. A prefix grep cannot tell the two apart.

import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const vmRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "arkade", "vm");
const ALLOWED_PACKAGE = /^@(scure|noble)\//;

const sourceFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
    });

const files = sourceFiles(vmRoot);
const findings = [];
for (const file of files) {
    const rel = relative(vmRoot, file).split(sep).join("/");
    // also reports `export ... from`, `import type`, dynamic import() and require()
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName: specifier } of importedFiles) {
        if (specifier.startsWith(".")) {
            const target = relative(vmRoot, resolve(dirname(file), specifier));
            if (target.startsWith("..") || isAbsolute(target)) {
                findings.push(`${rel}: "${specifier}" resolves outside vm/`);
            }
        } else if (!ALLOWED_PACKAGE.test(specifier)) {
            findings.push(`${rel}: "${specifier}" is not @scure/* or @noble/*`);
        }
    }
}

if (files.length === 0) {
    console.error(`check-vm-selfcontained: no source files under ${vmRoot}`);
    process.exit(1);
}
if (findings.length > 0) {
    console.error("check-vm-selfcontained: vm/ must import only vm/, @scure/* and @noble/*:");
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
}
console.log(`check-vm-selfcontained: ${files.length} files, every import stays inside vm/`);
