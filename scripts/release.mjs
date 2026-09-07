#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// `dependsOnSdk` marks a package that consumes @arkade-os/sdk via workspace:*.
// pnpm rewrites that to an exact version on pack/publish, so such a package
// pins whatever SDK version was current when IT was published — which is why
// releasing the SDK implies a dependent release for each of them, and why each
// gets a `--<key>-bump` override to size that dependent bump.
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
        dependsOnSdk: true,
        bumpFlag: "--boltz-bump",
        // Not part of bulk `all` releases for now; still releasable directly
        // (`release.mjs boltz-swap <bump>`) and still dragged along as a
        // dependent when `sdk` is released.
        excludeFromAll: true,
    },
    {
        key: "swap",
        name: "@arkade-os/swap",
        dir: path.join(ROOT_DIR, "packages/swap"),
        pkgJson: path.join(ROOT_DIR, "packages/swap/package.json"),
        tagPrefix: "@arkade-os/swap/",
        order: 3,
        dependsOnSdk: true,
        bumpFlag: "--swap-bump",
    },
];

const PACKAGE_BY_KEY = Object.fromEntries(PACKAGES.map((p) => [p.key, p]));
const ACTIVE_PACKAGES = PACKAGES.filter((p) => !p.excludedFromRelease);
const ALL_KEYS = ACTIVE_PACKAGES.map((p) => p.key);
const DEPENDENT_PACKAGES = ACTIVE_PACKAGES.filter((p) => p.dependsOnSdk);
const PACKAGE_BY_BUMP_FLAG = Object.fromEntries(
    DEPENDENT_PACKAGES.map((p) => [p.bumpFlag, p.key]),
);
const VALID_TARGETS = new Set([...ALL_KEYS, "all"]);
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
  ${[...ALL_KEYS, "all"].join(" | ")}

Bump or version:
  patch | minor | major | prepatch | preminor | premajor | prerelease |
  literal semver such as 0.4.30 or 0.5.0-beta.0

Options:
  --dry-run                Print the release plan without changing files
  --preid <id>             Pre-release identifier: alpha, beta, rc, or next
${DEPENDENT_PACKAGES.map(
    (p) =>
        `  ${`${p.bumpFlag} <bump|ver>`.padEnd(24)} Override the dependent ${p.key} bump when SDK is
                           released. Defaults to 'patch' for stable SDK
                           releases and to a prerelease bump matching the SDK
                           target preid for prerelease SDK releases (including
                           literal versions like 0.5.0-beta.0).`,
).join("\n")}
  --cleanup [target]       Restore local manifests and delete local
                           package-scoped tags. With no target, auto-detect
                           from release state or dirty manifests.
  --allow-any-branch       Escape hatch: publish a stable version from a
                           non-${RELEASE_BRANCH} branch. The release commit and tag
                           land on the current branch, so only use this when
                           the branch is the intended source of the release.
  --help                   Show this message

Releasing SDK implies a dependent release of ${DEPENDENT_PACKAGES.map((p) => p.name).join(" and ")}
because they depend on SDK via workspace:* (pnpm rewrites this to an exact
version on pack/publish).

