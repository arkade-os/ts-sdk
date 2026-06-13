import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hex } from "@scure/base";
import {
    installRestoreHarness,
    teardownRestoreHarness,
    makeStaticWalletForTest,
    mockArkInfo,
} from "./helpers/restoreWallet";
import { BoardingContractHandler } from "../src/contracts/handlers/boarding";
import { CSVMultisigTapscript } from "../src/script/tapscript";

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

            await wallet.rotateServerSigner(
                hex.decode(NEW_SERVER),
                mockArkInfo.checkpointTapscript,
            );

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

            await wallet.rotateServerSigner(
                hex.decode(NEW_SERVER),
                mockArkInfo.checkpointTapscript,
            );

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
            await wallet.rotateServerSigner(
                wallet.arkServerPublicKey,
                mockArkInfo.checkpointTapscript,
            );
            expect(await wallet.getAddress()).toBe(before);
            // A 33-byte compressed form of the same key is also a no-op.
            const compressed = hex.decode("02" + hex.encode(wallet.arkServerPublicKey));
            await wallet.rotateServerSigner(compressed, mockArkInfo.checkpointTapscript);
            expect(await wallet.getAddress()).toBe(before);
        } finally {
            await wallet.dispose();
        }
    });

    it("re-sources serverUnrollScript from the supplied checkpointTapscript", async () => {
        const { wallet } = await makeStaticWalletForTest();
        try {
            const before = hex.encode(wallet.serverUnrollScript.script);
            // A distinct, valid checkpoint script for the new server epoch.
            const newCheckpoint = hex.encode(
                CSVMultisigTapscript.encode({
                    timelock: { type: "blocks", value: 200 },
                    pubkeys: [hex.decode(NEW_SERVER)],
                }).script,
            );
            expect(newCheckpoint).not.toBe(before);

            await wallet.rotateServerSigner(hex.decode(NEW_SERVER), newCheckpoint);

            // The send path's checkpoint outputs now build against the new
            // epoch, not the pinned construction-time script.
            expect(hex.encode(wallet.serverUnrollScript.script)).toBe(newCheckpoint);
        } finally {
            await wallet.dispose();
        }
    });

    it("rejects a missing/empty checkpointTapscript without any side effect", async () => {
        const { wallet, contractRepository } = await makeStaticWalletForTest();
        try {
            const beforeKey = hex.encode(wallet.arkServerPublicKey);
            const beforeOffchain = hex.encode(wallet.offchainTapscript.options.serverPubKey);
            const beforeBoarding = hex.encode(wallet.boardingTapscript.options.serverPubKey);
            const beforeUnroll = hex.encode(wallet.serverUnrollScript.script);
            const beforeRows = (await contractRepository.getContracts({})).length;

            await expect(wallet.rotateServerSigner(hex.decode(NEW_SERVER), "")).rejects.toThrow(
                "Invalid checkpointTapscript from server",
            );

            // The wallet stays on its previous consistent epoch: key, both
            // tapscripts, the unroll script, and the contract rows are unchanged.
            expect(hex.encode(wallet.arkServerPublicKey)).toBe(beforeKey);
            expect(hex.encode(wallet.offchainTapscript.options.serverPubKey)).toBe(beforeOffchain);
            expect(hex.encode(wallet.boardingTapscript.options.serverPubKey)).toBe(beforeBoarding);
            expect(hex.encode(wallet.serverUnrollScript.script)).toBe(beforeUnroll);
            expect((await contractRepository.getContracts({})).length).toBe(beforeRows);
        } finally {
            await wallet.dispose();
        }
    });

    it("dispose() drains an in-flight onServerInfoChanged handler before teardown", async () => {
        const { wallet } = await makeStaticWalletForTest();

        // Stand in for a handleServerInfoChanged still mid-flight (rotation /
        // createContract not yet settled) at the moment dispose() is called.
        let releaseHandler!: () => void;
        (wallet as unknown as { _serverInfoInFlight: Promise<void> })._serverInfoInFlight =
            new Promise<void>((resolve) => {
                releaseHandler = resolve;
            });

        const disposing = wallet.dispose();
        const raced = await Promise.race([
            disposing.then(() => "disposed"),
            new Promise<string>((resolve) =>
                setTimeout(() => resolve("handler-still-running"), 50),
            ),
        ]);

        // dispose() must still be blocked on the in-flight handler, so its
        // rotation finishes before the contract manager is torn down under it.
        expect(raced).toBe("handler-still-running");

        releaseHandler();
        await disposing;
    });
});

