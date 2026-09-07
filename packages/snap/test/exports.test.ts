import { describe, expect, it } from "vitest";

import * as root from "../src/index";

describe("@arkade-os/snap export surface", () => {
    it("exposes the RPC handler", () => {
        expect(root.onRpcRequest).toBeTypeOf("function");
    });

    it("exports exactly the expected value surface, no accidental additions", () => {
        expect(Object.keys(root)).toEqual(["onRpcRequest"]);
    });

    it("rejects unknown RPC methods", async () => {
        await expect(
            root.onRpcRequest({
                origin: "https://example.com",
                request: { method: "not_a_real_method", params: {}, id: 1, jsonrpc: "2.0" },
            } as never),
        ).rejects.toThrow("Method not found: not_a_real_method");
    });

    it("keeps package.json and snap.manifest.json versions in lockstep", async () => {
        // The release hook syncs these two. MetaMask rejects a snap whose manifest
        // version disagrees with the published package version, so this is the
        // standing guard that the hook cannot silently drift.
        const pkg = await import("../package.json");
        const manifest = await import("../snap.manifest.json");
        expect(manifest.default.version).toBe(pkg.default.version);
    });

    it("points the manifest at the new repository", async () => {
        const manifest = await import("../snap.manifest.json");
        expect(manifest.default.repository.url).toBe("https://github.com/arkade-os/ts-sdk.git");
    });

    it("still publishes under the original npm package name", async () => {
        // @arkade-os/snap@0.1.2 is live and installed by real MetaMask users; the
        // manifest's npm location must keep pointing at it across the repo move.
        const manifest = await import("../snap.manifest.json");
        expect(manifest.default.source.location.npm.packageName).toBe("@arkade-os/snap");
    });
});
