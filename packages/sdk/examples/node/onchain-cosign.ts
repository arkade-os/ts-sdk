/**
 * Spends a boarding coin through arkd's onchain cosigner (no batch round).
 *
 * Needs the regtest stack (arkd >= v0.9.22). From the repo root:
 * ```
 * $ pnpm -C packages/sdk regtest
 * $ npx tsx packages/sdk/examples/node/onchain-cosign.ts
 * ```
 */

import { execFileSync } from "node:child_process";
import { p2tr } from "@scure/btc-signer";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "../../src";

import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

const ARK_URL = "http://localhost:7070";
const ESPLORA_URL = "http://localhost:3000/api";
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;
const BOARDING_SATS = 100_000;
const SEND_SATS = 50_000;

const regtest = (...args: string[]) =>
    execFileSync("node", ["regtest/regtest.mjs", ...args], { cwd: REPO_ROOT, stdio: "inherit" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const explorer = new EsploraProvider(ESPLORA_URL, {
        forcePolling: true,
        pollingInterval: 2000,
    });
    const wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestArkProvider(ARK_URL),
        indexerProvider: new RestIndexerProvider(ARK_URL),
        onchainProvider: explorer,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });

    const boarding = await wallet.getBoardingAddress();
    console.log("boarding address:", boarding);
    regtest("faucet", boarding, (BOARDING_SATS / 1e8).toFixed(8), "--confirm");

    while (!(await wallet.getBoardingUtxos()).some((u) => u.status.confirmed)) await sleep(1000);
    console.log("boarding coin confirmed");

    const dest = p2tr(
        await SingleKey.fromRandomBytes().xOnlyPublicKey(),
        undefined,
        networks.regtest,
    ).address!;
    const txid = await wallet.sendOnchain({ outputs: [{ address: dest, amount: SEND_SATS }] });
    console.log("cosigned and broadcast:", txid);

    regtest("mine", "1");
    for (;;) {
        const utxos = await explorer.getCoins(dest);
        if (utxos.length) {
            console.log("destination received", utxos[0].value, "sats");
            break;
        }
        await sleep(1000);
    }

    await wallet.dispose();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
