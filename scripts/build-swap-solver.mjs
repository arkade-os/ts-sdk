import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const revision = "e233504e25b9ef721b3ac156b5233f2f57be9f76";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = join(root, ".tmp/swap-solver");
const configured = process.argv[2]
    ? readFileSync(process.argv[2], "utf8").match(
          /^[ \t]*(?:export[ \t]+)?SOLVER_IMAGE[ \t]*=[ \t]*(.*)$/m,
      )?.[1]
    : undefined;
const override = configured
    ?.trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
if (override) {
    console.log(override);
    process.exit(0);
}
const run = (command, args) => execFileSync(command, args, { stdio: ["ignore", 2, 2] });
const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
if (!existsSync(checkout)) {
    mkdirSync(dirname(checkout), { recursive: true });
    run("git", [
        "clone",
        "--quiet",
        "--filter=blob:none",
        "--no-checkout",
        "--config",
        "core.autocrlf=false",
        "https://github.com/arkade-os/solver.git",
        checkout,
    ]);
    run("git", ["-C", checkout, "checkout", "--quiet", "--detach", revision]);
}
if (git("rev-parse", "HEAD") !== revision || git("status", "--porcelain", "--untracked-files=all"))
    throw new Error(`Swap solver checkout must be clean at ${revision}`);
const image = `arkade-sdk/solver:${revision}`;
run("docker", [
    "build",
    "--build-arg",
    `VERSION=compiler-${revision}`,
    "--label",
    `org.opencontainers.image.revision=${revision}`,
    "--tag",
    image,
    checkout,
]);
console.log(image);
