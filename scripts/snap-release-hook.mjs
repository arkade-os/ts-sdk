// Release-time helpers for @arkade-os/snap.
//
// A snap is not an ordinary npm package: snap.manifest.json carries its own
// `version` (which MetaMask requires to match the published package version) and
// a `source.shasum` that MetaMask validates at install time. A mismatch in
// either bricks installation for every user.
//
// The shasum is NOT a plain sha256 of dist/bundle.js. @metamask/snaps-utils
// computes it over every source file (bundle + icon + auxiliary + localization):
// sort by path, sha256 each, concatenate the digests, then sha256 the result.
// Never reimplement it here — always delegate to mm-snap.
//
// Ordering within release.mjs matters:
//   1. writePackageVersion() sets package.json
//   2. syncSnapManifestVersion()  <- mirrors it into snap.manifest.json
//   3. `pnpm -r build` runs `mm-snap build`, regenerating bundle + shasum
//   4. verifySnapManifest()  <- aborts the release if anything is inconsistent
//   5. git add (including snap.manifest.json), commit, tag, publish

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function paths(rootDir) {
    const dir = path.join(rootDir, "packages/snap");
    return {
        dir,
        pkgJson: path.join(dir, "package.json"),
        manifest: path.join(dir, "snap.manifest.json"),
    };
}

/**
 * Mirror the package.json version into snap.manifest.json. Must run after
 * writePackageVersion() and before the build.
 */
export function syncSnapManifestVersion(rootDir, version) {
    const { manifest } = paths(rootDir);
    const doc = readJson(manifest);
    if (doc.version === version) return { changed: false, version };
    doc.version = version;
    // 2-space to match mm-snap's own writer, which rewrites this file on --fix.
    fs.writeFileSync(manifest, `${JSON.stringify(doc, null, 2)}\n`);
    return { changed: true, version };
}

/**
 * Validate the built snap. Throws with a human-readable reason on any
 * inconsistency; the caller aborts the release.
 *
 * Primary gate is `mm-snap manifest`, whose exit code is reliable (verified
 * 2026-07-28: 0 when valid, 1 on a checksum mismatch). The --fix idempotency
 * check is a cheap backstop in case that ever regresses.
 */
export function verifySnapManifest(rootDir, expectedVersion) {
    const { dir, pkgJson, manifest } = paths(rootDir);

    if (!fs.existsSync(path.join(dir, "dist/bundle.js"))) {
        throw new Error("packages/snap/dist/bundle.js missing — did `mm-snap build` run?");
    }

    const pkgVersion = readJson(pkgJson).version;
    const manifestVersion = readJson(manifest).version;
    if (pkgVersion !== manifestVersion) {
        throw new Error(
            `snap version drift: package.json ${pkgVersion} != snap.manifest.json ${manifestVersion}`,
        );
    }
    if (expectedVersion && pkgVersion !== expectedVersion) {
        throw new Error(
            `snap version drift: package.json ${pkgVersion} != planned ${expectedVersion}`,
        );
    }

    const run = (args) =>
        spawnSync("pnpm", args, {
            cwd: dir,
            encoding: "utf8",
            shell: process.platform === "win32",
        });

    const check = run(["exec", "mm-snap", "manifest"]);
    if (check.status !== 0) {
        throw new Error(
            `snap manifest validation failed:\n${(check.stderr || check.stdout || "").trim()}`,
        );
    }

    // Backstop: `--fix` must be a no-op. If it rewrites the shasum, the
    // validation above did not catch a stale value.
    const before = readJson(manifest).source.shasum;
    const fix = run(["exec", "mm-snap", "manifest", "--fix"]);
    if (fix.status !== 0) {
        throw new Error(
            `mm-snap manifest --fix failed:\n${(fix.stderr || fix.stdout || "").trim()}`,
        );
    }
    const after = readJson(manifest).source.shasum;
    if (before !== after) {
        throw new Error(
            `snap manifest shasum was stale: ${before} -> ${after}. ` +
                `Refusing to publish a manifest mm-snap had to correct.`,
        );
    }

    return { version: pkgVersion, shasum: after };
}
