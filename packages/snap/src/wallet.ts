import {
    ArkAddress,
    CSVMultisigTapscript,
    DefaultVtxo,
    getNetwork,
    P2A,
    scriptFromTapLeafScript,
    SingleKey,
    Transaction,
    VtxoScript,
} from "@arkade-os/sdk";
import { divider, heading, panel, text } from "@metamask/snaps-sdk";
import { base64, hex } from "@scure/base";
import { Address, OutScript } from "@scure/btc-signer";

import { type Operator, readState, resolveOperator, updateState } from "./operator";
import type { ArkadeAddress, PubKeyHex, XOnlyPubKeyHex } from "./types";
import { validateInputIndexes, validatePsbt } from "./utils";

/** The snap's key, derived from MetaMask's entropy, so it is the same for the same account. */
async function snapIdentity(): Promise<SingleKey> {
    const entropy = await snap.request({
        method: "snap_getEntropy",
        params: {
            version: 1,
            salt: "bitcoin-arkade-snap",
        },
    });
    return SingleKey.fromHex(entropy.slice(2));
}

/** Best effort: it only lets a sign prompt mark change, so a failed write fails nothing. */
async function rememberPubkey(xOnly: Uint8Array): Promise<void> {
    const pubkey = hex.encode(xOnly);
    if ((await readState()).pubkey !== pubkey) {
        await updateState((state) => ({ ...state, pubkey })).catch(() => {});
    }
}

/** The default VTXO script the SDK wallet derives for this key and operator. */
function defaultScript(pubKey: Uint8Array, operator: Operator): DefaultVtxo.Script {
    return new DefaultVtxo.Script({
        pubKey,
        serverPubKey: operator.signer,
        csvTimelock: {
            value: operator.exitDelay,
            type: operator.exitDelay < 512n ? "blocks" : "seconds",
        },
    });
}

/**
 * Get public keys from snap's deterministic key derivation.
 * This ensures the same keys are always generated for the same MetaMask account.
 * @returns An object containing the compressed and x-only public keys.
 */
export async function getPublicKey(): Promise<{
    compressedPublicKey: PubKeyHex;
    xOnlyPublicKey: XOnlyPubKeyHex;
}> {
    const identity = await snapIdentity();
    const [compressedPublicKeyBytes, xOnlyPublicKeyBytes] = await Promise.all([
        identity.compressedPublicKey(),
        identity.xOnlyPublicKey(),
    ]);
    await rememberPubkey(xOnlyPublicKeyBytes);

    return {
        compressedPublicKey: hex.encode(compressedPublicKeyBytes),
        xOnlyPublicKey: hex.encode(xOnlyPublicKeyBytes),
    };
}

/**
 * The snap's Arkade address on the operator the request names. The operator's key and exit delay
 * come from the operator itself; see {@link resolveOperator}.
 * @param params - `{ network, operatorUrl? }`.
 * @param origin - The requesting dapp, which must have approved any operator that is not built in.
 * @returns An object containing the Arkade address.
 */
export async function getAddress(
    params: unknown,
    origin: string,
): Promise<{ address: ArkadeAddress }> {
    const operator = await resolveOperator(params, origin);
    const pubKey = await (await snapIdentity()).xOnlyPublicKey();
    await rememberPubkey(pubKey);

    const script = defaultScript(pubKey, operator);
    const hrp = getNetwork(operator.network).hrp;
    return { address: new ArkAddress(operator.signer, script.tweakedPublicKey, hrp).encode() };
}

const sats = (amount: bigint) => `${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",")} sats`;

const same = (a: Uint8Array, b: Uint8Array) => hex.encode(a) === hex.encode(b);

/**
 * One line per output, and what leaves the wallet: everything but change and checkpoints. A
 * checkpoint pays a script built from an input's own leaf and the operator's unroll script, so it
 * is the user's coin moving into the send rather than a payment, but only for an input the snap's
 * own script holds: from anyone else's leaf it is a payment like any other.
 */
