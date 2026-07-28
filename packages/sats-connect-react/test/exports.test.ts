import { describe, expect, it } from "vitest";

import * as root from "../src/index";

describe("@arkade-os/sats-connect-react export surface", () => {
    it("exposes its own value exports", () => {
        expect(root.ArkadeWalletProvider).toBeTypeOf("function");
        expect(root.useArkadeWallet).toBeTypeOf("function");
    });

    it("re-exports the sats-connect value surface", () => {
        expect(root.ArkadeWallet).toBeTypeOf("function");
        expect(root.SatsConnectIdentity).toBeTypeOf("function");
    });

    it("exports exactly the expected value surface, no accidental additions", () => {
        expect(Object.keys(root).sort()).toEqual([
            "ArkadeWallet",
            "ArkadeWalletProvider",
            "SatsConnectIdentity",
            "useArkadeWallet",
        ]);
    });

    it("declares a single root exports-map entry", async () => {
        const pkg = await import("../package.json");
        expect(Object.keys(pkg.default.exports)).toEqual(["."]);
    });

    it("depends on the sibling package via a caret workspace range, never an exact pin", async () => {
        // workspace:* would publish as an exact version, forcing a release here on every
        // sats-connect patch. workspace:^ publishes a caret range and stays decoupled.
        const pkg = await import("../package.json");
        expect(pkg.default.dependencies["@arkade-os/sats-connect"]).toBe("workspace:^");
    });
});
