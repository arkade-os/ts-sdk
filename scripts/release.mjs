#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const PACKAGES = [
    {
        key: "sdk",
        name: "@arkade-os/sdk",
        dir: path.join(ROOT_DIR, "packages/ts-sdk"),
        pkgJson: path.join(ROOT_DIR, "packages/ts-sdk/package.json"),
        tagPrefix: "@arkade-os/sdk/",
        order: 1,
    },
    {
        key: "boltz-swap",
        name: "@arkade-os/boltz-swap",
        dir: path.join(ROOT_DIR, "packages/boltz-swap"),
        pkgJson: path.join(ROOT_DIR, "packages/boltz-swap/package.json"),
        tagPrefix: "@arkade-os/boltz-swap/",
        order: 2,
    },
];

const PACKAGE_BY_KEY = Object.fromEntries(PACKAGES.map((p) => [p.key, p]));
const VALID_TARGETS = new Set(["sdk", "boltz-swap", "all"]);
const BUMP_TYPES = new Set([
    "patch",
    "minor",
    "major",
    "prepatch",
    "preminor",
    "premajor",
    "prerelease",
]);
const VALID_PREIDS = new Set(["alpha", "beta", "rc", "next"]);
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

const STATE_FILE = path.join(ROOT_DIR, ".git", "arkade-release-state.json");
const RELEASE_BRANCH = "master";

function die(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function readPackageVersion(pkgJsonPath) {
    return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
}

function writePackageVersion(pkgJsonPath, version) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    pkg.version = version;
    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 4)}\n`);
}

function headPackageVersion(repoRelativePath) {
    const result = spawnSync("git", ["show", `HEAD:${repoRelativePath}`], {
        cwd: ROOT_DIR,
        encoding: "utf8",
    });
    if (result.status !== 0) return null;
    try {
        return JSON.parse(result.stdout).version;
    } catch {
        return null;
    }
}

function parseVersion(version) {
    const match = version.match(VERSION_PATTERN);
    if (!match) die(`Unsupported semver version: ${version}`);
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] || "",
    };
}

function formatVersion(v) {
    return `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;
}

function compareIdentifiers(left, right) {
    const ln = /^\d+$/.test(left);
    const rn = /^\d+$/.test(right);
    if (ln && rn) return Number(left) - Number(right);
    if (ln) return -1;
    if (rn) return 1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function compareVersions(left, right) {
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key]) return left[key] - right[key];
    }
    if (left.pre === right.pre) return 0;
    if (!left.pre) return 1;
    if (!right.pre) return -1;
    const lp = left.pre.split(".");
    const rp = right.pre.split(".");
    const len = Math.max(lp.length, rp.length);
    for (let i = 0; i < len; i += 1) {
        if (lp[i] === undefined) return -1;
        if (rp[i] === undefined) return 1;
        const cmp = compareIdentifiers(lp[i], rp[i]);
        if (cmp !== 0) return cmp;
    }
    return 0;
}

function withPrerelease(version, preid) {
    const parts = version.pre ? version.pre.split(".") : [];
    const last = parts[parts.length - 1];
    if (parts[0] === preid && /^\d+$/.test(last)) {
        parts[parts.length - 1] = String(Number(last) + 1);
        return { ...version, pre: parts.join(".") };
    }
    return { ...version, pre: `${preid}.0` };
}

function incrementVersion(currentStr, type, preid) {
    const next = { ...parseVersion(currentStr) };
    switch (type) {
        case "patch":
            if (next.pre) next.pre = "";
            else next.patch += 1;
            return formatVersion(next);
        case "minor":
            next.minor += 1;
            next.patch = 0;
            next.pre = "";
            return formatVersion(next);
        case "major":
            next.major += 1;
            next.minor = 0;
            next.patch = 0;
            next.pre = "";
            return formatVersion(next);
        case "prepatch":
            next.patch += 1;
            next.pre = "";
            return formatVersion(withPrerelease(next, preid));
        case "preminor":
            next.minor += 1;
            next.patch = 0;
            next.pre = "";
            return formatVersion(withPrerelease(next, preid));
        case "premajor":
            next.major += 1;
            next.minor = 0;
            next.patch = 0;
            next.pre = "";
            return formatVersion(withPrerelease(next, preid));
        case "prerelease":
            if (!next.pre) next.patch += 1;
            return formatVersion(withPrerelease(next, preid));
        default:
            die(`Unsupported version bump: ${type}`);
    }
}

function isLiteralVersion(value) {
    return typeof value === "string" && VERSION_PATTERN.test(value);
}

