#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TS_SDK_DIR="$ROOT_DIR/packages/ts-sdk"
BOLTZ_DIR="$ROOT_DIR/packages/boltz-swap"

DRY_RUN=false
VERSION_BUMP=""
PRERELEASE_ID=""

show_help() {
    cat <<'HELP'
Usage: scripts/release.sh [options] [bump-or-version]

Release both @arkade-os/sdk and @arkade-os/boltz-swap at the same version.

Arguments:
  bump-or-version   patch | minor | major | prepatch | preminor | premajor |
                    prerelease | literal version such as 0.4.30

Options:
  --dry-run         Print the release steps without changing files
  --preid <id>      Pre-release identifier: alpha, beta, rc, or next
  --cleanup         Reset package version edits and remove the matching local tag
  --help            Show this message

When package versions are not already aligned, pass a literal target version for
that first lockstep release. After they are aligned, patch/minor/major bumps are
computed from the shared current version.
HELP
}

die() {
    echo "Error: $*" >&2
    exit 1
}

package_version() {
    node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(pkg.version);" "$1/package.json"
}

head_package_version() {
    git show "HEAD:$1" | node -e "let input=''; process.stdin.on('data', (chunk) => input += chunk); process.stdin.on('end', () => console.log(JSON.parse(input).version));"
}

cleanup() {
    echo "Cleaning up release artifacts..."

    local sdk_version boltz_version sdk_head_version boltz_head_version
    sdk_version=$(package_version "$TS_SDK_DIR")
    boltz_version=$(package_version "$BOLTZ_DIR")
    sdk_head_version=$(head_package_version "packages/ts-sdk/package.json")
    boltz_head_version=$(head_package_version "packages/boltz-swap/package.json")

    if [[ "$sdk_version" == "$sdk_head_version" && "$boltz_version" == "$boltz_head_version" ]]; then
        echo "No uncommitted package version edits to clean up."
        exit 0
    fi

    git checkout -- "$TS_SDK_DIR/package.json" "$BOLTZ_DIR/package.json" 2>/dev/null || true

    for version in "$sdk_version" "$boltz_version"; do
        if git tag --list "v$version" | grep -q .; then
            git tag -d "v$version"
            echo "Removed local tag v$version"
        fi
    done

    echo "Cleanup complete"
    exit 0
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --cleanup)
            cleanup
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --preid)
            [[ $# -ge 2 ]] || die "--preid requires a value"
            PRERELEASE_ID="$2"
            shift 2
            ;;
        --help)
            show_help
            exit 0
            ;;
        --)
            shift
            ;;
        --*)
            die "Unknown option: $1"
            ;;
        *)
            [[ -z "$VERSION_BUMP" ]] || die "Only one bump or version argument is allowed"
            VERSION_BUMP="$1"
            shift
            ;;
    esac
done

SDK_VERSION=$(package_version "$TS_SDK_DIR")
BOLTZ_VERSION=$(package_version "$BOLTZ_DIR")

if [[ -z "$VERSION_BUMP" ]]; then
    echo "Current versions: sdk=$SDK_VERSION, boltz-swap=$BOLTZ_VERSION"
    echo "What version should be released? (patch|minor|major|pre*|literal version like 0.4.30)"
    read -r VERSION_BUMP
fi

if [[ "$VERSION_BUMP" == pre* && -z "$PRERELEASE_ID" ]]; then
    echo "Pre-release identifier? (alpha|beta|rc|next)"
    read -r PRERELEASE_ID
fi

if [[ -n "$PRERELEASE_ID" ]]; then
    case "$PRERELEASE_ID" in
        alpha|beta|rc|next) ;;
        *) die "Invalid pre-release identifier: $PRERELEASE_ID" ;;
    esac
fi

NEW_VERSION=$(node - "$SDK_VERSION" "$BOLTZ_VERSION" "$VERSION_BUMP" "$PRERELEASE_ID" <<'NODE'
const [sdkVersion, boltzVersion, bump, preid] = process.argv.slice(2);
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
const bumpTypes = new Set([
    "patch",
    "minor",
    "major",
    "prepatch",
    "preminor",
    "premajor",
    "prerelease",
]);

function fail(message) {
    console.error(message);
    process.exit(1);
}

function parse(version) {
    const match = version.match(versionPattern);
    if (!match) fail(`Unsupported semver version: ${version}`);
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] || "",
    };
}

function format(version) {
    return `${version.major}.${version.minor}.${version.patch}${version.pre ? `-${version.pre}` : ""}`;
}

function compareIdentifiers(left, right) {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function compare(left, right) {
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key]) return left[key] - right[key];
    }
    if (left.pre === right.pre) return 0;
    if (!left.pre) return 1;
    if (!right.pre) return -1;

    const leftParts = left.pre.split(".");
    const rightParts = right.pre.split(".");
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
        if (leftParts[index] === undefined) return -1;
        if (rightParts[index] === undefined) return 1;
        const partCompare = compareIdentifiers(leftParts[index], rightParts[index]);
        if (partCompare !== 0) return partCompare;
    }
    return 0;
}

