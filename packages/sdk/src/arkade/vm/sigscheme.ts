import { p256 } from "@noble/curves/nist.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { liftX } from "./ec";
import { KIND, plainError, scriptError } from "./errors";

/** Verifies a 64-byte r||s over msg, used raw: never hashed for the caller. */
export type SchemeVerifier = (msg: Uint8Array, sig: Uint8Array) => boolean;

const ECDSA_SCHEMES = new Map([
    [0x10, { name: "secp256k1", curve: secp256k1 }],
    [0x11, { name: "secp256r1", curve: p256 }],
]);

export function parseSchemePubKey(pk: Uint8Array): SchemeVerifier {
    if (pk.length === 0) throw scriptError("ErrTaprootPubkeyIsEmpty", "");
    if (pk.length === 32) return parseSchnorrKey(pk);
    const scheme = ECDSA_SCHEMES.get(pk[0]);
    const key = pk.subarray(1);
    if (!scheme || key.length !== 33) {
        throw scriptError("ErrDiscourageUpgradeablePubKeyType", "unsupported pubkey scheme");
    }
    const { curve } = scheme;
    try {
        curve.Point.fromBytes(key);
    } catch {
        throw scriptError("ErrInvalidStackOperation", `invalid ${scheme.name} ecdsa pubkey`);
    }
    const { n } = curve.Point.CURVE();
    return (msg, sig) => {
        // noble throws on other lengths; Go just fails the verification
        if (msg.length !== 32 || sig.length !== 64) return false;
        const r = bytesToNumberBE(sig.subarray(0, 32));
        const s = bytesToNumberBE(sig.subarray(32));
        if (r === 0n || r >= n || s === 0n || s >= n || s > n >> 1n) return false;
        return curve.verify(sig, msg, key, { prehash: false, lowS: false });
    };
}

// schnorr.ParsePubKey's failures carry no txscript code, only a secp256k1 ErrorKind
function parseSchnorrKey(pk: Uint8Array): SchemeVerifier {
    const { p, n } = secp256k1.Point.CURVE();
    if (bytesToNumberBE(pk) >= p) {
        throw plainError(KIND.pubKeyXTooBig, "invalid public key: x >= field prime");
    }
    if (!liftX(pk)) {
        throw plainError(
            KIND.pubKeyNotOnCurve,
            "invalid public key: x coordinate is not on the secp256k1 curve",
        );
    }
    return (msg, sig) => {
        // btcec takes only 32-byte messages, where noble takes any length
        if (msg.length !== 32 || sig.length !== 64) return false;
        // btcec's ParseSignature reduces s mod n rather than rejecting s >= n
        const s = numberToBytesBE(bytesToNumberBE(sig.subarray(32)) % n, 32);
        return schnorr.verify(concatBytes(sig.subarray(0, 32), s), msg, pk);
    };
}
