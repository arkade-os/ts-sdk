import { describe, expect, it } from "vitest";

// The root entry is exercised via its sub-modules rather than ../src/index, because
// src/index.ts re-exports POST/GET from ./server/route, which imports next/server.
// That is a known carried-over defect (the root entry pulls server code into client
// bundles); testing the sub-modules gives the same coverage without depending on it.
describe("@arkade-os/checkout export surface", () => {
    it("exposes the client entry points", async () => {
        const { Checkout } = await import("../src/client/Checkout");
        const { useCheckout } = await import("../src/client/useCheckout");
        expect(Checkout).toBeTypeOf("function");
        expect(useCheckout).toBeTypeOf("function");
    });

    it("exposes the Next.js route handlers", async () => {
        const route = await import("../src/server/route");
        expect(route.POST).toBeTypeOf("function");
        expect(route.GET).toBeTypeOf("function");
    });

    it("exposes the next plugin as a default export", async () => {
        const plugin = await import("../src/next-plugin");
        expect(plugin.default).toBeTypeOf("function");
    });

    it("declares one exports-map entry per built subpath", async () => {
        const pkg = await import("../package.json");
        expect(Object.keys(pkg.default.exports).sort()).toEqual([
            ".",
            "./next-plugin",
            "./server/route",
        ]);
    });

    it("declares @vercel/kv as an optional peer, matching its lazy require", async () => {
        // storage.ts does require("@vercel/kv") behind a KV_REST_API_URL env guard.
        // The source repo declared it nowhere, so any consumer setting that env var
        // hit MODULE_NOT_FOUND.
        const pkg = await import("../package.json");
        expect(pkg.default.peerDependencies["@vercel/kv"]).toBeDefined();
        expect(pkg.default.peerDependenciesMeta["@vercel/kv"].optional).toBe(true);
    });

    it("depends on workspace packages via caret ranges, never exact pins", async () => {
        const pkg = await import("../package.json");
        expect(pkg.default.dependencies["@arkade-os/sdk"]).toBe("workspace:^");
        expect(pkg.default.dependencies["@arkade-os/boltz-swap"]).toBe("workspace:^");
    });

    it("does not publish the raw cli directory", async () => {
        const pkg = await import("../package.json");
        expect(pkg.default.files).not.toContain("cli");
    });
});
