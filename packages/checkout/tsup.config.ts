import { defineConfig, type Options } from "tsup";

// Annotated as Options rather than `as const`: a const assertion makes `format` a
// readonly tuple, which tsup's mutable Format[] rejects. The source repo did not
// catch this because its tsconfig only included src/.
const shared: Options = {
    format: ["esm", "cjs"],
    sourcemap: true,
    splitting: false,
    treeshake: true,
};

export default [
    defineConfig({
        entry: {
            index: "src/index.ts",
            "server/route": "src/server/route.ts",
            "next-plugin": "src/next-plugin.ts",
        },
        dts: true,
        clean: true,
        ...shared,
        external: [
            "next",
            "react",
            "@arkade-os/sdk",
            "@arkade-os/boltz-swap",
            "qrcode",
            "@vercel/kv",
        ],
    }),
    defineConfig({
        entry: { "cli/create": "cli/create.ts" },
        format: ["esm"],
        dts: false,
        clean: false,
        sourcemap: true,
        splitting: false,
        treeshake: true,
        banner: {
            js: "#!/usr/bin/env node",
        },
        external: ["@arkade-os/sdk"],
    }),
];
