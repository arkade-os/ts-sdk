import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        // each package symlinks the regtest submodule into its root; that tree
        // carries its own node:test suites, which vitest cannot run
        exclude: [...configDefaults.exclude, "regtest/**"],
        environment: "node",
        fileParallelism: false,
        reporters: ["verbose"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            exclude: [
                "node_modules/**",
                "dist/**",
                "**/*.test.ts",
                "**/*.spec.ts",
                "**/__tests__/**",
            ],
        },
    },
});
