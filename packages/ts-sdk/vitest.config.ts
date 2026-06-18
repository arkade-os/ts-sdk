import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "../../config/vitest.base";

// deprecatedSignerMigration is restarting arkd and deprecate the signer key
// we must ensure it runs after the other tests to not invalidate "old" signer public key 
const RUN_LAST = [/deprecatedSignerMigration/i];

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
        },
    }),
);
