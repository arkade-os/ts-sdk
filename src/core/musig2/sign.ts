import * as musig from "@scure/btc-signer/musig2";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { CURVE } from "@noble/secp256k1";
import { aggregateKeys } from "./keys";
import { schnorr } from "@noble/curves/secp256k1";

// Add this error type for decode failures
export class PartialSignatureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PartialSignatureError";
    }
}

interface SignOptions {
    sortKeys?: boolean;
    taprootTweak?: Uint8Array;
}

// Implement a concrete class for PartialSignature
export class PartialSig {
    constructor(
        public s: Uint8Array,
        public R: Uint8Array
    ) {
        if (s.length !== 32) {
            throw new PartialSignatureError("Invalid s length");
        }
        if (R.length !== 33) {
            throw new PartialSignatureError("Invalid R length");
        }
    }

    /**
     * Encodes the partial signature into bytes
     * Returns a 32-byte array containing just the s value
     */
    encode(): Uint8Array {
        // Return copy of s bytes
        return new Uint8Array(this.s);
    }

    /**
     * Decodes a partial signature from bytes
     * @param bytes - 32-byte array containing s value
     */
    static decode(bytes: Uint8Array): PartialSig {
        if (bytes.length !== 32) {
            throw new PartialSignatureError("Invalid partial signature length");
        }

        // Verify s is less than curve order
        const s = bytesToNumberBE(bytes);
        if (s >= CURVE.n) {
            throw new PartialSignatureError("s value overflows curve order");
        }

        // For decode we don't have R, so we'll need to compute it later
        const R = new Uint8Array(33); // Zero R for now

        return new PartialSig(bytes, R);
    }
}

/**
 * Generates a MuSig2 partial signature
 */
export function sign(
    secNonce: Uint8Array,
    privateKey: Uint8Array,
    combinedNonce: Uint8Array,
    publicKeys: Uint8Array[],
    message: Uint8Array,
    options?: SignOptions
): PartialSig {
    let tweakBytes: Uint8Array | undefined;

    if (options?.taprootTweak !== undefined) {
        const { preTweakedKey } = aggregateKeys(
            options?.sortKeys ? musig.sortKeys(publicKeys) : publicKeys,
            true
        );

        tweakBytes = schnorr.utils.taggedHash(
            "TapTweak",
            preTweakedKey.subarray(1),
            options.taprootTweak
        );
    }

    const session = new musig.Session(
        combinedNonce,
        options?.sortKeys ? musig.sortKeys(publicKeys) : publicKeys,
        message,
        tweakBytes ? [tweakBytes] : undefined,
        tweakBytes ? [true] : undefined
    );
    const partialSig = session.sign(secNonce, privateKey);
    return PartialSig.decode(partialSig);
}
