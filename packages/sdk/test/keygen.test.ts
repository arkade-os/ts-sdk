import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

// The bin runs as its own process under `pnpm dlx`, so it is exercised the same way here.

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const binPath = fileURLToPath(new URL(`../${pkg.bin["arkade-keygen"]}`, import.meta.url));

const run = (...args: string[]) =>
    spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });

describe("arkade-keygen", () => {
    it("prints one valid 12-word English mnemonic and nothing else", () => {
        const { status, stdout, stderr } = run();

        expect(status).toBe(0);
        expect(stderr).toBe("");
        expect(stdout.endsWith("\n")).toBe(true);
        const phrase = stdout.trimEnd();
        expect(phrase.split(" ")).toHaveLength(12);
        expect(validateMnemonic(phrase, wordlist)).toBe(true);
    });

    it("prints a fresh mnemonic on every run", () => {
        expect(run().stdout).not.toBe(run().stdout);
    });

    it("prints usage for --help", () => {
        const { status, stdout } = run("--help");

        expect(status).toBe(0);
        expect(stdout).toContain("Usage: arkade-keygen");
    });

    // A flag that only a later version supports must fail here, not print a phrase it did not ask for.
    it("refuses an unknown argument without printing a mnemonic", () => {
        const { status, stdout, stderr } = run("--words", "24");

        expect(status).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toContain("Unknown option '--words'");
        expect(stderr).toContain("Usage: arkade-keygen");
    });

    // `pnpm dlx` and `npx` run a package's only bin; a second one would need the caller to name it.
    it("is the package's only bin and ships in the published files", () => {
        expect(Object.keys(pkg.bin)).toEqual(["arkade-keygen"]);
        expect(pkg.files).toContain("bin");
        expect(readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    });
});
