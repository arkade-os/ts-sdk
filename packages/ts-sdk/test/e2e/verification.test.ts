import { base64, hex } from "@scure/base";
import { beforeEach, describe, expect, it } from "vitest";
import {
    createExitChainResolver,
    EsploraProvider,
    RestArkProvider,
    verifyVtxo,
    type VtxoProofSource,
} from "../../src";
import { Transaction } from "../../src/utils/transaction";
import {
    ARK_SERVER_URL,
    beforeEachFaucet,
    createTestArkWallet,
    createVtxo,
    ESPLORA_API_URL,
    execCommand,
} from "./utils";

async function serverInfo() {
    const info = await new RestArkProvider(ARK_SERVER_URL).getInfo();
    return {
        forfeitPubkey: hex.decode(info.forfeitPubkey).slice(1),
    };
}

describe("verifyVtxo — regtest integration", () => {
    beforeEach(beforeEachFaucet, 20_000);

    it("confirms a real settled VTXO against Bitcoin", { timeout: 120_000 }, async () => {
        const alice = await createTestArkWallet();
        await createVtxo(alice, 50_000);
        execCommand("node regtest/regtest.mjs mine 1");
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        const [vtxo] = await alice.wallet.getVtxos();
        expect(vtxo).toBeDefined();
        const proofSource = createExitChainResolver({
            indexer: alice.wallet.indexerProvider,
        });
        const result = await verifyVtxo(
            vtxo,
            proofSource,
            new EsploraProvider(ESPLORA_API_URL),
            await serverInfo(),
            { minConfirmationDepth: 1 },
        );

        expect(result.status).toBe("confirmed");
    });

    it("rejects a forged TREE tapKeySig", { timeout: 120_000 }, async () => {
        const alice = await createTestArkWallet();
        await createVtxo(alice, 50_000);
        execCommand("node regtest/regtest.mjs mine 1");
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        const [vtxo] = await alice.wallet.getVtxos();
        const real = createExitChainResolver({ indexer: alice.wallet.indexerProvider });
        const forged: VtxoProofSource = {
            getVtxoChain: (outpoint) => real.getVtxoChain(outpoint),
            getVirtualTxs: async (txids) => {
                let mutated = false;
                return (await real.getVirtualTxs(txids)).map((encoded) => {
                    if (mutated) return encoded;
                    const tx = Transaction.fromPSBT(base64.decode(encoded));
                    for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
                        const signature = tx.getInput(inputIndex).tapKeySig;
                        if (!signature) continue;
                        const replacement = Uint8Array.from(signature);
                        replacement[0] ^= 0xff;
                        tx.updateInput(inputIndex, { tapKeySig: replacement });
                        mutated = true;
                        return base64.encode(tx.toPSBT());
                    }
                    return encoded;
                });
            },
        };

        const result = await verifyVtxo(
            vtxo,
            forged,
            new EsploraProvider(ESPLORA_API_URL),
            await serverInfo(),
            { minConfirmationDepth: 1 },
        );

        expect(result.status).toBe("invalid");
        expect(result.issues).toContainEqual(
            expect.objectContaining({ code: "signature_invalid_tap_key" }),
        );
    });
});
