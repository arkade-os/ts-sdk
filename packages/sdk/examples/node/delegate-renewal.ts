/**
 * This example shows how a wallet keeps its VTXOs alive automatically by
 * delegating their renewal.
 *
 * When settlement is enabled and a delegate provider is configured, the wallet's
 * VtxoManager auto-settles incoming boarding UTXOs and, on every `vtxo_received`
 * event, delegates the coin's renewal to the delegate server. Each delegated
 * renewal mints a fresh VTXO, which fires `vtxo_received` again and is
 * re-delegated — a self-sustaining loop that requires no manual intervention.
 *
 * The example funds a single wallet once, then watches the wallet's lone VTXO
 * rotate its txid across several renewal cycles while its value is preserved.
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/delegate-renewal.ts
 * ```
 *
 * Requires the local regtest stack (including the delegate server on :7012).
 */

import { execFileSync } from "child_process";
import { EventSource } from "eventsource";

import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestDelegateProvider,
    SingleKey,
    Wallet,
} from "../../src";

// EventSource is used internally by the SDK to receive settlement events (SSE),
// which is what drives auto-delegation. It is not available in Node.js by
// default, so we polyfill it.
(globalThis as any).EventSource = EventSource;

const ARK_SERVER_URL = "http://localhost:7070";
const ESPLORA_URL = "http://localhost:3000/api";
const DELEGATE_SERVER_URL = "http://localhost:7012";

// Number of auto-delegated renewals to observe before the example stops.
const REQUIRED_RENEWALS = 3;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
    description: string,
    predicate: () => Promise<boolean>,
    timeoutMs = 150_000,
    intervalMs = 2_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!(await predicate())) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }

        await sleep(intervalMs);
    }
}

const startedAt = Date.now();

/** Log a line prefixed with the seconds elapsed since the example started. */
function log(message: string): void {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(5);
    console.log(`[+${elapsed}s] ${message}`);
}

async function main() {
    log("Starting Delegate Renewal NodeJS Example...");

    // Settlement enabled + a delegate provider wires up the auto-delegation loop.
    // `vtxoThreshold: 1` keeps the direct renewVtxos() path dormant (it would
    // otherwise fire for every VTXO, since regtest batch expiry sits far inside
    // the default 3-day threshold), leaving auto-delegation as the path that
    // renews each cycle.
    log("Creating wallet with settlement + delegation enabled (in-memory storage)...");
    const wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: ARK_SERVER_URL,
        esploraUrl: ESPLORA_URL,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        delegateProvider: new RestDelegateProvider(DELEGATE_SERVER_URL),
        settlementConfig: {
            pollIntervalMs: 5000,
            vtxoThreshold: 1,
        },
    });

    log(`Wallet ready — Ark address: ${wallet.arkAddress.encode()}`);
    log("The VtxoManager is now polling and subscribed to vtxo_received events.");

    const boardingAddress = await wallet.getBoardingAddress();
    log(`Funding boarding address ${boardingAddress} via regtest faucet...`);
    execFileSync("node", ["regtest/regtest.mjs", "faucet", boardingAddress, "0.001", "--confirm"], {
        stdio: "inherit",
    });

    log("Waiting for the boarding UTXO to be detected...");
    await waitFor(
        "boarding UTXO",
        async () => (await wallet.getBoardingUtxos()).length > 0,
        60_000,
    );
    log("Boarding UTXO detected — the poll loop will auto-settle it into a VTXO.");

    log("Waiting for the wallet to auto-settle into its first VTXO...");
    await waitFor("first VTXO", async () => (await wallet.getVtxos()).length > 0, 60_000);

    const initialVtxos = await wallet.getVtxos();
    const initialValue = initialVtxos[0].value;
    log(`First VTXO settled: ${initialVtxos[0].txid} (${initialValue} sats)`);
    log(`Balance: ${JSON.stringify(await wallet.getBalance())}`);
    log("On this vtxo_received the wallet auto-delegated the coin's renewal.");
    log(`Now watching the single VTXO renew itself ${REQUIRED_RENEWALS} times...\n`);

    // Watch the single VTXO's txid rotate across auto-delegated renewals. Each
    // renewal is triggered by the delegate server near the coin's expiry, mints a
    // fresh VTXO, and re-arms the loop — no manual delegate() call is made here.
    const seenTxids = new Set<string>([initialVtxos[0].txid]);
    let lastRenewalAt = Date.now();
    await waitFor(`${REQUIRED_RENEWALS} auto-delegated renewals`, async () => {
        const vtxos = await wallet.getVtxos();
        if (vtxos.length === 1 && !seenTxids.has(vtxos[0].txid)) {
            seenTxids.add(vtxos[0].txid);
            const sinceLast = ((Date.now() - lastRenewalAt) / 1000).toFixed(1);
            lastRenewalAt = Date.now();
            const preserved = vtxos[0].value === initialValue;
            log(
                `Renewal #${seenTxids.size - 1} (+${sinceLast}s): ${vtxos[0].txid} ` +
                    `(${vtxos[0].value} sats, value ${preserved ? "preserved" : "CHANGED"})`,
            );
        }
        return seenTxids.size >= REQUIRED_RENEWALS + 1;
    });

    log(`\nObserved ${seenTxids.size - 1} auto-delegated renewals — the wallet renews itself.`);
    log(`Final balance: ${JSON.stringify(await wallet.getBalance())}`);

    await wallet.dispose();
    log("Wallet disposed. Done.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
