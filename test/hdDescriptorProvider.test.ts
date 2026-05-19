import { describe, it, expect } from "vitest";
import { schnorr } from "@noble/secp256k1";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey, networks, expand } from "@bitcoinerlab/descriptors-scure";
import { MnemonicIdentity } from "../src/identity/seedIdentity";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { WalletRepository } from "../src/repositories/walletRepository";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

function makeIdentity(opts: { mnemonic?: string; isMainnet?: boolean } = {}) {
    return MnemonicIdentity.fromMnemonic(opts.mnemonic ?? MNEMONIC, {
        isMainnet: opts.isMainnet ?? true,
    });
}

async function makeProvider(
    repo?: WalletRepository,
    opts: { mnemonic?: string; isMainnet?: boolean } = {}
) {
    const walletRepo = repo ?? new InMemoryWalletRepository();
    const identity = makeIdentity(opts);
    const provider = await HDDescriptorProvider.create(identity, walletRepo);
    return { provider, walletRepo, identity };
}

describe("HDDescriptorProvider", () => {
    describe("create", () => {
        it("does not perform I/O at construction time", async () => {
            const { walletRepo } = await makeProvider();
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd).toBeUndefined();
        });

        it("does not overwrite unrelated settings keys when later rotated", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ settings: { other: "preserved" } });
            const { provider } = await makeProvider(repo);
            await provider.getNextSigningDescriptor();

            const state = await repo.getWalletState();
            expect(state?.settings?.other).toBe("preserved");
            expect(state?.settings?.hd).toBeDefined();
        });

        it("preserves unrelated walletState fields (e.g. lastSyncTime) on rotation", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ lastSyncTime: 12345 });
            const { provider } = await makeProvider(repo);
            await provider.getNextSigningDescriptor();

            const state = await repo.getWalletState();
            expect(state?.lastSyncTime).toBe(12345);
        });

        it("throws on rotate when stored state belongs to a different identity", async () => {
            const repo = new InMemoryWalletRepository();
            const { provider: first } = await makeProvider(repo);
            await first.getNextSigningDescriptor(); // seed state

            const { provider: second } = await makeProvider(repo, {
                mnemonic: OTHER_MNEMONIC,
            });
            await expect(second.getNextSigningDescriptor()).rejects.toThrow(
                /descriptor mismatch/i
            );
        });
    });

    describe("getNextSigningDescriptor", () => {
        it("returns descriptor at index 0 on the first call", async () => {
            const { provider } = await makeProvider();
            const first = await provider.getNextSigningDescriptor();
            expect(first).toMatch(/\/0\/0\)$/);
        });

        it("returns sequential indexes 0, 1, 2...", async () => {
            const { provider } = await makeProvider();
            const a = await provider.getNextSigningDescriptor();
            const b = await provider.getNextSigningDescriptor();
            const c = await provider.getNextSigningDescriptor();
            expect(a).toMatch(/\/0\/0\)$/);
            expect(b).toMatch(/\/0\/1\)$/);
            expect(c).toMatch(/\/0\/2\)$/);
        });

        it("returns a descriptor parsable via descriptors-scure", async () => {
            const { provider } = await makeProvider();
            const descriptor = await provider.getNextSigningDescriptor();
            // Fully materialized (non-wildcard) tr() expression.
            expect(descriptor).toMatch(/^tr\(/);
            expect(descriptor).not.toContain("*");
            // Round-trip parse without an `index` arg — already concrete.
            expect(() =>
                expand({ descriptor, network: networks.bitcoin })
            ).not.toThrow();
        });

        it("persists each bump so a restart continues the sequence", async () => {
            const repo = new InMemoryWalletRepository();
            const { provider: first } = await makeProvider(repo);
            await first.getNextSigningDescriptor(); // 0
            await first.getNextSigningDescriptor(); // 1

            const { provider: second } = await makeProvider(repo);
            const next = await second.getNextSigningDescriptor();
            expect(next).toMatch(/\/0\/2\)$/);
        });

        it("serialises concurrent callers so indexes never collide", async () => {
            const { provider } = await makeProvider();
            const results = await Promise.all(
                Array.from({ length: 10 }, () =>
                    provider.getNextSigningDescriptor()
                )
            );
            // All 10 are unique and contiguous 0..9 when sorted.
            expect(new Set(results).size).toBe(results.length);
            const indexes = results
                .map((d) => Number(d.match(/\/0\/(\d+)\)$/)?.[1]))
                .sort((a, b) => a - b);
            expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        });

        it("serialises rotations across two providers on the same repo", async () => {
            // The shared per-repo updateWalletState mutex must serialise
            // R-M-W across distinct provider instances. Without doing the
            // read inside the lock, both providers would see the same
            // lastIndexUsed and emit a duplicate.
            const repo = new InMemoryWalletRepository();
            const { provider: a } = await makeProvider(repo);
            const { provider: b } = await makeProvider(repo);

            const results = await Promise.all([
                a.getNextSigningDescriptor(),
                b.getNextSigningDescriptor(),
                a.getNextSigningDescriptor(),
                b.getNextSigningDescriptor(),
            ]);
            expect(new Set(results).size).toBe(results.length);
        });
    });

    describe("DescriptorProvider interface", () => {
        it("isOurs returns true for a descriptor derived by this wallet", async () => {
            const { provider } = await makeProvider();
            const descriptor = await provider.getNextSigningDescriptor();
            expect(provider.isOurs(descriptor)).toBe(true);
        });

        it("isOurs returns false for a descriptor from another wallet", async () => {
            const { provider } = await makeProvider();
            const other = makeIdentity({ mnemonic: OTHER_MNEMONIC });
            expect(provider.isOurs(other.descriptor)).toBe(false);
        });

        it("isOurs returns true for the account template with wildcard", async () => {
            const { provider, identity } = await makeProvider();
            expect(provider.isOurs(identity.descriptor)).toBe(true);
        });

        it("signMessageWithDescriptor signs with the index-derived key", async () => {
            const { provider } = await makeProvider();
            const descriptor = await provider.getNextSigningDescriptor();
            const message = new Uint8Array(32).fill(7);

            const sig = await provider.signMessageWithDescriptor(
                descriptor,
                message
            );

            // Derive the expected x-only pubkey at the same index directly
            // from the seed and verify the signature against it.
            const seed = mnemonicToSeedSync(MNEMONIC);
            const master = HDKey.fromMasterSeed(seed, networks.bitcoin.bip32);
            const probe = expand({
                descriptor,
                network: networks.bitcoin,
            });
            const path = probe.expansionMap?.["@0"]?.path;
            expect(path).toBeDefined();
            const pubkey = master.derive(path!).publicKey!.slice(1);

            expect(await schnorr.verifyAsync(sig, message, pubkey)).toBe(true);
            // First rotate gives index 0.
            expect(descriptor).toMatch(/\/0\/0\)$/);
        });

        it("signWithDescriptor rejects descriptors not belonging to this wallet", async () => {
            const { provider } = await makeProvider();
            const other = makeIdentity({ mnemonic: OTHER_MNEMONIC });
            // Materialize the other identity's template at index 0 — a
            // concrete-form descriptor is what signing expects.
            const otherDescriptor = other.descriptor.replace("/*)", "/0)");
            await expect(
                provider.signWithDescriptor([
                    {
                        descriptor: otherDescriptor,
                        tx: {} as never,
                    },
                ])
            ).rejects.toThrow(/does not belong/);
        });
    });

    describe("error paths", () => {
        it("throws on rotate when stored lastIndexUsed is not a non-negative integer", async () => {
            const repo = new InMemoryWalletRepository();
            const identity = makeIdentity();
            await repo.saveWalletState({
                settings: {
                    hd: {
                        descriptor: identity.descriptor,
                        lastIndexUsed: -1,
                    },
                },
            });
            const provider = await HDDescriptorProvider.create(identity, repo);
            await expect(provider.getNextSigningDescriptor()).rejects.toThrow(
                /corrupt hd settings.*lastindexused/i
            );
        });
    });

    describe("concurrent wallet-state writers", () => {
        // The provider must serialise against other updateWalletState writers
        // (e.g. VTXO sync cursor advance) so that interleaved read-modify-write
        // cycles never silently drop either side's changes.
        it("does not lose an HD index bump when a sync cursor advance races it", async () => {
            const { advanceSyncCursor } = await import(
                "../src/utils/syncCursors"
            );
            const repo = new InMemoryWalletRepository();
            const { provider } = await makeProvider(repo);

            // Kick both mutations off together so they contend for the mutex.
            await Promise.all([
                provider.getNextSigningDescriptor(),
                advanceSyncCursor(repo, 1_000_000),
                provider.getNextSigningDescriptor(),
                advanceSyncCursor(repo, 2_000_000),
                provider.getNextSigningDescriptor(),
            ]);

            const state = await repo.getWalletState();
            // Sync cursor landed at the higher of the two advances.
            expect(state?.lastSyncTime).toBe(2_000_000);
            // Three rotations from a fresh wallet → indexes 0, 1, 2 →
            // lastIndexUsed is 2.
            expect(state?.settings?.hd.lastIndexUsed).toBe(2);
            // The migration marker written by advanceSyncCursor is preserved.
            expect(state?.settings?.vtxoCursorMigrated).toBe(true);
        });

        it("does not clobber HD settings when a concurrent clearSyncCursor runs", async () => {
            const { advanceSyncCursor, clearSyncCursor } = await import(
                "../src/utils/syncCursors"
            );
            const repo = new InMemoryWalletRepository();
            const { provider } = await makeProvider(repo);
            await advanceSyncCursor(repo, 500_000);

            await Promise.all([
                provider.getNextSigningDescriptor(),
                clearSyncCursor(repo),
                provider.getNextSigningDescriptor(),
            ]);

            const state = await repo.getWalletState();
            // Cursor was cleared.
            expect(state?.lastSyncTime).toBeUndefined();
            expect(state?.settings?.vtxoCursorMigrated).toBeUndefined();
            // HD rotations survived: indexes 0 and 1 → lastIndexUsed is 1.
            expect(state?.settings?.hd.lastIndexUsed).toBe(1);
        });
    });
});
