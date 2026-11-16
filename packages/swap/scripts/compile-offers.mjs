import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REVISION = "e264d5e6ecd044de7130d5c8a0e1f49d43958c11";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = join(root, ".tmp/swap-compiler");
const source = resolve(process.env.ARKADE_COMPILER_SOURCE ?? join(scratch, "compiler"));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--write"))
    throw new Error("Usage: node compile-offers.mjs [--write]");
const write = args[0] === "--write";
const run = (command, argv, options = {}) =>
    execFileSync(command, argv, {
        encoding: "utf8",
        stdio: "pipe",
        ...options,
    });
const git = (...argv) => run("git", ["-C", source, ...argv]).trim();
mkdirSync(scratch, { recursive: true });
if (!existsSync(source)) {
    if (process.env.ARKADE_COMPILER_SOURCE) throw new Error(`Compiler checkout missing: ${source}`);
    run("git", [
        "clone",
        "--config",
        "core.autocrlf=false",
        "--quiet",
        "--filter=blob:none",
        "--no-checkout",
        "https://github.com/arkade-os/compiler.git",
        source,
    ]);
    git("checkout", "--quiet", "--detach", REVISION);
}
if (git("rev-parse", "HEAD") !== REVISION || git("status", "--porcelain", "--untracked-files=all"))
    throw new Error(`Compiler checkout must be clean at ${REVISION}`);
run(
    "cargo",
    [
        "build",
        "--locked",
        "--manifest-path",
        join(source, "Cargo.toml"),
        "--target-dir",
        join(source, "target"),
        "--bin",
        "arkadec",
        "-j",
        "2",
    ],
    { stdio: "inherit" },
);
const binary = join(
    source,
    "target/debug",
    process.platform === "win32" ? "arkadec.exe" : "arkadec",
);
const artifacts = [];
for (const side of ["btc", "asset"]) {
    const entry = `swap-want-${side}.ark`;
    const input = join(root, "packages/swap/contracts", entry);
    const canonical = join(scratch, entry);
    const text = readFileSync(input, "utf8").replaceAll("\r\n", "\n");
    writeFileSync(canonical, text);
    const output = join(scratch, `swap-want-${side}.artifact.json`);
    run(binary, [canonical, "--output", output], { stdio: "inherit" });
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    delete artifact.updatedAt;
    if (
        artifact.source?.entry !== entry ||
        artifact.source.files[entry] !== text ||
        !artifact.fingerprint
    )
        throw new Error(`Compiler omitted provenance for ${entry}`);
    const target = join(root, "packages/swap/contracts", basename(output));
    const rendered = `${JSON.stringify(artifact, null, 4)}\n`;
    if (write) writeFileSync(target, rendered);
    else if (
        !existsSync(target) ||
        readFileSync(target, "utf8").replaceAll("\r\n", "\n") !== rendered
    )
        throw new Error(`${target} differs; run pnpm contracts:generate`);
    artifacts.push({
        source: entry,
        artifact: basename(output),
        fingerprint: artifact.fingerprint,
    });
}
writeFileSync(
    join(scratch, "toolchain.json"),
    `${JSON.stringify(
        {
            compilerRevision: REVISION,
            binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
            rustc: run("rustc", ["--version"]).trim(),
            artifacts,
        },
        null,
        4,
    )}\n`,
);
console.log(`Verified ${artifacts.length} swap artifacts with compiler ${REVISION}`);
