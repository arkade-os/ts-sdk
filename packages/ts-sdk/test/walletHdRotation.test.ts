import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex, base64 } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    DefaultVtxo,
    MissingSigningDescriptorError,
    buildOffchainTx,
    type BatchSignableIdentity,
    type Identity,
    type SignRequest,
} from "../src";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { WalletReceiveRotator } from "../src/wallet/walletReceiveRotator";
import type { Contract, ContractEvent, ExtendedVirtualCoin } from "../src";

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
const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

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

// Mock fetch
const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const MockEventSource = vi.fn().mockImplementation((url: string) => ({
    url,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
}));

beforeEach(() => {
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
        if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
        // Esplora-style onchain calls (boarding coins etc.) — empty array.
        return reply([]);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeHdWallet(
    walletRepo?: InMemoryWalletRepository,
    contractRepo?: InMemoryContractRepository,
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
            contractRepository: contractRepo ?? new InMemoryContractRepository(),
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
            const newest = contracts.sort((a, b) => b.createdAt - a.createdAt)[0];
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
            const tagged = all.filter((c) => c.metadata?.source === "wallet-receive");
            expect(tagged).toHaveLength(0);

            await wallet.dispose();
        });

        it("does NOT install HD provider for SingleKey identities", async () => {
            const repo = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: SingleKey.fromHex(
                    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
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

        it("a failing install leaves no cached manager and retries on next call", async () => {
            // PR #489 review #2: `getVtxoManager` used to assign
            // `_vtxoManager` + flip `_receiveRotatorInstalled` BEFORE
            // awaiting `install()`. A transient install failure would
            // then cache the half-initialised state and silently disable
            // rotation for the wallet's lifetime. Post-fix: both
            // assignments happen only AFTER install resolves; a retry
            // on the same instance succeeds when the cause clears.
            //
            // `Wallet.create` calls `getVtxoManager` eagerly, so we
            // build a happy wallet first and then reset its rotator
            // bookkeeping to simulate "fresh, install not yet run".
            const wallet = await makeHdWallet();
            (wallet as any)._vtxoManager = undefined;
            (wallet as any)._vtxoManagerInitializing = undefined;
            (wallet as any)._receiveRotatorInstalled = false;

            const installSpy = vi
                .spyOn(WalletReceiveRotator.prototype, "install")
                .mockRejectedValueOnce(new Error("simulated install failure"))
                .mockResolvedValueOnce(undefined);

            await expect(wallet.getVtxoManager()).rejects.toThrow(/simulated install failure/);
            // Neither side of the cache was set.
            expect((wallet as any)._vtxoManager).toBeUndefined();
            expect((wallet as any)._receiveRotatorInstalled).toBe(false);

            // Second call: install succeeds, cache populates.
            const manager = await wallet.getVtxoManager();
            expect(manager).toBeDefined();
            expect((wallet as any)._receiveRotatorInstalled).toBe(true);
            expect(installSpy).toHaveBeenCalledTimes(2);

            installSpy.mockRestore();
            await wallet.dispose();
        });
    });

    describe("rotation", () => {
        it("advances the receive index when vtxo_received fires for the current contract", async () => {
            const rotateSpy = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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
            const rotateSpy = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            expect(rotateSpy).not.toHaveBeenCalled();
            rotateSpy.mockRestore();
            await wallet.dispose();
        });

        it("ignores non-vtxo_received event types", async () => {
            const rotateSpy = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");
            const wallet = await makeHdWallet();
            const manager = await wallet.getContractManager();
            rotateSpy.mockClear();

            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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

        it("skips subsequent events within the backoff window after a rotation failure", async () => {
            // PR #489 review #6: a broken provider used to make every
            // incoming `vtxo_received` re-attempt `getNextSigningDescriptor`
            // + `createContract` immediately. With exponential backoff
            // in place, a second event arriving within the backoff
            // window must skip the rotation entirely.
            const wallet = await makeHdWallet();
            const scriptBefore = wallet.defaultContractScript;

            const manager = await wallet.getContractManager();
            const createSpy = vi
                .spyOn(manager, "createContract")
                .mockRejectedValue(new Error("simulated repo failure"));

            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: scriptBefore,
                vtxos: [],
                contract: { script: scriptBefore } as never,
                timestamp: Date.now(),
            };
            // Fire the same event twice. The first triggers a rotate
            // that fails (counter = 1, backoff window opens). The
            // second arrives inside that window and must short-circuit
            // — no second `createContract` call.
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
                cb(event);
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            expect(createSpy).toHaveBeenCalledTimes(1);
            // Displayed tapscript still pinned to pre-rotation script.
            expect(wallet.defaultContractScript).toBe(scriptBefore);

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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript,
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
                (c) => c.script === tagged1Script,
            );
            expect(tagged1).toBeDefined();
            expect(tagged1!.state).toBe("inactive");

            // Baseline still active. tagged-2 is the new active display.
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript,
            );
            expect(baseline!.state).toBe("active");
            const tagged2 = (await contractRepo.getContracts({})).find(
                (c) => c.script === tagged2Script,
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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
            const tagged = all.filter((c) => c.metadata?.source === "wallet-receive");
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            // Display has moved to index-1, but the baseline contract
            // at index 0 is still in the repo, still active, still
            // untagged.
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript,
            );
            expect(baseline).toBeDefined();
            expect(baseline!.state).toBe("active");
            expect(baseline!.metadata?.source).toBeUndefined();

            // Exactly one tagged contract exists — the rotated display.
            const tagged = (await contractRepo.getContracts({})).filter(
                (c) => c.metadata?.source === "wallet-receive",
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
        it("rethrows a rotator-disposal error while still disposing the manager", async () => {
            // PR #489 review #3: `await this._receiveRotator?.dispose()`
            // used to short-circuit teardown — a rejection there would
            // leak the VtxoManager + its watcher. Now the rotator
            // error is captured, manager + super disposal still run,
            // and the captured error is rethrown at the end so callers
            // still see the failure.
            const wallet = await makeHdWallet();
            const manager = await wallet.getVtxoManager();

            const rotator = (wallet as any)._receiveRotator as WalletReceiveRotator;
            const rotatorDisposeSpy = vi
                .spyOn(rotator, "dispose")
                .mockRejectedValueOnce(new Error("simulated rotator disposal failure"));
            const managerDisposeSpy = vi.spyOn(manager, "dispose");

            await expect(wallet.dispose()).rejects.toThrow(/simulated rotator disposal failure/);

            // The manager was disposed despite the rotator failure.
            expect(managerDisposeSpy).toHaveBeenCalledTimes(1);

            rotatorDisposeSpy.mockRestore();
            managerDisposeSpy.mockRestore();
        });

        it("unsubscribes the rotation handler", async () => {
            const rotateSpy = vi.spyOn(HDDescriptorProvider.prototype, "getNextSigningDescriptor");
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
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
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

        const PUBKEY_A = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        const PUBKEY_B = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

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

        it("default ('auto') currently behaves like 'static' for HD-capable identities — TODO(hd-maturation): flip me back when re-enabling auto-probe", async () => {
            // TEMPORARY DEFAULT — short-term safety while HD rotation
            // matures. An HD-capable identity gets the static path
            // unless the caller explicitly opts into HD via
            // `walletMode: 'hd'` or a supplied DescriptorProvider.
            //
            // This test is the explicit gate that locks the behaviour
            // in. Re-enabling identity-probing under `'auto'` MUST flip
            // this test in the same commit (the assertion below
            // captures the current short-term contract; a future
            // diff that re-enables `'auto'` will fail here, forcing
            // the author to acknowledge the behaviour change).
            //
            // See `TODO(hd-maturation)` in
            // `src/wallet/walletReceiveRotator.ts:resolveDescriptorProvider`
            // for the flip-back criteria.
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
                        "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
                    ),
                    walletMode: "hd",
                    arkServerUrl: "http://localhost:7070",
                    storage: {
                        walletRepository: new InMemoryWalletRepository(),
                        contractRepository: new InMemoryContractRepository(),
                    },
                }),
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
                    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
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
                        "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
                    ),
                    walletMode: provider as never,
                    arkServerUrl: "http://localhost:7070",
                    storage: {
                        walletRepository: new InMemoryWalletRepository(),
                        contractRepository: new InMemoryContractRepository(),
                    },
                }),
            ).rejects.toThrow(/HSM unavailable/);
        });
    });

    /**
     * Spending paths after a receive rotation. Each test rotates the
     * wallet to a fresh tagged display contract, builds an
     * `ExtendedVirtualCoin` whose script matches that rotated contract,
     * exercises a signing surface, and asserts the resulting PSBT
     * carries a `tapScriptSig` keyed to the rotated pubkey.
     *
     * Regression for the reported errors:
     *   - `INVALID_PSBT_INPUT (5): missing tapscript spend sig in ark
     *     tx input 0` (sends)
     *   - `INVALID_INTENT_PROOF (23): input 0 has no tapscript signatures`
     *     (auto-renewal)
     */
    describe("signing after rotation", () => {
        // mockArkInfo.signerPubkey is the compressed form (0x02 prefix).
        // Strip the byte to match how `Wallet.create` materializes
        // x-only pubkeys for DefaultVtxo.Script construction.
        const SERVER_PUBKEY = hex.decode(SERVER_PUBKEY_HEX).slice(1);

        // Fire one `vtxo_received` and wait for the rotation to settle.
        // Returns the rotated default contract record.
        async function rotateOnce(
            wallet: Wallet,
            contractRepo: InMemoryContractRepository,
        ): Promise<Contract> {
            const scriptBefore = wallet.defaultContractScript;
            const manager = await wallet.getContractManager();
            const event: ContractEvent = {
                type: "vtxo_received",
                contractScript: scriptBefore,
                vtxos: [],
                contract: { script: scriptBefore } as never,
                timestamp: Date.now(),
            };
            for (const cb of (manager as any).eventCallbacks as Set<(e: ContractEvent) => void>) {
                cb(event);
            }
            await (wallet as any)._receiveRotator?.drain();

            const rotatedScript = wallet.defaultContractScript;
            expect(rotatedScript).not.toBe(scriptBefore);

            const rotated = (await contractRepo.getContracts({})).find(
                (c) => c.script === rotatedScript && c.metadata?.source === "wallet-receive",
            );
            if (!rotated) {
                throw new Error("rotated contract not found in repo");
            }
            return rotated;
        }

        function makeVtxoForContract(contract: Contract, txid?: string): ExtendedVirtualCoin {
            const params = contract.params;
            const pubKey = hex.decode(params.pubKey);
            const serverPubKey = hex.decode(params.serverPubKey);
            const csvBlocks = BigInt(params.csvTimelock);
            const tapscript = new DefaultVtxo.Script({
                pubKey,
                serverPubKey,
                csvTimelock: { value: csvBlocks, type: "blocks" },
            });
            return {
                txid: txid ?? "11".repeat(32),
                vout: 0,
                value: 50_000,
                status: { confirmed: true },
                virtualStatus: { state: "settled" },
                createdAt: new Date(),
                isUnrolled: false,
                isSpent: false,
                isSwept: false,
                isPreconfirmed: false,
                spentBy: "",
                commitmentTxIds: [],
                script: hex.encode(tapscript.pkScript),
                forfeitTapLeafScript: tapscript.forfeit(),
                intentTapLeafScript: tapscript.forfeit(),
                tapTree: tapscript.encode(),
            };
        }

        // Pull every signing pubkey off a given input's tapScriptSig
        // entries (PSBT canonical: `[[ {pubKey, leafHash}, signature ], ...]`).
        function tapscriptSignerPubkeysHex(
            txOrPsbtBase64: Transaction | string,
            inputIndex: number,
        ): string[] {
            const tx =
                typeof txOrPsbtBase64 === "string"
                    ? Transaction.fromPSBT(base64.decode(txOrPsbtBase64))
                    : txOrPsbtBase64;
            const sigs = tx.getInput(inputIndex).tapScriptSig ?? [];
            return sigs.map(([data]) => hex.encode(data.pubKey));
        }

        it("intent proof after rotation: tx-input 0 AND tx-input 1 carry a tapScriptSig keyed to coin[0]'s rotated pubkey", async () => {
            // Direct regression for `INVALID_INTENT_PROOF (23): input 0
            // has no tapscript signatures`. `Intent.create` lays out
            // tx-input 0 as a synthetic toSpend reference whose
            // witnessUtxo.script is copied from coin[0]'s real
            // pkScript — both tx-input 0 and tx-input 1 must therefore
            // carry coin[0]'s pubkey signature.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const rotated = await rotateOnce(wallet, contractRepo);
            const rotatedPubKeyHex = rotated.params.pubKey;
            const baselinePubKeyHex = hex.encode(await wallet.identity.xOnlyPublicKey());
            // Sanity: rotation must have produced a non-baseline pubkey,
            // otherwise the test isn't exercising the descriptor branch.
            expect(rotatedPubKeyHex).not.toBe(baselinePubKeyHex);

            const coin = makeVtxoForContract(rotated);
            const intent = await wallet.makeRegisterIntentSignature([coin], [], [], []);
            const proof = Transaction.fromPSBT(base64.decode(intent.proof));

            expect(tapscriptSignerPubkeysHex(proof, 0)).toContain(rotatedPubKeyHex);
            expect(tapscriptSignerPubkeysHex(proof, 1)).toContain(rotatedPubKeyHex);

            await wallet.dispose();
        });

        it("delete-intent proof after rotation also signs both inputs with the rotated pubkey", async () => {
            // `safeRegisterIntent` uses `makeDeleteIntentSignature` to
            // recover from `duplicated input`. If that path silently
            // produced an unsigned PSBT, send-after-rotation would
            // wedge on the retry loop instead of recovering.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const rotated = await rotateOnce(wallet, contractRepo);
            const coin = makeVtxoForContract(rotated);

            const intent = await wallet.makeDeleteIntentSignature([coin]);
            const proof = Transaction.fromPSBT(base64.decode(intent.proof));
            const rotatedPubKeyHex = rotated.params.pubKey;

            expect(tapscriptSignerPubkeysHex(proof, 0)).toContain(rotatedPubKeyHex);
            expect(tapscriptSignerPubkeysHex(proof, 1)).toContain(rotatedPubKeyHex);

            await wallet.dispose();
        });

        it("get-pending-tx intent proof after rotation signs with the rotated pubkey", async () => {
            // The auto-renewal recovery path in `finalizePendingTxs`
            // calls `makeGetPendingTxIntentSignature`. Same shape as
            // the other two intent helpers; if owner-routed signing
            // weren't wired in, recovery would also produce unsigned
            // proofs.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const rotated = await rotateOnce(wallet, contractRepo);
            const coin = makeVtxoForContract(rotated);

            const intent = await wallet.makeGetPendingTxIntentSignature([coin]);
            const proof = Transaction.fromPSBT(base64.decode(intent.proof));
            const rotatedPubKeyHex = rotated.params.pubKey;

            expect(tapscriptSignerPubkeysHex(proof, 0)).toContain(rotatedPubKeyHex);
            expect(tapscriptSignerPubkeysHex(proof, 1)).toContain(rotatedPubKeyHex);

            await wallet.dispose();
        });

        it("mixed baseline + rotated VTXO in one intent: each input is signed by its own pubkey", async () => {
            // Proves the sequential threading inside `InputSignerRouter`
            // accumulates signatures across groups: identity-signed
            // inputs and descriptor-signed inputs end up on the SAME
            // PSBT, not two clones whose signatures get lost.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            // Build a synthetic baseline contract record exactly as
            // initializeContractManager does, so the router can
            // resolve coin1.script → baseline contract → identity sign.
            const baselineScript = wallet.defaultContractScript;
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript,
            )!;
            expect(baseline.metadata?.source).toBeUndefined();

            const rotated = await rotateOnce(wallet, contractRepo);
            const baselineCoin = makeVtxoForContract(baseline, "aa".repeat(32));
            const rotatedCoin = makeVtxoForContract(rotated, "bb".repeat(32));
            // Order: rotated-coin FIRST so tx-input 0 (synthetic
            // toSpend) carries the rotated pubkey signature too;
            // tx-input 1 = rotated coin; tx-input 2 = baseline coin.
            const intent = await wallet.makeRegisterIntentSignature(
                [rotatedCoin, baselineCoin],
                [],
                [],
                [],
            );
            const proof = Transaction.fromPSBT(base64.decode(intent.proof));

            const rotatedPubKeyHex = rotated.params.pubKey;
            const baselinePubKeyHex = baseline.params.pubKey;

            // Tx-input 0 (toSpend) and tx-input 1 = coin[0] = rotated.
            expect(tapscriptSignerPubkeysHex(proof, 0)).toContain(rotatedPubKeyHex);
            expect(tapscriptSignerPubkeysHex(proof, 1)).toContain(rotatedPubKeyHex);
            // Tx-input 2 = coin[1] = baseline.
            expect(tapscriptSignerPubkeysHex(proof, 2)).toContain(baselinePubKeyHex);

            await wallet.dispose();
        });

        it("hard-error: default contract with non-baseline pubkey AND no signingDescriptor throws MissingSigningDescriptorError", async () => {
            // Legacy-record path: wallets that rotated under the
            // pre-fix HD branch carry contracts with `params.pubKey` set
            // but `metadata.signingDescriptor` absent. Silently falling
            // back to the identity's index-0 key would reproduce the
            // original bug; the helper must throw a typed error so
            // consumers can prompt the user to repair the record.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            // Inject a fake "rotated" contract whose pubkey ≠ baseline
            // and whose metadata is intentionally missing the
            // descriptor. Pubkey is a real, on-curve x-only key from
            // an unrelated test fixture so DefaultVtxo.Script accepts
            // it without throwing during script construction.
            const orphanPubKeyHex =
                "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === wallet.defaultContractScript,
            )!;
            const orphanScript = new DefaultVtxo.Script({
                pubKey: hex.decode(orphanPubKeyHex),
                serverPubKey: SERVER_PUBKEY,
                csvTimelock: {
                    value: BigInt(baseline.params.csvTimelock),
                    type: "blocks",
                },
            });
            const orphanScriptHex = hex.encode(orphanScript.pkScript);
            await contractRepo.saveContract({
                type: "default",
                params: {
                    pubKey: orphanPubKeyHex,
                    serverPubKey: baseline.params.serverPubKey,
                    csvTimelock: baseline.params.csvTimelock,
                },
                script: orphanScriptHex,
                address: orphanScript.address("tark", SERVER_PUBKEY).encode(),
                state: "active",
                createdAt: Date.now(),
                metadata: { source: "wallet-receive" }, // tag set, descriptor missing
            });

            const orphanCoin = makeVtxoForContract({
                ...baseline,
                params: {
                    ...baseline.params,
                    pubKey: orphanPubKeyHex,
                },
                script: orphanScriptHex,
            } as Contract);

            await expect(
                wallet.makeRegisterIntentSignature([orphanCoin], [], [], []),
            ).rejects.toBeInstanceOf(MissingSigningDescriptorError);

            // Re-throw to capture the typed instance and assert on its
            // exposed fields (test the contract on the error, not just
            // the message).
            try {
                await wallet.makeRegisterIntentSignature([orphanCoin], [], [], []);
                throw new Error("expected throw");
            } catch (err) {
                expect(err).toBeInstanceOf(MissingSigningDescriptorError);
                const e = err as MissingSigningDescriptorError;
                expect(e.contractScript).toBe(orphanScriptHex);
                expect(e.contractType).toBe("default");
            }

            await wallet.dispose();
        });

        it("an input with a script that matches no contract is left untouched (cosigner / connector behaviour)", async () => {
            // Mirror today's silent-skip for cosigner / connector
            // inputs: the router must not throw on an input whose
            // script doesn't resolve to any known contract.
            // Easiest way to exercise this is via the boarding-script
            // miss path: inject a coin whose script doesn't match
            // anything the wallet knows about, then assert the proof
            // still gets the rotated coin's signatures (and the unknown
            // coin's input has none).
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);
            const rotated = await rotateOnce(wallet, contractRepo);

            const rotatedCoin = makeVtxoForContract(rotated, "cc".repeat(32));
            // Cosigner-shape coin: a real-looking VTXO whose tapscript
            // isn't tracked by any contract in the repo (different
            // pubkey and wallet doesn't own it). Use an unrelated
            // x-only pubkey so the script is well-formed.
            const cosignerScript = new DefaultVtxo.Script({
                pubKey: hex.decode(
                    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
                ),
                serverPubKey: SERVER_PUBKEY,
                csvTimelock: {
                    value: BigInt(rotated.params.csvTimelock),
                    type: "blocks",
                },
            });
            const cosignerCoin: ExtendedVirtualCoin = {
                txid: "dd".repeat(32),
                vout: 0,
                value: 50_000,
                status: { confirmed: true },
                virtualStatus: { state: "settled" },
                createdAt: new Date(),
                isUnrolled: false,
                isSpent: false,
                script: hex.encode(cosignerScript.pkScript),
                forfeitTapLeafScript: cosignerScript.forfeit(),
                intentTapLeafScript: cosignerScript.forfeit(),
                tapTree: cosignerScript.encode(),
            };

            const intent = await wallet.makeRegisterIntentSignature(
                [rotatedCoin, cosignerCoin],
                [],
                [],
                [],
            );
            const proof = Transaction.fromPSBT(base64.decode(intent.proof));

            // Tx-input 0 / 1 = rotated coin → signed.
            expect(tapscriptSignerPubkeysHex(proof, 0)).toContain(rotated.params.pubKey);
            expect(tapscriptSignerPubkeysHex(proof, 1)).toContain(rotated.params.pubKey);
            // Tx-input 2 = cosigner-shape coin → no signatures (the
            // wallet doesn't own it; the router skipped it exactly the
            // way today's tx.sign would silently skip an unsignable
            // leaf).
            expect(tapscriptSignerPubkeysHex(proof, 2)).toEqual([]);

            await wallet.dispose();
        });

        it("buildAndSubmitOffchainTx after rotation: arkTx submitted to the server carries a tapScriptSig keyed to the rotated pubkey", async () => {
            // Direct regression for `INVALID_PSBT_INPUT (5): missing
            // tapscript spend sig in ark tx input 0`. arkTx inputs
            // spend checkpoint outputs whose `witnessUtxo.script` is
            // the checkpoint pkScript (server-unroll + collaborative-
            // closure combo) — *not* the source VTXO's contract
            // script. Without the per-input source-script jobs fed
            // into the router, the arkTx PSBT goes to the server
            // unsigned.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const rotated = await rotateOnce(wallet, contractRepo);
            const coin = makeVtxoForContract(rotated);

            // Capture the PSBT base64 the wallet hands to the server,
            // and short-circuit the rest of the round-trip so the test
            // doesn't need a live arkd. Round-trip the supplied
            // checkpoints back out unchanged so the per-checkpoint
            // re-sign path inside buildAndSubmitOffchainTx still has
            // valid PSBTs to rehydrate.
            let submittedArkTxB64: string | undefined;
            const submitSpy = vi
                .spyOn(wallet.arkProvider, "submitTx")
                .mockImplementation(async (arkTxB64, checkpointsB64) => {
                    submittedArkTxB64 = arkTxB64;
                    return {
                        arkTxid: "ee".repeat(32),
                        finalArkTx: arkTxB64,
                        signedCheckpointTxs: checkpointsB64,
                    };
                });
            const finalizeSpy = vi
                .spyOn(wallet.arkProvider, "finalizeTx")
                .mockResolvedValue(undefined);

            // Output script: any well-formed pkScript works since
            // submitTx is mocked. Use the wallet's own arkAddress so
            // we don't have to invent one.
            const outputs = [
                {
                    amount: BigInt(coin.value - 1000),
                    script: wallet.arkAddress.pkScript,
                },
            ];

            await wallet.buildAndSubmitOffchainTx([coin], outputs);

            expect(submitSpy).toHaveBeenCalledTimes(1);
            expect(finalizeSpy).toHaveBeenCalledTimes(1);
            expect(submittedArkTxB64).toBeDefined();

            const arkTx = Transaction.fromPSBT(base64.decode(submittedArkTxB64!));
            expect(tapscriptSignerPubkeysHex(arkTx, 0)).toContain(rotated.params.pubKey);

            submitSpy.mockRestore();
            finalizeSpy.mockRestore();
            await wallet.dispose();
        });

        it("buildAndSubmitOffchainTx baseline send: arkTx is signed by the identity's index-0 pubkey", async () => {
            // Sanity check that the arkTx-input owner mapping doesn't
            // regress baseline (non-rotated) sends, which were silently
            // unsigned by the same code path before the override was
            // added.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === wallet.defaultContractScript,
            )!;
            const baselinePubKeyHex = baseline.params.pubKey;
            const coin = makeVtxoForContract(baseline);

            let submittedArkTxB64: string | undefined;
            const submitSpy = vi
                .spyOn(wallet.arkProvider, "submitTx")
                .mockImplementation(async (arkTxB64, checkpointsB64) => {
                    submittedArkTxB64 = arkTxB64;
                    return {
                        arkTxid: "cc".repeat(32),
                        finalArkTx: arkTxB64,
                        signedCheckpointTxs: checkpointsB64,
                    };
                });
            const finalizeSpy = vi
                .spyOn(wallet.arkProvider, "finalizeTx")
                .mockResolvedValue(undefined);

            await wallet.buildAndSubmitOffchainTx(
                [coin],
                [
                    {
                        amount: BigInt(coin.value - 1000),
                        script: wallet.arkAddress.pkScript,
                    },
                ],
            );

            const arkTx = Transaction.fromPSBT(base64.decode(submittedArkTxB64!));
            expect(tapscriptSignerPubkeysHex(arkTx, 0)).toContain(baselinePubKeyHex);

            submitSpy.mockRestore();
            finalizeSpy.mockRestore();
            await wallet.dispose();
        });

        it("descriptor signing is opt-in: provider.signWithDescriptor is NOT called when every input matches the baseline", async () => {
            // Baseline-only spend (no rotation) must take the identity
            // arm — the descriptor provider is wired in but stays
            // untouched, preserving today's behaviour for static / first
            // boot wallets.
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const provider = (wallet as any)._descriptorProvider as HDDescriptorProvider;
            const signSpy = vi.spyOn(provider, "signWithDescriptor");

            const baselineScript = wallet.defaultContractScript;
            const baseline = (await contractRepo.getContracts({})).find(
                (c) => c.script === baselineScript,
            )!;
            const coin = makeVtxoForContract(baseline);

            const intent = await wallet.makeRegisterIntentSignature([coin], [], [], []);
            const proof = Transaction.fromPSBT(base64.decode(intent.proof));

            expect(signSpy).not.toHaveBeenCalled();
            // Baseline pubkey signs both inputs as expected.
            expect(tapscriptSignerPubkeysHex(proof, 0)).toContain(baseline.params.pubKey);
            expect(tapscriptSignerPubkeysHex(proof, 1)).toContain(baseline.params.pubKey);

            signSpy.mockRestore();
            await wallet.dispose();
        });
    });
});

