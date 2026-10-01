import * as musig from "@scure/btc-signer/musig2.js";
import { hex } from "@scure/base";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { Point } from "@noble/secp256k1";
import { aggregateKeys } from "./keys";
import { schnorr } from "@noble/curves/secp256k1.js";

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
        public R: Uint8Array,
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
        if (s >= Point.CURVE().n) {
            throw new PartialSignatureError("s value overflows curve order");
        }

        // For decode we don't have R, so we'll need to compute it later
        const R = new Uint8Array(33); // Zero R for now

        return new PartialSig(bytes, R);
    }
}

function createSession(
    combinedNonce: Uint8Array,
    publicKeys: Uint8Array[],
    message: Uint8Array,
    options?: SignOptions,
): musig.Session {
    // sortKeys sorts in place; copy so the caller's key order (and anything
    // aligned with it, such as per-signer nonces) survives.
    const keys = options?.sortKeys ? musig.sortKeys([...publicKeys]) : publicKeys;

    let tweakBytes: Uint8Array | undefined;

    if (options?.taprootTweak !== undefined) {
        // `keys` is already in the session's final order; the tweak must
        // commit to that same order, so don't re-sort here.
        const { preTweakedKey } = aggregateKeys(keys, false);

        tweakBytes = schnorr.utils.taggedHash(
            "TapTweak",
            preTweakedKey.subarray(1),
            options.taprootTweak,
        );
    }

    return new musig.Session(
        combinedNonce,
        keys,
        message,
        tweakBytes ? [tweakBytes] : undefined,
        tweakBytes ? [true] : undefined,
    );
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
    options?: SignOptions,
): PartialSig {
    const session = createSession(combinedNonce, publicKeys, message, options);
    const partialSig = session.sign(secNonce, privateKey);
    return PartialSig.decode(partialSig);
}

/**
 * Verifies a single signer's MuSig2 partial signature.
 *
 * @param partialSig - The share to verify
 * @param signerPublicKey - Public key of the signer that produced it
 * @param pubNonces - Public nonce of every signer, parallel to `publicKeys`
 * @param combinedNonce - The aggregated nonce the share was produced under
 * @param publicKeys - Public keys of every signer
 * @param message - The signed message
 * @param options - Must match the options the share was produced with
 * @throws PartialSignatureError if the inputs do not describe a coherent session
 */
export function partialSigVerify(
    partialSig: PartialSig,
    signerPublicKey: Uint8Array,
    pubNonces: Uint8Array[],
    combinedNonce: Uint8Array,
    publicKeys: Uint8Array[],
    message: Uint8Array,
    options?: SignOptions,
): boolean {
    if (pubNonces.length !== publicKeys.length) {
        throw new PartialSignatureError("pubNonces and publicKeys must have the same length");
    }

    // The signer index addresses both arrays, so nonces must follow the key
    // order the session uses — sort the pairs together rather than the keys alone.
    const signers = publicKeys.map((publicKey, i) => ({
        publicKey,
        publicKeyHex: hex.encode(publicKey),
        pubNonce: pubNonces[i],
    }));

    if (options?.sortKeys) {
        signers.sort((a, b) =>
            a.publicKeyHex < b.publicKeyHex ? -1 : a.publicKeyHex > b.publicKeyHex ? 1 : 0,
        );
    }

    const signerIndex = signers.findIndex((s) => s.publicKeyHex === hex.encode(signerPublicKey));
    if (signerIndex === -1) {
        throw new PartialSignatureError("signer public key is not part of the session");
    }

    const session = createSession(
        combinedNonce,
        signers.map((s) => s.publicKey),
        message,
        { ...options, sortKeys: false },
    );

    return session.partialSigVerify(
        partialSig.encode(),
        signers.map((s) => s.pubNonce),
        signerIndex,
    );
}
