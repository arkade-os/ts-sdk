import { SingleKey, Wallet } from "../../src";

async function main() {
    console.log("Starting Ark SDK NodeJS Example...");

    // We use a random identity for this example
    const identity = SingleKey.fromRandomBytes();

    const wallet = await Wallet.create({
        identity,
        // Mock URLs for example purposes
        arkServerUrl: "http://localhost:7070",
        esploraUrl: "http://localhost:3000",
    });

    console.log("Wallet created successfully!");
    console.log("Ark Address:", wallet.arkAddress.encode());

    // Example: Save some dummy contract data to verify persistence
    console.log("Saving contract data...");

    await wallet.contractRepository.setContractData("example-id", "config", {
        type: "swap",
        address: "abcdefg",
    });

    const savedData = await wallet.contractRepository.getContractData(
        "example-id",
        "config"
    );
    console.log("Retrieved contract data:", savedData);

    // For in-memory repositories, the program will wait for the worker to terminate
    await wallet.close();
}

main().catch(console.error);
