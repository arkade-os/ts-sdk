#!/usr/bin/env node
/**
 * Arkade Bitcoin Wallet CLI
 *
 * A command-line interface for sending and receiving Bitcoin over Arkade and Lightning.
 * Designed for agent integration (e.g., MoltBot, Claude).
 *
 * Usage: node cli/arkade.mjs <command> [args]
 *
 * Commands:
 *   init <private-key-hex> <ark-server-url>  Initialize wallet
 *   address                                   Show Ark address for receiving
 *   boarding-address                          Show boarding address (on-chain)
 *   balance                                   Show wallet balance
 *   send <address> <amount>                   Send sats to Ark address
 *   history                                   Show transaction history
 *   onboard                                   Move on-chain funds to Arkade
 *   offboard <btc-address>                    Move Arkade funds to on-chain
 *   ln-invoice <amount> [description]         Create Lightning invoice
 *   ln-pay <bolt11>                           Pay Lightning invoice
 *   ln-fees                                   Show Lightning swap fees
 *   ln-limits                                 Show Lightning swap limits
 *   ln-pending                                Show pending Lightning swaps
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

// Data directory
const DATA_DIR = join(homedir(), ".arkade-wallet");
const CONFIG_FILE = join(DATA_DIR, "config.json");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}

// Load config
function loadConfig() {
    if (!existsSync(CONFIG_FILE)) {
        return null;
    }
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}

// Save config
function saveConfig(config) {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Dynamic import of SDK (ESM)
async function loadSDK() {
    const sdk = await import("../dist/esm/index.js");
    return sdk;
}

// Create wallet from config
async function createWallet(sdk, config) {
    const identity = sdk.SingleKey.fromHex(config.privateKey);
    const wallet = await sdk.Wallet.create({
        identity,
        arkServerUrl: config.arkServerUrl,
    });
    return wallet;
}

// Format satoshis
function formatSats(sats) {
    return `${sats.toLocaleString()} sats`;
}

// Commands
const commands = {
    async init(args) {
        if (args.length < 2) {
            console.log(
                "Usage: arkade init <private-key-hex> <ark-server-url>"
            );
            console.log("\nExample:");
            console.log('  arkade init abc123...def "https://ark.example.com"');
            process.exit(1);
        }

        const [privateKey, arkServerUrl] = args;
        const config = { privateKey, arkServerUrl };

        // Validate by trying to create wallet
        try {
            const sdk = await loadSDK();
            const wallet = await createWallet(sdk, config);
            const address = await wallet.getAddress();

            saveConfig(config);
            console.log("Wallet initialized successfully!");
            console.log(`Ark Address: ${address}`);
        } catch (error) {
            console.error("Failed to initialize wallet:", error.message);
            process.exit(1);
        }
    },

    async address() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const address = await wallet.getAddress();
        console.log(address);
    },

    async "boarding-address"() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const address = await wallet.getBoardingAddress();
        console.log(address);
    },

    async balance() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const balance = await wallet.getBalance();

        console.log("=== Arkade Wallet Balance ===");
        console.log(`Total:        ${formatSats(balance.total)}`);
        console.log("");
        console.log("Off-chain (Arkade):");
        console.log(`  Available:  ${formatSats(balance.available)}`);
        console.log(`  Settled:    ${formatSats(balance.settled)}`);
        console.log(`  Pending:    ${formatSats(balance.preconfirmed)}`);
        console.log(`  Recoverable:${formatSats(balance.recoverable)}`);
        console.log("");
        console.log("On-chain (Boarding):");
        console.log(`  Confirmed:  ${formatSats(balance.boarding.confirmed)}`);
        console.log(
            `  Unconfirmed:${formatSats(balance.boarding.unconfirmed)}`
        );
    },

    async send(args) {
        if (args.length < 2) {
            console.log("Usage: arkade send <address> <amount>");
            console.log("\nExample:");
            console.log("  arkade send ark1qq... 50000");
            process.exit(1);
        }

        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const [address, amountStr] = args;
        const amount = parseInt(amountStr, 10);

        if (isNaN(amount) || amount <= 0) {
            console.error("Invalid amount. Must be a positive number of sats.");
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);

        console.log(`Sending ${formatSats(amount)} to ${address}...`);

        try {
            const txid = await wallet.sendBitcoin({ address, amount });
            console.log("Success!");
            console.log(`Transaction ID: ${txid}`);
        } catch (error) {
            console.error("Failed to send:", error.message);
            process.exit(1);
        }
    },

    async history() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const history = await wallet.getTransactionHistory();

        if (history.length === 0) {
            console.log("No transactions yet.");
            return;
        }

        console.log("=== Transaction History ===");
        for (const tx of history) {
            const date = new Date(tx.createdAt).toLocaleString();
            const type = tx.type === "SENT" ? "SENT" : "RECEIVED";
            const status = tx.settled ? "settled" : "pending";
            console.log(
                `[${date}] ${type} ${formatSats(tx.amount)} (${status})`
            );
        }
    },

    async onboard() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const ramps = new sdk.Ramps(wallet);

        // Get ark info for fees
        const arkProvider = new sdk.RestArkProvider(config.arkServerUrl);
        const arkInfo = await arkProvider.getInfo();

        console.log("Onboarding funds from on-chain to Arkade...");

        try {
            const txid = await ramps.onboard(arkInfo.feeInfo);
            console.log("Success!");
            console.log(`Commitment TX: ${txid}`);
        } catch (error) {
            console.error("Failed to onboard:", error.message);
            process.exit(1);
        }
    },

    async offboard(args) {
        if (args.length < 1) {
            console.log("Usage: arkade offboard <btc-address>");
            console.log("\nExample:");
            console.log("  arkade offboard bc1q...");
            process.exit(1);
        }

        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const [address] = args;

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const ramps = new sdk.Ramps(wallet);

        // Get ark info for fees
        const arkProvider = new sdk.RestArkProvider(config.arkServerUrl);
        const arkInfo = await arkProvider.getInfo();

        console.log(`Offboarding funds to ${address}...`);

        try {
            const txid = await ramps.offboard(address, arkInfo.feeInfo);
            console.log("Success!");
            console.log(`Commitment TX: ${txid}`);
        } catch (error) {
            console.error("Failed to offboard:", error.message);
            process.exit(1);
        }
    },

    async "ln-invoice"(args) {
        if (args.length < 1) {
            console.log("Usage: arkade ln-invoice <amount> [description]");
            console.log("\nExample:");
            console.log('  arkade ln-invoice 50000 "Payment for coffee"');
            process.exit(1);
        }

        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const amount = parseInt(args[0], 10);
        const description = args.slice(1).join(" ") || undefined;

        if (isNaN(amount) || amount <= 0) {
            console.error("Invalid amount. Must be a positive number of sats.");
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const lightning = new sdk.ArkaLightningSkill({
            wallet,
            network: "bitcoin",
        });

        console.log(`Creating Lightning invoice for ${formatSats(amount)}...`);

        try {
            const invoice = await lightning.createInvoice({
                amount,
                description,
            });
            console.log("\n=== Lightning Invoice ===");
            console.log(`Amount: ${formatSats(invoice.amount)}`);
            console.log(`Invoice: ${invoice.bolt11}`);
            console.log(`\nShare this invoice to receive payment.`);
        } catch (error) {
            console.error("Failed to create invoice:", error.message);
            process.exit(1);
        }
    },

    async "ln-pay"(args) {
        if (args.length < 1) {
            console.log("Usage: arkade ln-pay <bolt11>");
            console.log("\nExample:");
            console.log("  arkade ln-pay lnbc...");
            process.exit(1);
        }

        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const [bolt11] = args;

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const lightning = new sdk.ArkaLightningSkill({
            wallet,
            network: "bitcoin",
        });

        console.log("Paying Lightning invoice...");

        try {
            const result = await lightning.payInvoice({ bolt11 });
            console.log("\n=== Payment Successful ===");
            console.log(`Amount: ${formatSats(result.amount)}`);
            console.log(`Preimage: ${result.preimage}`);
            console.log(`TX ID: ${result.txid}`);
        } catch (error) {
            console.error("Failed to pay invoice:", error.message);
            process.exit(1);
        }
    },

    async "ln-fees"() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const lightning = new sdk.ArkaLightningSkill({
            wallet,
            network: "bitcoin",
        });

        const fees = await lightning.getFees();

        console.log("=== Lightning Swap Fees ===");
        console.log("\nSend to Lightning (Submarine):");
        console.log(`  Percentage: ${fees.submarine.percentage}%`);
        console.log(`  Miner Fee:  ${formatSats(fees.submarine.minerFees)}`);
        console.log("\nReceive from Lightning (Reverse):");
        console.log(`  Percentage: ${fees.reverse.percentage}%`);
        console.log(
            `  Lockup Fee: ${formatSats(fees.reverse.minerFees.lockup)}`
        );
        console.log(
            `  Claim Fee:  ${formatSats(fees.reverse.minerFees.claim)}`
        );
    },

    async "ln-limits"() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const lightning = new sdk.ArkaLightningSkill({
            wallet,
            network: "bitcoin",
        });

        const limits = await lightning.getLimits();

        console.log("=== Lightning Swap Limits ===");
        console.log(`Minimum: ${formatSats(limits.min)}`);
        console.log(`Maximum: ${formatSats(limits.max)}`);
    },

    async "ln-pending"() {
        const config = loadConfig();
        if (!config) {
            console.error(
                "Wallet not initialized. Run: arkade init <key> <url>"
            );
            process.exit(1);
        }

        const sdk = await loadSDK();
        const wallet = await createWallet(sdk, config);
        const lightning = new sdk.ArkaLightningSkill({
            wallet,
            network: "bitcoin",
        });

        const pending = await lightning.getPendingSwaps();

        if (pending.length === 0) {
            console.log("No pending swaps.");
            return;
        }

        console.log("=== Pending Lightning Swaps ===");
        for (const swap of pending) {
            const date = swap.createdAt.toLocaleString();
            const type = swap.type === "reverse" ? "RECEIVE" : "SEND";
            console.log(
                `[${date}] ${type} ${formatSats(swap.amount)} - ${swap.status}`
            );
        }
    },

    async help() {
        console.log(`
Arkade Bitcoin Wallet CLI

Usage: arkade <command> [args]

Wallet Commands:
  init <key> <url>       Initialize wallet with private key and Ark server URL
  address                Show Ark address for receiving off-chain Bitcoin
  boarding-address       Show boarding address for receiving on-chain Bitcoin
  balance                Show wallet balance (on-chain and off-chain)
  send <address> <amt>   Send sats to an Ark address
  history                Show transaction history
  onboard                Move on-chain funds to Arkade (off-chain)
  offboard <btc-addr>    Move Arkade funds to on-chain Bitcoin address

Lightning Commands:
  ln-invoice <amt> [desc]  Create Lightning invoice to receive payment
  ln-pay <bolt11>          Pay a Lightning invoice
  ln-fees                  Show Lightning swap fees
  ln-limits                Show Lightning swap limits
  ln-pending               Show pending Lightning swaps

Examples:
  arkade init abc123... https://ark.example.com
  arkade balance
  arkade send ark1qq... 50000
  arkade ln-invoice 25000 "Coffee payment"
  arkade ln-pay lnbc50u1...

Data stored in: ~/.arkade-wallet/
        `);
    },
};

// Main
const args = process.argv.slice(2);
const command = args[0] || "help";
const commandArgs = args.slice(1);

if (commands[command]) {
    commands[command](commandArgs).catch((error) => {
        console.error("Error:", error.message);
        process.exit(1);
    });
} else {
    console.error(`Unknown command: ${command}`);
    console.log('Run "arkade help" for usage.');
    process.exit(1);
}
