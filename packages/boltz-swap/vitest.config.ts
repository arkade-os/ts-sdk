/// <reference types="vitest" />
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../config/vitest.base";

export default mergeConfig(
    base,
    defineConfig({
        test: {
            setupFiles: ["./test/setup.ts"],
            typecheck: {
                // `.test-d.ts` assertions are no-ops unless tsc actually runs:
                // esbuild strips their types without checking them. The dedicated
                // tsconfig is required too — the package one excludes `test/`, so
                // the checker would never see these files.
                enabled: true,
                tsconfig: "./tsconfig.typecheck.json",
            },
        },
    }),
);
