// Extract the package's export surface as `(name, kind, module)` triples, by
// parsing the barrels with the TypeScript compiler rather than by reading a
// list anyone maintains.
//
// M8's premise: a hand-written inventory of this surface loses the race against
// the branch it describes. The one M0 produced was wrong in every count by the
// time M8 opened. So the dispositions are diffed against *this*, at build time,
// and a name that appears in one and not the other fails the run.
//
// `export *` is followed into the target module, so `client/index.ts` — 28 star
// exports — resolves to the names a consumer actually sees. A name reachable
// from both barrels is not a duplicate to resolve: it is one declaration
// reached two ways, and the triple records the module it is declared in.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SWAP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sourceFileOf = (file) =>
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);

const resolveSpecifier = (fromFile, specifier) => {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`, `${base}.d.ts`]) {
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
};

const isTypeDeclaration = (node) =>
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);

const hasExportModifier = (node) =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

/**
 * Every name `file` exports, following `export *` transitively.
 *
 * @param {string} file absolute path to a `.ts` module
 * @param {Set<string>} seen cycle guard
 * @returns {Map<string, {kind: "value" | "type", module: string}>}
 */
const exportsOf = (file, seen = new Set()) => {
    /** @type {Map<string, {kind: "value" | "type", module: string}>} */
    const found = new Map();
    if (seen.has(file)) return found;
    seen.add(file);

    const module = relative(SWAP_ROOT, file);
    const source = sourceFileOf(file);

    // `export { X }` with no module specifier re-exports a local import as
    // often as a local declaration. Following the import is what keeps the
    // triple's module the file the name is DECLARED in — `SwapRefusal` reads
    // `src/rfq.ts` through `client/errors.ts`, not the barrel that relays it.
    /** @type {Map<string, string>} */
    const importedFrom = new Map();
    for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings) continue;
        if (!ts.isNamedImports(node.importClause.namedBindings)) continue;
        const from = resolveSpecifier(file, node.moduleSpecifier.text);
        if (!from) continue;
        for (const element of node.importClause.namedBindings.elements) {
            importedFrom.set(element.name.text, from);
        }
    }

    const record = (name, kind, declaredIn = module) => {
        if (!found.has(name)) found.set(name, { kind, module: declaredIn });
    };

    for (const node of source.statements) {
        // `export { a, type B } from "./x"` and `export { a, type B }`
        if (ts.isExportDeclaration(node) && node.exportClause) {
            if (!ts.isNamedExports(node.exportClause)) continue;
            const from = node.moduleSpecifier
                ? resolveSpecifier(file, node.moduleSpecifier.text)
                : undefined;
            const upstream = from ? exportsOf(from, new Set(seen)) : undefined;
            for (const element of node.exportClause.elements) {
                const local = (element.propertyName ?? element.name).text;
                const relayed = from
                    ? undefined
                    : importedFrom.get(local) &&
                      exportsOf(importedFrom.get(local), new Set(seen)).get(local);
                const source = upstream?.get(local) ?? relayed;
                const kind =
                    node.isTypeOnly || element.isTypeOnly
                        ? "type"
                        : (source?.kind ?? "value");
                record(element.name.text, kind, source?.module ?? module);
            }
            continue;
        }
        // `export * from "./x"`
        if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
            const from = resolveSpecifier(file, node.moduleSpecifier.text);
            if (!from) continue;
            for (const [name, entry] of exportsOf(from, seen)) {
                record(name, node.isTypeOnly ? "type" : entry.kind, entry.module);
            }
            continue;
        }
        if (!hasExportModifier(node)) continue;
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) record(declaration.name.text, "value");
            }
            continue;
        }
        if (isTypeDeclaration(node)) {
            record(node.name.text, "type");
            continue;
        }
        if (
            (ts.isFunctionDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isEnumDeclaration(node)) &&
            node.name
        ) {
            record(node.name.text, "value");
        }
    }
    return found;
};

/**
 * `(name, kind, module)` triples for a barrel, sorted by name.
 *
 * @param {string} entry path relative to `packages/swap`
 */
export const inventory = (entry) =>
    [...exportsOf(resolve(SWAP_ROOT, entry))]
        .map(([name, entry]) => ({ name, ...entry }))
        .sort((a, b) => a.name.localeCompare(b.name));

export const ROOT_ENTRY = "src/index.ts";
export const CLIENT_ENTRY = "src/client/index.ts";
export const PROTOCOL_ENTRY = "src/protocol.ts";
export const ADVANCED_ENTRY = "src/advanced.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const entry = process.argv[2] ?? ROOT_ENTRY;
    const triples = inventory(entry);
    for (const { name, kind, module } of triples) {
        console.log(`${kind === "type" ? "type " : "     "}${name}\t${module}`);
    }
    const values = triples.filter((t) => t.kind === "value").length;
    console.error(`${entry}: ${values} value, ${triples.length - values} type, ${triples.length} total`);
}
