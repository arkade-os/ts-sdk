import { describe, it, expect } from "vitest";
import * as root from "../src";
import { SingleKey } from "../src/identity/singleKey";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";

// `@arkade-os/sdk` publishes only the root entrypoint — there is no
// `./identity` subpath — so a provider exported from the identity barrel
// alone is unreachable to consumers and plugin packages. The descriptor
// providers are the sanctioned way to hold a foreign signable contract,
// so they must be constructible from the published surface.
describe("descriptor providers are exported from the root entrypoint", () => {
    it("exposes the provider classes as runtime values", () => {
        expect(typeof root.StaticDescriptorProvider).toBe("function");
        expect(typeof root.KeyringDescriptorProvider).toBe("function");
        expect(typeof root.HDDescriptorProvider).toBe("function");
    });

    it("can build a keyring provider using only root exports", async () => {
        const base = await root.StaticDescriptorProvider.create(
            SingleKey.fromPrivateKey(new Uint8Array(32).fill(1)),
        );
        const provider = await root.KeyringDescriptorProvider.create(
            base,
            new InMemoryWalletRepository(),
        );

        const descriptor = await provider.importKey(new Uint8Array(32).fill(2));
        expect(provider.isOurs(descriptor)).toBe(true);
    });
});
