import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../config/vitest.base";

export default mergeConfig(
    base,
    defineConfig({
        test: {
            setupFiles: ["./test/polyfill.js"],
        },
    }),
);
