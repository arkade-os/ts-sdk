/**
 * This example shows how Alice can send money to Bob using ArkCash.
 *
 * ArkCash is a bearer instrument: Alice creates a cash string and sends that
 * string to Bob. Bob does not need to share an address with Alice.
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/arkcash.ts
 * ```
 *
 * Requires the local regtest stack to be running.
 */

import { execFileSync } from "child_process";
import { EventSource } from "eventsource";

// EventSource is used internally by the SDK for settlement events (SSE).
// It is not available in Node.js by default, so we need to polyfill it.
(globalThis as any).EventSource = EventSource;

const { InMemoryContractRepository, InMemoryWalletRepository, Ramps, SingleKey, Wallet } =
    await import("../../src");

type WalletInstance = Awaited<ReturnType<typeof Wallet.create>>;

const ARK_SERVER_URL = "http://localhost:7070";
const ESPLORA_URL = "http://localhost:3000/api";
const CASH_AMOUNT_SATS = 5000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
    description: string,
    predicate: () => Promise<boolean>,
    timeoutMs = 60_000,
    intervalMs = 2_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!(await predicate())) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }

        await sleep(intervalMs);
    }
}

async function createWallet(name: string): Promise<WalletInstance> {
    const wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: ARK_SERVER_URL,
        esploraUrl: ESPLORA_URL,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });

    console.log(`[${name}]\tWallet created successfully!`);
    console.log(`[${name}]\tArk Address:`, wallet.arkAddress.encode());

    return wallet;
}

async function printBalance(name: string, wallet: WalletInstance): Promise<void> {
    console.log(`[${name}]\tBalance:`, await wallet.getBalance());
}

async function main() {
    console.log("Starting ArkCash NodeJS Example...");

    const aliceWallet = await createWallet("Alice");
    const bobWallet = await createWallet("Bob");

    const boardingAddress = await aliceWallet.getBoardingAddress();
    console.log("[Alice]\tBoarding Address:", boardingAddress);

    console.log("[Alice]\tFunding boarding address via regtest faucet...");
    execFileSync("node", ["regtest/regtest.mjs", "faucet", boardingAddress, "0.001", "--confirm"], {
        stdio: "inherit",
    });

    console.log("[Alice]\tWaiting for boarding UTXOs...");
    await waitFor(
        "Alice's boarding UTXOs",
        async () => (await aliceWallet.getBoardingUtxos()).length > 0,
    );

    console.log("[Alice]\tOnboarding into Ark...");
    const info = await aliceWallet.arkProvider.getInfo();
    const ramps = new Ramps(aliceWallet);
    const settlementTxid = await ramps.onboard(info.fees);
    console.log("[Alice]\tSettlement txid:", settlementTxid);

    console.log("[Alice]\tWaiting for spendable VTXOs...");
    await waitFor("Alice's spendable VTXOs", async () => (await aliceWallet.getVtxos()).length > 0);

    await printBalance("Alice", aliceWallet);
    await printBalance("Bob", bobWallet);

    console.log(`[Alice]\tCreating ${CASH_AMOUNT_SATS} sats of ArkCash for Bob...`);
    const cash = await aliceWallet.createCash(CASH_AMOUNT_SATS);
    console.log("[Alice]\tArkCash string sent to Bob:", cash);

    console.log("[Bob]\tClaiming ArkCash...");
    const claim = await bobWallet.claimCash(cash);
    console.log("[Bob]\tSwept:", claim.swept, "sats");
    if (claim.recovering.vtxos.length > 0) {
        // Server-swept notes: imported for background recovery, arriving once
        // the isolated recovery settlement finalizes.
        console.log("[Bob]\tRecovering:", claim.recovering.amount, "sats", claim.recovering.vtxos);
    }
    if (claim.unclaimed.vtxos.length > 0) {
        console.log("[Bob]\tUnclaimed:", claim.unclaimed.amount, "sats", claim.unclaimed.vtxos);
    }

    await waitFor("Bob's claimed balance", async () => {
        const balance = await bobWallet.getBalance();
        return balance.total > 0;
    });

    await printBalance("Alice", aliceWallet);
    await printBalance("Bob", bobWallet);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
