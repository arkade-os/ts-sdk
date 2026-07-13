/**
 * Minimal Arkade-script primitives needed to reconstruct a VHTLC's
 * non-interactive claim leaf. This is a temporary copy of the helpers being
 * introduced by the "Arkade script support" PR (ts-sdk #319); delete this file
 * and import from `@arkade-os/sdk` once that PR is merged.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";

const TAG_SCRIPT = "ArkScriptHash";

/** BIP-340 tagged hash of an Arkade script: taggedHash("ArkScriptHash", script). */
export function arkadeScriptHash(script: Uint8Array): Uint8Array {
    return schnorr.utils.taggedHash(TAG_SCRIPT, script);
}

/**
 * Compute the Arkade-script tweaked public key:
 *   result = liftX(pubKey) + arkadeScriptHash(script) * G
 * NOT taproot tweaking — a plain EC point addition binding a script to a key.
 * Accepts a 32- or 33-byte pubKey, returns a 32-byte x-only key.
 */
export function computeArkadeScriptPublicKey(pubKey: Uint8Array, script: Uint8Array): Uint8Array {
    const hash = arkadeScriptHash(script);
    const xOnly = pubKey.length === 33 ? pubKey.subarray(1) : pubKey;
    const point = schnorr.utils.lift_x(bytesToNumberBE(xOnly));
    const scalar = bytesToNumberBE(hash) % secp256k1.Point.CURVE().n;
    const tweak = secp256k1.Point.BASE.multiply(scalar);
    return schnorr.utils.pointToBytes(point.add(tweak));
}

/**
 * Arkade `EnforcePayTo` script: pins output[currentInputIndex] to a P2TR paying
 * `receiverTapKey` with value >= the input's value. Matches go-sdk vhtlc's
 * enforcePayTo (the emulator's introspection covenant).
 */
export function enforcePayTo(receiverTapKey: Uint8Array): Uint8Array {
    if (receiverTapKey.length !== 32)
        throw new Error(`enforcePayTo: expected 32-byte tap key, got ${receiverTapKey.length}`);
    return new Uint8Array([
        0xcd, // OP_PUSHCURRENTINPUTINDEX
        0x76, // OP_DUP
        0xd1, // OP_INSPECTOUTPUTSCRIPTPUBKEY
        0x51, // OP_1 (taproot version)
        0x88, // OP_EQUALVERIFY
        0x20, // push 32 bytes
        ...receiverTapKey,
        0x88, // OP_EQUALVERIFY
        0xcf, // OP_INSPECTOUTPUTVALUE
        0xcd, // OP_PUSHCURRENTINPUTINDEX
        0xc9, // OP_INSPECTINPUTVALUE
        0xa2, // OP_GREATERTHANOREQUAL
    ]);
}
