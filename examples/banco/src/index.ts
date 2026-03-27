#!/usr/bin/env tsx
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

import * as fs from "node:fs";
import * as path from "node:path";
import {
    banco,
    SingleKey,
    Wallet,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../../src";
const { Maker, Taker, Offer } = banco;

// ── ANSI helpers ──────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

const bold = (s: string) => `${BOLD}${s}${RESET}`;
const dim = (s: string) => `${DIM}${s}${RESET}`;
const green = (s: string) => `${GREEN}${s}${RESET}`;
const red = (s: string) => `${RED}${s}${RESET}`;

function banner() {
    console.log(
        `\n${BOLD}${CYAN}  banco${RESET} ${dim("— peer-to-peer arkade swaps")}\n`
    );
}

function formatSats(sats: bigint | number): string {
    return Number(sats).toLocaleString("en-US");
}

// ── Spinner ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinner(msg: string): { stop: (result?: string) => void } {
    let i = 0;
    const id = setInterval(() => {
        process.stderr.write(
            `\r${DIM}${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]}${RESET} ${msg}`
        );
    }, 80);
    return {
        stop(result?: string) {
            clearInterval(id);
            process.stderr.write(`\r${green("✓")} ${msg}`);
            if (result) process.stderr.write(` ${dim(result)}`);
            process.stderr.write("\n");
        },
    };
}

// ── Config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(process.env.HOME ?? ".", ".banco", "config.json");

interface Config {
    serverUrl: string;
    introspectorUrl: string;
    network: string;
    privateKey: string;
}

function loadConfig(): Config {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error(
            `\n  ${red("Error:")} Not initialized.\n  Run ${bold("banco init")} first.\n`
        );
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config: Config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Arg parsing ───────────────────────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i];
        const value = args[i + 1];
        if (!key?.startsWith("--") || !value) {
            fatal(`Unexpected argument: ${key ?? "(empty)"}`);
        }
        result[key.slice(2)] = value;
    }
    return result;
}

function requireArg(opts: Record<string, string>, key: string): string {
    const value = opts[key];
    if (!value) fatal(`Missing required argument: ${bold("--" + key)}`);
    return value;
}

function fatal(msg: string): never {
    console.error(`\n  ${red("Error:")} ${msg}\n`);
    process.exit(1);
}

// ── Wallet factory ────────────────────────────────────────────────────────

