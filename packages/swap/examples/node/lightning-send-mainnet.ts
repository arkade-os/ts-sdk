/**
 * The same Ark -> Lightning swap as `lightning-send.ts`, but pointed at a real
 * network: a persistent identity, a real solver, durable storage, and no
 * faucet anywhere.
 *
 * To run it:
 * ```
 * $ ARK_PRIVATE_KEY=<64 hex> \
 *   ARK_SERVER_URL=... ESPLORA_URL=... EMULATOR_URL=... SOLVER_URL=... \
 *   npx tsx examples/node/lightning-send-mainnet.ts <bolt11 invoice>
 * ```
 *
 * Nothing has a default here on purpose: a localhost fallback is exactly the
 * footgun that funds a mainnet covenant against a regtest key. Quoting is a
 * dry run — it derives, verifies and gates without moving a sat — and only
 * `FUND=1` funds.
 *
 * `ARK_SERVER_URL` and `EMULATOR_URL` must be the SAME Ark server and emulator
 * the solver uses. Both keys go into the covenant, so a different emulator
 * derives a different address and the swap is refused (`AddressMismatch`) —
 * the guard working correctly, but it reads like a solver bug if you don't
 * know why.
 */
import { DatabaseSync } from "node:sqlite";

import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { EventSource } from "eventsource";

import type { AssetSwapRepository, RfqTransport } from "../../src/index.js";

// EventSource is used internally by the SDK for settlement events (SSE). It is
// not available in Node.js by default, so we need to polyfill it — before the
// SDK is loaded, hence the deferred imports below.
(globalThis as any).EventSource = EventSource;

const { SingleKey, Wallet } = await import("@arkade-os/sdk");
const { SQLiteContractRepository, SQLiteWalletRepository } = await import(
    "@arkade-os/sdk/repositories/sqlite"
);
const {
    AddressMismatch,
    BTC_ASSET_ID,
    LIGHTNING_SEND_PAIR,
    RFQ_TERMINAL_STATES,
    SwapRefusal,
    addAssetSwap,
    getAssetSwaps,
    httpTransport,
    requestLightningSend,
    updateAssetSwap,
} = await import("../../src/index.js");
const { SqliteAssetSwapRepository, createSQLExecutor } = await import("./sqlite.js");
const { invoiceFacts } = await import("./bolt11.js");

class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/** Collect every missing variable before failing, so one run tells the whole
 * story instead of one name at a time. */
