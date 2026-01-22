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
// The easiest way to run this example is by using `test:setup` script.
//
// Usage:
// $ pnpm test:setup
// $ node examples/contract-manager.js [arkdExec]
//
import {
    InMemoryWalletRepository,
    InMemoryContractRepository,
    SingleKey,
    Wallet,
    VHTLC,
    networks,
} from "../src/index";
import { hash160, randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { execSync } from "child_process";

const signerPubkeyRaw = execSync(
    "curl -s http://localhost:7070/v1/info | jq -r '.signerPubkey'"
)
    .toString()
    .trim();

const SERVER_PUBLIC_KEY = hex.decode(signerPubkeyRaw.slice(2));

const arkdExec = process.argv[2] || "docker exec -t ark";

// Alice is the sender (e.g., paying for a Lightning invoice)
const alice = SingleKey.fromHex(hex.encode(randomPrivateKeyBytes()));
// Bob is the receiver (e.g., swap service like Boltz)
const bob = SingleKey.fromHex(hex.encode(randomPrivateKeyBytes()));

// The secret (preimage) that Bob will reveal
const secret = Uint8Array.from(Buffer.from("swap-preimage-secret"));
const preimageHash = hash160(secret);

async function main() {
    console.log("=== Contract Manager Example ===\n");

    const storage = {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    };

    // Create Alice's wallet
    console.log("Creating Alice's wallet...");
    const aliceWallet = await Wallet.create({
        identity: alice,
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
        storage,
        // force refresh in 2s at most for the example to run quickly
        watcherConfig: { failsafePollIntervalMs: 2000 },
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
    });

    console.log("Contract registered with ID:", contract.id);

    console.log("\nSubscribing to contract events...");
    const stopWatching = manager.onContractEvent((event) => {
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

    // Wait a moment for updated
    await sleep(4000);

    // Check contract balance
    const balance = await manager.getContractBalance(contract.id);
    console.log("\nContract balance:");
    console.log("  Total:", balance.total, "sats");
    console.log("  Spendable:", balance.spendable, "sats");
    console.log("  VTXO count:", balance.vtxoCount);

    // Check spendable paths (Alice is sender, no preimage yet)
    console.log("\nChecking spendable paths for Alice (sender)...");
    let paths = manager.getSpendablePaths({
        contractId: contract.id,
        collaborative: true,
        walletPubKey: hex.encode(alicePubKey),
    });
    console.log("Spendable paths:", paths.length);
    if (paths.length === 0) {
        console.log("  (No paths available yet - refund timelock not reached)");
    } else {
        for (const path of paths) {
            console.log("  - Leaf available");
            if (path.extraWitness) {
                console.log("    Requires extra witness (preimage)");
            }
            if (path.sequence) {
                console.log("    Sequence:", path.sequence);
            }
        }
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
    paths = manager.getSpendablePaths({
        contractId: contract.id,
        collaborative: true,
        walletPubKey: hex.encode(bobPubKey),
    });
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
    manager.dispose();

    console.log("\n=== Example Complete ===");
    return 0;
}

// WARNING: arkdExec is passed directly to shell. Only use trusted values.
// For production code, use execFileSync with separated arguments to prevent
// command injection vulnerabilities.
async function fundAddress(address: string, amount: number) {
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`,
        { stdio: "inherit" }
    );
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
