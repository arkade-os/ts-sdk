/**
 * This example shows how to create two wallets using the SDK and onboard
 * Alice's wallet into the Ark protocol.
 *
 * It demonstrates:
 * - Creating in-memory and IndexedDB-backed wallets
 * - Funding a boarding address via nigiri faucet
 * - Settling (onboarding) into the Ark protocol using Ramps
 *
 * Requires a local regtest environment (nigiri + Ark server on localhost:7070).
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/multiple-wallets.ts
 * ```
 */

import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    Ramps,
    SingleKey,
    Wallet,
} from "../../src";

// EventSource is used internally by the SDK for settlement events (SSE).
// It is not available in Node.js by default, so we need to polyfill it.
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

// Must define `self` BEFORE calling setGlobalVars
if (typeof self === "undefined") {
    (globalThis as any).self = globalThis;
}
import setGlobalVars from "indexeddbshim/src/node-UnicodeIdentifiers";
import { execSync } from "child_process";

(globalThis as any).window = globalThis;

setGlobalVars(null, { checkOrigin: false });

async function main() {
    console.log("Starting Ark SDK NodeJS Example...");

    const bob = SingleKey.fromRandomBytes();
    const alice = SingleKey.fromRandomBytes();

    // in-memory wallet
    const bobWallet = await Wallet.create({
        identity: bob,
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });

    console.log("[Bob]\tWallet created successfully!");
    console.log("[Bob]\tArk Address:", bobWallet.arkAddress.encode());

    const aliceWallet = await Wallet.create({
        identity: alice,
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });

    console.log("[Alice]\tWallet created successfully!");
    console.log("[Alice]\tArk Address:", aliceWallet.arkAddress.encode());

    // Fund Alice's boarding address
    const boardingAddress = await aliceWallet.getBoardingAddress();
    console.log("[Alice]\tBoarding Address:", boardingAddress);

    console.log("[Alice]\tFunding boarding address via nigiri faucet...");
    execSync(`nigiri faucet ${boardingAddress} 0.001`);

    // Wait for the boarding UTXOs to be available
    console.log("[Alice]\tWaiting for boarding UTXOs...");
    let utxos = await aliceWallet.getBoardingUtxos();
    while (utxos.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        utxos = await aliceWallet.getBoardingUtxos();
    }
    console.log("[Alice]\tBoarding UTXOs found:", utxos.length);

    // Settle (onboard) into the Ark protocol
    console.log("[Alice]\tOnboarding into Ark...");
    const info = await aliceWallet.arkProvider.getInfo();
    const ramps = new Ramps(aliceWallet);
    const txid = await ramps.onboard(info.fees);
    console.log("[Alice]\tSettlement txid:", txid);

    const bobOffChainAddress = await bobWallet.getAddress();
    await aliceWallet.sendBitcoin({
        address: bobOffChainAddress,
        amount: 50000,
    });

    console.log("[Alice]\tBalance:", await aliceWallet.getBalance());
    console.log("[Bob]\tBalance:", await bobWallet.getBalance());
    console.log("Only Alice's data is persisted in the DB");
}

main().catch(console.error);
