/**
 * Arkade VTXO Script
 *
 * Extends VtxoScript to support Arkade-enhanced tapscript leaves.
 * Arkade leaves have their pubkey set tweaked by the introspector's
 * script-bound key before being encoded into the taproot tree.
 *
 * @module arkade/vtxoScript
 */

import { Bytes } from "@scure/btc-signer/utils.js";
import {
    TapscriptType,
    MultisigTapscript,
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CLTVMultisigTapscript,
    type ArkTapscript,
} from "../script/tapscript";
import { VtxoScript } from "../script/base";
import { computeArkadeScriptPublicKey } from "./tweak";

export type ArkadeLeaf = {
    arkadeScript: Uint8Array;
    tapscript: ArkTapscript<TapscriptType, any>;
};

export type ArkadeVtxoInput = ArkadeLeaf | Uint8Array;

function isArkadeLeaf(input: ArkadeVtxoInput): input is ArkadeLeaf {
    return (
        typeof input === "object" &&
        !(input instanceof Uint8Array) &&
        "arkadeScript" in input &&
        "tapscript" in input
    );
}

function reEncodeTapscript(
    tapscript: ArkTapscript<TapscriptType, any>
): Uint8Array {
    switch (tapscript.type) {
        case TapscriptType.Multisig:
            return MultisigTapscript.encode(tapscript.params).script;
        case TapscriptType.CSVMultisig:
            return CSVMultisigTapscript.encode(tapscript.params).script;
        case TapscriptType.ConditionCSVMultisig:
            return ConditionCSVMultisigTapscript.encode(tapscript.params)
                .script;
        case TapscriptType.ConditionMultisig:
            return ConditionMultisigTapscript.encode(tapscript.params).script;
        case TapscriptType.CLTVMultisig:
            return CLTVMultisigTapscript.encode(tapscript.params).script;
        default:
            throw new Error(
                `Unsupported tapscript type: ${(tapscript as any).type}`
            );
    }
}

function processScripts(
    scripts: ArkadeVtxoInput[],
    introspectorPubkey: Uint8Array
): { processedScripts: Bytes[]; arkadeMap: Map<number, Uint8Array> } {
    const processedScripts: Bytes[] = [];
    const arkadeMap = new Map<number, Uint8Array>();

    for (const input of scripts) {
        if (isArkadeLeaf(input)) {
            const tweakedKey = computeArkadeScriptPublicKey(
                introspectorPubkey,
                input.arkadeScript
            );
            const params = {
                ...input.tapscript.params,
                pubkeys: [...input.tapscript.params.pubkeys, tweakedKey],
            };
            const modified = { ...input.tapscript, params };
            const leafIndex = processedScripts.length;
            processedScripts.push(reEncodeTapscript(modified));
            arkadeMap.set(leafIndex, input.arkadeScript);
        } else {
            processedScripts.push(input);
        }
    }

    return { processedScripts, arkadeMap };
}

/**
 * VtxoScript subclass that supports Arkade-enhanced tapscript leaves.
 *
 * For each {@link ArkadeLeaf} in the constructor input, the introspector's
 * public key is tweaked with the arkade script hash and appended to the
 * leaf's pubkey set before encoding into the taproot tree.
 * Plain `Uint8Array` leaves are passed through unchanged.
 *
 * The resulting `arkadeScripts` map records which leaf indices carry an
 * arkade script, so callers can set the corresponding PSBT field when
 * signing.
 *
 * @example
 * ```typescript
 * import { ArkadeVtxoScript, ArkadeScript, computeArkadeScriptPublicKey } from "@anthropic/ts-sdk/arkade";
 *
 * // Build an arkade script that checks output 0 goes to a specific address
 * const arkadeScriptBytes = ArkadeScript.encode([
 *     0, "INSPECTOUTPUTSCRIPTPUBKEY",
 *     1, "EQUALVERIFY",
 *     witnessProgram, "EQUAL",
 * ]);
 *
 * // Create a VtxoScript with one arkade-enhanced multisig leaf and one CSV exit leaf
 * const vtxoScript = new ArkadeVtxoScript(
 *     [
 *         {
 *             arkadeScript: arkadeScriptBytes,
 *             tapscript: MultisigTapscript.encode({
 *                 pubkeys: [bobPubkey, serverPubkey],
 *             }),
 *         },
 *         CSVMultisigTapscript.encode({
 *             timelock: { type: "blocks", value: 5120n },
 *             pubkeys: [bobPubkey, serverPubkey],
 *         }).script,
 *     ],
 *     { introspectorPubkey }
 * );
 *
 * // Derive the contract address
 * const address = vtxoScript.address(network.hrp, serverXOnlyPubkey).encode();
 *
 * // Find the arkade leaf for signing
 * const leaf = vtxoScript.findLeaf(hex.encode(multisigScript));
 * ```
 */
export class ArkadeVtxoScript extends VtxoScript {
    readonly arkadeScripts: ReadonlyMap<number, Uint8Array>;

    constructor(
        scripts: ArkadeVtxoInput[],
        opts: { introspectorPubkey: Uint8Array }
    ) {
        const { processedScripts, arkadeMap } = processScripts(
            scripts,
            opts.introspectorPubkey
        );
        super(processedScripts);
        this.arkadeScripts = arkadeMap;
    }
}