function isBumpType(value) {
    return BUMP_TYPES.has(value);
}

function isPrereleaseBump(value) {
    return typeof value === "string" && value.startsWith("pre") && BUMP_TYPES.has(value);
}

function distTagFor(version) {
    if (version.includes("-alpha")) return "alpha";
    if (version.includes("-beta")) return "beta";
    if (version.includes("-rc")) return "rc";
    if (version.includes("-next")) return "next";
    return "latest";
}

function showHelp() {
    console.log(
        `Usage: scripts/release.mjs <target> <bump-or-version> [options]
       scripts/release.mjs --cleanup [target]

Targets:
  sdk | boltz-swap | all

Bump or version:
  patch | minor | major | prepatch | preminor | premajor | prerelease |
  literal semver such as 0.4.30 or 0.5.0-beta.0

Options:
  --dry-run                Print the release plan without changing files
  --preid <id>             Pre-release identifier: alpha, beta, rc, or next
  --boltz-bump <bump|ver>  Override the dependent boltz-swap bump when SDK is
                           released. Defaults to 'patch' for stable SDK
                           releases and to a prerelease bump matching the SDK
                           target preid for prerelease SDK releases (including
                           literal versions like 0.5.0-beta.0).
  --cleanup [target]       Restore local manifests and delete local
                           package-scoped tags. With no target, auto-detect
                           from release state or dirty manifests.
  --help                   Show this message

Releasing SDK implies a dependent boltz-swap release because boltz-swap
depends on SDK via workspace:* (pnpm rewrites this to an exact version on
pack/publish).

Stable releases (patch/minor/major or a literal non-prerelease version) must
be run from master. Prerelease releases (prepatch/preminor/premajor/
prerelease, or a literal -alpha/-beta/-rc/-next version) may be run from any
branch and publish under a matching npm dist-tag, never 'latest'.
`,
    );
}

function parseArgs(argv) {
    const args = {
        target: null,
        bump: null,
        preid: null,
        boltzBump: null,
        dryRun: false,
        cleanup: false,
        help: false,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--help":
            case "-h":
                args.help = true;
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--cleanup":
                args.cleanup = true;
                break;
            case "--preid":
                if (i + 1 >= argv.length) die("--preid requires a value");
                args.preid = argv[++i];
                break;
            case "--boltz-bump":
                if (i + 1 >= argv.length) die("--boltz-bump requires a value");
                args.boltzBump = argv[++i];
                break;
            case "--":
                // pnpm forwards a literal "--" separator before script args; ignore it
                // rather than treating the remainder as positional (that would swallow
                // subsequent options like --preid).
                break;
            default:
                if (arg.startsWith("--")) die(`Unknown option: ${arg}`);
                positional.push(arg);
        }
    }
    if (positional.length > 2) {
        die(`Unexpected positional arguments: ${positional.slice(2).join(" ")}`);
    }
    args.target = positional[0] ?? null;
    args.bump = positional[1] ?? null;
    return args;
}

function validateTarget(target) {
    if (!VALID_TARGETS.has(target)) {
        die(`Invalid target: ${target}. Use sdk, boltz-swap, or all.`);
    }
}

function validateBump(bump) {
    if (!isBumpType(bump) && !isLiteralVersion(bump)) {
        die(`Invalid bump or version: ${bump}. Use patch|minor|major|pre* or a literal version.`);
    }
}

function validatePreid(preid) {
    if (!VALID_PREIDS.has(preid)) {
        die(`Invalid preid: ${preid}. Use alpha|beta|rc|next.`);
    }
}

function primarySelection(target) {
    if (target === "all") return ["sdk", "boltz-swap"];
    if (target === "sdk") return ["sdk", "boltz-swap"];
    if (target === "boltz-swap") return ["boltz-swap"];
    die(`Invalid target: ${target}`);
}

