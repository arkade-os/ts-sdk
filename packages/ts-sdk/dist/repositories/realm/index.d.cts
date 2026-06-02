import { W as WalletRepository, E as ExtendedVirtualCoin, s as VtxoRepositoryKey, d as ExtendedCoin, A as ArkTransaction, t as WalletState, C as ContractRepository, u as ContractFilter, r as Contract } from '../../ark-BCdDnaIQ.cjs';
import '@scure/btc-signer/transaction.js';
import '@scure/btc-signer/utils.js';
import '@scure/btc-signer/psbt.js';
import '@scure/btc-signer';

/**
 * Minimal interface for the subset of the Realm API used by the
 * Arkade repositories. Consumers pass their real Realm instance and
 * the compiler validates it satisfies this shape.
 */
/** Result set returned by `realm.objects()`. */
interface RealmResults<T = Record<string, unknown>> extends Iterable<T> {
    filtered(query: string, ...args: unknown[]): RealmResults<T>;
    sorted(keypaths: string, reverse?: boolean): RealmResults<T>;
    readonly length: number;
}
/** The Realm API surface used by Arkade repositories. */
interface RealmLike {
    write(callback: () => void): void;
    objects<T = Record<string, unknown>>(schemaName: string): RealmResults<T>;
    create(schemaName: string, values: Record<string, any>, mode?: boolean | string): void;
    delete(objects: unknown): void;
}

/**
 * Realm-based implementation of WalletRepository.
 *
 * Consumers must open Realm with the schemas from `./schemas.ts` and pass
 * the instance to the constructor.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
declare class RealmWalletRepository implements WalletRepository {
    private readonly realm;
    readonly version: 1;
    constructor(realm: RealmLike);
    private ensureInit;
    [Symbol.asyncDispose](): Promise<void>;
    clear(): Promise<void>;
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxos(address: string): Promise<void>;
    getVtxosForScript(script: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxosForScript(script: string): Promise<void>;
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    deleteUtxos(address: string): Promise<void>;
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    deleteTransactions(address: string): Promise<void>;
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
}

/**
 * Realm-based implementation of ContractRepository.
 *
 * Consumers must open Realm with the schemas from `./schemas.ts` and pass
 * the instance to the constructor.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
declare class RealmContractRepository implements ContractRepository {
    private readonly realm;
    readonly version: 1;
    constructor(realm: RealmLike);
    private ensureInit;
    [Symbol.asyncDispose](): Promise<void>;
    clear(): Promise<void>;
    getContracts(filter?: ContractFilter): Promise<Contract[]>;
    saveContract(contract: Contract): Promise<void>;
    deleteContract(script: string): Promise<void>;
    private addFilterCondition;
}

/**
 * All Realm schemas needed by the Arkade wallet repositories.
 * Pass this array to your Realm configuration's `schema` property.
 */
declare const ArkRealmSchemas: ({
    readonly name: "ArkVtxo";
    readonly primaryKey: "pk";
    readonly properties: {
        readonly pk: "string";
        readonly address: {
            readonly type: "string";
            readonly indexed: true;
        };
        readonly txid: "string";
        readonly vout: "int";
        readonly value: "int";
        readonly tapTree: "string";
        readonly forfeitCb: "string";
        readonly forfeitS: "string";
        readonly intentCb: "string";
        readonly intentS: "string";
        readonly extraWitnessJson: "string?";
        readonly statusJson: "string";
        readonly virtualStatusJson: "string";
        readonly spentBy: "string?";
        readonly settledBy: "string?";
        readonly arkTxId: "string?";
        readonly createdAt: "string";
        readonly isUnrolled: "bool";
        readonly isSpent: "bool?";
        readonly assetsJson: "string?";
        readonly script: {
            readonly type: "string";
            readonly indexed: true;
        };
    };
} | {
    readonly name: "ArkUtxo";
    readonly primaryKey: "pk";
    readonly properties: {
        readonly pk: "string";
        readonly address: {
            readonly type: "string";
            readonly indexed: true;
        };
        readonly txid: "string";
        readonly vout: "int";
        readonly value: "int";
        readonly tapTree: "string";
        readonly forfeitCb: "string";
        readonly forfeitS: "string";
        readonly intentCb: "string";
        readonly intentS: "string";
        readonly extraWitnessJson: "string?";
        readonly statusJson: "string";
    };
} | {
    readonly name: "ArkTransaction";
    readonly primaryKey: "pk";
    readonly properties: {
        readonly pk: "string";
        readonly address: {
            readonly type: "string";
            readonly indexed: true;
        };
        readonly boardingTxid: "string";
        readonly commitmentTxid: "string";
        readonly arkTxid: "string";
        readonly type: "string";
        readonly amount: "int";
        readonly settled: "bool";
        readonly createdAt: "int";
        readonly assetsJson: "string?";
    };
} | {
    readonly name: "ArkWalletState";
    readonly primaryKey: "key";
    readonly properties: {
        readonly key: "string";
        readonly lastSyncTime: "int?";
        readonly settingsJson: "string?";
    };
} | {
    readonly name: "ArkContract";
    readonly primaryKey: "script";
    readonly properties: {
        readonly script: "string";
        readonly address: "string";
        readonly type: {
            readonly type: "string";
            readonly indexed: true;
        };
        readonly state: {
            readonly type: "string";
            readonly indexed: true;
        };
        readonly paramsJson: "string";
        readonly createdAt: "int";
        readonly expiresAt: "int?";
        readonly label: "string?";
        readonly metadataJson: "string?";
    };
})[];
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
 */
declare const ARK_REALM_SCHEMA_VERSION = 2;
/**
 * Run every Arkade schema migration applicable to the open Realm.
 *
 * Designed to be composed with the consumer's own migrations inside a single
 * `onMigration` callback. Each migration step does a per-row check so it
 * remains idempotent and independent of the app's global `schemaVersion` —
 * a consumer whose app is already at version 10 can still trigger the
 * Arkade v1→v2 script backfill when the row has never been populated.
 */
declare function runArkRealmMigrations(oldRealm: any, newRealm: any): void;

export { ARK_REALM_SCHEMA_VERSION, ArkRealmSchemas, RealmContractRepository, type RealmLike, type RealmResults, RealmWalletRepository, runArkRealmMigrations };
