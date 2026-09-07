/**
 * Realm object schemas for the asset-swap repository.
 *
 * The names land in the **consuming application's** schema namespace, next to
 * its own models and the SDK's `Ark*` / the Boltz plugin's `Boltz*`, so they
 * are prefixed with `ArkadeAssetSwap`. Unlike the SQLite backend there is no
 * prefix option: a Realm schema name is baked into the schema objects the
 * consumer registers and into every `realm.objects(…)` call here.
 *
 * Since `realm` is not a dependency of this package, schemas are plain JS
 * objects conforming to Realm's ObjectSchema shape. They are new, so a consumer
 * adds them to its Realm config and bumps its own `schemaVersion`; no migration
 * helper ships here.
 *
 * `ArkadeRfqSwap` arrived after the first three. A consumer already shipping
 * those has to add it and bump `schemaVersion` again — Realm creates schemas on
 * open, so a config that lists three while the code reads four fails on the
 * fourth `realm.objects(…)` rather than at open.
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

export const AssetSwapRealmSchemas = [
    ArkadeRfqSwapSchema,
    ArkadeAssetSwapSchema,
    ArkadeAssetSwapScannedTxidSchema,
    ArkadeAssetSwapMarketsCacheSchema,
];