describe("Wallet batch signing (BatchSignableIdentity)", () => {
    // The well-known generator-point key: privkey = 1, whose x-only pubkey
    // is exactly `mockArkInfo.signerPubkey` (SERVER_PUBKEY_HEX). Lets the
    // tests produce a REAL server `tapScriptSig` on a checkpoint's
    // collaborative leaf, so the merge / recovery paths run against genuine
    // signatures rather than fabricated ones.
    const SERVER_KEY = SingleKey.fromHex(
        "0000000000000000000000000000000000000000000000000000000000000001",
    );

    // Sign input 0 of a checkpoint PSBT with the server key on the
    // collaborative (forfeit) leaf and return the re-encoded base64 PSBT.
    async function serverSignCheckpoint(checkpointB64: string): Promise<string> {
        const tx = Transaction.fromPSBT(base64.decode(checkpointB64));
        const signed = await SERVER_KEY.sign(tx, [0]);
        return base64.encode(signed.toPSBT());
    }

    // Pubkeys (x-only hex) that carry a tapScriptSig on the given input.
    function tapscriptSignerPubkeysHex(psbtB64: string, inputIndex: number): string[] {
        const tx = Transaction.fromPSBT(base64.decode(psbtB64));
        return (tx.getInput(inputIndex).tapScriptSig ?? []).map(([data]) =>
            hex.encode(data.pubKey),
        );
    }

    // Decorate an Identity with a tracked `signMultiple` that delegates
    // each request to `base.sign`. Explicit per-method delegation —
    // spreading `base` doesn't carry prototype methods.
    function makeBatchSignable(base: Identity): BatchSignableIdentity & {
        signMultipleSpy: ReturnType<typeof vi.fn>;
        signSpy: ReturnType<typeof vi.fn>;
    } {
        const signSpy = vi.fn(async (tx: Transaction, idx?: number[]) => base.sign(tx, idx));
        const signMultipleSpy = vi.fn(async (requests: SignRequest[]) =>
            Promise.all(requests.map((r) => base.sign(r.tx, r.inputIndexes))),
        );
        return {
            xOnlyPublicKey: () => base.xOnlyPublicKey(),
            compressedPublicKey: () => base.compressedPublicKey(),
            signerSession: () => base.signerSession(),
            signMessage: (msg, type) => base.signMessage(msg, type),
            sign: signSpy as unknown as Identity["sign"],
            signMultiple: signMultipleSpy as unknown as BatchSignableIdentity["signMultiple"],
            signSpy,
            signMultipleSpy,
        };
    }

    async function makeStaticBatchWallet(contractRepo?: InMemoryContractRepository) {
        // Use a baseline SingleKey wallet (no HD rotation): every input
        // routes to the identity, so canBatch returns true and the batch
        // path is exercised.
        const base = SingleKey.fromHex(
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
        );
        const identity = makeBatchSignable(base);
        const wallet = await Wallet.create({
            identity,
            arkServerUrl: "http://localhost:7070",
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: contractRepo ?? new InMemoryContractRepository(),
            },
        });
        const getChainTipSpy = vi.spyOn(wallet.onchainProvider, "getChainTip").mockResolvedValue({
            height: 0,
            time: 0,
            hash: "00".repeat(32),
        });
        return { wallet, identity, base, getChainTipSpy };
    }

    function makeBaselineCoin(
        wallet: Awaited<ReturnType<typeof makeStaticBatchWallet>>["wallet"],
    ): ExtendedVirtualCoin {
        // Reuse the wallet's own offchainTapscript so the coin's source
        // script matches a registered baseline contract — the router needs
        // a contract match to route to identity (vs silently skip).
        const tapscript = (wallet as any).offchainTapscript as DefaultVtxo.Script;
        return {
            txid: "11".repeat(32),
            vout: 0,
            value: 50_000,
            status: { confirmed: true },
            virtualStatus: { state: "settled" },
            createdAt: new Date(),
            isUnrolled: false,
            isSpent: false,
            isSwept: false,
            isPreconfirmed: false,
            spentBy: "",
            commitmentTxIds: [],
            script: hex.encode(tapscript.pkScript),
            forfeitTapLeafScript: tapscript.forfeit(),
            intentTapLeafScript: tapscript.forfeit(),
            tapTree: tapscript.encode(),
        };
    }

    it("buildAndSubmitOffchainTx takes the batch path: signMultiple called once with arkTx + N checkpoints", async () => {
        const { wallet, identity } = await makeStaticBatchWallet();
        const coin = makeBaselineCoin(wallet);

        // Short-circuit at submitTx so the test focuses on the signing
        // dispatch and doesn't have to fabricate a server tapScriptSig to
        // satisfy `combineTapscriptSigs`. signMultiple runs *before*
        // submitTx in the batch path, so the spy assertions below capture
        // the full picture even though the call aborts here.
        const sentinel = new Error("STOP_AFTER_SUBMIT");
        vi.spyOn(wallet.arkProvider, "submitTx").mockRejectedValue(sentinel);

        await expect(
            wallet.buildAndSubmitOffchainTx(
                [coin],
                [
                    {
                        amount: BigInt(coin.value - 1000),
                        script: wallet.arkAddress.pkScript,
                    },
                ],
            ),
        ).rejects.toBe(sentinel);

        // One batch call covers arkTx + every checkpoint (here: 1 of each).
        expect(identity.signMultipleSpy).toHaveBeenCalledTimes(1);
        expect(identity.signMultipleSpy.mock.calls[0][0]).toHaveLength(2);

        // signMultiple is the one and only user-signing entry point on
        // this path — per-tx sign() must not be invoked.
        expect(identity.signSpy).not.toHaveBeenCalled();

        await wallet.dispose();
    });

    it("falls back to sequential when identity does not implement signMultiple", async () => {
        // Sanity check that the batch detection is conditional — a plain
        // Identity (no signMultiple) keeps the existing per-PSBT path.
        const base = SingleKey.fromHex(
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
        );
        const signSpy = vi.spyOn(base, "sign");
        const wallet = await Wallet.create({
            identity: base,
            arkServerUrl: "http://localhost:7070",
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
        });
        const coin = makeBaselineCoin(wallet);

        vi.spyOn(wallet.arkProvider, "submitTx").mockImplementation(
            async (arkTxB64, checkpointsB64) => ({
                arkTxid: "cc".repeat(32),
                finalArkTx: arkTxB64,
                signedCheckpointTxs: checkpointsB64,
            }),
        );
        vi.spyOn(wallet.arkProvider, "finalizeTx").mockResolvedValue(undefined);

        await wallet.buildAndSubmitOffchainTx(
            [coin],
            [
                {
                    amount: BigInt(coin.value - 1000),
                    script: wallet.arkAddress.pkScript,
                },
            ],
        );

        // arkTx + 1 checkpoint → 2 sign() invocations on the fallback.
        expect(signSpy).toHaveBeenCalledTimes(2);

        signSpy.mockRestore();
        await wallet.dispose();
    });

    it("batch send merge: finalized checkpoint carries BOTH server and user tapScriptSig", async () => {
        // Covers the merge step (`combineTapscriptSigs`) the other batch
        // test skips by aborting at submitTx. The user pre-signs the
        // unsigned checkpoints inside signMultiple; submitTx returns them
        // carrying the server's sig; the wallet must merge the two so the
        // checkpoint handed to finalizeTx is signed by BOTH parties.
        const { wallet, identity } = await makeStaticBatchWallet();
        const coin = makeBaselineCoin(wallet);
        const userXOnlyHex = hex.encode(await identity.xOnlyPublicKey());
        const serverXOnlyHex = hex.encode(await SERVER_KEY.xOnlyPublicKey());

        const submitSpy = vi
            .spyOn(wallet.arkProvider, "submitTx")
            .mockImplementation(async (arkTxB64, checkpointsB64) => ({
                arkTxid: "ab".repeat(32),
                finalArkTx: arkTxB64,
                // Server adds its share to the *unsigned* checkpoints it
                // was handed — exactly what arkd does in production.
                signedCheckpointTxs: await Promise.all(
                    checkpointsB64.map((c) => serverSignCheckpoint(c)),
                ),
            }));

        let finalizedCheckpoints: string[] | undefined;
        const finalizeSpy = vi
            .spyOn(wallet.arkProvider, "finalizeTx")
            .mockImplementation(async (_arkTxid, checkpoints) => {
                finalizedCheckpoints = checkpoints;
            });

        await wallet.buildAndSubmitOffchainTx(
            [coin],
            [{ amount: BigInt(coin.value - 1000), script: wallet.arkAddress.pkScript }],
        );

        // Batch path taken: one signMultiple, no per-tx sign.
        expect(identity.signMultipleSpy).toHaveBeenCalledTimes(1);
        expect(identity.signSpy).not.toHaveBeenCalled();

        expect(finalizedCheckpoints).toHaveLength(1);
        const signers = tapscriptSignerPubkeysHex(finalizedCheckpoints![0], 0);
        // The merge preserved the server sig AND added the user sig.
        expect(signers).toContain(serverXOnlyHex);
        expect(signers).toContain(userXOnlyHex);

        submitSpy.mockRestore();
        finalizeSpy.mockRestore();
        await wallet.dispose();
    });

    it("batch send merge: rejects when the server returns a mismatched checkpoint count", async () => {
        // The merge pairs the server's signedCheckpointTxs with the stashed
        // userSignedCheckpoints by index. A count mismatch must throw loudly
        // rather than silently drop the tail (short response) or blow up with
        // a cryptic undefined access mid-merge (long response).
        const { wallet } = await makeStaticBatchWallet();
        const coin = makeBaselineCoin(wallet);

        const submitSpy = vi
            .spyOn(wallet.arkProvider, "submitTx")
            .mockImplementation(async (arkTxB64, checkpointsB64) => {
                const signed = await Promise.all(
                    checkpointsB64.map((c) => serverSignCheckpoint(c)),
                );
                return {
                    arkTxid: "ab".repeat(32),
                    finalArkTx: arkTxB64,
                    // One more checkpoint than the user signed → mismatch.
                    signedCheckpointTxs: [...signed, signed[0]],
                };
            });
        const finalizeSpy = vi.spyOn(wallet.arkProvider, "finalizeTx").mockResolvedValue(undefined);

        await expect(
            wallet.buildAndSubmitOffchainTx(
                [coin],
                [{ amount: BigInt(coin.value - 1000), script: wallet.arkAddress.pkScript }],
            ),
        ).rejects.toThrow(/submitTx returned 2 checkpoints, expected 1/);

        // Guard fired before finalize — no malformed checkpoint reaches arkd.
        expect(finalizeSpy).not.toHaveBeenCalled();

        submitSpy.mockRestore();
        finalizeSpy.mockRestore();
        await wallet.dispose();
    });

    it("batch recovery: signs server-signed checkpoints once and preserves the server sig", async () => {
        // `finalizePendingTxs` batch path is NOT a restore of #395 — it is
        // new code that hands signMultiple a checkpoint that ALREADY carries
        // the server's tapScriptSig and uses the result directly (no merge).
        // It is correct only if the user signer preserves the pre-existing
        // server sig. This locks that contract in.
        const { wallet, identity } = await makeStaticBatchWallet();
        const coin = makeBaselineCoin(wallet);
        const userXOnlyHex = hex.encode(await identity.xOnlyPublicKey());
        const serverXOnlyHex = hex.encode(await SERVER_KEY.xOnlyPublicKey());

        // Build the checkpoint the same way the wallet does, then have the
        // server (and only the server) sign it — mimics what the server
        // returns from submitTx and persists for recovery.
        const offchain = buildOffchainTx(
            [{ ...coin, tapLeafScript: coin.forfeitTapLeafScript }],
            [{ amount: BigInt(coin.value - 1000), script: wallet.arkAddress.pkScript }],
            wallet.serverUnrollScript,
        );
        const serverCheckpointB64 = await serverSignCheckpoint(
            base64.encode(offchain.checkpoints[0].toPSBT()),
        );
        // Sanity: the persisted checkpoint carries the server sig and NOT
        // the user sig (recovery is responsible for adding the user share).
        expect(tapscriptSignerPubkeysHex(serverCheckpointB64, 0)).toEqual([serverXOnlyHex]);

        // Pretend a previous send was interrupted after submit.
        await (wallet as any).setPendingTxFlag(true);
        const getPendingSpy = vi
            .spyOn(wallet.arkProvider, "getPendingTxs")
            .mockResolvedValue([
                { arkTxid: "cd".repeat(32), signedCheckpointTxs: [serverCheckpointB64] },
            ] as never);
        let finalizedCheckpoints: string[] | undefined;
        const finalizeSpy = vi
            .spyOn(wallet.arkProvider, "finalizeTx")
            .mockImplementation(async (_arkTxid, checkpoints) => {
                finalizedCheckpoints = checkpoints;
            });

        const result = await wallet.finalizePendingTxs([coin]);

        expect(result.finalized).toEqual(["cd".repeat(32)]);
        // One batch call covers every checkpoint of the recovered tx.
        expect(identity.signMultipleSpy).toHaveBeenCalledTimes(1);

        expect(finalizedCheckpoints).toHaveLength(1);
        const signers = tapscriptSignerPubkeysHex(finalizedCheckpoints![0], 0);
        expect(signers).toContain(serverXOnlyHex); // server sig survived
        expect(signers).toContain(userXOnlyHex); // user sig added on top

        getPendingSpy.mockRestore();
        finalizeSpy.mockRestore();
        await wallet.dispose();
    });

    // ── sendSelectedVtxosToSelf: the deprecated-signer VTXO migration primitive ──

    // A spendable, batch-expiry-bearing baseline coin: the migration primitive
    // rejects inputs without a batch expiry (the DB-update path only persists a
    // wallet-owned output when one exists).
    function makeMigratableCoin(
        wallet: Awaited<ReturnType<typeof makeStaticBatchWallet>>["wallet"],
        extra: Partial<ExtendedVirtualCoin> = {},
    ): ExtendedVirtualCoin {
        const base = makeBaselineCoin(wallet);
        const batchExpiry = Date.now() + 7 * 24 * 3600 * 1000;
        return {
            ...base,
            // A real (post-2025) wall-clock expiry, so the coin reads as live.
            virtualStatus: { state: "settled", batchExpiry },
            expiresAt: new Date(batchExpiry),
            ...extra,
        };
    }

    // Drive a successful send round-trip (server signs checkpoints, finalize
    // resolves) and return the arkTxid the wallet recorded against.
    function stubSendRoundTrip(
        wallet: Awaited<ReturnType<typeof makeStaticBatchWallet>>["wallet"],
    ) {
        const arkTxid = "ab".repeat(32);
        const submitSpy = vi
            .spyOn(wallet.arkProvider, "submitTx")
            .mockImplementation(async (arkTxB64, checkpointsB64) => ({
                arkTxid,
                finalArkTx: arkTxB64,
                signedCheckpointTxs: await Promise.all(
                    checkpointsB64.map((c) => serverSignCheckpoint(c)),
                ),
            }));
        const finalizeSpy = vi.spyOn(wallet.arkProvider, "finalizeTx").mockResolvedValue(undefined);
        return { arkTxid, submitSpy, finalizeSpy };
    }

    it("sendSelectedVtxosToSelf persists the full-value self output when there is no change", async () => {
        const { wallet } = await makeStaticBatchWallet();
        const coin = makeMigratableCoin(wallet);
        const { arkTxid } = stubSendRoundTrip(wallet);

        const returned = await wallet.sendSelectedVtxosToSelf([coin]);
        expect(returned).toBe(arkTxid);

        // The self output (output index 0) is persisted at the FULL input value
        // even though there is no separate change output, on the wallet's own
        // primary (active-signer) address.
        const primaryAddress = await wallet.getAddress();
        const persisted = await (wallet as any).walletRepository.getVtxos(primaryAddress);
        const self = persisted.filter((v: ExtendedVirtualCoin) => v.txid === arkTxid && !v.isSpent);
        expect(self).toHaveLength(1);
        expect(self[0].vout).toBe(0);
        expect(self[0].value).toBe(coin.value);
        // The migrated input is now recorded as spent.
        const spentInput = persisted.find(
            (v: ExtendedVirtualCoin) => v.txid === coin.txid && v.vout === coin.vout,
        );
        expect(spentInput?.isSpent).toBe(true);

        await wallet.dispose();
    });

    it("sendSelectedVtxosToSelf preserves all input assets on the self output", async () => {
        const { wallet } = await makeStaticBatchWallet();
        // Asset ids are 34 bytes (68 hex chars).
        const assetA = "dd".repeat(34);
        const assetB = "ee".repeat(34);
        // Two assets across the (single) stale input — both must land on the
        // active-signer self output via the asset packet.
        const coin = makeMigratableCoin(wallet, {
            assets: [
                { assetId: assetA, amount: 42n },
                { assetId: assetB, amount: 7n },
            ],
        });
        const { arkTxid } = stubSendRoundTrip(wallet);

        await wallet.sendSelectedVtxosToSelf([coin]);

        const primaryAddress = await wallet.getAddress();
        const persisted = await (wallet as any).walletRepository.getVtxos(primaryAddress);
        const self = persisted.find((v: ExtendedVirtualCoin) => v.txid === arkTxid && !v.isSpent)!;
        expect(self.assets).toEqual([
            { assetId: assetA, amount: 42n },
            { assetId: assetB, amount: 7n },
        ]);

        await wallet.dispose();
    });

    it("sendSelectedVtxosToSelf rejects a height-expired input before submission", async () => {
        const { wallet, getChainTipSpy } = await makeStaticBatchWallet();
        getChainTipSpy.mockResolvedValueOnce({
            height: 501,
            time: 0,
            hash: "00".repeat(32),
        });
        const coin = makeMigratableCoin(wallet, {
            virtualStatus: { state: "settled", batchExpiry: 500_000 },
            expiresAt: undefined,
            expiresAtHeight: 500,
        });
        const { submitSpy } = stubSendRoundTrip(wallet);

        await expect(wallet.sendSelectedVtxosToSelf([coin])).rejects.toThrow(
            /not cooperatively spendable/,
        );
        expect(submitSpy).not.toHaveBeenCalled();
        expect(getChainTipSpy).toHaveBeenCalled();

        await wallet.dispose();
    });

    it("sendSelectedVtxosToSelf rejects an input without a batch expiry", async () => {
        const { wallet } = await makeStaticBatchWallet();
        // A settled coin with no batchExpiry (unrolled-style) — not cooperatively
        // migratable, and the DB-update path can't persist its self output.
        const coin = makeBaselineCoin(wallet);
        const { submitSpy } = stubSendRoundTrip(wallet);

        await expect(wallet.sendSelectedVtxosToSelf([coin])).rejects.toThrow(/batch expiry/);
        // Validation happens before any submission.
        expect(submitSpy).not.toHaveBeenCalled();

        await wallet.dispose();
    });
});
