import {
    Wallet,
    SingleKey,
    WalletRepositoryImpl,
    ContractRepositoryImpl,
} from "../../dist/esm/index.js";
import { FileSystemStorageAdapter } from "../../dist/esm/adapters/fileSystem.js";
import * as path from "path";

async function main() {
    console.log("Starting Ark SDK NodeJS Example...");

    // 1. Setup the native persistence layer (File-based StorageAdapter)
    const storagePath = path.join(process.cwd(), "temp-storage");
    const fileStorage = new FileSystemStorageAdapter(storagePath);

    // 2. Inject the storage adapter into the SDK repositories
    const walletRepository = new WalletRepositoryImpl(fileStorage);
    const contractRepository = new ContractRepositoryImpl(fileStorage);

    // 3. Create a wallet with the custom storage
    // We use a random identity for this example
    const identity = SingleKey.fromRandomBytes();

    console.log("Initializing wallet with custom persistence...");
    const wallet = await Wallet.create({
        identity,
        // networkName: "regtest",
        // Pass the injected repositories via the storage config
        storage: {
            walletRepository,
            contractRepository,
        },
        // Mock URLs for example purposes
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
    });

    console.log("Wallet created successfully!");
    console.log("Ark Address:", wallet.arkAddress.encode());
    console.log(`Persistence files location: ${storagePath}`);

    await walletRepository;

    // Example: Save some dummy contract data to verify persistence
    console.log("Saving contract data...");
    await contractRepository.setContractData("example-id", "config", {
        type: "swap",
        address: "abcdefg",
    });

    const savedData = await contractRepository.getContractData(
        "example-id",
        "config"
    );
    console.log("Retrieved contract data:", savedData);

    console.log(
        "\nExample finished. Check 'temp-storage' folder to see the persisted data."
    );
}

main().catch(console.error);