function describeOutputs(tx: Transaction, operator: Operator, own?: DefaultVtxo.Script) {
    const network = getNetwork(operator.network);
    const arkAddress = (script: Uint8Array) =>
        new ArkAddress(operator.signer, script.slice(2), network.hrp).encode();
    const unroll = operator.checkpointTapscript
        ? CSVMultisigTapscript.decode(hex.decode(operator.checkpointTapscript))
        : undefined;
    const ownLeaves = own
        ? [own.forfeit(), own.exit()].map((leaf) => hex.encode(scriptFromTapLeafScript(leaf)))
        : [];
    const checkpoints: Uint8Array[] = [];
    for (let i = 0; own && unroll && i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        const leaf = input.tapLeafScript?.[0];
        if (!leaf || !input.witnessUtxo || !same(input.witnessUtxo.script, own.pkScript)) continue;
        const leafScript = scriptFromTapLeafScript(leaf);
        if (!ownLeaves.includes(hex.encode(leafScript))) continue;
        checkpoints.push(new VtxoScript([unroll.script, leafScript]).pkScript);
    }
    const ownScript = own?.pkScript;
    const outputs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
    // An offchain tx carries the anchor; without one, a taproot output is an onchain address.
    const offchain = outputs.some((o) => o.script && same(o.script, P2A.script));

    let leaving = 0n;
    const lines = outputs.map((output, i) => {
        const script = output.script ?? new Uint8Array();
        const amount = output.amount ?? 0n;
        let destination: string;
        let stays = false;
        if (same(script, P2A.script)) {
            destination = "to the fee anchor";
        } else if (script[0] === 0x6a) {
            destination = "to data (OP_RETURN)";
        } else if (ownScript && same(script, ownScript)) {
            stays = true;
            destination = `back to your address ${arkAddress(script)}`;
        } else if (checkpoints.some((checkpoint) => same(checkpoint, script))) {
            stays = true;
            destination = "to the checkpoint of your spend";
        } else if (offchain && script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
            destination = `to ${arkAddress(script)}`;
        } else {
            try {
                destination = `to ${Address(network).encode(OutScript.decode(script))}`;
            } catch {
                destination = `to script ${hex.encode(script)}`;
            }
        }
        if (!stays) leaving += amount;
        return text(`#${i}: ${sats(amount)} ${destination}`);
    });
    return { lines, leaving };
}

/**
 * Sign a PSBT with the snap's Bitcoin key.
 *
 * Prompts the user for confirmation before signing, showing the requesting origin and every
 * output. Any dapp with RPC access can call this, so the prompt is the only thing standing between
 * a hostile page and a signature over the user's VTXOs.
 * @param params - `{ psbt, inputIndexes, network, operatorUrl? }`.
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
    const operator = await resolveOperator(params, origin);

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
    const { pubkey } = await readState();
    const own = pubkey ? defaultScript(hex.decode(pubkey), operator) : undefined;
    const { lines, leaving } = describeOutputs(tx, operator, own);

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
                text(
                    `Signing input ${validatedInputIndexes.join(", ")} of ${tx.inputsLength} on ${operator.network}.`,
                ),
                ...lines,
                divider(),
                text(`Leaving your wallet: **${sats(leaving)}**`),
                ...(own
                    ? []
                    : [
                          text(
                              "The snap does not know your address yet, so nothing is marked as change.",
                          ),
                      ]),
                text("Only approve this if you recognise the site and expect this transaction."),
            ]),
        },
    });

    if (approved !== true) {
        throw new Error("User rejected the signature request");
    }

    const identity = await snapIdentity();

    // Sign the transaction using SingleKey's sign method
    const signedTx = await identity.sign(tx, validatedInputIndexes);

    // Convert signed transaction back to PSBT
    const signedPsbt = signedTx.toPSBT();
    const signedPsbtBase64 = base64.encode(signedPsbt);

    return {
        psbt: signedPsbtBase64,
    };
}
