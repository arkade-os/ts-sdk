import { describe, it, expect } from "vitest";
import * as root from "../src";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";

// `@arkade-os/sdk` publishes only the root entrypoint — there is no
// `./identity` subpath — so anything exported from the identity barrel
// alone is unreachable to consumers and plugin packages. Holding a foreign
// signable contract is the sanctioned capability here, so the keyring
// source and the descriptor providers must be usable from the published
// surface. The composite that orders sources is wallet wiring and stays
// deliberately unexported.
describe("descriptor signing surface is exported from the root entrypoint", () => {
    it("exposes the provider classes and the keyring source as runtime values", () => {
        expect(typeof root.StaticDescriptorProvider).toBe("function");
        expect(typeof root.HDDescriptorProvider).toBe("function");
        expect(typeof root.KeyringSigningSource).toBe("function");
    });

    it("exposes the loud-failure error for an unclaimed descriptor", () => {
        expect(typeof root.UnknownSigningDescriptorError).toBe("function");
    });

    it("round-trips an import through canProvide using only root exports", async () => {
        const keyring = new root.KeyringSigningSource(new InMemoryWalletRepository());

        const descriptor = await keyring.importKey(new Uint8Array(32).fill(2));

        expect(await keyring.canProvide(descriptor)).toBe(true);
    });
});
