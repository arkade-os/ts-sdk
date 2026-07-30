import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    arkade,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    RestEmulatorProvider,
} from "../../src";
import { beforeEachFaucet, faucetOffchain, randomP2TR } from "./utils";

const EMULATOR_URL = "http://localhost:7073";
const ARK_SERVER_URL = "http://localhost:7070";
const HTLC_PREIMAGE = new Uint8Array(32).fill(0x42);
const HTLC_PREIMAGE_HASH = hex.decode("8739f40ec4dbf569dcb38134c6e7310908566981"); // RIPEMD160(SHA256(HTLC_PREIMAGE))
const CONTRACT_AMOUNT = 10_000n;

const nonInteractiveHTLC = {
    version: 0,
    params: ["hash", "funder", "receiver", "amount", "server"],
    functions: {
        claim: {
            inputs: [{ name: "preimage", type: "bytes" }] as const,
            tapscript: {
                signers: ["$server"],
                asm: ["HASH160", "$hash", "EQUAL"],
                witness: ["preimage"],
            },
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
                witness: [],
            },
        },
        refund: {
            tapscript: {
                signers: ["$server"],
                cltv: 500_000_000n,
            },
            arkadeScript: {
                asm: [
                    0,
                    "DUP",
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$funder",
                    "EQUALVERIFY",
                    "INSPECTOUTPUTVALUE",
                    "$amount",
                    "EQUAL",
                ],
                witness: [],
            },
        },
    },
};

describe("non-interactive vHTLC", () => {
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    const arkProvider = new RestArkProvider(ARK_SERVER_URL);
    const indexerProvider = new RestIndexerProvider(ARK_SERVER_URL);
    const receiverPkScript = randomP2TR();
    const funderPkScript = randomP2TR();

    beforeEach(beforeEachFaucet, 20000);

    it("claim", { timeout: 60000 }, async () => {
        const ark = await arkade.Arkade.connect({
            arkade: arkProvider,
            emulator,
            indexer: indexerProvider,
            network: networks.regtest,
        });

        const contract = ark.contract(nonInteractiveHTLC, {
            hash: HTLC_PREIMAGE_HASH,
            receiver: receiverPkScript.slice(2), // 32-byte witness program
            funder: funderPkScript.slice(2), // 32-byte witness program
            amount: CONTRACT_AMOUNT,
        });

        // fund the contract address
        faucetOffchain(contract.address, Number(CONTRACT_AMOUNT));
        await waitForVtxo(indexerProvider, contract.pkScript);

        // try to claim to the wrong address : should fail
        await expect(
            contract.functions
                .claim(HTLC_PREIMAGE)
                .to(new Uint8Array([0x6a]), CONTRACT_AMOUNT)
                .send(),
        ).rejects.toThrow();

        // try to claim but the wrong amount : should fail
        await expect(
            contract.functions
                .claim(HTLC_PREIMAGE)
                .to([
                    { script: receiverPkScript, amount: CONTRACT_AMOUNT - 1n },
                    { script: randomP2TR(), amount: 1n },
                ])
                .send(),
        ).rejects.toThrow();

        // try to claim with right address and amount : should succeed
        const { txid } = await contract.functions
            .claim(HTLC_PREIMAGE)
            .to(receiverPkScript, CONTRACT_AMOUNT)
            .send();

        const [vtxo] = await waitForVtxo(indexerProvider, receiverPkScript);
        expect(vtxo.txid).toBe(txid);
    });
});

/** Wait for at least one VTXO at the given pkScript */
async function waitForVtxo(indexer: RestIndexerProvider, pkScript: Uint8Array, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const resp = await indexer.getVtxos({
            scripts: [hex.encode(pkScript)],
            spendableOnly: true,
        });
        if (resp.vtxos.length > 0) return resp.vtxos;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("waitForVtxo: timeout");
}
