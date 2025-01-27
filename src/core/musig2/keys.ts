import { ProjectivePoint, CURVE } from "@noble/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { mod } from "@noble/curves/abstract/modular";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { concatBytes } from "@noble/hashes/utils";
import { nobleCrypto } from "./crypto";
import { MuSigFactory } from "@brandonblack/musig";

const KEY_AGG_LIST_TAG = "KeyAgg list";
const KEY_AGG_COEFF_TAG = "KeyAgg coefficient";

export class KeyAggError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KeyAggError";
    }
}

interface KeyAggOptions {
    taprootTweak?: Uint8Array;
}

export interface AggregateKey {
    preTweakedKey: Uint8Array; // 33-byte compressed point
    finalKey: Uint8Array; // 33-byte compressed point
}

/**
 * Computes the key aggregation coefficient (a) for a specific public key.
 * Returns 1 for the second unique key, otherwise computes the coefficient as:
 * H(tag=KeyAgg coefficient, keyHashFingerprint(pks) || pk)
 */
export function aggregationCoefficient(
    publicKeys: Uint8Array[],
    targetKey: Uint8Array,
    keysHash: Uint8Array,
    secondKeyIdx: number
): bigint {
    // If this is the second key, return 1
    if (
        secondKeyIdx !== -1 &&
        publicKeys[secondKeyIdx].every((b, i) => b === targetKey[i])
    ) {
        return 1n;
    }

    // Otherwise compute the coefficient hash
    const coefficientData = concatBytes(keysHash, targetKey);
    const muHash = schnorr.utils.taggedHash(KEY_AGG_COEFF_TAG, coefficientData);

    return mod(bytesToNumberBE(muHash), CURVE.n);
}

/**
 * Applies a tweak to a public key
 */
function tweakKey(
    key: ProjectivePoint,
    parityAcc: bigint,
    tweak: Uint8Array,
    tweakAcc: bigint,
    isXOnly: boolean
): {
    tweakedKey: ProjectivePoint;
    newParityAcc: bigint;
    newTweakAcc: bigint;
} {
    // Convert tweak to scalar
    const tweakScalar = mod(bytesToNumberBE(tweak), CURVE.n);

    // Multiply generator by tweak and add to key
    const tweakPoint = ProjectivePoint.BASE.multiply(tweakScalar);
    const tweakedKey = key.add(tweakPoint);

    // Update accumulators
    const newTweakAcc = mod(tweakAcc + tweakScalar, CURVE.n);

    // Handle parity for x-only tweaks
    let newParityAcc = parityAcc;
    if (isXOnly && tweakedKey.toAffine().y % 2n === 1n) {
        newParityAcc = mod(-parityAcc, CURVE.n);
    }

    return {
        tweakedKey,
        newParityAcc,
        newTweakAcc,
    };
}

/**
 * Checks if array of public keys is already sorted
 */
function isSorted(keys: Uint8Array[]): boolean {
    for (let i = 1; i < keys.length; i++) {
        const prev = keys[i - 1];
        const curr = keys[i];

        // Compare each byte
        for (let j = 0; j < prev.length; j++) {
            if (prev[j] < curr[j]) {
                break;
            }
            if (prev[j] > curr[j]) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Sorts public keys in lexicographical order based on their serialized bytes.
 * Returns a new array with sorted keys.
 */
export function sortKeys(keys: Uint8Array[]): Uint8Array[] {
    // Check if already sorted
    if (isSorted(keys)) {
        return keys;
    }

    return [...keys].sort((a, b) => {
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return a[i] - b[i];
            }
        }
        return 0;
    });
}

/**
 * Computes the tagged hash of the series of (sorted) public keys.
 * H(tag=KeyAgg list, pk1 || pk2..)
 */
export function keyHashFingerprint(
    publicKeys: Uint8Array[],
    doSort: boolean
): Uint8Array {
    // Sort keys if required
    const keys = doSort ? sortKeys(publicKeys) : publicKeys;

    // Pre-allocate buffer for all keys
    const totalLength = keys.length * 33; // Each key is 33 bytes
    const keyBuffer = new Uint8Array(totalLength);

    // Write all keys into buffer
    let offset = 0;
    for (const key of keys) {
        keyBuffer.set(key, offset);
        offset += key.length;
    }

    // Create tagged hash of concatenated keys
    return schnorr.utils.taggedHash(
        KEY_AGG_LIST_TAG,
        keyBuffer.slice(0, offset)
    );
}

/**
 * Finds the second unique key index in the sorted key set.
 * Returns -1 if all keys are equal.
 */
export function secondUniqueKeyIndex(
    publicKeys: Uint8Array[],
    doSort: boolean
): number {
    // Sort keys if required
    const keys = doSort ? sortKeys(publicKeys) : publicKeys;

    // Find first key that differs from the first key
    const firstKey = keys[0];
    for (let i = 0; i < keys.length; i++) {
        if (!keys[i].every((b, j) => b === firstKey[j])) {
            return i;
        }
    }

    // Return -1 if all keys are equal
    return -1;
}

/**
 * Aggregates multiple public keys according to the MuSig2 algorithm
 */
export function aggregateKeys(
    publicKeys: Uint8Array[],
    sort: boolean,
    options: Partial<KeyAggOptions> = {}
): AggregateKey {
    if (sort) {
        publicKeys = sortKeys(publicKeys);
    }

    const musig2 = MuSigFactory(nobleCrypto);
    const preTweakedKeyCtx = musig2.keyAgg(publicKeys);
    const preTweakedKey = preTweakedKeyCtx.aggPublicKey;
    const preTweakedKeyCompressed = nobleCrypto.pointCompress(
        preTweakedKey,
        true
    );
    const tweakBytes = schnorr.utils.taggedHash(
        "TapTweak",
        preTweakedKeyCompressed.subarray(1),
        options.taprootTweak ?? new Uint8Array(0)
    );
    const finalKeyCtx = musig2.addTweaks(preTweakedKeyCtx, {
        tweak: tweakBytes,
        xOnly: true,
    });
    const finalKey = finalKeyCtx.aggPublicKey;

    // convert to compressed format
    const finalKeyCompressed = nobleCrypto.pointCompress(finalKey, true);

    return {
        preTweakedKey: preTweakedKeyCompressed,
        finalKey: finalKeyCompressed,
    };
}
