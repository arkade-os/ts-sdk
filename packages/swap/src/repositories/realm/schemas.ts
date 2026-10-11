/**
 * Realm object schemas for the asset-swap repository.
 *
 * Prefixed `ArkadeAssetSwap` because the names land in the consuming app's schema namespace; unlike
 * SQLite there is no prefix option, since the name is baked into the schema objects and every
 * `realm.objects(…)` call. Plain objects in Realm's ObjectSchema shape (`realm` is not a dependency);
 * no migration helper ships, so consumers bump their own `schemaVersion` when schemas are added.
 *
 * Realm creates schemas on open, so a config missing a newer schema (`ArkadeRfqSwap`,
 * `ArkadeSwapRecord`) fails on the first `realm.objects(…)` for it, not at open. Register
 * {@link AssetSwapRealmSchemas} rather than listing names by hand.
 */

export const ArkadeAssetSwapSchema = {
    name: "ArkadeAssetSwap",
    primaryKey: "id",
    properties: {
        id: "string",
        status: "string",
        createdAt: "int",
        data: "string",
    },
};

export const ArkadeAssetSwapScannedTxidSchema = {
    name: "ArkadeAssetSwapScannedTxid",
    primaryKey: "txid",
    properties: {
        txid: "string",
    },
};

export const ArkadeAssetSwapMarketsCacheSchema = {
    name: "ArkadeAssetSwapMarketsCache",
    primaryKey: "key",
    properties: {
        key: "string",
        data: "string",
    },
};

/** Monitored RFQ swaps, keyed by `rfqId`. `state` and `updatedAt` are mapped out
 * for state and date-filtered history queries; the record
 * itself goes in whole, `profile` included. */
export const ArkadeRfqSwapSchema = {
    name: "ArkadeRfqSwap",
    primaryKey: "rfqId",
    properties: {
        rfqId: "string",
        state: "string",
        updatedAt: "int",
        data: "string",
    },
};

/** The v2 client's accept records, keyed by the client-minted quote id. `family` and `updatedAt` are
 * mapped out for querying; the record goes in whole so a nested corridor `profile` cannot be lost
 * the way a field-mapped schema could lose it. */
export const ArkadeSwapRecordSchema = {
    name: "ArkadeSwapRecord",
    primaryKey: "id",
    properties: {
        id: "string",
        family: "string",
        updatedAt: "int",
        data: "string",
    },
};

export const AssetSwapRealmSchemas = [
    ArkadeRfqSwapSchema,
    ArkadeSwapRecordSchema,
    ArkadeAssetSwapSchema,
    ArkadeAssetSwapScannedTxidSchema,
    ArkadeAssetSwapMarketsCacheSchema,
];
