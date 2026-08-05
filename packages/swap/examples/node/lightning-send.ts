/**
 * Ark -> Lightning with `@arkade-os/swap`: quote, verify the covenant against
 * your OWN derivation, fund it, and go offline.
 *
 * The negotiation is the only interactive part. There is no accept message:
 * acceptance IS funding. After the deposit lands the solver observes it, pays
 * the invoice, and claims the lockup with the preimage — which appears in the
 * claim witness as a receipt nobody can withhold. A swap that fails refunds by
 * covenant to this wallet's own address, pushable by anyone, needing no key
 * and no state on this side.
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/lightning-send.ts [<bolt11 invoice>]
 * ```
 *
 * Requires the regtest stack (arkd + the Arkade emulator) — see
 * `examples/README.md`, which also covers the one arkd setting this corridor
 * needs.
 *
 * Two modes:
 * - no `SOLVER_URL` (default): quotes against an in-process demo solver and
 *   stops at the funding step, since that solver cannot pay an invoice.
 * - `SOLVER_URL=... FUND=1`: quotes a real solver over HTTP, funds the swap,
 *   and follows it to a terminal state.
 */
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { EventSource } from "eventsource";

import type { NetworkName } from "@arkade-os/sdk";
import type { AssetSwapRepository, RfqTransport } from "../../src/index.js";

// EventSource is used internally by the SDK for settlement events (SSE). It is
// not available in Node.js by default, so we need to polyfill it — before the
// SDK is loaded, hence the deferred imports below.
(globalThis as any).EventSource = EventSource;

const {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    Ramps,
    RestArkProvider,
    RestEmulatorProvider,
    SingleKey,
    Wallet,
    getNetwork,
} = await import("@arkade-os/sdk");
const {
    AddressMismatch,
    BTC_ASSET_ID,
    InMemoryAssetSwapRepository,
    LIGHTNING_SEND_PAIR,
    RFQ_TERMINAL_STATES,
    SwapRefusal,
    addAssetSwap,
    httpTransport,
    requestLightningSend,
    unilateralClaimDelay,
    updateAssetSwap,
} = await import("../../src/index.js");
const { demoSolverTransport } = await import("./demo-solver.js");
const { invoiceFacts } = await import("./bolt11.js");

type WalletInstance = Awaited<ReturnType<typeof Wallet.create>>;

const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "http://localhost:7070";
const ESPLORA_URL = process.env.ESPLORA_URL ?? "http://localhost:3000/api";
const EMULATOR_URL = process.env.EMULATOR_URL ?? "http://localhost:7073";
/** A real solver's base URL; unset selects the in-process demo solver. */
const SOLVER_URL = process.env.SOLVER_URL;
/** Funding is opt-in: it moves real balance into a covenant. */
const FUND = process.env.FUND === "1";
/** How long to follow the swap after funding before giving up on the status
 * stream — the chain stays the fallback either way. */
const WATCH_TIMEOUT_MS = 10 * 60_000;

const REGTEST_CLI = fileURLToPath(new URL("../../../../regtest/regtest.mjs", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
    description: string,
    predicate: () => Promise<boolean>,
    timeoutMs = 60_000,
    intervalMs = 2_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
        await sleep(intervalMs);
    }
}

/** Ask the regtest stack's Lightning node for an invoice (100k sats).
 * `--secondary` picks the base-layer LND, so the `boltz` profile is not
 * needed just to mint an invoice. */
function createRegtestInvoice(): string {
    const output = execFileSync("node", [REGTEST_CLI, "create-invoice", "--secondary"], {
        encoding: "utf8",
    });
    const invoice = output
        .split("\n")
        // the CLI wraps the bare payment request in colored progress lines
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
        .filter((line) => /^ln[a-z0-9]+$/.test(line))
        .at(-1);
    if (!invoice) throw new Error(`no invoice in regtest output:\n${output}`);
    return invoice;
}

/** Board enough balance to cover the swap, faucet included. */
async function ensureBalance(wallet: WalletInstance, needed: number): Promise<void> {
    if ((await wallet.getBalance()).available >= needed) return;

    const boardingAddress = await wallet.getBoardingAddress();
    console.log("Funding boarding address from the regtest faucet:", boardingAddress);
    execFileSync("node", [REGTEST_CLI, "faucet", boardingAddress, "0.002", "--confirm"], {
        stdio: "inherit",
    });
    await waitFor("boarding utxos", async () => (await wallet.getBoardingUtxos()).length > 0);

    const { fees } = await wallet.arkProvider.getInfo();
    console.log("Onboarding into Ark:", await new Ramps(wallet).onboard(fees));
    await waitFor("spendable balance", async () => (await wallet.getBalance()).available >= needed);
}

/** A solver that quotes an address other than the one the trader derives. The
 * guard is transport-shaped, so this wraps any transport. */
const tampering = (inner: RfqTransport): RfqTransport => ({
    ...inner,
    async requestQuote(payload) {
        const quote = await inner.requestQuote(payload);
        return {
            ...quote,
            profile: { ...quote.profile, lockup_address: "tark1qnot0the0address0you0derived" },
        };
    },
});

