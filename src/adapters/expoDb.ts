import setGlobalVars from "indexeddbshim";
import { openDatabase } from "../repositories/indexedDB/websqlAdapter";

export interface SetupExpoDbOptions {
    origin?: string;
    checkOrigin?: boolean;
    cacheDatabaseInstances?: boolean;
}

let _initialized = false;

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
