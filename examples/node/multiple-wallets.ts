/**
 * This example shows how to create two wallets using the SDK.
 * Alice's wallet will be persisted in SQLite, while Bob's wallet will be in-memory.
 *
 * By inspecting the `alice-wallet.sqlite` file created upon running the code,
 * you can see the persisted data for Alice's wallet.
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/multiple-wallets.ts
 * ```
 *
 * Requires `better-sqlite3` (included as a devDependency).
 */

import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
    Ramps,
} from "../../src";
import { WalletState } from "../../src/repositories";
import {
    SQLiteWalletRepository,
    SQLiteContractRepository,
    SQLExecutor,
} from "../../src/repositories/sqlite";
import Database from "better-sqlite3";
import { execSync } from "child_process";

// EventSource is used internally by the SDK for settlement events (SSE).
// It is not available in Node.js by default, so we need to polyfill it.
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

function createSQLExecutor(dbPath: string): SQLExecutor {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    return {
        run: async (sql, params) => {
            db.prepare(sql).run(...(params ?? []));
        },
        get: async <T>(sql: string, params?: unknown[]) =>
            db.prepare(sql).get(...(params ?? [])) as T | undefined,
        all: async <T>(sql: string, params?: unknown[]) =>
            db.prepare(sql).all(...(params ?? [])) as T[],
    };
}

async function main() {
    console.log("Starting Ark SDK NodeJS Example...");

    const bob = SingleKey.fromRandomBytes();
    const alice = SingleKey.fromRandomBytes();

    // In-memory wallet
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

    // SQLite-persisted wallet
    const executor = createSQLExecutor("alice-wallet.sqlite");

    const aliceWallet = await Wallet.create({
        identity: alice,
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
        storage: {
            walletRepository: new SQLiteWalletRepository(executor),
            contractRepository: new SQLiteContractRepository(executor),
        },
    });

    console.log("[Alice]\tWallet created successfully!");
    console.log("[Alice]\tArk Address:", aliceWallet.arkAddress.encode());

    const state: WalletState = {
        lastSyncTime: Date.now(),
        settings: { theme: "dark" },
    };

    await aliceWallet.walletRepository.saveWalletState(state);
    await bobWallet.walletRepository.saveWalletState(state);

    // Fund Alice's boarding address
    const boardingAddress = await aliceWallet.getBoardingAddress();
    console.log("[Alice]\tBoarding Address:", boardingAddress);

    console.log("[Alice]\tFunding boarding address via nigiri faucet...");
    execSync(`nigiri faucet ${boardingAddress} 0.001`);

    // Wait for the boarding inputs to be available (timeout after 60s)
    console.log("[Alice]\tWaiting for boarding UTXOs...");
    const deadline = Date.now() + 60_000;
    let utxos = await aliceWallet.getBoardingUtxos();
    while (utxos.length === 0) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for boarding UTXOs");
        }
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
    console.log("Only Alice's data is persisted on disk");
}

main().catch(console.error);
