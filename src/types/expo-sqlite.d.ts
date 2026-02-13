/**
 * Minimal type stub for expo-sqlite.
 *
 * expo-sqlite is an optional peer dependency used only by the expo-db adapter.
 * This declaration lets the SDK compile without the actual package installed.
 * When expo-sqlite IS installed (e.g. in an Expo project), the runtime module
 * is still resolved from node_modules as usual.
 */
declare module "expo-sqlite" {
    export interface SQLiteDatabase {
        getAllSync(source: string, params?: any[]): any[];
        runSync(
            source: string,
            params?: any[]
        ): { changes: number; lastInsertRowId: number };
        withTransactionSync(task: () => void): void;
    }

    export function openDatabaseSync(name: string): SQLiteDatabase;
}
