import {
    DB_VERSION,
    STORE_CONTRACTS,
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
    DB_VERSION,
};

// Serialization helpers (re-exported from shared module)
export {
    serializeTapLeaf,
    serializeVtxo,
    serializeUtxo,
    deserializeTapLeaf,
    deserializeVtxo,
    deserializeUtxo,
} from "../serialization";

export type { SerializedTapLeaf, SerializedVtxo, SerializedUtxo } from "../serialization";
