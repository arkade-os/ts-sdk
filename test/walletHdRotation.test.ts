import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../src";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import type { ContractEvent } from "../src/contracts/types";

/**
 * Hand-crafted integration tests for wallet HD receive rotation (Phase C2).
 *
 * Mocks the minimum surface to let `Wallet.create` succeed and then drives
 * rotation by invoking the captured `onContractEvent` callback directly —
 * we don't need a real indexer subscription to exercise the handler.
 */

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SERVER_PUBKEY_HEX =
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const mockArkInfo = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
};

// Shared mocks - reset between each test
const mockFetch = vi.fn();
const MockEventSource = vi.fn().mockImplementation((url: string) => ({
    url,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
}));

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    // Route by URL so test ordering doesn't depend on exact fetch counts.
    mockFetch.mockImplementation((url: string) => {
        const reply = (body: unknown) =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve(body),
            });
        if (url.includes("/info")) return reply(mockArkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        // Indexer: anything asking for vtxos — default to empty.
        if (url.includes("vtxo") || url.includes("scripts"))
            return reply({ vtxos: [] });
        // Esplora-style onchain calls (boarding coins etc.) — empty array.
        return reply([]);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeHdWallet(repo?: InMemoryWalletRepository) {
    const identity = MnemonicIdentity.fromMnemonic(MNEMONIC, {
        isMainnet: false,
    });
    return Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: repo ?? new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
}

describe("Wallet HD rotation", () => {
    describe("installation", () => {
        it("installs HD provider when identity is a MnemonicIdentity", async () => {
            const wallet = await makeHdWallet();
            // The provider is kept private; inspect via persisted state.
            const state = await wallet.walletRepository.getWalletState();
            expect(state?.settings?.hd).toBeDefined();
            expect(state?.settings?.hd.currentReceiveIndex).toBe(0);
            await wallet.dispose();
        });

        it("does NOT install HD provider for SingleKey identities", async () => {
            const repo = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: SingleKey.fromHex(
                    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2"
                ),
                arkServerUrl: "http://localhost:7070",
                storage: {
                    walletRepository: repo,
                    contractRepository: new InMemoryContractRepository(),
                },
            });
            const state = await repo.getWalletState();
            expect(state?.settings?.hd).toBeUndefined();
            await wallet.dispose();
        });
    });

    describe("rotation", () => {
        it("advances the receive index when vtxo_received fires for the current contract", async () => {
            const rotateSpy = vi.spyOn(
                HDDescriptorProvider.prototype,
                "rotateReceive"
            );
            const wallet = await makeHdWallet();

            const scriptBefore = wallet.defaultContractScript;
            const manager = await wallet.getContractManager();

            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: scriptBefore,
                vtxos: [],
                contract: { script: scriptBefore } as never,
                timestamp: Date.now(),
            };
            // Drive the registered callbacks directly — one of them is our
            // rotation handler.
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }

            // Wait for the chained rotation to complete.
            await (wallet as any)._hdRotationChain;

            expect(rotateSpy).toHaveBeenCalledTimes(1);
            const scriptAfter = wallet.defaultContractScript;
            expect(scriptAfter).not.toBe(scriptBefore);

            const state = await wallet.walletRepository.getWalletState();
            expect(state?.settings?.hd.currentReceiveIndex).toBe(1);

            rotateSpy.mockRestore();
            await wallet.dispose();
        });

        it("ignores vtxo_received for other contract scripts", async () => {
            const rotateSpy = vi.spyOn(
                HDDescriptorProvider.prototype,
                "rotateReceive"
            );
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();

            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: "unrelated-script",
                vtxos: [],
                contract: { script: "unrelated-script" } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }
            await (wallet as any)._hdRotationChain;

            expect(rotateSpy).not.toHaveBeenCalled();
            rotateSpy.mockRestore();
            await wallet.dispose();
        });

        it("ignores non-vtxo_received event types", async () => {
            const rotateSpy = vi.spyOn(
                HDDescriptorProvider.prototype,
                "rotateReceive"
            );
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();

            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb({ type: "connection_reset", timestamp: Date.now() });
            }
            await (wallet as any)._hdRotationChain;

            expect(rotateSpy).not.toHaveBeenCalled();
            rotateSpy.mockRestore();
            await wallet.dispose();
        });
    });

    describe("persistence", () => {
        it("second wallet on the same repo reads the rotated index", async () => {
            const repo = new InMemoryWalletRepository();
            const first = await makeHdWallet(repo);

            const scriptV0 = first.defaultContractScript;
            const addrV0 = await first.getAddress();

            // Drive one rotation.
            const manager = await first.getContractManager();
            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: scriptV0,
                vtxos: [],
                contract: { script: scriptV0 } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }
            await (first as any)._hdRotationChain;

            const addrV1 = await first.getAddress();
            expect(addrV1).not.toBe(addrV0);
            await first.dispose();

            // Restart on the same repo — boot should land on the rotated
            // index without any event replay.
            const second = await makeHdWallet(repo);
            const restoredAddr = await second.getAddress();
            expect(restoredAddr).toBe(addrV1);
            await second.dispose();
        });
    });

    describe("dispose", () => {
        it("unsubscribes the rotation handler", async () => {
            const rotateSpy = vi.spyOn(
                HDDescriptorProvider.prototype,
                "rotateReceive"
            );
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();
            const scriptBefore = wallet.defaultContractScript;

            await wallet.dispose();

            // After dispose, firing an event should not trigger rotation
            // (the callback was removed). We can't assert the callback
            // was removed directly — inspect the set size, then confirm
            // rotateReceive stays at zero.
            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: scriptBefore,
                vtxos: [],
                contract: { script: scriptBefore } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }
            // No rotation chain to drain — handler is gone.
            expect(rotateSpy).not.toHaveBeenCalled();
            rotateSpy.mockRestore();
        });
    });
});
