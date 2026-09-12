/**
 * Realm object schemas for the asset-swap repository.
 *
 * The names land in the **consuming application's** schema namespace, next to
 * its own models and the SDK's `Ark*`, so they are prefixed with
 * `ArkadeAssetSwap`. Unlike the SQLite backend there is no
 * prefix option: a Realm schema name is baked into the schema objects the
 * consumer registers and into every `realm.objects(…)` call here.
 *
 * Since `realm` is not a dependency of this package, schemas are plain JS
 * objects conforming to Realm's ObjectSchema shape. They are new, so a consumer
 * adds them to its Realm config and bumps its own `schemaVersion`; no migration
 * helper ships here.
 *
 * `ArkadeRfqSwap` arrived after the first three, and `ArkadeSwapRecord` after
 * that. A consumer already shipping the earlier set has to add the new one and
 * bump `schemaVersion` again — Realm creates schemas on open, so a config that
 * lists four while the code reads five fails on the fifth `realm.objects(…)`
 * rather than at open. Export {@link AssetSwapRealmSchemas} into the config
 * rather than listing names by hand and the mismatch cannot happen.
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
 * for querying and for the retention sweep (`shouldRetainRfqSwap`); the record
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

/**
 * The v2 client's accept records, keyed by the client-minted quote id.
 *
 * `family` and `updatedAt` are mapped out for querying; the record itself goes
 * in whole, which is what keeps a nested corridor `profile` from being lost the
 * way a field-mapped schema could lose it.
 */
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
