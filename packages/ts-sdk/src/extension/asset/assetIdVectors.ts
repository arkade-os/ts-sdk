import raw from "./assetIdVectors.json";

/**
 * Cross-repo test vectors for the Arkade Asset ID encodings.
 *
 * @remarks
 * Shipped from `src/` rather than `test/` so consumers outside this package can
 * pin the same bytes: `lightning-swap-service` imports this value, while NArk
 * and go-sdk vendor the backing `assetIdVectors.json` from a pinned revision of
 * this repository.
 *
 * The encoding is implemented in seven places across three repos and every
 * disagreement between them fails silently — a flipped txid makes a covenant
 * unsatisfiable, a flipped group index resolves to a different asset, a case
 * mismatch is a routing miss. None of those name their cause, which is what
 * these vectors are for.
 *
 * @see plans/asset-id-shared-vectors.md
 */
export interface AssetIdVectors {
    readonly version: number;
    readonly note: string;
    /** Genesis txid in display order — the 32 bytes an id's leading 64 hex chars carry. */
    readonly txid_hex: string;
    /** `txid_hex` reversed: serialization order, what the introspection opcodes match. */
    readonly script_txid_hex: string;
    readonly valid: ReadonlyArray<{
        readonly label: string;
        readonly group_index: number;
        /** `txid_hex` with the group index appended little-endian. */
        readonly asset_id_hex: string;
        /**
         * The group index as a stack item, after script-number encoding and
         * before push framing. Not the raw u16: `65535` is `ffff00` here and
         * `ffff` on the wire, and `0` is the empty item.
         */
        readonly script_group_index_item_hex: string;
    }>;
    /** Refused by the identity rule (`^[0-9a-f]{68}$`), though not necessarily by the decoder. */
    readonly invalid_identity: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        readonly why: string;
        /** Present when the value still decodes: what `toString()` must return. */
        readonly normalizes_to?: string;
    }>;
    /** Refused by {@link AssetId.fromString} / `fromBytes`. */
    readonly invalid_decode: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        /** Substring of the thrown message — normative for TS, advisory for other SDKs. */
        readonly expected_error: string;
    }>;
    /** Refused by {@link AssetId.create} / `validate`. */
    readonly invalid_construction: ReadonlyArray<{
        readonly label: string;
        readonly txid_hex: string;
        readonly group_index: number;
        readonly expected_error: string;
        /** Set when the group index cannot be expressed by an SDK whose constructor takes a native u16. */
        readonly outside_uint16?: boolean;
    }>;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.getOwnPropertyNames(value)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
    }
    return value;
}

/**
 * The asset-id test vectors, deeply frozen.
 *
 * @remarks
 * Frozen all the way down, not just at the top: every value that matters lives
 * inside the nested arrays, and the module is a singleton — one consumer
 * mutating an entry would corrupt it for every other consumer in the process.
 *
 * @example
 * ```typescript
 * import { asset } from '@arkade-os/sdk'
 * const { txid_hex, valid } = asset.ASSET_ID_VECTORS
 * expect(AssetId.create(txid_hex, valid[0].group_index).toString()).toBe(valid[0].asset_id_hex)
 * ```
 */
export const ASSET_ID_VECTORS: AssetIdVectors = deepFreeze(raw as AssetIdVectors);
