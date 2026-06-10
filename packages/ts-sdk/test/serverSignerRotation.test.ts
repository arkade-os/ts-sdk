import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    installRestoreHarness,
    teardownRestoreHarness,
    makeStaticWalletForTest,
} from "./helpers/restoreWallet";

const NEW_SERVER = "ab".repeat(32);

describe("Wallet.rotateServerSigner (mid-session server-signer rotation)", () => {
    beforeEach(() => installRestoreHarness());
    afterEach(() => teardownRestoreHarness());

    it("swaps offchain + boarding tapscripts and addresses to the new signer", async () => {
        const { wallet, contractRepository } = await makeStaticWalletForTest();
        try {
            const oldServerHex = hex.encode(wallet.arkServerPublicKey);
            const oldAddress = await wallet.getAddress();
            const oldBoardingAddress = await wallet.getBoardingAddress();

            await wallet.rotateServerSigner(hex.decode(NEW_SERVER));

            // Server key + both tapscripts now commit to the new signer.
            expect(hex.encode(wallet.arkServerPublicKey)).toBe(NEW_SERVER);
            expect(hex.encode(wallet.offchainTapscript.options.serverPubKey)).toBe(NEW_SERVER);
            expect(hex.encode(wallet.boardingTapscript.options.serverPubKey)).toBe(NEW_SERVER);

            // Derived addresses changed.
            expect(await wallet.getAddress()).not.toBe(oldAddress);
            expect(await wallet.getBoardingAddress()).not.toBe(oldBoardingAddress);

            // New contract rows exist for the rotated scripts, both committing
            // to the new signer. (This fixture's unilateral- and boarding-exit
            // delays coincide, so the boarding script collapses onto the
            // first-wins `default` row — hence the type-agnostic boarding
            // assertion via the script lookup.)
            const all = await contractRepository.getContracts({});
            const offchainRow = all.find((c) => c.script === wallet.defaultContractScript);
            expect(offchainRow?.params.serverPubKey).toBe(NEW_SERVER);
            const boardingScript = hex.encode(wallet.boardingTapscript.pkScript);
            const boardingRow = all.find((c) => c.script === boardingScript);
            expect(boardingRow?.params.serverPubKey).toBe(NEW_SERVER);
        } finally {
            await wallet.dispose();
        }
    });

    it("leaves the old-signer contract rows active and watched for migration", async () => {
        const { wallet, contractRepository } = await makeStaticWalletForTest();
        try {
            const oldServerHex = hex.encode(wallet.arkServerPublicKey);

            await wallet.rotateServerSigner(hex.decode(NEW_SERVER));

            const all = await contractRepository.getContracts({});
            const oldRows = all.filter((c) => c.params.serverPubKey === oldServerHex);
            expect(oldRows.length).toBeGreaterThan(0);
            expect(oldRows.every((c) => c.state === "active")).toBe(true);
        } finally {
            await wallet.dispose();
        }
    });

    it("is idempotent when rotating to the already-active signer", async () => {
        const { wallet } = await makeStaticWalletForTest();
        try {
            const before = await wallet.getAddress();
            await wallet.rotateServerSigner(wallet.arkServerPublicKey);
            expect(await wallet.getAddress()).toBe(before);
            // A 33-byte compressed form of the same key is also a no-op.
            const compressed = hex.decode("02" + hex.encode(wallet.arkServerPublicKey));
            await wallet.rotateServerSigner(compressed);
            expect(await wallet.getAddress()).toBe(before);
        } finally {
            await wallet.dispose();
        }
    });
});
