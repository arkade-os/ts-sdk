import { ProjectivePoint, CURVE } from "@noble/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { concatBytes } from "@noble/hashes/utils";
import { mod } from "@noble/curves/abstract/modular";
import { PUB_NONCE_SIZE, SEC_NONCE_SIZE } from "./nonces";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import {
    aggregateKeys,
    aggregationCoefficient,
    keyHashFingerprint,
    secondUniqueKeyIndex,
} from "./keys";

const CHALLENGE_TAG = "BIP0340/challenge";
const NONCE_BLIND_TAG = "MuSig/noncecoef";

export class SignError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SignError";
    }
}

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
 * Computes the signing nonce from the combined public nonce.
 * Returns the final nonce point (R) and the blinding factor (b).
 */
function computeSigningNonce(
    combinedNonce: Uint8Array,
    combinedKey: Uint8Array,
    msg: Uint8Array
): { nonce: ProjectivePoint; nonceBlinder: bigint } {
    // Create blinding factor b = H(combinedNonce || combinedKey || msg)
    if (combinedKey.length === 33) {
        combinedKey = combinedKey.slice(1); // Convert to 32-byte x-only pubkey
    }

    // Compute b = H(combinedNonce || combinedKey || msg)
    const blindingData = concatBytes(combinedNonce, combinedKey, msg);
    const nonceBlindHash = schnorr.utils.taggedHash(
        NONCE_BLIND_TAG,
        blindingData
    );
    const nonceBlinder = mod(bytesToNumberBE(nonceBlindHash), CURVE.n);

    console.log("nonceBlinder (hex):", nonceBlinder.toString(16));

    // Parse R1 and R2 from combined nonce
    let R1: ProjectivePoint;
    try {
        R1 = ProjectivePoint.fromHex(combinedNonce.slice(0, 33));
    } catch (error) {
        throw new SignError("Invalid first public nonce (" + error + ")");
    }

    console.log("R1 (compressed):", R1.toHex(true));
    console.log("R1.x:", R1.x.toString(16));
    console.log("R1.y:", R1.y.toString(16));

    let R2: ProjectivePoint;
    try {
        R2 = ProjectivePoint.fromHex(combinedNonce.slice(33, 66));
    } catch (error) {
        throw new SignError("Invalid second public nonce (" + error + ")");
    }

    console.log("R2 (compressed):", R2.toHex(true));
    console.log("R2.x:", R2.x.toString(16));
    console.log("R2.y:", R2.y.toString(16));

    // Compute R = R1 + b*R2
    const blindedR2 = R2.multiply(nonceBlinder);

    console.log("blindedR2 (compressed):", blindedR2.toHex(true));
    console.log("blindedR2.x:", blindedR2.x.toString(16));
    console.log("blindedR2.y:", blindedR2.y.toString(16));

    const nonce = R1.add(blindedR2);

    console.log("final nonce (compressed):", nonce.toHex(true));
    console.log("nonce.x:", nonce.x.toString(16));
    console.log("nonce.y:", nonce.y.toString(16));

    // If the result is the point at infinity, use the generator point
    if (nonce.equals(ProjectivePoint.ZERO)) {
        return {
            nonce: ProjectivePoint.BASE,
            nonceBlinder,
        };
    }

    return { nonce, nonceBlinder };
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
    const { sortKeys, taprootTweak } = options || {};

    // Compute key fingerprint and unique key index
    const keysHash = keyHashFingerprint(publicKeys, sortKeys || false);
    const uniqueKeyIndex = secondUniqueKeyIndex(publicKeys, sortKeys || false);

    // Get our public key
    const pubKey = secp256k1.getPublicKey(privateKey);

    // Validate inputs
    if (secNonce.length !== SEC_NONCE_SIZE) {
        throw new SignError("Invalid secret nonce size");
    }
    if (combinedNonce.length !== PUB_NONCE_SIZE) {
        throw new SignError("Invalid combined nonce size");
    }
    if (privateKey.length !== 32) {
        throw new SignError("Invalid private key size");
    }

    // Verify secret nonce matches our public key
    if (!secNonce.slice(64).every((b, i) => b === pubKey[i])) {
        throw new SignError("Secret nonce does not match public key");
    }

    // Verify our public key is in the key set
    const hasKey = publicKeys.some((pk) => pk.every((b, i) => b === pubKey[i]));
    if (!hasKey) {
        throw new SignError("Public key not included in key set");
    }

    // Aggregate the public keys
    const aggregatedKey = aggregateKeys(publicKeys, sortKeys || false, {
        taprootTweak,
    });

    // Compute the signing nonce
    const { nonce, nonceBlinder } = computeSigningNonce(
        combinedNonce,
        aggregatedKey.finalKey,
        message
    );

    console.log("nonce.x", nonce.x);
    console.log("nonce.y", nonce.y);
    console.log("nonceBlinder", nonceBlinder);

    // Extract secret nonces
    const k1 = bytesToNumberBE(secNonce.slice(0, 32));
    const k2 = bytesToNumberBE(secNonce.slice(32, 64));

    if (k1 === 0n || k2 === 0n) {
        throw new SignError("Secret nonce cannot be zero");
    }

    // Get nonce point coordinates and check parity
    const noncePoint = nonce.toAffine();
    const adjustedK1 = noncePoint.y % 2n ? mod(-k1, CURVE.n) : k1;
    const adjustedK2 = noncePoint.y % 2n ? mod(-k2, CURVE.n) : k2;

    // Create challenge hash e = H(R || Q || m)
    const challengeData = concatBytes(
        nonce.toRawBytes(true),
        aggregatedKey.finalKey,
        message
    );
    const challenge = bytesToNumberBE(
        schnorr.utils.taggedHash(CHALLENGE_TAG, challengeData)
    );

    // Get aggregation coefficient for our key
    const a = aggregationCoefficient(
        publicKeys,
        pubKey,
        keysHash,
        uniqueKeyIndex
    );

    // Apply parity factors to private key
    const privKeyScalar = mod(
        bytesToNumberBE(privateKey) * aggregatedKey.parityAcc,
        CURVE.n
    );

    // Compute partial signature s = k1 + b*k2 + e*a*d mod n
    const s = mod(
        adjustedK1 + adjustedK2 * nonceBlinder + challenge * a * privKeyScalar,
        CURVE.n
    );

    return new PartialSig(
        schnorr.utils.numberToBytesBE(s, 32),
        nonce.toRawBytes(true)
    );
}
