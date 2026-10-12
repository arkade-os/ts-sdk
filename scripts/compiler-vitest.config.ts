import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/compiler-report.test.ts"],
        environment: "node",
        fileParallelism: false,
        testTimeout: 30_000,
    },
});
