import {
    ArkAddress,
    buildOffchainTx,
    CSVMultisigTapscript,
    DefaultVtxo,
    SingleKey,
    toXOnly,
    Transaction,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { p2tr, Script } from "@scure/btc-signer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAddress, signPsbt } from "../src/wallet";
import { installSnap, MAINNET_ADDRESS, MAINNET_INFO, stubOperators } from "./harness";

// The confirmation gate is the only thing between a hostile dapp and a
// signature over the user's VTXOs, so it gets tested against the real
// signPsbt rather than the mock used by index.test.ts.

const ORIGIN = "https://dapp.example";
const signer = toXOnly(hex.decode(MAINNET_INFO.signerPubkey));
const exit = { value: BigInt(MAINNET_INFO.unilateralExitDelay), type: "seconds" } as const;
const own = new DefaultVtxo.Script({
    pubKey: await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey(),
    serverPubKey: signer,
    csvTimelock: exit,
});
const recipient = new DefaultVtxo.Script({
    pubKey: await SingleKey.fromHex("44".repeat(32)).xOnlyPublicKey(),
    serverPubKey: signer,
    csvTimelock: exit,
});
const RECIPIENT_ADDRESS = new ArkAddress(signer, recipient.tweakedPublicKey, "ark").encode();

/** A send of 6,000 sats from a 10,000-sat VTXO: 3,500 back as change, the rest to the anchor. */
const send = buildOffchainTx(
    [
        {
            txid: "aa".repeat(32),
            vout: 0,
            value: 10_000,
            tapLeafScript: own.forfeit(),
            tapTree: own.encode(),
        },
    ],
    [
        { script: recipient.pkScript, amount: 6_000n },
        { script: own.pkScript, amount: 3_500n },
        { script: Script.encode(["RETURN", new Uint8Array([1, 2, 3])]), amount: 0n },
    ],
    CSVMultisigTapscript.decode(hex.decode(MAINNET_INFO.checkpointTapscript)),
);

const psbtOf = (tx: Transaction) => base64.encode(tx.toPSBT());

function emptyPsbt() {
    return psbtOf(new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true }));
}

/** Approves the sign dialog and returns its rendered text. */
async function signDialogFor(psbt: string): Promise<string> {
    const { dialogs } = installSnap(() => true);
    await getAddress({ network: "bitcoin" }, ORIGIN);
    await signPsbt({ psbt, inputIndexes: [0], network: "bitcoin" }, ORIGIN).catch(() => {});
    return JSON.stringify(dialogs.at(-1));
}

describe("signPsbt user confirmation", () => {
    beforeEach(() => {
        stubOperators({ "https://arkade.computer": MAINNET_INFO });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete (globalThis as Record<string, unknown>).snap;
    });

    it("asks for confirmation and names the requesting origin", async () => {
        const { dialogs } = installSnap(() => false);

        await expect(
            signPsbt(
                { psbt: emptyPsbt(), inputIndexes: [0], network: "bitcoin" },
                "https://evil.example",
            ),
        ).rejects.toThrow("User rejected the signature request");

        expect(dialogs).toHaveLength(1);
        expect(JSON.stringify(dialogs[0])).toContain("https://evil.example");
    });

    it("never touches key material when the user rejects", async () => {
        const { methods } = installSnap(() => false);

        await expect(
            signPsbt(
                { psbt: emptyPsbt(), inputIndexes: [0], network: "bitcoin" },
                "https://evil.example",
            ),
        ).rejects.toThrow("User rejected");

        // The critical assertion: a rejection must not reach snap_getEntropy.
        expect(methods).toContain("snap_dialog");
        expect(methods).not.toContain("snap_getEntropy");
    });

    it("treats a non-true dialog result as a rejection", async () => {
        installSnap(() => null);

        await expect(
            signPsbt({ psbt: emptyPsbt(), inputIndexes: [0], network: "bitcoin" }, ORIGIN),
        ).rejects.toThrow("User rejected the signature request");
    });

    it("requests confirmation before entropy when the user approves", async () => {
        const { methods } = installSnap(() => true);

        await signPsbt({ psbt: emptyPsbt(), inputIndexes: [0], network: "bitcoin" }, ORIGIN).catch(
            () => {
                // Signing an input-less PSBT may still fail downstream; ordering
                // is what this test asserts.
            },
        );

        expect(methods).toContain("snap_dialog");
        expect(methods).toContain("snap_getEntropy");
        expect(methods.indexOf("snap_dialog")).toBeLessThan(methods.indexOf("snap_getEntropy"));
    });

    it("needs the network to describe the outputs", async () => {
        installSnap(() => true);
        await expect(signPsbt({ psbt: emptyPsbt(), inputIndexes: [0] }, ORIGIN)).rejects.toThrow(
            "Invalid network",
        );
    });

    it("lists every output's amount and destination, and what leaves the wallet", async () => {
        const shown = await signDialogFor(psbtOf(send.arkTx));

        expect(shown).toContain(`6,000 sats to ${RECIPIENT_ADDRESS}`);
        expect(shown).toContain(`3,500 sats back to your address ${MAINNET_ADDRESS}`);
        expect(shown).toContain("0 sats to data (OP_RETURN)");
        expect(shown).toContain("500 sats to the fee anchor");
        expect(shown).toContain("Leaving your wallet: **6,500 sats**");
    });

    it("shows a checkpoint as your own coin moving into the send", async () => {
        const shown = await signDialogFor(psbtOf(send.checkpoints[0]));

        expect(shown).toContain("10,000 sats to the checkpoint of your spend");
        expect(shown).toContain("Leaving your wallet: **0 sats**");
    });

    it("shows a taproot output without an anchor as an onchain address", async () => {
        const tx = new Transaction({ allowUnknownOutputs: true });
        const onchain = p2tr(await SingleKey.fromHex("55".repeat(32)).xOnlyPublicKey());
        tx.addOutput({ script: onchain.script, amount: 2_000n });

        const shown = await signDialogFor(psbtOf(tx));

        expect(shown).toContain(`2,000 sats to ${onchain.address}`);
    });

    it("shows a script it cannot decode as hex rather than skipping it", async () => {
        const tx = new Transaction({ allowUnknownOutputs: true });
        tx.addOutput({ script: new Uint8Array([0x00, 0x01, 0x02]), amount: 1_000n });

        const shown = await signDialogFor(psbtOf(tx));

        expect(shown).toContain("1,000 sats to script 000102");
    });
});
