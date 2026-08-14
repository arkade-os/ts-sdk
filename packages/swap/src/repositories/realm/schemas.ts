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

export const AssetSwapRealmSchemas = [
    ArkadeAssetSwapSchema,
    ArkadeAssetSwapScannedTxidSchema,
    ArkadeAssetSwapMarketsCacheSchema,
];