function computeTargetVersions({ target, bump, preid, boltzBump }) {
    validateTarget(target);
    validateBump(bump);
    if (preid !== null) validatePreid(preid);
    if (isPrereleaseBump(bump) && !preid) {
        die(`Pre-release bump '${bump}' requires --preid alpha|beta|rc|next`);
    }

    const selected = primarySelection(target);
    const plan = new Map();

    for (const pkg of PACKAGES) {
        if (!selected.includes(pkg.key)) continue;
        const current = readPackageVersion(pkg.pkgJson);
        let next;
        const isPrimary = pkg.key === target || target === "all";

        if (isPrimary) {
            next = isLiteralVersion(bump) ? bump : incrementVersion(current, bump, preid);
        } else if (pkg.key === "boltz-swap" && target === "sdk") {
            if (boltzBump !== null) {
                if (isLiteralVersion(boltzBump)) {
                    next = boltzBump;
                } else if (isPrereleaseBump(boltzBump)) {
                    if (!preid) die(`--boltz-bump '${boltzBump}' requires --preid`);
                    next = incrementVersion(current, boltzBump, preid);
                } else if (isBumpType(boltzBump)) {
                    next = incrementVersion(current, boltzBump, null);
                } else {
                    die(`Invalid --boltz-bump value: ${boltzBump}`);
                }
            } else if (isPrereleaseBump(bump)) {
                next = incrementVersion(current, bump, preid);
            } else {
                const sdkNext = plan.get("sdk").next;
                const sdkPre = parseVersion(sdkNext).pre;
                if (sdkPre) {
                    const sdkPreid = sdkPre.split(".")[0];
                    if (!VALID_PREIDS.has(sdkPreid)) {
                        die(
                            `Cannot derive dependent boltz-swap bump from SDK literal ${sdkNext} ` +
                                `(unrecognized prerelease id '${sdkPreid}'). ` +
                                `Pass --boltz-bump explicitly.`,
                        );
                    }
                    next = incrementVersion(current, "prepatch", sdkPreid);
                } else {
                    next = incrementVersion(current, "patch", null);
                }
            }
        } else {
            die(`Unhandled selection for ${pkg.key} with target ${target}`);
        }

        if (compareVersions(parseVersion(next), parseVersion(current)) <= 0) {
            die(`Target version ${next} must be greater than current ${pkg.name}@${current}`);
        }
        plan.set(pkg.key, { current, next });
    }

    return plan;
}

function selectedInDependencyOrder(plan) {
    return PACKAGES.filter((p) => plan.has(p.key))
        .sort((a, b) => a.order - b.order)
        .map((p) => p.key);
}

function summarizePlan({ target, bump, preid, boltzBump, plan }) {
    console.log("Release plan:");
    console.log(`  target: ${target}`);
    const opts = [bump];
    if (preid) opts.push(`--preid ${preid}`);
    if (boltzBump) opts.push(`--boltz-bump ${boltzBump}`);
    console.log(`  bump: ${opts.join(" ")}`);
    console.log("  selected packages:");
    for (const key of selectedInDependencyOrder(plan)) {
        const pkg = PACKAGE_BY_KEY[key];
        const { current, next } = plan.get(key);
        console.log(`    ${pkg.name}: ${current} -> ${next}`);
        console.log(`      tag: ${pkg.tagPrefix}${next}`);
        console.log(`      npm dist-tag: ${distTagFor(next)}`);
    }
    const order = selectedInDependencyOrder(plan)
        .map((k) => PACKAGE_BY_KEY[k].name)
        .join(", ");
    console.log(`  publish order: ${order}`);
    if (plan.has("boltz-swap")) {
        const sdkChanges = plan.has("sdk");
        const sdkVersion = sdkChanges
            ? plan.get("sdk").next
            : readPackageVersion(PACKAGE_BY_KEY.sdk.pkgJson);
        console.log(
            `  boltz-swap pinned @arkade-os/sdk: ${sdkVersion} (changes: ${
                sdkChanges ? "yes" : "no"
            })`,
        );
    }
}

function gitCurrentBranch() {
    return execFileSync("git", ["branch", "--show-current"], {
        cwd: ROOT_DIR,
        encoding: "utf8",
    }).trim();
}

function assertReleaseBranch(plan) {
    const isPrerelease = [...plan.values()].some((v) => parseVersion(v.next).pre);
    if (isPrerelease) return;

    const branch = gitCurrentBranch();
    if (branch !== RELEASE_BRANCH) {
        die(
            `Stable releases must be run from ${RELEASE_BRANCH}; current branch is ${branch || "detached HEAD"}. ` +
                `Prerelease versions (prepatch/preminor/premajor/prerelease, or a literal -alpha/-beta/-rc/-next version) may be run from any branch.`,
        );
    }
}

function gitClean() {
    const out = execFileSync("git", ["status", "--porcelain"], {
        cwd: ROOT_DIR,
        encoding: "utf8",
    });
    return out.trim() === "";
}

function gitTagExists(tag) {
    const result = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
        cwd: ROOT_DIR,
        stdio: "ignore",
    });
    return result.status === 0;
}

function gitTagSha(tag) {
    return execFileSync("git", ["rev-list", "-n", "1", tag], {
        cwd: ROOT_DIR,
        encoding: "utf8",
    }).trim();
}

function gitHeadSha() {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT_DIR, encoding: "utf8" }).trim();
}

