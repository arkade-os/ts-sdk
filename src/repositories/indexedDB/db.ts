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

/**
 * Opens an IndexedDB database.
 */
export async function openDatabase(
    dbName: string = DEFAULT_DB_NAME
): Promise<IDBDatabase> {
    const { globalObject } = getGlobalObject();
    if (!globalObject.indexedDB) {
        throw new Error("IndexedDB is not available in this environment");
    }

    // Return cached instance if available
    if (dbCache.has(dbName)) {
        const cached = dbCache.get(dbName)!;
        if (!cached.version) {
            // Database was closed, remove from cache
            dbCache.delete(dbName);
        } else {
            return cached;
        }
    }

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalObject.indexedDB.open(dbName, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            dbCache.set(dbName, db);
            resolve(db);
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            initDatabase(db);
        };
    });

    return db;
}

export function closeDatabase(
    dbName: string = DEFAULT_DB_NAME,
    db?: IDBDatabase | null
): void {
    const cached = dbCache.get(dbName);
    if (!cached) return;
    if (!db || cached === db) {
        dbCache.delete(dbName);
    }
}
