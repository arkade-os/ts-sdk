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
import { legacyVtxoFacts } from "../legacyVtxoFacts";

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
        spentBy: "string?",
        settledBy: "string?",
        arkTxId: "string?",
        createdAt: "string", // ISO 8601
        isUnrolled: "bool",
        isSpent: "bool?",
        isSwept: "bool?",
        isPreconfirmed: "bool?",
        commitmentTxIdsJson: "string?",
        expiresAt: "string?", // ISO 8601
        expiresAtHeight: "int?",
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
        watch: { type: "string", optional: true, indexed: true },
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
        psbt: "string?",
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
];

/**
 * @experimental Schemas for the inert intent/virtualtx persistence layer.
 *
 * Deliberately kept OUT of {@link ArkRealmSchemas} and {@link
 * ARK_REALM_SCHEMA_VERSION} so upgrading the SDK never migrates an existing
 * consumer's Realm. A consumer opting in must register these schemas and bump
 * their own `schemaVersion` themselves:
 *
 * ```ts
 * schema: [...ArkRealmSchemas, ...ArkExperimentalRealmSchemas],
 * schemaVersion: Math.max(ARK_REALM_SCHEMA_VERSION + 1, yourSchemaVersion),
 * ```
 */
export const ArkExperimentalRealmSchemas = [
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
 *   - v3: ArkContract.watch added (nullable). No data migration: a row
 *     without one reads as `watched`, which is the coverage every
 *     existing contract has today.
 *   - v4: ArkVtxo.virtualStatusJson removed.
 *   - v5: ArkVtxo stores the canonical VTXO facts that blob used to project —
 *     `isSwept`, `isPreconfirmed`, `commitmentTxIdsJson`, `expiresAt`,
 *     `expiresAtHeight` — backfilled from it during migration.
 *
 * The intent/virtualtx schemas ({@link ArkExperimentalRealmSchemas}) are NOT
 * counted here: they are experimental and inert, so they never move the
 * advertised version on their own. `runArkRealmMigrations` still carries the
 * intent-schema migration steps (guarded per-schema) for consumers who opt in
 * and bump their own version.
 */
export const ARK_REALM_SCHEMA_VERSION = 5;

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
    // v4 → v5: the canonical facts used to live inside `virtualStatusJson`, which v4 drops. Realm
    // deletes a removed property from the new realm, so the old one is the only place left to read
    // it from — and without the copy a swept row comes back `isSwept: false`, spendable, until the
    // first indexer sync. Keyed by `pk` rather than by position: the two collections are parallel
    // in practice, but a mismatch here would write one row's state onto another's.
    const legacyByPk = new Map<string, unknown>();
    const oldVtxos = oldRealm?.objects?.("ArkVtxo") ?? [];
    for (let i = 0; i < oldVtxos.length; i++) {
        const raw = oldVtxos[i].virtualStatusJson;
        if (raw) legacyByPk.set(oldVtxos[i].pk, raw);
    }

    const newVtxos = newRealm.objects("ArkVtxo");
    for (let i = 0; i < newVtxos.length; i++) {
        const newVtxo = newVtxos[i];
        if (!newVtxo.script) {
            newVtxo.script = scriptFromArkAddress(newVtxo.address);
        }

        const facts = legacyVtxoFacts(legacyByPk.get(newVtxo.pk));
        // Only fill blanks: a row the new code has already written carries the authoritative value,
        // and the legacy projection is the lossier of the two.
        if (facts) {
            if (newVtxo.isSpent == null) newVtxo.isSpent = facts.isSpent;
            if (newVtxo.isSwept == null) newVtxo.isSwept = facts.isSwept;
            if (newVtxo.isPreconfirmed == null) newVtxo.isPreconfirmed = facts.isPreconfirmed;
            if (newVtxo.commitmentTxIdsJson == null && facts.commitmentTxIds) {
                newVtxo.commitmentTxIdsJson = JSON.stringify(facts.commitmentTxIds);
            }
            if (newVtxo.expiresAt == null && facts.expiresAt) {
                newVtxo.expiresAt = facts.expiresAt.toISOString();
            }
            if (newVtxo.expiresAtHeight == null && facts.expiresAtHeight !== undefined) {
                newVtxo.expiresAtHeight = facts.expiresAtHeight;
            }
        }
    }

    // ArkVirtualTx.hex was renamed to psbt (both hold the same serialized tx
    // payload). A rename is drop-old + add-new, so the value would be lost
    // unless we copy it across. The step is versioned by the consumer's own
    // counter, not by ARK_REALM_SCHEMA_VERSION: these schemas are opt-in and
    // never move it. Guard on the old schema actually defining ArkVirtualTx —
    // a realm that never opted in doesn't have it, and reading objects of an
    // unknown type throws.
    const oldHasVirtualTx =
        Array.isArray(oldRealm?.schema) &&
        oldRealm.schema.some((s: { name: string }) => s.name === "ArkVirtualTx");
    if (oldHasVirtualTx) {
        const oldTxs = oldRealm.objects("ArkVirtualTx");
        const newTxs = newRealm.objects("ArkVirtualTx");
        for (let i = 0; i < newTxs.length; i++) {
            if (newTxs[i].psbt == null && oldTxs[i].hex != null) {
                newTxs[i].psbt = oldTxs[i].hex;
            }
        }
    }
}