function run(cmd, cmdArgs, options = {}) {
    const result = spawnSync(cmd, cmdArgs, {
        cwd: options.cwd ?? ROOT_DIR,
        stdio: "inherit",
        ...options,
    });
    if (result.status !== 0) die(`Command failed: ${cmd} ${cmdArgs.join(" ")}`);
}

function runCapture(cmd, cmdArgs, options = {}) {
    const result = spawnSync(cmd, cmdArgs, {
        cwd: options.cwd ?? ROOT_DIR,
        encoding: "utf8",
        ...options,
    });
    if (result.status !== 0) {
        die(`Command failed: ${cmd} ${cmdArgs.join(" ")}\n${result.stderr ?? ""}`);
    }
    return result.stdout;
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return null;
    }
}

function clearState() {
    try {
        fs.unlinkSync(STATE_FILE);
    } catch {
        /* ignore */
    }
}

function packAndReadManifest(pkg) {
    const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "arkade-pack-"));
    try {
        run("pnpm", ["pack", "--pack-destination", packDir], { cwd: pkg.dir });
        const tarballs = fs.readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) die(`pnpm pack produced no tarball in ${packDir}`);
        const tarball = path.join(packDir, tarballs[0]);
        const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "arkade-extract-"));
        try {
            run("tar", ["-xzf", tarball, "-C", extractDir, "package/package.json"]);
            return JSON.parse(
                fs.readFileSync(path.join(extractDir, "package/package.json"), "utf8"),
            );
        } finally {
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(packDir, { recursive: true, force: true });
    }
}

function validateBoltzPackedDep(expectedSdkVersion) {
    const boltz = PACKAGE_BY_KEY["boltz-swap"];
    console.log(`Packing ${boltz.name} to verify pinned @arkade-os/sdk dependency...`);
    const manifest = packAndReadManifest(boltz);
    const actual = manifest.dependencies?.["@arkade-os/sdk"];
    if (actual !== expectedSdkVersion) {
        die(
            `${boltz.name} packed manifest pins @arkade-os/sdk@${actual} but expected ${expectedSdkVersion}`,
        );
    }
    console.log(`Verified ${boltz.name} pins @arkade-os/sdk@${expectedSdkVersion}`);
}

function detectCleanupCandidates() {
    const state = readState();
    if (state && Array.isArray(state.selected) && state.selected.length > 0) {
        return { source: "state", keys: [...state.selected], state };
    }
    const dirty = [];
    for (const pkg of PACKAGES) {
        const current = readPackageVersion(pkg.pkgJson);
        const head = headPackageVersion(path.relative(ROOT_DIR, pkg.pkgJson));
        if (head && current !== head) dirty.push(pkg.key);
    }
    return { source: "manifest-diff", keys: dirty, state: null };
}

function cleanup({ target }) {
    let keys;
    let state = null;

    if (target) {
        validateTarget(target);
        keys = target === "all" ? ["sdk", "boltz-swap"] : [target];
        state = readState();
    } else {
        const detected = detectCleanupCandidates();
        keys = detected.keys;
        state = detected.state;
        if (keys.length === 0) {
            console.log("No release artifacts detected. Nothing to clean.");
            return;
        }
        console.log(`Cleanup candidates from ${detected.source}: ${keys.join(", ")}`);
    }

    if (state && state.commitCreated) {
        console.log(
            "A release commit was already created. Cleanup will not reset commits or branches.\n" +
                "Restoring manifests and removing local tags only. Inspect 'git log' and decide\n" +
                "whether to undo the commit manually (e.g. 'git reset --hard HEAD~1') before retrying.",
        );
    }

    for (const key of keys) {
        const pkg = PACKAGE_BY_KEY[key];
        const current = readPackageVersion(pkg.pkgJson);
        const head = headPackageVersion(path.relative(ROOT_DIR, pkg.pkgJson));
        if (head && current !== head) {
            run("git", ["checkout", "--", pkg.pkgJson]);
            console.log(`Restored ${pkg.name} manifest to ${head}`);
        }
        const candidates = new Set();
        if (state?.tags?.[key]) candidates.add(state.tags[key]);
        candidates.add(`${pkg.tagPrefix}${current}`);
        if (head) candidates.add(`${pkg.tagPrefix}${head}`);
        for (const tag of candidates) {
            if (gitTagExists(tag)) {
                run("git", ["tag", "-d", tag]);
                console.log(`Removed local tag ${tag}`);
            }
        }
    }

    if (state) clearState();
    console.log("Cleanup complete.");
}

