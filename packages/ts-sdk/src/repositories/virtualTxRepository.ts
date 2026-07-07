import { Outpoint } from "../wallet";

/**
 * Type of a tx inside a VTXO's chain (commitment → leaf), as reported by
 * arkd's chain indexer. Values pinned verbatim from NArk `ChainedTxType.cs`.
 */
export enum ChainedTxType {
    Unspecified = 0,
    Commitment = 1,
    Ark = 2,
    Tree = 3,
    Checkpoint = 4,
}

/** A single virtual transaction in the VTXO tree. */
export interface VirtualTx {
    /** Transaction id (hex). Primary key. */
    txid: string;
    /** Base64-encoded PSBT body; null when only metadata has been cached. */
    psbt: string | null;
    /** Operator pre-signature expiry, ms epoch; null if not applicable. */
    expiresAt: number | null;
    /** Tx type as reported by arkd's chain indexer. */
    type: ChainedTxType;
}

/**
 * Links a VTXO to one virtual tx in its exit branch, ordered.
 * `position` 0 = closest to commitment (tree root); higher = closer to leaf.
 */
export interface VtxoBranch {
    vtxoTxid: string;
    vtxoVout: number;
    virtualTxid: string;
    position: number;
}

export interface VirtualTxRepository extends AsyncDisposable {
    readonly version: 1;
    clear(): Promise<void>;
    /** Upsert: non-null incoming fields overwrite, null/absent fields are preserved. */
    upsertVirtualTxs(txs: VirtualTx[]): Promise<void>;
    getVirtualTx(txid: string): Promise<VirtualTx | null>;
    /** Replace the entire stored branch for a VTXO. */
    setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void>;
    /** Resolved virtual txs in the VTXO's branch, ordered by position asc. */
    getBranch(vtxo: Outpoint): Promise<VirtualTx[]>;
    hasBranch(vtxo: Outpoint): Promise<boolean>;
    /** Drop branch rows for a spent VTXO, then delete now-orphaned VirtualTx rows. */
    pruneForSpentVtxo(vtxo: Outpoint): Promise<void>;
}
