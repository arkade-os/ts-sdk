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

// Accept legacy persisted shapes where `amount` is a `number` — pre-bigint
// data already on disk must keep round-tripping.
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

// Normalized on the way out so rows written before canonical facts existed — and rows from the
// column-mapped backends, whose explicit column lists don't carry them — come back with the facts
// reconstructed from the legacy blob. `expiresAt` gets the same treatment `createdAt` has always
// needed: rehydrated to a real Date rather than the ISO string JSON left behind.
//
// This is convenience and durability, not the correctness boundary: repository *reads* are
// normalized at `getVtxosForContract`, which also covers InMemory (stores by reference, never
// deserializes) and consumer-implemented repositories that never touch this code.
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
