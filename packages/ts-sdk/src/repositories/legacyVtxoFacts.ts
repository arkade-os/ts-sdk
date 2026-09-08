import { EXPIRY_MIN_PLAUSIBLE_MS } from "../wallet/vtxo";

/**
 * The legacy `virtualStatus` projection, as databases written before the canonical VTXO columns
 * persisted it.
 *
 * A storage-format concern, not a domain one: nothing outside a migration meets this shape any
 * more, so it lives with the repositories rather than in `wallet/vtxo.ts`.
 */
export type LegacyVirtualStatus = {
    state?: "preconfirmed" | "settled" | "swept" | "spent";
    commitmentTxIds?: string[];
    batchExpiry?: number;
};

/** Canonical facts recovered from a legacy row. */
export type LegacyVtxoFacts = {
    isSpent: boolean;
    isSwept: boolean;
    isPreconfirmed: boolean;
    commitmentTxIds?: string[];
    expiresAt?: Date;
    expiresAtHeight?: number;
};

/** Legacy `batchExpiry` -> canonical, inverting the old `toBatchExpiry` on its domain. */
function parseLegacyExpiry(batchExpiry: unknown): {
    expiresAt?: Date;
    expiresAtHeight?: number;
} {
    // `<= 0` would otherwise yield `expiresAtHeight: 0`, which every chain tip is past — a coin
    // with no expiry would read as permanently expired.
    if (typeof batchExpiry !== "number" || !Number.isFinite(batchExpiry) || batchExpiry <= 0) {
        return {};
    }
    if (batchExpiry >= EXPIRY_MIN_PLAUSIBLE_MS) return { expiresAt: new Date(batchExpiry) };
    // The old projection multiplied a block height by 1000; undo that.
    return { expiresAtHeight: batchExpiry / 1000 };
}

/**
 * Recover canonical VTXO facts from a legacy `virtualStatus` blob, or `undefined` when the row
 * carries none.
 *
 * `normalizeVtxo` used to derive these on every read. Now that they are stored in their own
 * columns, only the storage migrations still meet the old shape — and without this a swept row
 * upgraded from an older database comes back `isSwept: false`, so it lands in the spendable
 * balance and is fed to coin selection until the first indexer sync corrects it.
 *
 * `state` collapses independent facts with precedence `spent > swept > preconfirmed > settled`, so
 * a `spent` row cannot say whether it was *also* swept. Reading those as `false` is what the old
 * derivation did, and costs nothing: a spent coin already fails every spendability check.
 *
 * Never throws: a migration must not be stopped by one corrupt row.
 */
export function legacyVtxoFacts(status: unknown): LegacyVtxoFacts | undefined {
    let blob = status;
    if (typeof blob === "string") {
        try {
            blob = JSON.parse(blob);
        } catch {
            return undefined;
        }
    }
    if (typeof blob !== "object" || blob === null) return undefined;

    const { state, commitmentTxIds, batchExpiry } = blob as LegacyVirtualStatus;
    if (state === undefined && commitmentTxIds === undefined && batchExpiry === undefined) {
        return undefined;
    }

    return {
        isSpent: state === "spent",
        isSwept: state === "swept",
        isPreconfirmed: state === "preconfirmed",
        commitmentTxIds: Array.isArray(commitmentTxIds) ? commitmentTxIds : undefined,
        ...parseLegacyExpiry(batchExpiry),
    };
}