function config(): {
    privateKey: string;
    arkServerUrl: string;
    esploraUrl: string;
    emulatorUrl: string;
    solverUrl: string;
    invoice: string;
    dbPath: string;
    fund: boolean;
} {
    const invoice = process.argv[2] ?? process.env.INVOICE;
    const missing: string[] = [];
    const required = (name: string): string => {
        const value = process.env[name];
        if (!value) missing.push(name);
        return value ?? "";
    };

    const values = {
        privateKey: required("ARK_PRIVATE_KEY"),
        arkServerUrl: required("ARK_SERVER_URL"),
        esploraUrl: required("ESPLORA_URL"),
        emulatorUrl: required("EMULATOR_URL"),
        solverUrl: required("SOLVER_URL"),
        invoice: invoice ?? "",
        dbPath: process.env.DB_PATH ?? "lightning-send.sqlite",
        fund: process.env.FUND === "1",
    };
    if (!invoice) missing.push("INVOICE (or pass the invoice as the first argument)");
    if (missing.length) throw new ConfigError(`missing required config: ${missing.join(", ")}`);
    return values;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
    const settings = config();

    // One file holds the wallet, its contracts, and the swap records.
    const db = new DatabaseSync(settings.dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    const executor = createSQLExecutor(db);
    const swaps = new SqliteAssetSwapRepository(db);

    const wallet = await Wallet.create({
        identity: SingleKey.fromHex(settings.privateKey),
        arkServerUrl: settings.arkServerUrl,
        esploraUrl: settings.esploraUrl,
        storage: {
            walletRepository: new SQLiteWalletRepository(executor),
            contractRepository: new SQLiteContractRepository(executor),
        },
    });
    const transport = httpTransport(settings.solverUrl);

    try {
        const { network } = await wallet.arkProvider.getInfo();
        console.log("Network:", network, "| storage:", settings.dbPath);
        console.log("Wallet address:", wallet.arkAddress.encode());

        // Swaps from earlier runs. The record is history, not a resumption
        // token: it carries no rfq id, so a swap funded by a previous run can
        // only be followed on chain, never back through `transport.status`.
        const history = await getAssetSwaps(swaps);
        if (history.length) {
            console.log(`\n${history.length} swap(s) on file:`);
            for (const swap of history) {
                console.log(`  ${swap.status.padEnd(10)} ${swap.fromAmount} sats  ${swap.id}`);
            }
        }

        const invoice = invoiceFacts(settings.invoice);
        console.log("\nInvoice:", invoice.amountSats, "sats, hash", invoice.paymentHash);

        // No faucet: on a real network funding the wallet is the operator's job.
        const balance = await wallet.getBalance();
        if (balance.available < invoice.amountSats) {
            console.log(
                `\nBalance is ${balance.available} sats, the swap needs ${invoice.amountSats}.`,
                "\nBoard this wallet first:",
                await wallet.getBoardingAddress(),
            );
            process.exitCode = 1;
            return;
        }
        console.log("Balance:", balance.available, "sats available");

        // Quote, derive locally, compare, gate. Nothing is broadcast here.
        const swap = await requestLightningSend(
            wallet,
            settings.arkServerUrl,
            settings.emulatorUrl,
            transport,
            { invoice },
        );
        console.log("\nQuote accepted, covenant derived locally:");
        console.log("  rfq id         ", swap.rfqId);
        console.log("  lockup address ", swap.address);
        console.log("  fund amount    ", swap.fundAmount, "sats");
        console.log("  refunds to     ", swap.refundAddress);
        console.log(
            "  refund opens at",
            new Date((swap.quote.refund_locktime ?? 0) * 1000).toISOString(),
        );
        if (swap.quote.from_amount !== swap.fundAmount) {
            console.log(
                `  NOTE: the solver quoted from_amount=${swap.quote.from_amount}, but the lockup`,
                `carries the invoice amount (${swap.fundAmount})`,
            );
        }

        if (!settings.fund) {
            console.log("\nDry run. Set FUND=1 to fund the lockup and complete the swap.");
            return;
        }

        // Acceptance is funding. Once this lands the wallet may go offline: a
        // swap that fails refunds by covenant, so unlike the onchain corridor
        // there is no secret to persist first — the record below is history.
        const fundingTxid = await wallet.send({ address: swap.address, amount: swap.fundAmount });
        console.log("\nFunded:", fundingTxid);
        await addAssetSwap(swaps, {
            id: fundingTxid,
            fromAsset: BTC_ASSET_ID,
            toAsset: BTC_ASSET_ID,
            fromAmount: String(swap.fundAmount),
            toAmount: String(invoice.amountSats),
            swapAddress: swap.address,
            swapPkScript: hex.encode(swap.swapPkScript),
            // no TLV offer on this corridor — the payment hash identifies it
            offerHex: "",
            fundingTxid,
            status: "pending",
            createdAt: Date.now(),
            pair: LIGHTNING_SEND_PAIR,
            paymentHash: invoice.paymentHash,
        });

        await watch(transport, swaps, swap.rfqId, fundingTxid, invoice.paymentHash);
    } finally {
        await transport.close();
        await wallet.dispose();
        db.close();
    }
}

/** Follow the negotiation to a terminal state. Optional: the solver's claim
 * witness carries the preimage on chain whether or not anyone is watching. */
async function watch(
    transport: RfqTransport,
    swaps: AssetSwapRepository,
    rfqId: string,
    fundingTxid: string,
    paymentHash: string,
): Promise<void> {
    const terminal = new Set<string>(RFQ_TERMINAL_STATES);
    const deadline = Date.now() + 10 * 60_000;
    let previous = "";

    while (Date.now() < deadline) {
        const status = await transport.status(rfqId);
        if (status && status.state !== previous) {
            previous = status.state;
            console.log("  state:", status.state);
        }
        if (status && terminal.has(status.state)) {
            if (status.state !== "settled") {
                await updateAssetSwap(swaps, fundingTxid, { status: "recoverable" });
                console.log(
                    "\nThe swap did not settle. Nothing to do: the covenant refunds to the",
                    "\nwallet's own address once refund_locktime passes, and anyone can push it.",
                );
                return;
            }
            const preimage = status.profile.preimage as string | undefined;
            const paid = preimage && hex.encode(sha256(hex.decode(preimage))) === paymentHash;
            console.log("\nSettled. Preimage:", preimage ?? "(not published by the solver)");
            console.log("Preimage matches the invoice's payment hash:", Boolean(paid));
            await updateAssetSwap(swaps, fundingTxid, {
                status: "fulfilled",
                completedAt: Date.now(),
                ...(preimage && { preimageHex: preimage }),
            });
            return;
        }
        await sleep(3_000);
    }
    console.log("\nStopped watching — the swap is unaffected, it lives on chain.");
}

main().catch((error) => {
    if (error instanceof ConfigError) {
        console.error(error.message, "\nSee examples/README.md for what each one is.");
    } else if (error instanceof SwapRefusal) {
        console.error(`Solver refused to quote (reason: ${error.reason})`);
    } else if (error instanceof AddressMismatch) {
        console.error("Refused to fund:", error.message);
        console.error("  derived:", error.derived, "\n  quoted: ", error.quoted);
        console.error("\nCheck that ARK_SERVER_URL and EMULATOR_URL are the ones the solver uses.");
    } else if (error instanceof Error && "reason" in error) {
        console.error(`Funding gate ${String(error.reason)}: ${error.message}`);
    } else {
        console.error(error);
    }
    process.exitCode = 1;
});
