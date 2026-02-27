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

// Serialization helpers (re-exported from shared module)
export {
    serializeTapLeaf,
    serializeVtxo,
    serializeUtxo,
    deserializeTapLeaf,
    deserializeVtxo,
    deserializeUtxo,
} from "../serialization";

export type {
    SerializedTapLeaf,
    SerializedVtxo,
    SerializedUtxo,
} from "../serialization";
