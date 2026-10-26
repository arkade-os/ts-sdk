// Fails when sdk or plugin code decodes a PSBT with @scure/btc-signer's own
// `Transaction.fromPSBT`, which strips the unknown fields that carry Ark data.
// Use the SDK's `Transaction` (packages/sdk/src/utils/transaction.ts) instead.
//
// Resolved through the TypeScript checker rather than by grep: the SDK wrapper
// has the same name and method, and scure's class is also reached through
// aliases (`Transaction as BtcSignerTransaction`, `btc.Transaction`).

import ts from "typescript";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Test configs: they include src as well as tests.
const CONFIGS = ["packages/sdk/tsconfig.tests.json", "packages/swap/tsconfig.test.json"];

// No tsconfig covers the examples, and most of them are plain JS.
const EXAMPLES = "packages/sdk/examples";

const ALLOWLIST = [
    // The wrapper itself.
    "packages/sdk/src/utils/transaction.ts",
];

const findings = new Set();

const programs = CONFIGS.map((configPath) => {
    const { config } = ts.readConfigFile(join(repoRoot, configPath), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
        config,
        ts.sys,
        join(repoRoot, configPath, ".."),
    );
    return ts.createProgram(parsed.fileNames, parsed.options);
});
programs.push(
    ts.createProgram(
        ts.sys.readDirectory(join(repoRoot, EXAMPLES), [".ts", ".js", ".mjs"]),
        {
            allowJs: true,
            noEmit: true,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            target: ts.ScriptTarget.ES2022,
        },
    ),
);

for (const program of programs) {
    const checker = program.getTypeChecker();

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        const rel = relative(repoRoot, sourceFile.fileName).split(sep).join("/");
        if (rel.includes("node_modules/") || ALLOWLIST.includes(rel)) continue;

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
                    findings.add(`${rel}:${line + 1}: ${node.getText().split("\n")[0].trim()}`);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
}

if (findings.size > 0) {
    console.error(
        `Found ${findings.size} fromPSBT call(s) on @scure/btc-signer's Transaction.\n` +
            `Use the SDK's Transaction (packages/sdk/src/utils/transaction.ts); scure's\n` +
            `decoder drops Ark PSBT fields. See AGENTS.md, "Decoding PSBTs".\n`,
    );
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
}

console.log("scure fromPSBT guard: no raw scure PSBT decoding.");
