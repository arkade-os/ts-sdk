// @deprecated Use `@arkade-os/sdk/adapters/sqlite` with an expo-sqlite SQLExecutor instead.
// This adapter routes through indexeddbshim which adds unnecessary overhead.
//
// Expo IndexedDB polyfill — requires expo-sqlite and indexeddbshim.
//
// Separated from ./expo so that consumers who only need the streaming
// providers (ExpoArkProvider, ExpoIndexerProvider) don't pull in a
// hard dependency on expo-sqlite at bundle time.
import setGlobalVars from "indexeddbshim";
import { openDatabase } from "../repositories/indexedDB/websqlAdapter";

export { openDatabase } from "../repositories/indexedDB/websqlAdapter";

export interface SetupExpoDbOptions {
    origin?: string;
    checkOrigin?: boolean;
    cacheDatabaseInstances?: boolean;
}

let _initialized = false;

/**
 * @deprecated Use `@arkade-os/sdk/adapters/sqlite` with an expo-sqlite SQLExecutor instead.
 * This adapter routes through indexeddbshim which adds unnecessary overhead.
 */
export function setupExpoDb(options?: SetupExpoDbOptions): void {
    if (_initialized) return;

    const {
        origin = "expo://localhost",
        checkOrigin = false,
        cacheDatabaseInstances = true,
    } = options ?? {};

    if (typeof (globalThis as any).window === "undefined") {
        (globalThis as any).window = globalThis;
    }
    if (typeof (globalThis as any).location === "undefined") {
        (globalThis as any).location = { origin };
    }
    (globalThis as any).openDatabase = openDatabase;

    setGlobalVars(globalThis as any, {
        checkOrigin,
        useSQLiteIndexes: true,
        cacheDatabaseInstances,
    });

    _initialized = true;
}
