/**
 * This example shows how to create two wallets using the SDK.
 * Alice's wallet will be persisted in IndexedDB, while Bob's wallet will be in-memory.
 *
 * By inspecting the `D_arkade-service-worker.sqlite` created upon running the code,
 * you can see the persisted data for Alice's wallet.
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/multiple-wallets.ts
 * ```
 */

import {
    IndexedDBContractRepository,
    IndexedDBWalletRepository,
    SingleKey,
    Wallet,
} from "../../src";

// Must define `self` BEFORE calling setGlobalVars
if (typeof self === "undefined") {
    (globalThis as any).self = globalThis;
}
import setGlobalVars from "indexeddbshim/src/node-UnicodeIdentifiers";

(globalThis as any).window = globalThis;

setGlobalVars(null, { checkOrigin: false });

async function main() {
    console.log("Starting Ark SDK NodeJS Example...");

    const bob = SingleKey.fromRandomBytes();
    const alice = SingleKey.fromRandomBytes();

    // default, in-memory wallet
    const bobWallet = await Wallet.create({
        identity: bob,
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
    });

    console.log("[Bob]\tWallet created successfully!");
    console.log("[Bob]\tArk Address:", bobWallet.arkAddress.encode());

    const aliceWallet = await Wallet.create({
        identity: alice,
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
        storage: {
            // This wallet will be persisted in IndexedDB because we pass the storage options
            walletRepository: await IndexedDBWalletRepository.create(),
            contractRepository: await IndexedDBContractRepository.create(),
        },
    });

    console.log("[Alice]\tWallet created successfully!");
    console.log("[Alice]\tArk Address:", aliceWallet.arkAddress.encode());

    await bobWallet.contractRepository.setContractData("example-id", "config", {
        type: "bob-contract",
        address: bobWallet.arkAddress.encode(),
    });

    await aliceWallet.contractRepository.setContractData(
        "example-id",
        "config",
        {
            type: "alice-contract",
            address: aliceWallet.arkAddress.encode(),
        }
    );

    const bobSavedData = await bobWallet.contractRepository.getContractData(
        "example-id",
        "config"
    );
    console.log("[Bob]\tRetrieved contract data:", bobSavedData);

    const aliceSavedData = await aliceWallet.contractRepository.getContractData(
        "example-id",
        "config"
    );
    console.log("[Alice]\tRetrieved contract data:", aliceSavedData);

    console.log(
        "Only Alice's data is present in IndexedDB contractData table, check the .sqlite file to verify this."
    );
}

main().catch(console.error);
