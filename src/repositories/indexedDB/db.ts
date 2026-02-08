import { hex } from "@scure/base";
import { TapLeafScript } from "../../script/base";
import { ExtendedCoin, ExtendedVirtualCoin } from "../../wallet";
import { TaprootControlBlock } from "@scure/btc-signer";
import {
    DB_VERSION,
    STORE_CONTRACTS,
    LEGACY_STORE_CONTRACT_COLLECTIONS,
    STORE_TRANSACTIONS,
    STORE_UTXOS,
    STORE_VTXOS,
    STORE_WALLET_STATE,
} from "./schema";

export {
    STORE_VTXOS,
    STORE_UTXOS,
    STORE_TRANSACTIONS,
    STORE_WALLET_STATE,
    STORE_CONTRACTS,
    LEGACY_STORE_CONTRACT_COLLECTIONS,
    DB_VERSION,
};

// Serialization helpers

export type SerializedVtxo = ReturnType<typeof serializeVtxo>;
export type SerializedUtxo = ReturnType<typeof serializeUtxo>;

export const serializeTapLeaf = ([cb, s]: TapLeafScript) => ({
    cb: hex.encode(TaprootControlBlock.encode(cb)),
    s: hex.encode(s),
});

export const serializeVtxo = (v: ExtendedVirtualCoin) => ({
    ...v,
    tapTree: hex.encode(v.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
    extraWitness: v.extraWitness?.map(hex.encode),
});

export const serializeUtxo = (u: ExtendedCoin) => ({
    ...u,
    tapTree: hex.encode(u.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
    extraWitness: u.extraWitness?.map(hex.encode),
});

export const deserializeTapLeaf = (t: {
    cb: string;
    s: string;
}): TapLeafScript => {
    const cb = TaprootControlBlock.decode(hex.decode(t.cb));
    const s = hex.decode(t.s);
    return [cb, s];
};

export const deserializeVtxo = (o: SerializedVtxo): ExtendedVirtualCoin => ({
    ...o,
    createdAt: new Date(o.createdAt),
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});

export const deserializeUtxo = (o: SerializedUtxo): ExtendedCoin => ({
    ...o,
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});
