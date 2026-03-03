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
} from "../../src";
import { WalletState } from "../../src/repositories";
import {
    SQLiteWalletRepository,
    SQLiteContractRepository,
    SQLExecutor,
} from "../../src/repositories/sqlite";
import Database from "better-sqlite3";

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
}

main().catch(console.error);
