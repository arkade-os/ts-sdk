/**
 * Builds and broadcasts covenant claim transactions.
 *
 * Flow:
 * 1. Build a PSBT spending the UTXO via the covenantClaim leaf
 * 2. Add Extension OP_RETURN output with IntrospectorPacket (arkade script)
 * 3. Set ConditionWitness PSBT field with the preimage
 * 4. Submit to introspector for co-signing
 * 5. Manually finalize the witness (introspectorSig + preimage + tapscript)
 * 6. Broadcast via esplora
 */

import { hex, base64 } from "@scure/base";
import { RawWitness, SigHash, NETWORK } from "@scure/btc-signer";
import {
    Transaction,
    RestIntrospectorProvider,
    setArkPsbtField,
    ConditionWitness,
} from "@arkade-os/sdk";
import {
    Extension,
    IntrospectorPacket,
} from "@arkade-os/sdk/dist/esm/extension/index.js";
import { scriptFromTapLeafScript } from "@arkade-os/sdk/dist/esm/script/base.js";
import type { CovenantEntry, Config, EsploraUtxo } from "./types.js";
import { deriveCovVHTLC } from "./derive.js";

// Rough estimate for a 1-input 2-output taproot tx with extension (vbytes)
const ESTIMATED_VSIZE = 200;

export async function claimCovenant(
    entry: CovenantEntry,
    utxo: EsploraUtxo,
    config: Config
): Promise<string> {
    const { script } = await deriveCovVHTLC(entry.registration, config);

    const network = networkFromConfig(config);
    const leaf = script.covenantClaim();
    const preimage = hex.decode(entry.registration.preimage);

    // Fetch fee rate from esplora
    const feeRate = await fetchFeeRate(config.esploraUrl);
    const fee = BigInt(Math.ceil(feeRate * ESTIMATED_VSIZE));

    const expectedAmount = BigInt(entry.registration.expectedAmount);
    const inputAmount = BigInt(utxo.value);
    const change = inputAmount - expectedAmount - fee;

    // Build the spending transaction
    const tx = new Transaction();

    tx.addInput({
        txid: hex.decode(utxo.txid),
        index: utxo.vout,
        witnessUtxo: {
            amount: inputAmount,
            script: script.pkScript,
        },
        sighashType: SigHash.DEFAULT,
        tapLeafScript: [leaf],
    });

    // Output 0: covenant-enforced destination (must match arkade script constraints)
    tx.addOutputAddress(
        entry.registration.claimAddress,
        expectedAmount,
        network
    );

    // Output 1: change back to claim address (if enough remains after fee)
    if (change > 546n) {
        tx.addOutputAddress(
            entry.registration.claimAddress,
            change,
            network
        );
    }

    // Output N: Extension OP_RETURN with IntrospectorPacket.
    // The introspector reads this to find the arkade script for vin 0,
    // evaluates the script (checks output constraints), and co-signs.
    const arkadeScriptBytes = script.arkadeScripts.get(6)!;
    const extensionOutput = Extension.create([
        IntrospectorPacket.create([
            { vin: 0, script: arkadeScriptBytes, witness: new Uint8Array(0) },
        ]),
    ]).txOut();
    tx.addOutput(extensionOutput);

    // Set ConditionWitness PSBT field with the preimage.
    // The introspector reads this and includes it in the witness assembly.
    setArkPsbtField(tx, 0, ConditionWitness, [preimage]);

    // Submit to introspector for co-signing
    const introspector = new RestIntrospectorProvider(config.introspectorUrl);
    const psbtB64 = base64.encode(tx.toPSBT());
    const result = await introspector.submitTx(psbtB64, []);

    // Parse the signed PSBT
    const signedTx = Transaction.fromPSBT(base64.decode(result.signedArkTx));

    // Check if the introspector already finalized (set finalScriptWitness)
    const signedInput = signedTx.getInput(0);
    if (signedInput.finalScriptWitness) {
        // Introspector fully finalized — extract and broadcast
        const rawTx = hex.encode(signedTx.extract());
        return broadcastTx(config.esploraUrl, rawTx);
    }

    // Manual finalization: the introspector added tapScriptSig but didn't finalize.
    // Construct the witness: [introspectorSig, preimage, leafScript, controlBlock]
    const tapScriptSig = signedInput.tapScriptSig;
    if (!tapScriptSig || tapScriptSig.length === 0) {
        throw new Error("introspector did not sign the transaction");
    }
    const introspectorSig = tapScriptSig[0][1];

    // Build control block from the tapLeafScript proof data
    const leafInfo = leaf[0]; // { version, internalKey, merklePath }
    const controlBlock = new Uint8Array(
        1 + 32 + leafInfo.merklePath.length * 32
    );
    controlBlock[0] = leafInfo.version;
    controlBlock.set(leafInfo.internalKey, 1);
    for (let i = 0; i < leafInfo.merklePath.length; i++) {
        controlBlock.set(leafInfo.merklePath[i], 33 + i * 32);
    }

    // Get the raw leaf script (strip the trailing version byte)
    const leafScript = scriptFromTapLeafScript(leaf);

    // Assemble the tapscript witness:
    //   [introspectorSig, preimage, leafScript, controlBlock]
    //
    // The script evaluates bottom-to-top:
    //   1. preimage → SIZE 32 EQUALVERIFY HASH160 <hash> EQUAL VERIFY
    //   2. introspectorSig → <tweakedKey> CHECKSIG
    const finalWitness = RawWitness.encode([
        introspectorSig,
        preimage,
        leafScript,
        controlBlock,
    ]);

    signedTx.updateInput(0, {
        finalScriptWitness: finalWitness,
        // Clear intermediate PSBT fields
        tapLeafScript: undefined,
        tapScriptSig: undefined,
    } as any);

    const rawTx = hex.encode(signedTx.extract());
    return broadcastTx(config.esploraUrl, rawTx);
}

async function fetchFeeRate(esploraUrl: string): Promise<number> {
    const res = await fetch(`${esploraUrl}/api/fee-estimates`);
    if (!res.ok) {
        return 1; // Fallback to 1 sat/vbyte
    }
    const estimates: Record<string, number> = await res.json();
    return estimates["6"] ?? 1;
}

async function broadcastTx(
    esploraUrl: string,
    rawTxHex: string
): Promise<string> {
    const res = await fetch(`${esploraUrl}/api/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rawTxHex,
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to broadcast tx: ${errorText}`);
    }

    return res.text();
}

function networkFromConfig(config: Config): typeof NETWORK {
    switch (config.network) {
        case "mainnet":
            return { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05 };
        case "signet":
            return { bech32: "tb", pubKeyHash: 0x6f, scriptHash: 0xc4 };
        case "regtest":
            return { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4 };
    }
}
