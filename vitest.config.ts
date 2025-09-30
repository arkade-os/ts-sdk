import { defineConfig } from "vitest/config";

export default defineConfig({
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
