// This example shows how to use the ContractManager to register and watch
// external contracts (like VHTLCs for Lightning swaps) alongside the wallet's
// default address.
//
// The ContractManager provides:
// - Unified watching for all contracts with resilient connections
// - Automatic reconnection with exponential backoff
// - Failsafe polling to catch missed events
// - Path selection for spending contracts
// - Optional auto-sweeping of spendable VTXOs
//
// Usage:
// node examples/contract-manager.js [arkdExec]
//
import { SingleKey, Wallet, VHTLC, networks } from "../dist/esm/index.js";
import { hash160, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { execSync } from "child_process";

const SERVER_PUBLIC_KEY = hex.decode(
    "e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb"
);

const arkdExec = process.argv[2] || "docker exec -t arkd";

// Alice is the sender (e.g., paying for a Lightning invoice)
const alice = SingleKey.fromHex(hex.encode(randomPrivateKeyBytes()));
// Bob is the receiver (e.g., swap service like Boltz)
const bob = SingleKey.fromHex(hex.encode(randomPrivateKeyBytes()));

// The secret (preimage) that Bob will reveal
const secret = Uint8Array.from(Buffer.from("swap-preimage-secret"));
const preimageHash = hash160(secret);

async function main() {
    console.log("=== Contract Manager Example ===\n");

    // Create Alice's wallet
    console.log("Creating Alice's wallet...");
    const aliceWallet = await Wallet.create({
        identity: alice,
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
    });

    const alicePubKey = await alice.xOnlyPublicKey();
    const bobPubKey = await bob.xOnlyPublicKey();

    console.log("Alice pubkey:", hex.encode(alicePubKey));
    console.log("Bob pubkey:", hex.encode(bobPubKey));

    // Get current chain tip for locktime
    const chainTip = await fetch(
        "http://localhost:3000/blocks/tip/height"
    ).then((res) => res.json());

    // Create the VHTLC script for the swap
    const vhtlcScript = new VHTLC.Script({
        preimageHash,
        sender: alicePubKey,
        receiver: bobPubKey,
        server: SERVER_PUBLIC_KEY,
        refundLocktime: BigInt(chainTip + 100), // Refund after 100 blocks
        unilateralClaimDelay: { type: "blocks", value: 10n },
        unilateralRefundDelay: { type: "blocks", value: 12n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 14n },
    });

    const swapAddress = vhtlcScript
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    const swapScript = hex.encode(vhtlcScript.pkScript);

    console.log("\nVHTLC swap address:", swapAddress);

    // Get the contract manager
    console.log("\nInitializing ContractManager...");
    const manager = await aliceWallet.getContractManager();

    // Register the VHTLC contract
    console.log("Registering VHTLC contract...");
    const contract = await manager.createContract({
        label: "Lightning Swap",
        type: "vhtlc",
        params: {
            sender: hex.encode(alicePubKey),
            receiver: hex.encode(bobPubKey),
            server: hex.encode(SERVER_PUBLIC_KEY),
            hash: hex.encode(preimageHash),
            refundLocktime: (chainTip + 100).toString(),
            claimDelay: "10",
            refundDelay: "12",
            refundNoReceiverDelay: "14",
        },
        script: swapScript,
        address: swapAddress,
        autoSweep: false, // We'll handle spending manually in this example
    });

    console.log("Contract registered with ID:", contract.id);

    // Start watching for events
    console.log("\nStarting contract watcher...");
    const stopWatching = await manager.startWatching((event) => {
        console.log(`\n[Event] ${event.type} on contract ${event.contractId}`);
        if (event.vtxos?.length) {
            console.log(`  VTXOs: ${event.vtxos.length}`);
            for (const vtxo of event.vtxos) {
                console.log(
                    `    - ${vtxo.txid}:${vtxo.vout} (${vtxo.value} sats)`
                );
            }
        }
    });

    // Fund the VHTLC address
    const fundAmount = 5000;
    console.log(`\nFunding VHTLC with ${fundAmount} sats...`);
    await fundAddress(swapAddress, fundAmount);

    // Wait a moment for the watcher to detect the new VTXO
    await sleep(3000);

    // Check contract balance
    const balance = await manager.getContractBalance(contract.id);
    console.log("\nContract balance:");
    console.log("  Settled:", balance.settled, "sats");
    console.log("  Preconfirmed:", balance.preconfirmed, "sats");
    console.log("  Spendable:", balance.spendable, "sats");
    console.log("  VTXO count:", balance.vtxoCount);

    // Check spendable paths (Alice is sender, no preimage yet)
    console.log("\nChecking spendable paths for Alice (sender)...");
    let paths = manager.getSpendablePaths(
        contract.id,
        true,
        hex.encode(alicePubKey)
    );
    console.log("Spendable paths:", paths.length);
    if (paths.length === 0) {
        console.log("  (No paths available yet - refund timelock not reached)");
    }

    // Simulate: Bob reveals the preimage (e.g., Lightning payment succeeded)
    console.log("\n--- Simulating preimage reveal ---");
    console.log("Bob reveals preimage:", hex.encode(secret));

    // Update contract with the revealed preimage
    await manager.updateContractData(contract.id, {
        preimage: hex.encode(secret),
    });

    // Now check Bob's spendable paths
    console.log(
        "\nChecking spendable paths for Bob (receiver with preimage)..."
    );
    paths = manager.getSpendablePaths(contract.id, true, hex.encode(bobPubKey));
    console.log("Spendable paths:", paths.length);
    for (const path of paths) {
        console.log("  - Leaf available");
        if (path.extraWitness) {
            console.log("    Requires extra witness (preimage)");
        }
        if (path.sequence) {
            console.log("    Sequence:", path.sequence);
        }
    }

    // Get all balances (wallet + contracts)
    console.log("\nAll contract balances:");
    const allBalances = await manager.getAllBalances();
    for (const [contractId, bal] of allBalances) {
        const c = await manager.getContract(contractId);
        const label = c?.label || contractId;
        console.log(
            `  ${label}: ${bal.spendable} sats (${bal.vtxoCount} VTXOs)`
        );
    }

    // List all contracts
    console.log("\nRegistered contracts:");
    const contracts = manager.getAllContracts();
    for (const c of contracts) {
        console.log(`  - ${c.id} (${c.type}, ${c.state})`);
    }

    // Clean up
    console.log("\nStopping watcher...");
    stopWatching();

    console.log("\n=== Example Complete ===");
}

async function fundAddress(address, amount) {
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`,
        { stdio: "inherit" }
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