async function main(wallet: WalletInstance): Promise<void> {
    const invoice = invoiceFacts(process.argv[2] ?? process.env.INVOICE ?? createRegtestInvoice());
    console.log("Invoice:", invoice.amountSats, "sats, hash", invoice.paymentHash);

    // Everything the covenant is built from, read from the trader's OWN
    // endpoints. From the quote only `solver_pubkey`, `refund_locktime`,
    // `valid_until` and the amounts are ever used.
    const [info, emulatorInfo] = await Promise.all([
        new RestArkProvider(ARK_SERVER_URL).getInfo(),
        new RestEmulatorProvider(EMULATOR_URL).getInfo(),
    ]);
    const claimDelay = unilateralClaimDelay(Number(info.unilateralExitDelay));
    console.log("\nLocal derivation inputs (never taken from the quote):");
    console.log("  ark signer      ", info.signerPubkey);
    console.log("  emulator signer ", emulatorInfo.signerPubkey);
    console.log("  network         ", info.network);
    console.log("  claim delay     ", claimDelay, "s");

    const transport = SOLVER_URL
        ? httpTransport(SOLVER_URL)
        : demoSolverTransport({
              // slice(-32) drops the prefix byte of a compressed key: the
              // covenant commits to x-only keys
              serverPubkey: hex.decode(info.signerPubkey).slice(-32),
              emulatorPubkey: hex.decode(emulatorInfo.signerPubkey).slice(-32),
              claimDelay,
              hrp: getNetwork(info.network as NetworkName).hrp,
          });
    console.log("\nSolver:", SOLVER_URL ?? "in-process demo solver (no SOLVER_URL set)");

    try {
        if (!SOLVER_URL) {
            // The guard that makes the rest safe: a quoted address that is not
            // the trader's own derivation is refuse-to-fund, never "use theirs".
            console.log("\nGuard check — quoting through a solver that swaps the address in:");
            const liar = tampering(transport);
            try {
                await requestLightningSend(wallet, ARK_SERVER_URL, EMULATOR_URL, liar, { invoice });
                console.log("  NOT REFUSED — that is a bug");
            } catch (error) {
                if (!(error instanceof AddressMismatch)) throw error;
                console.log("  refused:", error.message);
                console.log("  derived:", error.derived);
                console.log("  quoted: ", error.quoted);
            }
        }

        await ensureBalance(wallet, invoice.amountSats);
        console.log("\nBalance:", await wallet.getBalance());

        // Quote, derive locally, compare, and gate — all of it before a single
        // sat moves. `requestLightningSend` broadcasts nothing.
        const swap = await requestLightningSend(wallet, ARK_SERVER_URL, EMULATOR_URL, transport, {
            invoice,
        });
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

        if (!SOLVER_URL) {
            console.log(
                "\nStopping before funding: the demo solver cannot pay a Lightning invoice, so",
                "\nfunding it would only park the sats until the covenant refund opens.",
                "\nPoint SOLVER_URL at a real solver and set FUND=1 to run the swap for real.",
            );
            return;
        }
        if (!FUND) {
            console.log("\nSet FUND=1 to fund the lockup and complete the swap.");
            return;
        }

        // Acceptance is funding. After this the wallet may go offline.
        const fundingTxid = await wallet.send({ address: swap.address, amount: swap.fundAmount });
        console.log("\nFunded:", fundingTxid);

        // Record-keeping is for the UI, not for safety: the refund is by
        // covenant and the receipt lands on chain regardless.
        const swaps = new InMemoryAssetSwapRepository();
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
    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    let previous = "";

    while (Date.now() < deadline) {
        const status = await transport.status(rfqId);
        if (status && status.state !== previous) {
            previous = status.state;
            console.log("  state:", status.state);
        }
        if (status && terminal.has(status.state)) {
            if (status.state !== "settled") {
                console.log(
                    "\nThe swap did not settle. Nothing to do: the covenant refunds to the",
                    "\nwallet's own address once refund_locktime passes, and anyone can push it.",
                );
                return;
            }
            // The receipt. It is also readable from the solver's claim witness
            // on chain, which is the copy nobody can withhold.
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

const explain = (error: unknown): void => {
    if (error instanceof SwapRefusal) {
        console.error(`Solver refused to quote (reason: ${error.reason})`);
    } else if (error instanceof AddressMismatch) {
        console.error("Refused to fund:", error.message);
        console.error("  derived:", error.derived, "\n  quoted: ", error.quoted);
    } else if (error instanceof Error && "reason" in error) {
        console.error(`Funding gate ${String(error.reason)}: ${error.message}`);
    } else if (error instanceof Error && /512/.test(error.message)) {
        console.error(error.message);
        console.error(
            "\nThe Ark server reports a block-denominated unilateral exit delay. This corridor",
            "\nneeds a seconds-denominated one — see examples/README.md.",
        );
    } else {
        console.error(error);
    }
    process.exitCode = 1;
};

let wallet: WalletInstance | undefined;
try {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: ARK_SERVER_URL,
        esploraUrl: ESPLORA_URL,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
    console.log("Wallet address:", wallet.arkAddress.encode());
    await main(wallet);
} catch (error) {
    explain(error);
} finally {
    // the wallet holds subscriptions and timers: without this the process
    // stays alive after the swap is done
    await wallet?.dispose();
}
