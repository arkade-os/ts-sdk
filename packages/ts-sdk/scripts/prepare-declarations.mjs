import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const relativeImport = /((?:from|import)\s*(?:\(\s*)?["'])(\.[^"']+)(["'])/g;

function walkDeclarations(directory, files = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            walkDeclarations(path, files);
        } else if (entry.name.endsWith(".d.ts")) {
            files.push(path);
        }
    }
    return files;
}

function javascriptSpecifier(file, specifier, extension) {
    const stem = resolve(dirname(file), specifier.replace(/\.c?js$/, ""));
    if (existsSync(`${stem}.d.ts`)) {
        return `${specifier.replace(/\.c?js$/, "")}${extension}`;
    }
    if (existsSync(join(stem, "index.d.ts"))) {
        return `${specifier.replace(/\/$/, "")}/index${extension}`;
    }
    return specifier;
}

function rewriteRelativeImports(file, contents, extension) {
    return contents.replace(relativeImport, (_, prefix, specifier, suffix) => {
        return `${prefix}${javascriptSpecifier(file, specifier, extension)}${suffix}`;
    });
}

for (const declaration of walkDeclarations(distRoot)) {
    const original = readFileSync(declaration, "utf8");
    writeFileSync(declaration, rewriteRelativeImports(declaration, original, ".js"));

    const commonJsDeclaration = declaration.replace(/\.d\.ts$/, ".d.cts");
    writeFileSync(commonJsDeclaration, rewriteRelativeImports(declaration, original, ".cjs"));
}
