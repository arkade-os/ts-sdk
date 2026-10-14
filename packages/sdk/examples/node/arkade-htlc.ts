/**
 * This example shows how to turn an Arkade program into a contract, fund it and claim it.
 *
 * The program is a covenant HTLC: whoever reveals the preimage can claim, but the covenant
 * (checked by the emulator against the spending transaction) forces the coins to Bob.
 *
 * To run it:
 * ```
 * $ npx tsx examples/node/arkade-htlc.ts
 * ```
 *
 * Requires the local regtest stack to be running, with the emulator.
 */

import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { hash160 } from "@scure/btc-signer/utils.js";
import { EventSource } from "eventsource";
import type { Program } from "../../src/arkade";

// EventSource is used internally by the SDK to watch contracts (SSE).
// It is not available in Node.js by default, so we need to polyfill it.
(globalThis as any).EventSource = EventSource;

const {
    arkade,
    ArkAddress,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
} = await import("../../src");

const ARK_SERVER_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
const AMOUNT = 10_000;

const htlcProgram = {
    version: 0,
    params: ["hash", "receiver", "amount", "server"],
    functions: {
        claim: {
            inputs: [{ name: "preimage", type: "bytes" }],
            // Enforced by Bitcoin script: the preimage matches the hash, and the server co-signs.
            tapscript: {
                signers: ["$server"],
                asm: ["HASH160", "$hash", "EQUAL"],
                witness: ["preimage"],
            },
            // Enforced by the emulator: output 0 pays `receiver` exactly `amount`.
            arkadeScript: {
                asm: [
                    0,
                    "DUP",
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$receiver",
                    "EQUALVERIFY",
                    "INSPECTOUTPUTVALUE",
                    "$amount",
                    "EQUAL",
                ],
            },
        },
    },
} satisfies Program;

/** Pay `address` from the regtest arkd's CLI wallet, topping it up with a fresh note first. */
function fund(address: string, amount: number) {
    const ark = (...args: string[]) =>
        execFileSync("docker", ["exec", "arkd", ...args], { encoding: "utf8" }).trim();
    const note = ark("arkd", "note", "--amount", String(amount));
    ark("ark", "redeem-notes", "-n", note, "--password", "secret");
    ark("ark", "send", "--to", address, "--amount", String(amount), "--password", "secret");
}

async function main() {
    // Bob's wallet receives the claimed coins.
    const bob = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        service: { serverUrl: ARK_SERVER_URL },
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
    const bobPkScript = ArkAddress.decode(await bob.getAddress()).pkScript;

    const preimage = randomBytes(32);

    const ark = await arkade.Arkade.connect({
        service: { serverUrl: ARK_SERVER_URL, emulatorUrl: EMULATOR_URL },
        storage: { contractRepository: new InMemoryContractRepository() },
    });
    const htlc = ark.contract(htlcProgram, {
        hash: hash160(preimage),
        receiver: bobPkScript.subarray(2), // 32-byte witness program
        amount: BigInt(AMOUNT),
    });
    console.log("HTLC address:", htlc.address);

    // Subscribe before funding: `.on` reports activity from subscription on.
    let onCoin!: (coin: { txid: string; vout: number; value: number }) => void;
    const received = new Promise<Parameters<typeof onCoin>[0]>((resolve) => (onCoin = resolve));
    await htlc.on("vtxo_received", (event) => onCoin(event.vtxos[0]));

    console.log(`Funding the HTLC with ${AMOUNT} sats...`);
    fund(htlc.address, AMOUNT);
    const coin = await received;
    console.log(`Received ${coin.value} sats in ${coin.txid}:${coin.vout}`);

    const { txid } = await htlc.functions
        .claim(preimage)
        .from(coin)
        .to(bobPkScript, coin.value)
        .send();
    console.log("Claimed in tx", txid);

    while ((await bob.getBalance()).total === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    console.log("Bob's balance:", await bob.getBalance());

    ark.dispose();
    await bob.dispose();
}

main().catch((error) => {
    console.error(error);
    process.exit(1); // the open contract watcher would otherwise keep the process alive
});
