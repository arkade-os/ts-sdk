/**
 * Realm object schemas for the Ark wallet.
 *
 * All schema names are prefixed with "Ark" to avoid collisions with
 * other Realm schemas in the consuming application.
 *
 * Since `realm` is a peer dependency (not installed in this package),
 * schemas are defined as plain JS objects conforming to Realm's
 * ObjectSchema shape.
 */

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

/**
 * All Realm schemas needed by the Ark wallet repositories.
 * Pass this array to your Realm configuration's `schema` property.
 */
export const ArkRealmSchemas = [
    ArkVtxoSchema,
    ArkUtxoSchema,
    ArkTransactionSchema,
    ArkWalletStateSchema,
    ArkContractSchema,
];
