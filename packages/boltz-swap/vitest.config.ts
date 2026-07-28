/// <reference types="vitest" />
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../config/vitest.base";

export default mergeConfig(
    base,
    defineConfig({
        test: {
            setupFiles: ["./test/setup.ts"],
            typecheck: {
                // See tsconfig.typecheck.json — `.test-d.ts` assertions are no-ops
                // without it.
                enabled: true,
                tsconfig: "./tsconfig.typecheck.json",
            },
        },
    }),
);
