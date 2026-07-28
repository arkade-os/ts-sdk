import { describe, expect, it } from "vitest";

import * as root from "../src/index";
import { LeatherIdentity } from "../src/providers/leather";
import { OkxIdentity } from "../src/providers/okx";
import { PhantomIdentity } from "../src/providers/phantom";
import { UnisatIdentity } from "../src/providers/unisat";

describe("@arkade-os/wallet-providers export surface", () => {
    it("exposes every value export from the root entry", () => {
        expect(root.BrowserWalletIdentity).toBeTypeOf("function");
        expect(root.UnisatIdentity).toBeTypeOf("function");
        expect(root.OkxIdentity).toBeTypeOf("function");
        expect(root.LeatherIdentity).toBeTypeOf("function");
        expect(root.PhantomIdentity).toBeTypeOf("function");
    });

    it("exports exactly the expected value surface, no accidental additions", () => {
        expect(Object.keys(root).sort()).toEqual([
            "BrowserWalletIdentity",
            "LeatherIdentity",
            "OkxIdentity",
            "PhantomIdentity",
            "UnisatIdentity",
        ]);
    });

    it("resolves each subpath entry to the same class as the root export", () => {
        expect(UnisatIdentity).toBe(root.UnisatIdentity);
        expect(OkxIdentity).toBe(root.OkxIdentity);
        expect(LeatherIdentity).toBe(root.LeatherIdentity);
        expect(PhantomIdentity).toBe(root.PhantomIdentity);
    });

    it("declares one exports-map entry per subpath module", async () => {
        const pkg = await import("../package.json");
        expect(Object.keys(pkg.default.exports).sort()).toEqual([
            ".",
            "./leather",
            "./okx",
            "./phantom",
            "./unisat",
        ]);
    });

    it("keeps the SDK a peer dependency so it is never bundled twice", async () => {
        const pkg = await import("../package.json");
        expect(pkg.default.peerDependencies["@arkade-os/sdk"]).toBeDefined();
        // Indexed via Object.keys rather than a property access: TypeScript narrows the
        // imported JSON to a literal type, so `dependencies["@arkade-os/sdk"]` is a
        // compile error rather than the runtime `undefined` this assertion wants.
        expect(Object.keys(pkg.default.dependencies)).not.toContain("@arkade-os/sdk");
    });
});
