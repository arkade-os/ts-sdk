import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { TapLeafScript } from "../script/base";
import { ArkTransaction, Asset, ExtendedCoin, ExtendedVirtualCoin } from "../wallet";
import { normalizeVtxo, type NormalizedExtendedVirtualCoin } from "../wallet/vtxo";

export type SerializedTapLeaf = { cb: string; s: string };
export type SerializedVtxo = ReturnType<typeof serializeVtxo>;
export type SerializedUtxo = ReturnType<typeof serializeUtxo>;
export type SerializedTransaction = ReturnType<typeof serializeTransaction>;

// `Asset.amount` is a `bigint`, which `JSON.stringify` cannot serialize
// (`TypeError: Do not know how to serialize a BigInt`). Persist it as a
// decimal string so SQLite/Realm/legacy localStorage paths round-trip
// correctly across process restarts.
export type SerializedAsset = { assetId: string; amount: string };

export const serializeTapLeaf = ([cb, s]: TapLeafScript): SerializedTapLeaf => ({
    cb: hex.encode(TaprootControlBlock.encode(cb)),
    s: hex.encode(s),
});

export const serializeAsset = (a: Asset): SerializedAsset => ({
    assetId: a.assetId,
    amount: a.amount.toString(),
});

// `number` is still accepted: amounts persisted before they became bigint are on disk as JSON
// numbers, and `BigInt()` would take a fractional one as a throw rather than a diagnosis. The
// guard turns silent precision loss into a message that says what to do about it.
export const deserializeAsset = (a: {
    assetId: string;
    amount: string | number | bigint;
}): Asset => {
    if (typeof a.amount === "number" && !Number.isSafeInteger(a.amount)) {
        throw new Error(
            `Unsafe legacy asset amount for ${a.assetId}; re-sync from the original source`,
        );
    }
    return {
        assetId: a.assetId,
        amount: typeof a.amount === "bigint" ? a.amount : BigInt(a.amount),
    };
};

export const serializeAssets = (assets: Asset[] | undefined): SerializedAsset[] | undefined =>
    assets?.map(serializeAsset);

export const deserializeAssets = (
    assets: Array<{ assetId: string; amount: string | number | bigint }> | undefined,
): Asset[] | undefined => assets?.map(deserializeAsset);

export const serializeVtxo = (v: ExtendedVirtualCoin) => ({
    ...v,
    tapTree: hex.encode(v.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
    extraWitness: v.extraWitness?.map(hex.encode),
    assets: serializeAssets(v.assets),
});

export const serializeUtxo = (u: ExtendedCoin) => ({
    ...u,
    tapTree: hex.encode(u.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
    extraWitness: u.extraWitness?.map(hex.encode),
});

export const serializeTransaction = (t: ArkTransaction) => ({
    ...t,
    assets: serializeAssets(t.assets),
});

export const deserializeTapLeaf = (t: SerializedTapLeaf): TapLeafScript => {
    const cb = TaprootControlBlock.decode(hex.decode(t.cb));
    const s = hex.decode(t.s);
    return [cb, s];
};

// Normalized on the way out so persisted Date fields are rehydrated and optional facts are present.
export const deserializeVtxo = (o: SerializedVtxo): NormalizedExtendedVirtualCoin =>
    normalizeVtxo({
        ...o,
        createdAt: new Date(o.createdAt),
        tapTree: hex.decode(o.tapTree),
        forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
        intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
        extraWitness: o.extraWitness?.map(hex.decode),
        assets: deserializeAssets(o.assets),
    });

export const deserializeUtxo = (o: SerializedUtxo): ExtendedCoin => ({
    ...o,
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});

export const deserializeTransaction = (o: SerializedTransaction): ArkTransaction => ({
    ...o,
    assets: deserializeAssets(o.assets),
});