function dryRun(args) {
    const plan = computeTargetVersions(args);
    summarizePlan({ ...args, plan });
    console.log("Dry run only; no changes made.");
}

function release(args) {
    const plan = computeTargetVersions(args);
    assertReleaseBranch(plan);
    summarizePlan({ ...args, plan });

    if (!gitClean()) {
        die("Working directory is not clean. Commit or stash changes first.");
    }

    console.log("Running unit tests...");
    run("pnpm", ["run", "test:unit"]);

    const selectedKeys = selectedInDependencyOrder(plan);
    const state = {
        selected: selectedKeys,
        originalVersions: Object.fromEntries(selectedKeys.map((k) => [k, plan.get(k).current])),
        targetVersions: Object.fromEntries(selectedKeys.map((k) => [k, plan.get(k).next])),
        tags: Object.fromEntries(
            selectedKeys.map((k) => [k, `${PACKAGE_BY_KEY[k].tagPrefix}${plan.get(k).next}`]),
        ),
        tagsCreated: Object.fromEntries(selectedKeys.map((k) => [k, false])),
        commitCreated: false,
        timestamp: new Date().toISOString(),
    };
    writeState(state);

    try {
        for (const key of selectedKeys) {
            const pkg = PACKAGE_BY_KEY[key];
            writePackageVersion(pkg.pkgJson, plan.get(key).next);
            console.log(`Set ${pkg.name} to ${plan.get(key).next}`);
        }

        console.log("Building packages...");
        run("pnpm", ["-r", "build"]);

        const manifestPaths = selectedKeys.map((k) => PACKAGE_BY_KEY[k].pkgJson);
        run("git", ["add", ...manifestPaths]);
        const stagedCheck = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT_DIR });
        if (stagedCheck.status === 0) {
            console.log("No manifest changes staged; reusing current HEAD.");
        } else {
            const summary = selectedKeys
                .map((k) => `${PACKAGE_BY_KEY[k].name}@${plan.get(k).next}`)
                .join(", ");
            run("git", ["commit", "-m", `chore: release ${summary}`]);
            state.commitCreated = true;
            writeState(state);
        }

        for (const key of selectedKeys) {
            const tag = state.tags[key];
            if (gitTagExists(tag)) {
                const tagSha = gitTagSha(tag);
                const headSha = gitHeadSha();
                if (tagSha !== headSha) {
                    die(`Local tag ${tag} exists but does not point at HEAD`);
                }
                console.log(`Tag ${tag} already exists at HEAD; reusing.`);
            } else {
                run("git", ["tag", tag]);
                console.log(`Created tag ${tag}`);
            }
            state.tagsCreated[key] = true;
            writeState(state);
        }

        for (const key of selectedKeys) {
            const pkg = PACKAGE_BY_KEY[key];
            const version = plan.get(key).next;

            if (key === "boltz-swap") {
                const expectedSdk = plan.has("sdk")
                    ? plan.get("sdk").next
                    : readPackageVersion(PACKAGE_BY_KEY.sdk.pkgJson);
                validateBoltzPackedDep(expectedSdk);
            }

            const published = spawnSync("npm", ["view", `${pkg.name}@${version}`, "version"], {
                cwd: ROOT_DIR,
                stdio: "ignore",
            });
            if (published.status === 0) {
                console.log(`${pkg.name}@${version} is already published; skipping.`);
                continue;
            }
            const distTag = distTagFor(version);
            console.log(`Publishing ${pkg.name}@${version} with npm dist-tag '${distTag}'...`);
            run("pnpm", ["publish", "--tag", distTag, "--no-git-checks"], { cwd: pkg.dir });
        }

        run("git", ["push", "origin", "HEAD"]);
        for (const key of selectedKeys) {
            run("git", ["push", "origin", state.tags[key]]);
        }

        clearState();
        const released = selectedKeys
            .map((k) => `${PACKAGE_BY_KEY[k].name}@${plan.get(k).next}`)
            .join(", ");
        console.log(`Released ${released}`);
    } catch (error) {
        console.error(`Release failed: ${error.message ?? error}`);
        console.error(
            `Release state preserved at ${STATE_FILE}. Run 'pnpm run release:cleanup' to revert local changes.`,
        );
        process.exit(1);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        showHelp();
        return;
    }

    if (args.cleanup) {
        cleanup({ target: args.target });
        return;
    }

    if (!args.target) die("Missing target. Run with --help for usage.");
    if (!args.bump) die("Missing bump or version. Run with --help for usage.");

    if (args.dryRun) {
        dryRun(args);
        return;
    }

    release(args);
}

main();