function withPrerelease(version, identifier) {
    const parts = version.pre ? version.pre.split(".") : [];
    const last = parts[parts.length - 1];
    if (parts[0] === identifier && /^\d+$/.test(last)) {
        parts[parts.length - 1] = String(Number(last) + 1);
        return { ...version, pre: parts.join(".") };
    }
    return { ...version, pre: `${identifier}.0` };
}

function increment(current, type, identifier) {
    const next = { ...parse(current) };

    switch (type) {
        case "patch":
            if (next.pre) next.pre = "";
            else next.patch += 1;
            return format(next);
        case "minor":
            next.minor += 1;
            next.patch = 0;
            next.pre = "";
            return format(next);
        case "major":
            next.major += 1;
            next.minor = 0;
            next.patch = 0;
            next.pre = "";
            return format(next);
        case "prepatch":
            next.patch += 1;
            next.pre = "";
            return format(withPrerelease(next, identifier));
        case "preminor":
            next.minor += 1;
            next.patch = 0;
            next.pre = "";
            return format(withPrerelease(next, identifier));
        case "premajor":
            next.major += 1;
            next.minor = 0;
            next.patch = 0;
            next.pre = "";
            return format(withPrerelease(next, identifier));
        case "prerelease":
            if (!next.pre) next.patch += 1;
            return format(withPrerelease(next, identifier));
        default:
            fail(`Unsupported version bump: ${type}`);
    }
}

const literal = versionPattern.test(bump);
if (!literal && !bumpTypes.has(bump)) {
    fail(`Unsupported version bump or target version: ${bump}`);
}

if (!literal && sdkVersion !== boltzVersion) {
    fail(
        `Package versions are not aligned (sdk=${sdkVersion}, boltz-swap=${boltzVersion}). ` +
            "Pass a literal target version for the first lockstep release.",
    );
}

if (bump.startsWith("pre") && !preid) {
    fail(`A pre-release bump requires --preid alpha|beta|rc|next`);
}

const target = literal ? bump : increment(sdkVersion, bump, preid);
const parsedTarget = parse(target);
for (const [name, version] of [
    ["@arkade-os/sdk", sdkVersion],
    ["@arkade-os/boltz-swap", boltzVersion],
]) {
    if (compare(parsedTarget, parse(version)) < 0) {
        fail(`Target version ${target} is lower than current ${name}@${version}`);
    }
}

console.log(target);
NODE
)

NPM_TAG="latest"
case "$NEW_VERSION" in
    *-alpha*) NPM_TAG="alpha" ;;
    *-beta*) NPM_TAG="beta" ;;
    *-rc*) NPM_TAG="rc" ;;
    *-next*) NPM_TAG="next" ;;
esac

if [[ "$SDK_VERSION" != "$BOLTZ_VERSION" ]]; then
    echo "Current versions are not aligned: sdk=$SDK_VERSION, boltz-swap=$BOLTZ_VERSION"
    echo "The release will set both package versions to $NEW_VERSION."
fi

if [[ "$DRY_RUN" == true ]]; then
    echo "Would run: pnpm run test:unit"
    echo "Would set both package versions to $NEW_VERSION"
    echo "Would run: pnpm -r build"
    echo "Would commit package version changes and create tag v$NEW_VERSION"
    echo "Would publish both packages with npm dist-tag '$NPM_TAG'"
    echo "Would push the release commit and v$NEW_VERSION tag"
    exit 0
fi

if [[ -n $(git status --porcelain) ]]; then
    die "Working directory is not clean. Commit or stash changes first."
fi

pnpm run test:unit

node - "$NEW_VERSION" "$TS_SDK_DIR/package.json" "$BOLTZ_DIR/package.json" <<'NODE'
const fs = require("fs");
const [version, ...paths] = process.argv.slice(2);
for (const path of paths) {
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    pkg.version = version;
    fs.writeFileSync(path, `${JSON.stringify(pkg, null, 4)}\n`);
}
NODE

pnpm -r build

git add "$TS_SDK_DIR/package.json" "$BOLTZ_DIR/package.json"
if git diff --cached --quiet; then
    echo "Package versions are already set to $NEW_VERSION; reusing current HEAD."
else
    git commit -m "chore: release v$NEW_VERSION"
fi

if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
    TAG_SHA=$(git rev-list -n 1 "v$NEW_VERSION")
    HEAD_SHA=$(git rev-parse HEAD)
    [[ "$TAG_SHA" == "$HEAD_SHA" ]] || die "Local tag v$NEW_VERSION exists but does not point at HEAD"
else
    git tag "v$NEW_VERSION"
fi

publish_package() {
    local package_name="$1"
    local package_dir="$2"

    if npm view "$package_name@$NEW_VERSION" version >/dev/null 2>&1; then
        echo "$package_name@$NEW_VERSION is already published; skipping."
        return
    fi

    echo "Publishing $package_name@$NEW_VERSION with npm dist-tag '$NPM_TAG'..."
    (cd "$package_dir" && pnpm publish --tag "$NPM_TAG" --no-git-checks)
}

publish_package "@arkade-os/sdk" "$TS_SDK_DIR"
publish_package "@arkade-os/boltz-swap" "$BOLTZ_DIR"

git push origin HEAD
git push origin "v$NEW_VERSION"

echo "Released v$NEW_VERSION (@arkade-os/sdk and @arkade-os/boltz-swap)"
