import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPILER_REVISION = "7dbd2ac2da2cd78589b497a6b68a425d84180e8b";
export const ENGINE_REVISION = "ce7fc1eafe3f406cd1eb2670f23912922fd0db97";
const manualBaseline = "a3ddefb00ba0a5411acc4d8c5c4b60b89058e739";
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = resolve(root, ".tmp/compiler-comparison");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--write")) {
    throw new Error("Usage: node scripts/compiler-covenants.mjs [--write]");
}
const write = args[0] === "--write";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, argv, options = {}) =>
    execFileSync(command, argv, {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
        ...options,
    });
const json = (value) => `${JSON.stringify(value, null, 4)}\n`;
const source = resolve(process.env.ARKADE_COMPILER_SOURCE ?? join(scratch, "compiler"));
mkdirSync(scratch, { recursive: true });
if (!existsSync(source)) {
    if (process.env.ARKADE_COMPILER_SOURCE) throw new Error(`Compiler checkout missing: ${source}`);
    run("git", [
        "clone",
        "--quiet",
        "--filter=blob:none",
        "https://github.com/arkade-os/compiler",
        source,
    ]);
    run("git", ["-C", source, "checkout", "--quiet", COMPILER_REVISION]);
}
const revision = run("git", ["-C", source, "rev-parse", "HEAD"]).trim();
const changes = run("git", ["-C", source, "status", "--porcelain", "--untracked-files=all"]).trim();
if (revision !== COMPILER_REVISION || changes) {
    throw new Error(
        `Compiler must be clean at ${COMPILER_REVISION}; found ${revision}${changes ? " with changes" : ""}`,
    );
}
const target = resolve(process.env.CARGO_TARGET_DIR ?? join(scratch, "cargo-target"));
run(
    "cargo",
    [
        "build",
        "--manifest-path",
        join(source, "Cargo.toml"),
        "--locked",
        "--release",
        "--bin",
        "arkadec",
    ],
    {
        env: { ...process.env, CARGO_TARGET_DIR: target },
    },
);
const compiler = join(target, "release", process.platform === "win32" ? "arkadec.exe" : "arkadec");
const binaryHash = hash(readFileSync(compiler));
writeFileSync(
    join(scratch, "toolchain.json"),
    json({
        compilerRevision: revision,
        binarySha256: binaryHash,
        rustc: run("rustc", ["--version"]).trim(),
        cargo: run("cargo", ["--version"]).trim(),
        platform: process.platform,
        arch: process.arch,
    }),
);

function sources(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ark") ? [path] : [];
    });
}

function record(path, value) {
    if (write) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, json(value));
    } else if (
        !existsSync(path) ||
        JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !== JSON.stringify(value)
    ) {
        throw new Error(`Generated artifact differs: ${path}; regenerate with --write`);
    }
}

const paths = ["packages/sdk/contracts", "packages/swap/contracts"]
    .flatMap((path) => sources(resolve(root, path)))
    .sort();
if (!paths.length) throw new Error("No covenant sources found");
const manualInputs = [
    "packages/sdk/src/script/vhtlc.ts",
    "packages/sdk/src/script/tapscript.ts",
    "packages/sdk/src/script/base.ts",
    "packages/sdk/src/script/taprootTree.ts",
    "packages/sdk/src/arkade/program.ts",
    "packages/sdk/src/arkade/script.ts",
    "packages/sdk/src/arkade/opcodes.ts",
    "packages/sdk/src/arkade/tweak.ts",
    "packages/sdk/src/utils/timelock.ts",
    "packages/swap/src/offer.ts",
    "packages/swap/src/swap-want-btc.program.json",
    "packages/swap/src/swap-want-asset.program.json",
].map((path) => {
    const current = readFileSync(resolve(root, path), "utf8").replaceAll("\r\n", "\n");
    const baseline = run("git", ["show", `${manualBaseline}:${path}`]).replaceAll("\r\n", "\n");
    if (current !== baseline)
        throw new Error(
            `Manual builder differs from ${manualBaseline}: ${path}; explicitly update the comparison baseline`,
        );
    return { path, sha256: hash(current) };
});
const artifacts = [];
for (const path of paths) {
    const relative = path.slice(root.length).replaceAll("\\", "/").replace(/^\//, "");
    const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    const canonical = resolve(scratch, "sources", relative);
    mkdirSync(dirname(canonical), { recursive: true });
    writeFileSync(canonical, text);
    for (const optimize of [true, false]) {
        const suffix = optimize ? ".artifact.json" : ".unoptimized.artifact.json";
        const output = canonical.replace(/\.ark$/, suffix);
        run(compiler, [canonical, "--output", output, ...(!optimize ? ["--no-optimize"] : [])]);
        const artifact = JSON.parse(readFileSync(output, "utf8"));
        delete artifact.updatedAt;
        if (
            artifact.compiler?.options?.optimize !== optimize ||
            !artifact.fingerprint ||
            !artifact.source?.files?.[basename(path)]
        ) {
            throw new Error(`Incomplete compiler provenance: ${relative}`);
        }
        record(path.replace(/\.ark$/, suffix), artifact);
        artifacts.push({
            source: relative,
            sourceSha256: hash(text),
            artifact: relative.replace(/\.ark$/, suffix),
            artifactSha256: hash(JSON.stringify(artifact)),
            optimize,
        });
    }
}
record(resolve(root, "contracts/compiler-comparison/manifest.json"), {
    compiler: { repository: "https://github.com/arkade-os/compiler", revision, locked: true },
    engineRevision: ENGINE_REVISION,
    manualBaseline,
    manualInputs,
    purpose: "Comparison only; production runtime builders remain authoritative",
    normalization:
        "LF source text and removal of updatedAt only; artifact digests hash compact JSON",
    artifacts,
});
console.log(
    `${write ? "Generated" : "Verified"} ${artifacts.length} artifacts from ${paths.length} sources; compiler ${revision}; binary ${binaryHash}`,
);
