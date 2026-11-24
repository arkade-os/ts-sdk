import { describe, expect, it } from "vitest";

import * as root from "../src/index";

describe("@arkade-os/sats-connect export surface", () => {
    it("exposes every value export from the root entry", () => {
        expect(root.SatsConnectIdentity).toBeTypeOf("function");
        expect(root.ArkadeWallet).toBeTypeOf("function");
    });

    it("exports exactly the expected value surface, no accidental additions", () => {
        expect(Object.keys(root).sort()).toEqual(["ArkadeWallet", "SatsConnectIdentity"]);
    });

    it("declares a single root exports-map entry", async () => {
        const pkg = await import("../package.json");
        expect(Object.keys(pkg.default.exports)).toEqual(["."]);
    });

    it("keeps the SDK and sats-connect as peers so neither is bundled twice", async () => {
        const pkg = await import("../package.json");
        expect(pkg.default.peerDependencies["@arkade-os/sdk"]).toBeDefined();
        expect(pkg.default.peerDependencies["sats-connect"]).toBeDefined();
        // Indexed via Object.keys rather than a property access: TypeScript narrows the
        // imported JSON to a literal type, so a missing key is a compile error rather
        // than the runtime `undefined` this assertion wants.
        expect(Object.keys(pkg.default.dependencies)).not.toContain("@arkade-os/sdk");
        expect(Object.keys(pkg.default.dependencies)).not.toContain("sats-connect");
    });
});
