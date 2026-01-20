import { hex } from "@scure/base";
import { TapLeafScript } from "../../script/base";
import { ExtendedCoin, ExtendedVirtualCoin } from "../../wallet";
import { TaprootControlBlock } from "@scure/btc-signer";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    DB_VERSION,
    STORE_CONTRACTS,
    STORE_CONTRACT_COLLECTIONS,
    STORE_TRANSACTIONS,
    STORE_UTXOS,
    STORE_VTXOS,
    STORE_WALLET_STATE,
    initDatabase,
} from "./schema";

function getGlobalObject(): {
    globalObject: typeof globalThis;
} {
    if (typeof globalThis !== "undefined") {
        if (typeof globalThis.self === "object" && globalThis.self !== null) {
            return { globalObject: globalThis.self };
        }
        if (
            typeof globalThis.window === "object" &&
            globalThis.window !== null
        ) {
            return { globalObject: globalThis.window };
        }
        return { globalObject: globalThis };
    }
    throw new Error("Global object not found");
}

export {
    STORE_VTXOS,
    STORE_UTXOS,
    STORE_TRANSACTIONS,
    STORE_WALLET_STATE,
    STORE_CONTRACTS,
    STORE_CONTRACT_COLLECTIONS,
    DB_VERSION,
};

// Serialization helpers

export type SerializedVtxo = ReturnType<typeof serializeVtxo>;
export type SerializedUtxo = ReturnType<typeof serializeUtxo>;

export const serializeTapLeaf = ([cb, s]: TapLeafScript) => ({
    cb: hex.encode(TaprootControlBlock.encode(cb)),
    s: hex.encode(s),
});

export const serializeVtxo = (v: ExtendedVirtualCoin) => ({
    ...v,
    tapTree: hex.encode(v.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
    extraWitness: v.extraWitness?.map(hex.encode),
});

export const serializeUtxo = (u: ExtendedCoin) => ({
    ...u,
    tapTree: hex.encode(u.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
    extraWitness: u.extraWitness?.map(hex.encode),
});

export const deserializeTapLeaf = (t: {
    cb: string;
    s: string;
}): TapLeafScript => {
    const cb = TaprootControlBlock.decode(hex.decode(t.cb));
    const s = hex.decode(t.s);
    return [cb, s];
};

export const deserializeVtxo = (o: SerializedVtxo): ExtendedVirtualCoin => ({
    ...o,
    createdAt: new Date(o.createdAt),
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});

export const deserializeUtxo = (o: SerializedUtxo): ExtendedCoin => ({
    ...o,
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});

// database instance cache, avoiding multiple open requests
const dbCache = new Map<string, IDBDatabase>();
// track reference counts for each database to avoid closing it prematurely
const refCounts = new Map<string, number>();

/**
 * Opens an IndexedDB database and increments the reference count.
 */
export async function openDatabase(
    dbName: string = DEFAULT_DB_NAME
): Promise<IDBDatabase> {
    const { globalObject } = getGlobalObject();
    if (!globalObject.indexedDB) {
        throw new Error("IndexedDB is not available in this environment");
    }

    // Return cached instance if available
    const cached = dbCache.get(dbName);
    if (cached) {
        refCounts.set(dbName, (refCounts.get(dbName) ?? 0) + 1);
        return cached;
    }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalObject.indexedDB.open(dbName, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            dbCache.set(dbName, db);
            refCounts.set(dbName, 1);
            resolve(db);
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            initDatabase(db);
        };
    });

    return db;
}

/**
 * Decrements the reference count and closes the database when no references remain.
 * Returns true if the database was actually closed.
 */
export function closeDatabase(
    dbName: string = DEFAULT_DB_NAME,
    db?: IDBDatabase | null
): boolean {
    const cached = dbCache.get(dbName);
    if (!cached) return false;
    if (db && cached !== db) return false; // Not the cached instance

    const count = (refCounts.get(dbName) ?? 1) - 1;
    if (count > 0) {
        refCounts.set(dbName, count);
        return false;
    }

    // Last reference — actually close
    refCounts.delete(dbName);
    dbCache.delete(dbName);
    cached.close();
    return true;
}
