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
 * Hand-crafted integration tests for HD receive rotation against the
 * contract-repository-as-source-of-truth design.
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

function makeHdWallet(
    walletRepo?: InMemoryWalletRepository,
    contractRepo?: InMemoryContractRepository
) {
    const identity = MnemonicIdentity.fromMnemonic(MNEMONIC, {
        isMainnet: false,
    });
    return Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: walletRepo ?? new InMemoryWalletRepository(),
            contractRepository:
                contractRepo ?? new InMemoryContractRepository(),
        },
    });
}

describe("Wallet HD rotation", () => {
    describe("installation", () => {
        it("installs HD provider on a fresh wallet and allocates index 0", async () => {
            const wallet = await makeHdWallet();
            // The provider is private; observe via persisted state. The
            // boot path allocates the first index through the provider so
            // storage and the registered default contract stay in sync.
            const state = await wallet.walletRepository.getWalletState();
            expect(state?.settings?.hd).toBeDefined();
            expect(state?.settings?.hd.lastIndexUsed).toBe(0);
            await wallet.dispose();
        });

        it("registers an active default contract for the boot pubkey", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const contracts = await contractRepo.getContracts({
                type: "default",
                state: "active",
            });
            // initializeContractManager registers one entry per
            // walletContractTimelocks; the wallet always has at least one.
            expect(contracts.length).toBeGreaterThan(0);
            const newest = contracts.sort(
                (a, b) => b.createdAt - a.createdAt
            )[0];
            expect(newest.script).toBe(wallet.defaultContractScript);

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
                "getNextSigningDescriptor"
            );
            const wallet = await makeHdWallet();

            const scriptBefore = wallet.defaultContractScript;
            const manager = await wallet.getContractManager();

            // Reset the spy AFTER the boot allocation so we count only
            // rotation-driven calls.
            rotateSpy.mockClear();

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
            expect(state?.settings?.hd.lastIndexUsed).toBe(1);

            rotateSpy.mockRestore();
            await wallet.dispose();
        });

        it("registers a new default contract on rotation while keeping the old one active", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const scriptBefore = wallet.defaultContractScript;
            const manager = await wallet.getContractManager();

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
            await (wallet as any)._hdRotationChain;

            const after = await contractRepo.getContracts({
                type: "default",
                state: "active",
            });
            const scripts = after.map((c) => c.script);
            // Both the original (scriptBefore) and the new
            // (defaultContractScript) entries are still active.
            expect(scripts).toContain(scriptBefore);
            expect(scripts).toContain(wallet.defaultContractScript);

            await wallet.dispose();
        });

        it("ignores vtxo_received for other contract scripts", async () => {
            const rotateSpy = vi.spyOn(
                HDDescriptorProvider.prototype,
                "getNextSigningDescriptor"
            );
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();
            rotateSpy.mockClear();

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
                "getNextSigningDescriptor"
            );
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();
            rotateSpy.mockClear();

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
        it("second wallet on the same repos reads the rotated address from the contract repo", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const first = await makeHdWallet(walletRepo, contractRepo);

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

            // Restart on the same repos — boot should land on the rotated
            // address by querying the contract repo for active default
            // contracts and picking the most recent.
            const second = await makeHdWallet(walletRepo, contractRepo);
            const restoredAddr = await second.getAddress();
            expect(restoredAddr).toBe(addrV1);
            await second.dispose();
        });
    });

    describe("dispose", () => {
        it("unsubscribes the rotation handler", async () => {
            const rotateSpy = vi.spyOn(
                HDDescriptorProvider.prototype,
                "getNextSigningDescriptor"
            );
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();
            const scriptBefore = wallet.defaultContractScript;

            await wallet.dispose();
            rotateSpy.mockClear();

            // After dispose, firing an event should not trigger rotation
            // (the callback was removed).
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
            expect(rotateSpy).not.toHaveBeenCalled();
            rotateSpy.mockRestore();
        });
    });
});
