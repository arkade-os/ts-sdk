import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    installRestoreHarness,
    makeHdWalletForTest,
    teardownRestoreHarness,
} from "./helpers/restoreWallet";

// A keyring-wrapped HD provider fails `instanceof HDDescriptorProvider`, so every HD-gated
// method must unwrap first or silently answer as a static wallet.
describe("Wallet with a keyring-wrapped HD provider as walletMode", () => {
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    async function pair() {
        const plain = await makeHdWalletForTest();
        const wrapped = await makeHdWalletForTest(new Set(), new Set(), { wrapInKeyring: true });
        return { plain, wrapped };
    }

    it("answers the HD descriptor API like the unwrapped wallet", async () => {
        const { plain, wrapped } = await pair();
        try {
            expect(await wrapped.wallet.getCurrentSigningDescriptor()).toBe(
                await plain.wallet.getCurrentSigningDescriptor(),
            );
            expect(await wrapped.wallet.getUsedSigningDescriptors({ lookAhead: 2 })).toEqual(
                await plain.wallet.getUsedSigningDescriptors({ lookAhead: 2 }),
            );
            const next = await wrapped.wallet.getNextSigningDescriptor();
            expect(next).toBe(await plain.wallet.getNextSigningDescriptor());
            expect(wrapped.hdProvider.isOurs(next!)).toBe(true);
        } finally {
            await plain.wallet.dispose();
            await wrapped.wallet.dispose();
        }
    });

    it("advances the HD watermark", async () => {
        const wrapped = await makeHdWalletForTest(new Set(), new Set(), { wrapInKeyring: true });
        try {
            await wrapped.wallet.advanceSigningDescriptorWatermark(
                wrapped.hdProvider.materializeDescriptorAt(5),
            );
            expect(await wrapped.hdProvider.getLastIndexUsed()).toBe(5);
        } finally {
            await wrapped.wallet.dispose();
        }
    });
});