describe("Boarding watch path across server-signer rotation", () => {
    beforeEach(() => installRestoreHarness());
    afterEach(() => teardownRestoreHarness());

    // The operator's PREVIOUS signer (compressed, as arkd advertises it in
    // deprecatedSigners); its x-only form is what a boarding row minted under
    // that signer carries in params.serverPubKey.
    const PREV_SERVER = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const PREV_SERVER_XONLY = PREV_SERVER.slice(2);

    it("getBoardingAddresses includes a boarding row under a now-deprecated signer", async () => {
        // Advertise PREV as a deprecated signer so the wallet caches it at setup.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                const reply = (b: unknown) =>
                    Promise.resolve({ ok: true, json: () => Promise.resolve(b) });
                if (url.includes("/info"))
                    return reply({
                        ...mockArkInfo,
                        deprecatedSigners: [{ pubkey: PREV_SERVER, cutoffDate: 9_999_999_999 }],
                    });
                if (url.includes("subscribe") || url.includes("subscriptions"))
                    return reply({ subscriptionId: "sub-1" });
                return reply([]);
            }),
        );

        const { wallet, contractRepository } = await makeStaticWalletForTest();
        try {
            const before = new Set(await wallet.getBoardingAddresses());

            // A boarding row this wallet minted while PREV was the active signer
            // — still active, still potentially funded after the rotation.
            await contractRepository.saveContract({
                type: "boarding",
                params: {
                    pubKey: "ab".repeat(32),
                    serverPubKey: PREV_SERVER_XONLY,
                    csvTimelock: "144",
                },
                script: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
                address: "tb1pdeprecated-unused",
                state: "active",
                createdAt: 1,
            });

            const after = new Set(await wallet.getBoardingAddresses());
            // The watch/read path fans out over current ∪ deprecated, so the
            // deprecated-signer boarding address is now watched (it wasn't
            // before), and no previously-watched address is dropped.
            expect(after.size).toBe(before.size + 1);
            for (const a of before) expect(after.has(a)).toBe(true);
        } finally {
            await wallet.dispose();
        }
    });

    it("handleServerInfoChanged rotates onto the new signer and keeps watching the old one", async () => {
        const { wallet, contractRepository } = await makeStaticWalletForTest();
        try {
            const oldSigner = hex.encode(wallet.arkServerPublicKey);
            const NEW = "ab".repeat(32);

            // A boarding row minted under the (soon-to-be deprecated) signer.
            await contractRepository.saveContract({
                type: "boarding",
                params: {
                    pubKey: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
                    serverPubKey: oldSigner,
                    csvTimelock: "144",
                },
                script: "ef".repeat(32),
                address: "tb1pold-unused",
                state: "active",
                createdAt: 1,
            });
            const oldBoardingAddr = BoardingContractHandler.createScript({
                pubKey: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
                serverPubKey: oldSigner,
                csvTimelock: "144",
            }).onchainAddress(wallet.network);

            // Watched now, because it sits under the wallet's current signer.
            expect(new Set(await wallet.getBoardingAddresses()).has(oldBoardingAddr)).toBe(true);

            // arkd rotated to NEW and now advertises the old signer as deprecated.
            await (
                wallet as unknown as {
                    handleServerInfoChanged(info: {
                        signerPubkey: string;
                        checkpointTapscript: string;
                        deprecatedSigners?: { pubkey: string }[];
                    }): Promise<void>;
                }
            ).handleServerInfoChanged({
                signerPubkey: NEW,
                checkpointTapscript: mockArkInfo.checkpointTapscript,
                deprecatedSigners: [{ pubkey: oldSigner }],
            });

            // Rotated onto NEW…
            expect(hex.encode(wallet.arkServerPublicKey)).toBe(NEW);
            // …and the old-signer boarding address is STILL watched (now via the
            // cached deprecated set), not dropped by the rotation.
            expect(new Set(await wallet.getBoardingAddresses()).has(oldBoardingAddr)).toBe(true);
        } finally {
            await wallet.dispose();
        }
    });
});

describe("Offchain baseline matrix across server-signer rotation", () => {
    beforeEach(() => installRestoreHarness());
    afterEach(() => teardownRestoreHarness());

    // arkd advertises the previous signer (compressed) in deprecatedSigners; its
    // x-only form is what a contract minted under it carries in params.serverPubKey.
    const PREV_SERVER = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const PREV_SERVER_XONLY = PREV_SERVER.slice(2);

    it("registers baseline default + boarding contracts under a deprecated signer at boot", async () => {
        // Advertise PREV as deprecated so the wallet caches it at setup, before
        // the contract manager builds its index-0 baseline matrix.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                const reply = (b: unknown) =>
                    Promise.resolve({ ok: true, json: () => Promise.resolve(b) });
                if (url.includes("/info"))
                    return reply({
                        ...mockArkInfo,
                        // Distinct from unilateralExitDelay (mockArkInfo: 144) so the
                        // boarding baseline is a SEPARATE contract, not a first-wins
                        // script collision with the default baseline. Production keeps
                        // these delays distinct; the shared mock happens to equate them.
                        boardingExitDelay: 288,
                        deprecatedSigners: [{ pubkey: PREV_SERVER, cutoffDate: 9_999_999_999 }],
                    });
                if (url.includes("subscribe") || url.includes("subscriptions"))
                    return reply({ subscriptionId: "sub-1" });
                return reply([]);
            }),
        );

        const { wallet, contractRepository } = await makeStaticWalletForTest();
        try {
            // Ensure the baseline matrix is built (initializeContractManager).
            await (
                wallet as unknown as { getContractManager(): Promise<unknown> }
            ).getContractManager();

            const contracts = await contractRepository.getContracts({});
            const underPrev = (type: string) =>
                contracts.filter(
                    (c) => c.type === type && c.params.serverPubKey === PREV_SERVER_XONLY,
                );
            // Both the default and boarding baseline contracts under the deprecated
            // signer must be registered at boot, so offchain VTXOs AND boarding
            // UTXOs minted under the now-rotated signer are watched without an
            // explicit restore().
            expect(underPrev("default").length).toBeGreaterThan(0);
            expect(underPrev("boarding").length).toBeGreaterThan(0);
        } finally {
            await wallet.dispose();
        }
    });
});
