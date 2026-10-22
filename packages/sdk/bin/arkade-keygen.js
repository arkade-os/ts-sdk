#!/usr/bin/env node
// Print a fresh 12-word BIP39 mnemonic to stdout, for `pnpm dlx @arkade-os/sdk`. Nothing is
// written anywhere else: the phrase controls funds, so it only ever goes to the caller.

import { parseArgs } from "node:util";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const USAGE =
    "Usage: arkade-keygen [--help]\nPrints a new 12-word BIP39 mnemonic (English wordlist).\n";

// The flags this command accepts; parseArgs refuses anything else. A later one, such as
// `words: { type: "string" }`, goes here and is read from `parsed.values` below.
const options = {
    help: { type: "boolean", short: "h" },
};

let parsed;
try {
    parsed = parseArgs({ options });
} catch (error) {
    process.stderr.write(`arkade-keygen: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
}

if (parsed?.values.help) {
    process.stdout.write(USAGE);
} else if (parsed) {
    process.stdout.write(`${generateMnemonic(wordlist)}\n`);
}
