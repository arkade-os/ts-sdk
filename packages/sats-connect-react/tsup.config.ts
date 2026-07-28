import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    external: [
        "react",
        "@arkade-os/sdk",
        "@arkade-os/boltz-swap",
        "@arkade-os/sats-connect",
        "sats-connect",
    ],
});