Stable releases (patch/minor/major or a literal non-prerelease version) must
be run from master, unless --allow-any-branch is passed. Prerelease releases
(prepatch/preminor/premajor/prerelease, or a literal -alpha/-beta/-rc/-next
version) may be run from any branch and publish under a matching npm
dist-tag, never 'latest'.
`,
    );
}

function parseArgs(argv) {
    const args = {
        target: null,
        bump: null,
        preid: null,
        /** Per-dependent-package bump overrides, keyed by package key. */
        dependentBumps: {},
        dryRun: false,
        cleanup: false,
        allowAnyBranch: false,
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
            case "--allow-any-branch":
                args.allowAnyBranch = true;
                break;
            case "--preid":
                if (i + 1 >= argv.length) die("--preid requires a value");
                args.preid = argv[++i];
                break;
            case "--":
                // pnpm forwards a literal "--" separator before script args; ignore it
                // rather than treating the remainder as positional (that would swallow
                // subsequent options like --preid).
                break;
            default: {
                const dependentKey = PACKAGE_BY_BUMP_FLAG[arg];
                if (dependentKey) {
                    if (i + 1 >= argv.length) die(`${arg} requires a value`);
                    args.dependentBumps[dependentKey] = argv[++i];
                    break;
                }
                if (arg.startsWith("--")) die(`Unknown option: ${arg}`);
                positional.push(arg);
            }
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
        const excluded = PACKAGES.find((p) => p.key === target && p.excludedFromRelease);
        if (excluded) {
            die(`${excluded.name} is excluded from the release cycle until further notice.`);
        }
        die(`Invalid target: ${target}. Use ${[...ALL_KEYS, "all"].join(", ")}.`);
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
    // Releasing the SDK drags every SDK-dependent package along, because each
    // would otherwise stay published against the previous SDK version.
    if (target === "sdk") return ALL_KEYS;
    // `all` is a bulk convenience, not an implication of the SDK bump; packages
    // marked `excludeFromAll` opt out of it but remain releasable directly.
    if (target === "all") return ALL_KEYS.filter((k) => !PACKAGE_BY_KEY[k].excludeFromAll);
    if (PACKAGE_BY_KEY[target]) return [target];
    die(`Invalid target: ${target}`);
}

function computeTargetVersions({ target, bump, preid, dependentBumps = {} }) {
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
        } else if (pkg.dependsOnSdk && target === "sdk") {
            const override = dependentBumps[pkg.key] ?? null;
            if (override !== null) {
                if (isLiteralVersion(override)) {
                    next = override;
                } else if (isPrereleaseBump(override)) {
                    if (!preid) die(`${pkg.bumpFlag} '${override}' requires --preid`);
                    next = incrementVersion(current, override, preid);
                } else if (isBumpType(override)) {
                    next = incrementVersion(current, override, null);
                } else {
                    die(`Invalid ${pkg.bumpFlag} value: ${override}`);
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
                            `Cannot derive dependent ${pkg.key} bump from SDK literal ${sdkNext} ` +
                                `(unrecognized prerelease id '${sdkPreid}'). ` +
                                `Pass ${pkg.bumpFlag} explicitly.`,
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

function summarizePlan({ target, bump, preid, dependentBumps = {}, allowAnyBranch, plan }) {
    console.log("Release plan:");
    console.log(`  target: ${target}`);
    console.log(
        `  branch: ${gitCurrentBranch() || "detached HEAD"}${
            allowAnyBranch ? " (--allow-any-branch: branch check bypassed)" : ""
        }`,
    );
    const opts = [bump];
    if (preid) opts.push(`--preid ${preid}`);
    for (const pkg of DEPENDENT_PACKAGES) {
        const override = dependentBumps[pkg.key];
        if (override) opts.push(`${pkg.bumpFlag} ${override}`);
    }
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
    const sdkChanges = plan.has("sdk");
    const sdkVersion = sdkChanges
        ? plan.get("sdk").next
        : readPackageVersion(PACKAGE_BY_KEY.sdk.pkgJson);
    for (const pkg of DEPENDENT_PACKAGES) {
        if (!plan.has(pkg.key)) continue;
        console.log(
            `  ${pkg.key} pinned @arkade-os/sdk: ${sdkVersion} (changes: ${
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

function assertReleaseBranch(plan, allowAnyBranch = false) {
    const hasStableVersion = [...plan.values()].some((v) => !parseVersion(v.next).pre);
    if (!hasStableVersion) return;

    const branch = gitCurrentBranch();
    if (branch === RELEASE_BRANCH) return;

    if (allowAnyBranch) {
        console.warn(
            `Warning: --allow-any-branch is set; releasing a stable version from ` +
                `${branch || "detached HEAD"} instead of ${RELEASE_BRANCH}. ` +
                `The release commit and tag will land on this branch.`,
        );
        return;
    }

    die(
        `Stable releases must be run from ${RELEASE_BRANCH}; current branch is ${branch || "detached HEAD"}. ` +
            `Prerelease versions (prepatch/preminor/premajor/prerelease, or a literal -alpha/-beta/-rc/-next version) may be run from any branch. ` +
            `Pass --allow-any-branch to release a stable version from this branch anyway.`,
    );
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

function validateDependentPackedDep(pkg, expectedSdkVersion) {
    console.log(`Packing ${pkg.name} to verify pinned @arkade-os/sdk dependency...`);
    const manifest = packAndReadManifest(pkg);
    const actual = manifest.dependencies?.["@arkade-os/sdk"];
    if (actual !== expectedSdkVersion) {
        die(
            `${pkg.name} packed manifest pins @arkade-os/sdk@${actual} but expected ${expectedSdkVersion}`,
        );
    }
    console.log(`Verified ${pkg.name} pins @arkade-os/sdk@${expectedSdkVersion}`);
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
        keys = target === "all" ? [...ALL_KEYS] : [target];
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
    assertReleaseBranch(plan, args.allowAnyBranch);
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

            if (pkg.dependsOnSdk) {
                const expectedSdk = plan.has("sdk")
                    ? plan.get("sdk").next
                    : readPackageVersion(PACKAGE_BY_KEY.sdk.pkgJson);
                validateDependentPackedDep(pkg, expectedSdk);
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
