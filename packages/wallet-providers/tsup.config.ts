import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/providers/unisat.ts",
        "src/providers/okx.ts",
        "src/providers/leather.ts",
        "src/providers/phantom.ts",
    ],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    external: ["@arkade-os/sdk"],
});
