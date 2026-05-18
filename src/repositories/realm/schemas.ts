/**
 * Realm object schemas for the Arkade wallet.
 *
 * All schema names are prefixed with "Ark" to avoid collisions with
 * other Realm schemas in the consuming application.
 *
 * Since `realm` is a peer dependency (not installed in this package),
 * schemas are defined as plain JS objects conforming to Realm's
 * ObjectSchema shape.
 */

import { scriptFromArkAddress } from "../scriptFromAddress";

export const ArkVtxoSchema = {
    name: "ArkVtxo",
    primaryKey: "pk",
    properties: {
        pk: "string", // composite: `${txid}:${vout}`
        address: { type: "string", indexed: true },
        txid: "string",
        vout: "int",
        value: "int",
        tapTree: "string", // hex-encoded
        forfeitCb: "string",
        forfeitS: "string",
        intentCb: "string",
        intentS: "string",
        extraWitnessJson: "string?",
        statusJson: "string",
        virtualStatusJson: "string",
        spentBy: "string?",
        settledBy: "string?",
        arkTxId: "string?",
        createdAt: "string", // ISO 8601
        isUnrolled: "bool",
        isSpent: "bool?",
        assetsJson: "string?",
        // scriptPubKey (hex) locking this VTXO, indexed so contract-scoped
        // queries can resolve ownership without touching address mapping.
        // Required as of schema v2; legacy rows are backfilled from `address`
        // during migration (see `runArkRealmMigrations`).
        script: { type: "string", indexed: true },
    },
} as const;

export const ArkUtxoSchema = {
    name: "ArkUtxo",
    primaryKey: "pk",
    properties: {
        pk: "string", // composite: `${txid}:${vout}`
        address: { type: "string", indexed: true },
        txid: "string",
        vout: "int",
        value: "int",
        tapTree: "string", // hex-encoded
        forfeitCb: "string",
        forfeitS: "string",
        intentCb: "string",
        intentS: "string",
        extraWitnessJson: "string?",
        statusJson: "string",
    },
} as const;

export const ArkTransactionSchema = {
    name: "ArkTransaction",
    primaryKey: "pk",
    properties: {
        pk: "string", // composite: `${address}:${boardingTxid}:${commitmentTxid}:${arkTxid}`
        address: { type: "string", indexed: true },
        boardingTxid: "string",
        commitmentTxid: "string",
        arkTxid: "string",
        type: "string",
        amount: "int",
        settled: "bool",
        createdAt: "int",
        assetsJson: "string?",
    },
} as const;

export const ArkWalletStateSchema = {
    name: "ArkWalletState",
    primaryKey: "key",
    properties: {
        key: "string",
        lastSyncTime: "int?",
        settingsJson: "string?",
    },
} as const;

export const ArkContractSchema = {
    name: "ArkContract",
    primaryKey: "script",
    properties: {
        script: "string",
        address: "string",
        type: { type: "string", indexed: true },
        state: { type: "string", indexed: true },
        paramsJson: "string",
        createdAt: "int",
        expiresAt: "int?",
        label: "string?",
        metadataJson: "string?",
    },
} as const;

export const ArkIntentSchema = {
    name: "ArkIntent",
    primaryKey: "intentTxId",
    properties: {
        intentTxId: "string",
        intentId: "string?",
        state: { type: "string", indexed: true },
        validFrom: "int?",
        validUntil: "int?",
        createdAt: "int",
        updatedAt: "int",
        registerProof: "string",
        registerProofMessage: "string",
        deleteProof: "string",
        deleteProofMessage: "string",
        batchId: "string?",
        commitmentTransactionId: "string?",
        cancellationReason: "string?",
        partialForfeitsJson: "string",
        signerDescriptor: "string?",
        intentVtxosJson: "string",
    },
} as const;

export const ArkVirtualTxSchema = {
    name: "ArkVirtualTx",
    primaryKey: "txid",
    properties: {
        txid: "string",
        hex: "string?",
        expiresAt: "int?",
        type: "int",
    },
} as const;

export const ArkVtxoBranchSchema = {
    name: "ArkVtxoBranch",
    primaryKey: "pk",
    properties: {
        pk: "string", // `${vtxoTxid}:${vtxoVout}:${position}`
        vtxoKey: { type: "string", indexed: true }, // `${vtxoTxid}:${vtxoVout}`
        vtxoTxid: "string",
        vtxoVout: "int",
        virtualTxid: { type: "string", indexed: true },
        position: "int",
    },
} as const;

/**
 * All Realm schemas needed by the Arkade wallet repositories.
 * Pass this array to your Realm configuration's `schema` property.
 */
export const ArkRealmSchemas = [
    ArkVtxoSchema,
    ArkUtxoSchema,
    ArkTransactionSchema,
    ArkWalletStateSchema,
    ArkContractSchema,
    ArkIntentSchema,
    ArkVirtualTxSchema,
    ArkVtxoBranchSchema,
];

/**
 * Current Realm schema version for the Arkade wallet.
 *
 * Consumers opening Realm must pass a `schemaVersion` at least this high so
 * legacy databases get migrated; merge it with your own app's version:
 *
 * ```ts
 * await Realm.open({
 *     schema: [...ArkRealmSchemas, ...yourSchemas],
 *     schemaVersion: Math.max(ARK_REALM_SCHEMA_VERSION, yourSchemaVersion),
 *     onMigration: (oldRealm, newRealm) => {
 *         runArkRealmMigrations(oldRealm, newRealm);
 *         // your own migrations
 *     },
 * });
 * ```
 *
 * History:
 *   - v1: initial ArkVtxo/ArkUtxo/... schemas, `script` nullable.
 *   - v2: ArkVtxo.script becomes required; NULL values are backfilled from
 *     the owning Ark address during migration.
 *   - v3: add ArkIntent / ArkVirtualTx / ArkVtxoBranch schemas (new; no
 *     backfill — runArkRealmMigrations is unchanged).
 */
export const ARK_REALM_SCHEMA_VERSION = 3;

/**
 * Run every Arkade schema migration applicable to the open Realm.
 *
 * Designed to be composed with the consumer's own migrations inside a single
 * `onMigration` callback. Each migration step does a per-row check so it
 * remains idempotent and independent of the app's global `schemaVersion` —
 * a consumer whose app is already at version 10 can still trigger the
 * Arkade v1→v2 script backfill when the row has never been populated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runArkRealmMigrations(oldRealm: any, newRealm: any): void {
    const newVtxos = newRealm.objects("ArkVtxo");
    for (let i = 0; i < newVtxos.length; i++) {
        const newVtxo = newVtxos[i];
        if (!newVtxo.script) {
            newVtxo.script = scriptFromArkAddress(newVtxo.address);
        }
    }
}
