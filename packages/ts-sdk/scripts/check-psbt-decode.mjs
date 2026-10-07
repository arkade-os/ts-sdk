// Fails when SDK logic decodes a PSBT with @scure/btc-signer's own `Transaction.fromPSBT` instead of
// the wrapper in src/utils/transaction.ts. Since scure 2.4 the default strips unknown PSBT fields,
// which drops every Ark field (taptree, condition witness, cosigner keys, ...), and the raw decoder
// also rejects the legacy output tap trees older SDK releases wrote.
//
// Resolved through the TypeScript checker rather than by grep, because what matters is which class
// the call resolves to, not how `Transaction` was imported or aliased.

import ts from "typescript";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// The wrapper itself, which applies the Ark options before delegating to scure.
const ALLOWLIST = ["src/utils/transaction.ts"];

const configPath = ts.findConfigFile(pkgRoot, ts.sys.fileExists, "tsconfig.json");
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, pkgRoot);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const findings = [];

for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    // relative() yields the platform separator; normalize so the prefix test and ALLOWLIST match
    // on Windows too.
    const rel = relative(pkgRoot, sourceFile.fileName).split(sep).join("/");
    if (!rel.startsWith("src/")) continue;
    if (ALLOWLIST.includes(rel)) continue;

    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "fromPSBT"
        ) {
            const decl = checker.getResolvedSignature(node)?.declaration;
            const declFile = decl?.getSourceFile().fileName.split(sep).join("/");
            if (declFile?.includes("/@scure/btc-signer/")) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                findings.push(`${rel}:${line + 1}: ${node.getText().split("\n")[0].trim()}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

if (findings.length > 0) {
    console.error(
        `Found ${findings.length} PSBT decode(s) through @scure/btc-signer's Transaction.\n` +
            `Import Transaction from src/utils/transaction.ts instead, so Ark PSBT fields survive\n` +
            `the decode and legacy output tap trees are repaired.\n`,
    );
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
}

console.log("PSBT decode guard: every fromPSBT goes through the Ark Transaction wrapper.");
