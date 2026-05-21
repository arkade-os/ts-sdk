import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/adapters/expo.ts",
        "src/adapters/localStorage.ts",
        "src/adapters/fileSystem.ts",
        "src/adapters/indexedDB.ts",
        "src/adapters/asyncStorage.ts",
        "src/repositories/sqlite/index.ts",
        "src/repositories/realm/index.ts",
        "src/worker/expo/index.ts",
        "src/wallet/expo/index.ts",
        "src/wallet/expo/background.ts",
        // Side-effects entry: keep this file at a predictable dist path
        // so the `sideEffects` array in package.json keeps pointing at it.
        "src/contracts/handlers/index.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2022",
    splitting: true,
    treeshake: true,
    external: [
        "expo",
        "expo-sqlite",
        "expo-task-manager",
        "expo-background-task",
        "@react-native-async-storage/async-storage",
    ],
});
