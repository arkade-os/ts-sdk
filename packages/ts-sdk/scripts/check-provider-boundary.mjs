// Fails when production SDK logic calls `IndexerProvider.getVtxos()` directly instead of going
// through `getNormalizedVtxos`, which is what guarantees every VTXO entering SDK logic carries its
// canonical facts.
//
// Resolved through the TypeScript checker rather than by grep, because the requirement is about the
// receiver's *type*: several unrelated classes declare a `getVtxos`, and a dotted pattern would
// miss multi-line call chains and aliased receivers.

import ts from "typescript";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// The wrapper itself, and the provider implementations, which compose below the boundary.
const ALLOWLIST = [
    "src/wallet/vtxo.ts",
    "src/providers/indexer.ts",
    "src/providers/expoIndexer.ts",
];

const configPath = ts.findConfigFile(pkgRoot, ts.sys.fileExists, "tsconfig.json");
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, pkgRoot);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const findings = [];

for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const rel = relative(pkgRoot, sourceFile.fileName);
    if (!rel.startsWith("src/")) continue;
    if (ALLOWLIST.includes(rel)) continue;

    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "getVtxos"
        ) {
            const decl = checker.getResolvedSignature(node)?.declaration;
            const owner = decl?.parent;
            // `IndexerProvider` declares getVtxos; RestIndexerProvider implements it. Both name
            // their owner the same way, so matching the owner's name covers implementations too.
            const ownerName = owner && "name" in owner ? owner.name?.getText() : undefined;
            if (ownerName && /IndexerProvider/.test(ownerName)) {
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
        `Found ${findings.length} direct IndexerProvider.getVtxos() call(s) in SDK logic.\n` +
            `Route them through getNormalizedVtxos(provider, opts) from src/wallet/vtxo.ts so\n` +
            `legacy-shaped VTXOs from custom providers are normalized at the boundary.\n`,
    );
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
}

console.log("provider boundary guard: no direct IndexerProvider.getVtxos() calls.");
