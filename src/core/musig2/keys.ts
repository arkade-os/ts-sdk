import * as musig from "@scure/btc-signer/musig2";
import { schnorr } from "@noble/curves/secp256k1";

interface KeyAggOptions {
    taprootTweak?: Uint8Array;
}

export interface AggregateKey {
    preTweakedKey: Uint8Array; // 33-byte compressed point
    finalKey: Uint8Array; // 33-byte compressed point
}

// Aggregates multiple public keys according to the MuSig2 algorithm
export function aggregateKeys(
    publicKeys: Uint8Array[],
    sort: boolean,
    options: Partial<KeyAggOptions> = {}
): AggregateKey {
    if (sort) {
        publicKeys = musig.sortKeys(publicKeys);
    }

    const { aggPublicKey: preTweakedKey } = musig.keyAggregate(publicKeys);

    if (!options.taprootTweak) {
        return {
            preTweakedKey: preTweakedKey.toRawBytes(true),
            finalKey: preTweakedKey.toRawBytes(true),
        };
    }

    const tweakBytes = schnorr.utils.taggedHash(
        "TapTweak",
        preTweakedKey.toRawBytes(true).subarray(1),
        options.taprootTweak ?? new Uint8Array(0)
    );

    const { aggPublicKey: finalKey } = musig.keyAggregate(
        publicKeys,
        [tweakBytes],
        [true]
    );

    return {
        preTweakedKey: preTweakedKey.toRawBytes(true),
        finalKey: finalKey.toRawBytes(true),
    };
}
