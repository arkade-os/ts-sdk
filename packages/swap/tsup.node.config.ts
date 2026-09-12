import { defineConfig } from "tsup";

/**
 * The `./node` subpath's build. Its own config and its own `tsup` invocation.
 *
 * **Why the config file exists.** tsup rewrites `node:`-prefixed builtins to
 * their bare names by default (`removeNodeProtocol`, a legacy default kept for
 * older Node), and turning that off is config-file-only — there is no CLI flag.
 * `node:os`, `node:path` and `node:fs` still resolve after the rewrite, so it
 * is invisible until a specifier has no bare alias: `node:sqlite` has none, so
 * the rewritten bundle fails at load with `Cannot find package 'sqlite'`.
 * esbuild on its own preserves the prefix under `platform: "node"`, so this is
 * tsup's rewrite and not the bundler's.
 *
 * **And no `target`.** Passing one re-enables the rewrite regardless of
 * `removeNodeProtocol`. The default is right here anyway — this entry is only
 * ever loaded by the Node version in `engines`, so there is nothing to
 * downlevel for.
 *
 * **Why a separate invocation from the web build.** `platform` also decides
 * which `exports` condition a dependency resolves under, so building the main
 * entry as Node would quietly pick a dependency's Node build for a bundle
 * headed to a browser. A separate file also leaves `clean` nothing to race:
 * `build:web` cleans `dist` and this one only adds to it.
 *
 * The dist smoke test is what catches a regression here: it imports every
 * declared subpath under both `import` and `require`, so a rewritten specifier
 * fails the build rather than a consumer's first run.
 */
export default defineConfig({
    entry: ["src/node/index.ts"],
    outDir: "dist/node",
    format: ["esm", "cjs"],
    platform: "node",
    removeNodeProtocol: false,
    dts: true,
    clean: false,
});
