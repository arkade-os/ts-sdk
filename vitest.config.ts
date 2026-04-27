import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    resolve: {
        alias: {
            // @noble/curves exports only "./secp256k1.js" (with .js extension)
            // but Vite resolves without extensions by default, causing failures.
            "@noble/curves/secp256k1": path.resolve(
                __dirname,
                "node_modules/@noble/curves/secp256k1.js"
            ),
        },
    },
    test: {
        globals: true,
        environment: "node",
        fileParallelism: false,
        reporters: ["verbose"],
        setupFiles: ["./test/polyfill.js"],
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
