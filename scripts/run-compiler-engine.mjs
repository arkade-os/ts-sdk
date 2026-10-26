import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vectors = resolve(root, "contracts/compiler-comparison/vectors.json");
const fixture = JSON.parse(readFileSync(vectors, "utf8"));
const args = process.argv.slice(2);
if (args.some((argument) => !["--docker", "--write"].includes(argument)))
    throw new Error("Usage: node scripts/run-compiler-engine.mjs [--docker] [--write]");
const write = args.includes("--write") ? "1" : "0";
const ref = fixture.engine;
if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("comparison vectors must pin the engine commit");
const reference = resolve(root, ".reference/compiler-emulator");
const run = (command, args, options = {}) =>
    execFileSync(command, args, { stdio: "inherit", ...options });
if (!existsSync(reference))
    run("git", [
        "clone",
        "-q",
        "--filter=blob:none",
        "https://github.com/arkade-os/emulator",
        reference,
    ]);
run("git", ["diff", "--exit-code"], { cwd: reference });
run("git", ["diff", "--cached", "--exit-code"], { cwd: reference });
const untracked = execFileSync(
    "git",
    [
        "ls-files",
        "--others",
        "-z",
        "--",
        ".",
        ":(exclude).go/**",
        ":(exclude).gocache/**",
        ":(exclude)compilercomparison/comparison_test.go",
    ],
    { cwd: reference, encoding: "utf8" },
)
    .split("\0")
    .filter(Boolean);
if (untracked.length)
    throw new Error(`Untracked inputs in pinned engine checkout: ${untracked.join(", ")}`);
try {
    run("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: reference, stdio: "ignore" });
} catch {
    run("git", ["fetch", "-q", "origin", ref], { cwd: reference });
}
run("git", ["checkout", "-q", ref], { cwd: reference });
mkdirSync(resolve(reference, "compilercomparison"), { recursive: true });
copyFileSync(
    resolve(root, "scripts/compiler-engine/comparison_test.go"),
    resolve(reference, "compilercomparison/comparison_test.go"),
);
const results = resolve(root, "contracts/compiler-comparison/engine-results.json");
if (args.includes("--docker")) {
    run("docker", [
        "run",
        "--rm",
        "--label",
        "arkade.task=compiler-comparison",
        "--mount",
        `type=bind,source=${reference},target=/engine`,
        "--mount",
        `type=bind,source=${resolve(vectors, "..")},target=/vectors`,
        "-w",
        "/engine",
        "-e",
        "GOPATH=/engine/.go",
        "-e",
        "GOCACHE=/engine/.gocache",
        "-e",
        "GOWORK=off",
        "-e",
        `COMPILER_COMPARISON_WRITE=${write}`,
        "-e",
        "COMPILER_COMPARISON_VECTORS=/vectors/vectors.json",
        "-e",
        "COMPILER_COMPARISON_RESULTS=/vectors/engine-results.json",
        "golang:1.26.9",
        "go",
        "test",
        "-count=1",
        "./compilercomparison",
    ]);
} else {
    run("go", ["test", "-count=1", "./compilercomparison"], {
        cwd: reference,
        env: {
            ...process.env,
            COMPILER_COMPARISON_VECTORS: vectors,
            COMPILER_COMPARISON_RESULTS: results,
            COMPILER_COMPARISON_WRITE: write,
            GOWORK: "off",
        },
    });
}
