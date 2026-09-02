import { defineConfig } from "tsup";

import { publicEntries } from "./tsup.config";

export default defineConfig({
    entry: publicEntries,
    format: ["esm", "cjs"],
    dts: { only: true },
    clean: false,
    target: "es2022",
});
