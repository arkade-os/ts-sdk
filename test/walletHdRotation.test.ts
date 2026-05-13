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
        // `'auto'` is currently a synonym for `'static'`. Tests in
        // this file exercise the HD-rotation path, so they must opt
        // in explicitly.
        walletMode: "hd",
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

        it("does not tag boot baseline contracts as wallet-receive", async () => {
            // Index-0 baseline contracts (default + delegate × every
            // walletContractTimelock) are registered as always-active
            // but stay UNTAGGED. The `metadata.source = 'wallet-receive'`
            // tag is reserved for contracts created by rotation — that's
            // how the next-session boot lookup distinguishes "we've
            // rotated to a new display address" from "this is the
            // baseline".
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const all = await contractRepo.getContracts({});
            expect(all.length).toBeGreaterThan(0);
            const tagged = all.filter(
                (c) => c.metadata?.source === "wallet-receive"
            );
            expect(tagged).toHaveLength(0);

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
            await (wallet as any)._receiveRotator?.drain();

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
            await (wallet as any)._receiveRotator?.drain();

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
            await (wallet as any)._receiveRotator?.drain();

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
            await (wallet as any)._receiveRotator?.drain();

            expect(rotateSpy).not.toHaveBeenCalled();
            rotateSpy.mockRestore();
            await wallet.dispose();
        });

        it("createContract failure during rotation does NOT mutate the wallet's displayed tapscript", async () => {
            // Regression for the Arkana / CodeRabbit ordering finding:
            // `rotate()` used to swap `wallet.offchainTapscript` to the
            // new pubkey BEFORE calling `createContract`. If that
            // registration threw, the wallet displayed an unwatched
            // address. The fixed `rotate()` builds the new tapscript
            // locally, registers the contract, and only THEN commits
            // the mutation — so a failed registration leaves the
            // displayed address pointing at the still-registered one.
            const wallet = await makeHdWallet();
            const scriptBefore = wallet.defaultContractScript;
            const addrBefore = await wallet.getAddress();

            const manager = await wallet.getContractManager();
            const createSpy = vi
                .spyOn(manager, "createContract")
                .mockRejectedValueOnce(new Error("simulated repo failure"));

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
            await (wallet as any)._receiveRotator?.drain();

            // The wallet still displays the pre-rotation address. The
            // contract for the OLD script remains the registered one.
            expect(wallet.defaultContractScript).toBe(scriptBefore);
            expect(await wallet.getAddress()).toBe(addrBefore);
            expect(createSpy).toHaveBeenCalledTimes(1);

            createSpy.mockRestore();
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
            await (first as any)._receiveRotator?.drain();

            const addrV1 = await first.getAddress();
            expect(addrV1).not.toBe(addrV0);
            await first.dispose();

            // Restart on the same repos — boot looks up the
            // most-recent active contract whose
            // `metadata.source === 'wallet-receive'` and uses its
            // pubkey for the new offchain tapscript.
            const second = await makeHdWallet(walletRepo, contractRepo);
            const restoredAddr = await second.getAddress();
            expect(restoredAddr).toBe(addrV1);
            await second.dispose();
        });

        it("second boot WITHOUT rotation keeps the same address (no index drift)", async () => {
            // Regression for Arkana / CodeRabbit finding: the boot
            // path used to call `getNextSigningDescriptor()` whenever
            // no tagged display contract existed. On a repo that's
            // never seen a rotation, that meant burning a fresh HD
            // index per restart — and the displayed address would
            // drift every session. `defaultBoot` now peeks the
            // already-allocated index when no tagged contract is
            // present.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();

            const first = await makeHdWallet(walletRepo, contractRepo);
            const firstAddr = await first.getAddress();
            const firstStateAfter = await walletRepo.getWalletState();
            expect(firstStateAfter?.settings?.hd?.lastIndexUsed).toBe(0);
            await first.dispose();

            // Restart on the same repos with no rotation in between.
            // Boot must re-derive the existing index, NOT advance.
            const second = await makeHdWallet(walletRepo, contractRepo);
            const secondAddr = await second.getAddress();
            const secondStateAfter = await walletRepo.getWalletState();
            expect(secondAddr).toBe(firstAddr);
            expect(secondStateAfter?.settings?.hd?.lastIndexUsed).toBe(0);
            await second.dispose();
        });

        it("first rotation does NOT deactivate the index-0 baseline", async () => {
            // The baseline is the wallet's permanent address. Even
            // though the FIRST rotation creates a new tagged display
            // contract, the baseline (untagged) must stay `active`.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const baselineScript = wallet.defaultContractScript;

            const manager = await wallet.getContractManager();
            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: baselineScript,
                vtxos: [],
                contract: { script: baselineScript } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript
            );
            expect(baseline).toBeDefined();
            expect(baseline!.state).toBe("active");

            await wallet.dispose();
        });

        it("second rotation deactivates the previous tagged display contract", async () => {
            // Privacy + watch-set hygiene: once we've moved past a
            // tagged display address, we stop accepting new arrivals
            // there. The watcher keeps tracking it as long as it has
            // unspent VTXOs, but `state: 'inactive'` filters it out of
            // future `pickActiveReceive` lookups and shrinks the
            // long-term watch surface.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const baselineScript = wallet.defaultContractScript;
            const manager = await wallet.getContractManager();

            // Rotation 1: baseline → tagged-1.
            const fireEvent = (script: string) => {
                const event: ContractEvent = {
                    type: "vtxo_received",
                    contractScript: script,
                    vtxos: [],
                    contract: { script } as never,
                    timestamp: Date.now(),
                };
                for (const cb of (manager as any).eventCallbacks as Set<
                    (e: ContractEvent) => void
                >) {
                    cb(event);
                }
            };
            fireEvent(baselineScript);
            await (wallet as any)._receiveRotator?.drain();
            const tagged1Script = wallet.defaultContractScript;
            expect(tagged1Script).not.toBe(baselineScript);

            // Rotation 2: tagged-1 → tagged-2. tagged-1 must be retired.
            fireEvent(tagged1Script);
            await (wallet as any)._receiveRotator?.drain();
            const tagged2Script = wallet.defaultContractScript;
            expect(tagged2Script).not.toBe(tagged1Script);

            const tagged1 = (await contractRepo.getContracts({})).find(
                (c) => c.script === tagged1Script
            );
            expect(tagged1).toBeDefined();
            expect(tagged1!.state).toBe("inactive");

            // Baseline still active. tagged-2 is the new active display.
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript
            );
            expect(baseline!.state).toBe("active");
            const tagged2 = (await contractRepo.getContracts({})).find(
                (c) => c.script === tagged2Script
            );
            expect(tagged2!.state).toBe("active");
            expect(tagged2!.metadata?.source).toBe("wallet-receive");

            await wallet.dispose();
        });

        it("does NOT re-register the multi-timelock matrix at a rotated pubkey on reboot", async () => {
            // Design: the multi-timelock matrix (default + delegate ×
            // every walletContractTimelocks entry) is bound to INDEX 0
            // — the identity's x-only pubkey. Rotated display contracts
            // are intentionally single-timelock-single-pubkey. A reboot
            // after rotation must keep the matrix at index 0 and NOT
            // expand it into a multi-timelock set at the rotated pubkey
            // (that would dilute the "index-0 baseline" guarantee).
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();

            const first = await makeHdWallet(walletRepo, contractRepo);
            const baselineScript = first.defaultContractScript;

            // Rotate once so the next boot has a tagged display contract.
            const manager = await first.getContractManager();
            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: baselineScript,
                vtxos: [],
                contract: { script: baselineScript } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }
            await (first as any)._receiveRotator?.drain();
            const rotatedScript = first.defaultContractScript;
            expect(rotatedScript).not.toBe(baselineScript);
            await first.dispose();

            // Boot a second wallet on the same repos. Its display is
            // the rotated pubkey. `initializeContractManager` runs
            // again and must register the matrix at the IDENTITY
            // pubkey, not at the rotated pubkey.
            const beforeCount = (await contractRepo.getContracts({})).length;
            const second = await makeHdWallet(walletRepo, contractRepo);
            await second.getContractManager();
            const all = await contractRepo.getContracts({});

            // The rotated display is exactly ONE tagged contract.
            const tagged = all.filter(
                (c) => c.metadata?.source === "wallet-receive"
            );
            expect(tagged).toHaveLength(1);
            expect(tagged[0].script).toBe(rotatedScript);

            // The rotated pubkey appears ONLY in the tagged display
            // contract — never duplicated across timelocks. (Each
            // contract in `all` either matches the baseline-script
            // family or is the single tagged display.)
            const rotatedFamily = all.filter((c) => c.script === rotatedScript);
            expect(rotatedFamily).toHaveLength(1);
            expect(rotatedFamily[0].metadata?.source).toBe("wallet-receive");

            // Re-registering the matrix at boot is idempotent: the
            // second boot did NOT add new contracts at the rotated
            // pubkey (the matrix at index 0 may be re-written but
            // contract count for the rotated family stays at 1).
            expect(all.length).toBe(beforeCount);

            await second.dispose();
        });

        it("index-0 baseline contracts stay active and untagged after rotation", async () => {
            // The user-facing guarantee: addresses derived from index 0
            // (the identity's xOnlyPublicKey) keep crediting the wallet
            // even after the display has rotated to index 1+. The
            // baseline contracts must (a) still be `active` in the repo
            // and (b) not carry the `wallet-receive` tag (only the
            // rotated contract does).
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const baselineScript = wallet.defaultContractScript;

            // Drive one rotation.
            const manager = await wallet.getContractManager();
            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: baselineScript,
                vtxos: [],
                contract: { script: baselineScript } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<
                (e: ContractEvent) => void
            >) {
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            // Display has moved to index-1, but the baseline contract
            // at index 0 is still in the repo, still active, still
            // untagged.
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript
            );
            expect(baseline).toBeDefined();
            expect(baseline!.state).toBe("active");
            expect(baseline!.metadata?.source).toBeUndefined();

            // Exactly one tagged contract exists — the rotated display.
            const tagged = (await contractRepo.getContracts({})).filter(
                (c) => c.metadata?.source === "wallet-receive"
            );
            expect(tagged).toHaveLength(1);
            expect(tagged[0].script).not.toBe(baselineScript);

            await wallet.dispose();
        });

        it("second wallet ignores active default contracts without the source tag", async () => {
            // Defensive: make sure the boot path is keyed off the
            // source tag, not "any active default contract". An
            // unrelated active default contract (e.g. one created by
            // an external integration that reused this repo) must NOT
            // be picked up as the wallet's display address.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();

            // Pre-seed with a stranger's active default contract — it
            // has the same serverPubKey shape but no source tag.
            await contractRepo.saveContract({
                type: "default",
                params: {
                    pubKey: "0000000000000000000000000000000000000000000000000000000000000000",
                    serverPubKey:
                        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                    csvTimelock: "144",
                },
                script: "ff".repeat(34),
                address: "intruder",
                state: "active",
                createdAt: Date.now(),
            });

            const wallet = await makeHdWallet(walletRepo, contractRepo);
            // Boot allocated index 0 (no tagged contract was found).
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd?.lastIndexUsed).toBe(0);
            await wallet.dispose();
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

    /**
     * `walletMode` is the polymorphic explicit knob that replaces
     * today's implicit `isHDCapableIdentity(identity)` probe. It accepts
     * the strings `'auto' | 'static' | 'hd'`, or a {@link DescriptorProvider}
     * instance directly. These tests cover the resolver matrix in
     * `resolveDescriptorProvider`.
     */
    describe("walletMode", () => {
        // Minimal fake provider that returns a sequence of static
        // `tr(pubkey)` descriptors. `getNextSigningDescriptor` is the
        // only method the wallet actually calls during boot/rotation;
        // the rest exist to satisfy the `DescriptorProvider` interface.
        function fakeProvider(pubkeysHex: string[]) {
            let cursor = 0;
            return {
                getNextSigningDescriptor: vi.fn(async () => {
                    const next = pubkeysHex[cursor++];
                    if (!next) throw new Error("provider exhausted");
                    return `tr(${next})`;
                }),
                isOurs: vi.fn(() => true),
                signWithDescriptor: vi.fn(async () => []),
                signMessageWithDescriptor: vi.fn(async () => new Uint8Array()),
            };
        }

        const PUBKEY_A =
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        const PUBKEY_B =
            "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

        it("'static' skips HD wiring even for HD-capable identities", async () => {
            const repo = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: MnemonicIdentity.fromMnemonic(MNEMONIC, {
                    isMainnet: false,
                }),
                walletMode: "static",
                arkServerUrl: "http://localhost:7070",
                storage: {
                    walletRepository: repo,
                    contractRepository: new InMemoryContractRepository(),
                },
            });
            // No `hd` settings persisted — the resolver short-circuited
            // before HDDescriptorProvider.create.
            const state = await repo.getWalletState();
            expect(state?.settings?.hd).toBeUndefined();
            await wallet.dispose();
        });

        it("default ('auto') currently behaves like 'static' for HD-capable identities", async () => {
            // Until HD rotation has more soak time, the default behaviour
            // is conservative: an HD-capable identity gets the static
            // path unless the caller explicitly opts into HD via
            // `walletMode: 'hd'` or a supplied DescriptorProvider. This
            // test locks that in so a future change to flip the default
            // is loud and intentional.
            const repo = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: MnemonicIdentity.fromMnemonic(MNEMONIC, {
                    isMainnet: false,
                }),
                // walletMode intentionally omitted → defaults to 'auto'.
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

        it("'hd' on a SingleKey identity throws with a clear error", async () => {
            await expect(
                Wallet.create({
                    identity: SingleKey.fromHex(
                        "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2"
                    ),
                    walletMode: "hd",
                    arkServerUrl: "http://localhost:7070",
                    storage: {
                        walletRepository: new InMemoryWalletRepository(),
                        contractRepository: new InMemoryContractRepository(),
                    },
                })
            ).rejects.toThrow(/walletMode 'hd' requires/i);
        });

        it("a supplied DescriptorProvider drives rotation even on a SingleKey identity", async () => {
            // The escape hatch: pass any DescriptorProvider directly as
            // `walletMode`. The identity must still be able to sign for
            // the pubkey the provider returns; that's the caller's
            // responsibility.
            const provider = fakeProvider([PUBKEY_A, PUBKEY_B]);
            const repo = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: SingleKey.fromHex(
                    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2"
                ),
                walletMode: provider as never,
                arkServerUrl: "http://localhost:7070",
                storage: {
                    walletRepository: repo,
                    contractRepository: new InMemoryContractRepository(),
                },
            });
            // Boot allocated the first descriptor through the supplied
            // provider. The built-in HD persistence (`settings.hd`) must
            // NOT be touched — that's owned by HDDescriptorProvider, not
            // by foreign providers.
            expect(provider.getNextSigningDescriptor).toHaveBeenCalledTimes(1);
            const state = await repo.getWalletState();
            expect(state?.settings?.hd).toBeUndefined();
            await wallet.dispose();
        });

        it("a supplied DescriptorProvider's errors propagate (no silent fallback)", async () => {
            // `'auto'`'s silent-fallback only applies to the built-in HD
            // path. An explicit provider always surfaces failures so
            // HSM / external-signer misconfigs are loud.
            const provider = {
                getNextSigningDescriptor: vi.fn(async () => {
                    throw new Error("HSM unavailable");
                }),
                isOurs: vi.fn(() => true),
                signWithDescriptor: vi.fn(async () => []),
                signMessageWithDescriptor: vi.fn(async () => new Uint8Array()),
            };
            await expect(
                Wallet.create({
                    identity: SingleKey.fromHex(
                        "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2"
                    ),
                    walletMode: provider as never,
                    arkServerUrl: "http://localhost:7070",
                    storage: {
                        walletRepository: new InMemoryWalletRepository(),
                        contractRepository: new InMemoryContractRepository(),
                    },
                })
            ).rejects.toThrow(/HSM unavailable/);
        });
    });
});
