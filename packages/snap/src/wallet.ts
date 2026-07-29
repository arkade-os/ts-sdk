import { Transaction, SingleKey, ArkAddress, DefaultVtxo } from "@arkade-os/sdk";
import { divider, heading, panel, text } from "@metamask/snaps-sdk";
import { base64, hex } from "@scure/base";

import type { ArkadeAddress, PubKeyHex, XOnlyPubKeyHex } from "./types";
import {
    validateInputIndexes,
    validateNetwork,
    validatePsbt,
    validateSignerPubkey,
    validateUnilateralExitDelay,
} from "./utils";

/**
 * Get public keys from snap's deterministic key derivation.
 * This ensures the same keys are always generated for the same MetaMask account.
 * @returns An object containing the compressed and x-only public keys.
 */
export async function getPublicKey(): Promise<{
    compressedPublicKey: PubKeyHex;
    xOnlyPublicKey: XOnlyPubKeyHex;
}> {
    const entropy = await snap.request({
        method: "snap_getEntropy",
        params: {
            version: 1,
            salt: "bitcoin-arkade-snap",
        },
    });

    // Derive the private key from entropy (remove 0x prefix)
    const privateKeyHex = entropy.slice(2);

    // Create identity from private key
    const identity = SingleKey.fromHex(privateKeyHex);

    // Get public keys from identity
    const [compressedPublicKeyBytes, xOnlyPublicKeyBytes] = await Promise.all([
        identity.compressedPublicKey(),
        identity.xOnlyPublicKey(),
    ]);

    return {
        compressedPublicKey: hex.encode(compressedPublicKeyBytes),
        xOnlyPublicKey: hex.encode(xOnlyPublicKeyBytes),
    };
}

/**
 * Get Arkade address and public keys from snap's deterministic key derivation.
 * This ensures the same wallet address is always generated for the same MetaMask account.
 *
 * Note: We fetch server info to get the server info, then build the Arkade address
 * without creating a full wallet instance.
 * @param params - The parameters object containing network, signerPubkey, and unilateralExitDelay.
 * @returns An object containing the Arkade address.
 */
export async function getAddress(params: unknown): Promise<{ address: ArkadeAddress }> {
    // Validate params structure
    if (!params || typeof params !== "object") {
        throw new Error("Invalid params: expected object");
    }

    const { network, signerPubkey, unilateralExitDelay } = params as {
        network: unknown;
        signerPubkey: unknown;
        unilateralExitDelay: unknown;
    };

    // Validate individual parameters
    const validatedNetwork = validateNetwork(network);
    const validatedSignerPubkey = validateSignerPubkey(signerPubkey);
    const validatedExitDelay = validateUnilateralExitDelay(unilateralExitDelay);

    const serverPubKeyBytes = hex.decode(validatedSignerPubkey);
    const prefix = validatedNetwork === "bitcoin" ? "ark" : "tark";

    const entropy = await snap.request({
        method: "snap_getEntropy",
        params: {
            version: 1,
            salt: "bitcoin-arkade-snap",
        },
    });

    // Derive the private key from entropy (remove 0x prefix)
    const privateKeyHex = entropy.slice(2);

    // Create identity from private key
    const identity = SingleKey.fromHex(privateKeyHex);
    const xOnlyPublicKeyBytes = await identity.xOnlyPublicKey();

    // Create the default vtxo script to get the taproot output key
    // The vtxo script contains forfeit (user + server) and exit (user after timelock) paths
    // Use the server's unilateral exit delay to match the official wallet
    const csvTimelock = {
        value: validatedExitDelay,
        type: validatedExitDelay < 512n ? "blocks" : "seconds",
    } as const;

    const vtxoScript = new DefaultVtxo.Script({
        pubKey: xOnlyPublicKeyBytes,
        serverPubKey: serverPubKeyBytes,
        csvTimelock,
    });

    // Get the tweaked public key (taproot output key) from the vtxo script
    const taprootOutputKey = vtxoScript.tweakedPublicKey;

    // Build Arkade address using server pubkey and taproot output key
    const arkadeAddress = new ArkAddress(serverPubKeyBytes, taprootOutputKey, prefix);

    return { address: arkadeAddress.encode() };
}

/**
 * Sign a PSBT with the snap's Bitcoin key.
 *
 * Prompts the user for confirmation before signing, showing the requesting
 * origin. Any dapp with RPC access can call this, so the prompt is the only
 * thing standing between a hostile page and a signature over the user's VTXOs.
 * @param params - The parameters object containing psbt and inputIndexes.
 * @param origin - The origin of the requesting dapp, shown in the prompt.
 * @returns An object containing the signed PSBT in base64 format.
 */
export async function signPsbt(params: unknown, origin: string): Promise<{ psbt: string }> {
    // Validate params structure
    if (!params || typeof params !== "object") {
        throw new Error("Invalid params: expected object");
    }

    const { psbt, inputIndexes } = params as { psbt: unknown; inputIndexes: unknown };

    // Validate individual parameters
    const validatedPsbt = validatePsbt(psbt);
    const validatedInputIndexes = validateInputIndexes(inputIndexes);

    // Decode PSBT
    let psbtBytes: Uint8Array;
    try {
        psbtBytes = base64.decode(validatedPsbt);
    } catch (error) {
        throw new Error(
            `Failed to decode PSBT: ${error instanceof Error ? error.message : "unknown error"}`,
        );
    }

    const tx = Transaction.fromPSBT(psbtBytes);

    // Ask the user before touching key material.
    //
    // `endowment:rpc` is granted with `dapps: true`, so ANY page the user visits
    // that can reach MetaMask may call arkade_signPsbt once the snap is
    // installed. Without this gate a malicious dapp could obtain a signature
    // over inputs of its choosing, including a spend of the user's VTXOs.
    // Placed after decode so the prompt can describe the real transaction, and
    // before snap_getEntropy so a rejection never unlocks the key.
    const approved = await snap.request({
        method: "snap_dialog",
        params: {
            type: "confirmation",
            content: panel([
                heading("Sign Arkade transaction?"),
                text(`**${origin}** is requesting a signature.`),
                divider(),
                text(`Inputs to sign: **${validatedInputIndexes.join(", ")}**`),
                text(`Transaction inputs: **${tx.inputsLength}**`),
                text(`Transaction outputs: **${tx.outputsLength}**`),
                divider(),
                text("Only approve this if you recognise the site and expect this transaction."),
            ]),
        },
    });

    if (approved !== true) {
        throw new Error("User rejected the signature request");
    }

    // Get the private key and create identity (consistent with getAddress())
    const entropy = await snap.request({
        method: "snap_getEntropy",
        params: {
            version: 1,
            salt: "bitcoin-arkade-snap",
        },
    });
    const privateKeyHex = entropy.slice(2);

    // Create identity from private key
    const identity = SingleKey.fromHex(privateKeyHex);

    // Sign the transaction using SingleKey's sign method
    const signedTx = await identity.sign(tx, validatedInputIndexes);

    // Convert signed transaction back to PSBT
    const signedPsbt = signedTx.toPSBT();
    const signedPsbtBase64 = base64.encode(signedPsbt);

    return {
        psbt: signedPsbtBase64,
    };
}
