import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
} from "../../src";
import { beforeEachFaucet, createTestArkWallet, faucetOffchain, randomP2TR } from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";

const HTLC_PREIMAGE = new Uint8Array(32).fill(0x42);
// HASH160 = RIPEMD160(SHA256(HTLC_PREIMAGE))
const HTLC_PREIMAGE_HASH = hex.decode("8739f40ec4dbf569dcb38134c6e7310908566981");
const CONTRACT_AMOUNT = 10_000n;

// Arkade-script covenant body: enforce that output 0 pays exactly `$amount` to
// `$receiver` (the 32-byte taproot witness program). Mirrors the `enforcePayTo`
// helper — the leading DUP consumes the output index pushed by the witness `[0]`.
const payTo = [
    "DUP",
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "$receiver",
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "$amount",
    "EQUAL",
] satisfies arkade.AsmToken[];

// HTLC claim: server + arkade-tweaked emulator multisig, gated by a HASH160
// preimage condition; the covenant forces the pay-to-receiver output.
const claimProgram = {
    params: ["hash", "receiver", "amount"],
    functions: {
        claim: {
            inputs: [{ name: "preimage", type: "bytes" }] as const,
            tapscript: {
                signers: ["server"],
                asm: ["HASH160", "$hash", "EQUAL"],
                witness: ["preimage"],
            },
            arkadeScript: { asm: payTo, witness: [0] },
        },
    },
} satisfies arkade.Program;

// HTLC refund: same covenant, gated by an absolute (CLTV) timelock instead of a
// preimage; no call arguments.
const refundProgram = {
    params: ["receiver", "amount"],
    functions: {
        refund: {
            tapscript: { signers: ["server"], cltv: 500_000_000n }, // genesis-relative, always satisfied
            arkadeScript: { asm: payTo, witness: [0] },
        },
    },
} satisfies arkade.Program;

describe("arkade HTLC (covenant)", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);

    let ark: arkade.Arkade;

    beforeAll(async () => {
        ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer: indexerProvider,
            network: networks.regtest,
        });
    });

    beforeEach(beforeEachFaucet, 20000);

    /** Wait for at least one VTXO at the given pkScript */
    async function waitForVtxo(pkScript: Uint8Array, timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const resp = await indexerProvider.getVtxos({
                scripts: [hex.encode(pkScript)],
                spendableOnly: true,
            });
            if (resp.vtxos.length > 0) return resp.vtxos;
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error("waitForVtxo: timeout");
    }

    it(
        "claim: emulator signs only when preimage + arkade script pass",
        { timeout: 60000 },
        async () => {
            await createTestArkWallet();

            const receiverPkScript = randomP2TR();
            const contract = ark.contract(claimProgram, {
                hash: HTLC_PREIMAGE_HASH,
                receiver: receiverPkScript.slice(2), // 32-byte witness program
                amount: CONTRACT_AMOUNT,
            });

            // Fund and wait for the contract VTXO.
            faucetOffchain(contract.address, Number(CONTRACT_AMOUNT));
            await waitForVtxo(contract.pkScript);

            // `preimage` is statically typed Uint8Array (see claimProgram inputs).

            // Negative case 1: wrong output script (OP_RETURN) — covenant rejects.
            await expect(
                contract.functions
                    .claim(HTLC_PREIMAGE)
                    .to(new Uint8Array([0x6a]), CONTRACT_AMOUNT)
                    .send(),
            ).rejects.toThrow();

            // Negative case 2: right script but wrong amount (split outputs).
            await expect(
                contract.functions
                    .claim(HTLC_PREIMAGE)
                    .to([
                        { script: receiverPkScript, amount: CONTRACT_AMOUNT - 1n },
                        { script: randomP2TR(), amount: 1n },
                    ])
                    .send(),
            ).rejects.toThrow();

            // Valid: right output and amount. The emulator is the last non-arkd
            // signer, so it finalizes with arkd internally — `send()` returns the
            // finalized txid.
            const { txid } = await contract.functions
                .claim(HTLC_PREIMAGE)
                .to(receiverPkScript, CONTRACT_AMOUNT)
                .send();
            expect(txid).toBeTruthy();
        },
    );

    it(
        "refund: emulator signs only when CLTV satisfied + arkade script passes",
        { timeout: 60000 },
        async () => {
            await createTestArkWallet();

            const senderPkScript = randomP2TR();
            const contract = ark.contract(refundProgram, {
                receiver: senderPkScript.slice(2),
                amount: CONTRACT_AMOUNT,
            });

            faucetOffchain(contract.address, Number(CONTRACT_AMOUNT));
            await waitForVtxo(contract.pkScript);

            // Negative: wrong destination.
            await expect(
                contract.functions
                    .refund()
                    .to(new Uint8Array([0x6a]), CONTRACT_AMOUNT)
                    .send(),
            ).rejects.toThrow();
            // Negative: wrong amount.
            await expect(
                contract.functions
                    .refund()
                    .to([
                        { script: senderPkScript, amount: CONTRACT_AMOUNT - 1n },
                        { script: randomP2TR(), amount: 1n },
                    ])
                    .send(),
            ).rejects.toThrow();

            // Valid: right output and amount.
            const { txid } = await contract.functions
                .refund()
                .to(senderPkScript, CONTRACT_AMOUNT)
                .send();
            expect(txid).toBeTruthy();
        },
    );
});
