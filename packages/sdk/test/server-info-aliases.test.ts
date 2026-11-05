import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { OperatorInfoSource, ServerInfoSource } from "../src";
import { ReadonlyWallet } from "../src";
import { CachingArkProvider } from "../src/providers/cachingArk";
import { RestArkProvider } from "../src/providers/ark";

describe("deprecated server info names", () => {
    it("keeps the source type", () => {
        expectTypeOf<ServerInfoSource>().toEqualTypeOf<OperatorInfoSource>();
    });

    it("forwards RestArkProvider.onServerInfoChanged", () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const subscribe = vi.spyOn(provider, "onOperatorInfoChanged");
        const listener = vi.fn();

        provider.onServerInfoChanged(listener);

        expect(subscribe).toHaveBeenCalledWith(listener);
    });

    it("forwards CachingArkProvider.onServerInfoChanged", () => {
        const unsubscribe = vi.fn();
        const inner = {
            onOperatorInfoChanged: vi.fn(() => unsubscribe),
        } as unknown as RestArkProvider;
        const provider = new CachingArkProvider(inner);
        const listener = vi.fn();

        expect(provider.onServerInfoChanged(listener)).toBe(unsubscribe);
        expect(inner.onOperatorInfoChanged).toHaveBeenCalledWith(listener);
    });

    it("forwards ReadonlyWallet.serverInfoSource", () => {
        const wallet = Object.create(ReadonlyWallet.prototype) as ReadonlyWallet;
        Object.defineProperty(wallet, "_operatorInfoSource", { value: "cache" });

        expect(wallet.operatorInfoSource).toBe("cache");
        expect(wallet.serverInfoSource).toBe("cache");
    });
});