function createWallet(privkey: string, serverUrl: string) {
    return Wallet.create({
        identity: SingleKey.fromHex(privkey),
        arkServerUrl: serverUrl,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
}

// ── Commands ──────────────────────────────────────────────────────────────

async function init(args: string[]) {
    const opts = parseArgs(args);
    const serverUrl = requireArg(opts, "server-url");
    const introspectorUrl = requireArg(opts, "introspector-url");

    const privkey = SingleKey.fromRandomBytes().toHex();

    const config: Config = {
        serverUrl,
        introspectorUrl,
        network: "regtest",
        privateKey: privkey,
    };

    saveConfig(config);

    console.log();
    console.log(`  ${dim("Server")}        ${serverUrl}`);
    console.log(`  ${dim("Introspector")}  ${introspectorUrl}`);
    console.log(`  ${dim("Config")}        ${CONFIG_PATH}`);
    console.log(`\n  ${green("Ready.")}\n`);
}

async function make(args: string[]) {
    const config = loadConfig();
    const opts = parseArgs(args);
    const wantAmount = BigInt(requireArg(opts, "want-amount"));
    const wantAsset = opts["want-asset"];
    const cancelDelay = opts["cancel-delay"]
        ? Number(opts["cancel-delay"])
        : undefined;

    const s = spinner("Creating wallet");
    const wallet = await createWallet(config.privateKey, config.serverUrl);
    s.stop();

    const maker = new Maker(wallet, config.serverUrl, config.introspectorUrl);

    const s2 = spinner("Building swap offer");
    const { offer, swapAddress } = await maker.createOffer({
        wantAmount,
        wantAsset,
        cancelDelay,
    });
    s2.stop();

    const decoded = Offer.fromHex(offer);
    const wantLabel = decoded.wantAsset ?? "BTC";

    console.log();
    console.log(`  ${dim("Swap address")}  ${swapAddress}`);
    console.log(
        `  ${dim("Wants")}         ${bold(formatSats(decoded.wantAmount))} sats ${dim("(" + wantLabel + ")")}`
    );
    console.log(`\n  Send your offer amount to the swap address,`);
    console.log(`  then share the offer below with a taker.\n`);
    console.log(dim("  ── offer (copy this) ──────────────────────"));
    console.log(`\n  ${offer}\n`);
}

async function take(args: string[]) {
    const config = loadConfig();
    const opts = parseArgs(args);

    const s = spinner("Creating wallet");
    const wallet = await createWallet(config.privateKey, config.serverUrl);
    s.stop();

    const taker = new Taker(wallet, config.serverUrl, config.introspectorUrl);

    const s2 = spinner("Fulfilling swap");
    let result: { txid: string };
    if (opts["txid"]) {
        result = await taker.fulfillByTxid(opts["txid"]);
    } else {
        result = await taker.fulfill(requireArg(opts, "offer"));
    }
    s2.stop(result.txid);

    console.log(
        `\n  ${green("Swap complete!")} ${dim("txid:")} ${result.txid}\n`
    );
}

async function status(args: string[]) {
    const config = loadConfig();
    const opts = parseArgs(args);
    const address = requireArg(opts, "address");

    const wallet = await createWallet(config.privateKey, config.serverUrl);
    const maker = new Maker(wallet, config.serverUrl, config.introspectorUrl);

    const s = spinner("Querying offers");
    const offers = await maker.getOffers(address);
    s.stop(`${offers.length} VTXO(s)`);

    if (offers.length === 0) {
        console.log(`\n  No VTXOs at this address.\n`);
        return;
    }

    for (const o of offers) {
        console.log(
            `  ${dim(o.txid + ":" + o.vout)}  ${bold(formatSats(o.value))} sats  ${o.spendable ? green("spendable") : red("spent")}`
        );
        if (o.assets && o.assets.length > 0) {
            for (const a of o.assets) {
                console.log(
                    `    ${dim("asset")} ${a.assetId.slice(0, 16)}... × ${a.amount}`
                );
            }
        }
    }
    console.log();
}

async function cancel(args: string[]) {
    const config = loadConfig();
    const opts = parseArgs(args);
    const offerHex = requireArg(opts, "offer");

    const s = spinner("Creating wallet");
    const wallet = await createWallet(config.privateKey, config.serverUrl);
    s.stop();

    const maker = new Maker(wallet, config.serverUrl, config.introspectorUrl);

    const s2 = spinner("Cancelling offer");
    const txid = await maker.cancelOffer(offerHex);
    s2.stop(txid);

    console.log(`\n  ${green("Offer cancelled.")} ${dim("txid:")} ${txid}\n`);
}

// ── Help ──────────────────────────────────────────────────────────────────

function help() {
    banner();
    console.log(`  ${bold("COMMANDS")}\n`);
    console.log(
        `    ${bold("init")}     Configure server and introspector endpoints`
    );
    console.log(`    ${bold("make")}     Create a new swap offer`);
    console.log(`    ${bold("take")}     Accept an existing swap offer`);
    console.log(`    ${bold("status")}   Check VTXOs at a swap address`);
    console.log(`    ${bold("cancel")}   Cancel an existing swap offer`);
    console.log(`    ${bold("help")}     Show this help message`);

    console.log(`\n  ${bold("USAGE")}\n`);
    console.log(
        `    ${dim("$")} banco init --server-url ${dim("<url>")} --introspector-url ${dim("<url>")}`
    );
    console.log(
        `    ${dim("$")} banco make --want-amount ${dim("<sats>")} [--want-asset ${dim("<txid:vout>")}] [--cancel-delay ${dim("<secs>")}]`
    );
    console.log(
        `    ${dim("$")} banco take --txid ${dim("<funding-txid>")}  ${dim("or")}  --offer ${dim("<hex>")}`
    );
    console.log(
        `    ${dim("$")} banco status --address ${dim("<swap-address>")}`
    );
    console.log(`    ${dim("$")} banco cancel --offer ${dim("<hex>")}`);
    console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────

const [, , cmd, ...cmdArgs] = process.argv;

function run(fn: (args: string[]) => Promise<void>) {
    fn(cmdArgs)
        .then(() => process.exit(0))
        .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`\n  ${red("Error:")} ${msg}\n`);
            process.exit(1);
        });
}

switch (cmd) {
    case "init":
        run(init);
        break;
    case "make":
        run(make);
        break;
    case "take":
        run(take);
        break;
    case "status":
        run(status);
        break;
    case "cancel":
        run(cancel);
        break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
        help();
        break;
    default:
        console.error(`\n  ${red("Unknown command:")} ${cmd}`);
        help();
        process.exit(1);
}
