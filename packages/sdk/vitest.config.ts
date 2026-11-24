import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "../../config/vitest.base";

const RUN_LAST = [/deprecatedSignerMigration/i, /digestMismatch/i];

const isRunLast = (spec: TestSpecification): boolean =>
    RUN_LAST.some((re) => re.test(spec.moduleId));

class CustomSequencer extends BaseSequencer {
    async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
        const sorted = await super.sort(files);
        const first = sorted.filter((f) => !isRunLast(f));
        const last = sorted.filter(isRunLast);
        return [...first, ...last];
    }
}

export default mergeConfig(
    base,
    defineConfig({
        test: {
            setupFiles: ["./test/polyfill.js"],
            sequence: {
                sequencer: CustomSequencer,
            },
            typecheck: {
                enabled: true,
                tsconfig: "./tsconfig.typecheck.json",
                // Pinned to the tsconfig's own scope. Vitest's default glob is
                // wider, and a file it collects but tsc excludes is reported as
                // passing without ever being compiled.
                include: ["test/**/*.test-d.ts"],
                exclude: ["test/e2e/**"],
            },
        },
    }),
);
