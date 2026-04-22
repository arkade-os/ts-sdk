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
    describe("create / initialization", () => {
        it("materializes receive index 0 on a fresh wallet", async () => {
            const { provider } = await makeProvider();
            expect(provider.getCurrentReceiveIndex()).toBe(0);
            expect(provider.getSigningDescriptor()).toMatch(/\/0\/0\)$/);
        });

        it("persists initial state to the repository", async () => {
            const { walletRepo } = await makeProvider();
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd).toMatchObject({
                template: expect.stringMatching(/\/0\/\*\)$/),
                nextIndex: 1,
                currentReceiveIndex: 0,
            });
        });

        it("reuses stored currentReceiveIndex across instances", async () => {
            const repo = new InMemoryWalletRepository();
            const { provider: first } = await makeProvider(repo);
            await first.rotateReceive(); // bumps to index 1
            await first.rotateReceive(); // bumps to index 2

            const { provider: second } = await makeProvider(repo);
            expect(second.getCurrentReceiveIndex()).toBe(2);
            expect(second.getSigningDescriptor()).toBe(
                first.getSigningDescriptor()
            );
        });

        it("does not overwrite unrelated settings keys", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ settings: { other: "preserved" } });
            await makeProvider(repo);

            const state = await repo.getWalletState();
            expect(state?.settings?.other).toBe("preserved");
            expect(state?.settings?.hd).toBeDefined();
        });

        it("preserves unrelated walletState fields (e.g. lastSyncTime)", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ lastSyncTime: 12345 });
            await makeProvider(repo);

            const state = await repo.getWalletState();
            expect(state?.lastSyncTime).toBe(12345);
        });

        it("throws when stored state belongs to a different identity", async () => {
            const repo = new InMemoryWalletRepository();
            await makeProvider(repo); // seeds state for MNEMONIC

            await expect(
                makeProvider(repo, { mnemonic: OTHER_MNEMONIC })
            ).rejects.toThrow(/template mismatch/i);
        });
    });

    describe("peekNextIndex", () => {
        it("returns the value that will be used by the next consume", async () => {
            const { provider } = await makeProvider();
            const peeked = await provider.peekNextIndex();
            const { index } = await provider.consumeNextIndex();
            expect(index).toBe(peeked);
        });

        it("does not mutate state", async () => {
            const { provider, walletRepo } = await makeProvider();
            const before = (await walletRepo.getWalletState())?.settings?.hd
                .nextIndex;
            await provider.peekNextIndex();
            const after = (await walletRepo.getWalletState())?.settings?.hd
                .nextIndex;
            expect(after).toBe(before);
        });
    });

    describe("consumeNextIndex", () => {
        it("returns sequential indexes 1, 2, 3... (0 was taken by init)", async () => {
            const { provider } = await makeProvider();
            const a = await provider.consumeNextIndex();
            const b = await provider.consumeNextIndex();
            const c = await provider.consumeNextIndex();
            expect([a.index, b.index, c.index]).toEqual([1, 2, 3]);
        });

        it("returns a descriptor matching the substituted template at that index", async () => {
            const { provider, identity } = await makeProvider();
            const { index, descriptor } = await provider.consumeNextIndex();
            const expected = identity
                .getAccountDescriptor()
                .replace("/*)", `/${index})`);
            expect(descriptor).toBe(expected);
        });

        it("does not change the active receive descriptor", async () => {
            const { provider } = await makeProvider();
            const beforeDesc = provider.getSigningDescriptor();
            const beforeIdx = provider.getCurrentReceiveIndex();
            await provider.consumeNextIndex();
            expect(provider.getSigningDescriptor()).toBe(beforeDesc);
            expect(provider.getCurrentReceiveIndex()).toBe(beforeIdx);
        });

        it("serialises concurrent callers so indexes never collide", async () => {
            const { provider } = await makeProvider();
            const results = await Promise.all(
                Array.from({ length: 10 }, () => provider.consumeNextIndex())
            );
            const indexes = results.map((r) => r.index);
            expect(new Set(indexes).size).toBe(indexes.length);
            // monotonic and contiguous (1..10 — 0 was claimed by init)
            expect([...indexes].sort((a, b) => a - b)).toEqual([
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
            ]);
        });

        it("persists each bump so a restart continues the sequence", async () => {
            const repo = new InMemoryWalletRepository();
            const { provider: first } = await makeProvider(repo);
            await first.consumeNextIndex(); // 1
            await first.consumeNextIndex(); // 2

            const { provider: second } = await makeProvider(repo);
            const next = await second.consumeNextIndex();
            expect(next.index).toBe(3);
        });
    });

    describe("rotateReceive", () => {
        it("moves the active receive descriptor to the next index", async () => {
            const { provider } = await makeProvider();
            expect(provider.getCurrentReceiveIndex()).toBe(0);
            const rotated = await provider.rotateReceive();
            expect(rotated.index).toBe(1);
            expect(provider.getCurrentReceiveIndex()).toBe(1);
            expect(provider.getSigningDescriptor()).toBe(rotated.descriptor);
        });

        it("bumps past previously consumed indexes", async () => {
            const { provider } = await makeProvider();
            await provider.consumeNextIndex(); // 1
            await provider.consumeNextIndex(); // 2
            const rotated = await provider.rotateReceive();
            expect(rotated.index).toBe(3);
        });

        it("persists the new currentReceiveIndex", async () => {
            const { provider, walletRepo } = await makeProvider();
            const rotated = await provider.rotateReceive();
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd.currentReceiveIndex).toBe(rotated.index);
        });

        it("serialises against concurrent consumeNextIndex", async () => {
            const { provider } = await makeProvider();
            const ops = [
                provider.consumeNextIndex(),
                provider.rotateReceive(),
                provider.consumeNextIndex(),
                provider.rotateReceive(),
            ];
            const results = await Promise.all(ops);
            const indexes = results.map((r) => r.index);
            expect(new Set(indexes).size).toBe(indexes.length);
        });
    });

    describe("DescriptorProvider interface", () => {
        it("isOurs returns true for a descriptor derived by this wallet", async () => {
            const { provider } = await makeProvider();
            const { descriptor } = await provider.consumeNextIndex();
            expect(provider.isOurs(descriptor)).toBe(true);
        });

        it("isOurs returns false for a descriptor from another wallet", async () => {
            const { provider } = await makeProvider();
            const other = makeIdentity({ mnemonic: OTHER_MNEMONIC });
            expect(provider.isOurs(other.descriptor)).toBe(false);
        });

        it("isOurs returns true for the account template with wildcard", async () => {
            const { provider, identity } = await makeProvider();
            expect(provider.isOurs(identity.getAccountDescriptor())).toBe(true);
        });

        it("signMessageWithDescriptor signs with the index-derived key", async () => {
            const { provider } = await makeProvider();
            const { index, descriptor } = await provider.consumeNextIndex();
            const message = new Uint8Array(32).fill(7);

            const sig = await provider.signMessageWithDescriptor(
                descriptor,
                message
            );

            // Derive the expected x-only pubkey at the same index
            // directly from the seed and verify the signature against it.
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
            expect(index).toBe(1); // index 0 is claimed by init
        });

        it("signWithDescriptor rejects descriptors not belonging to this wallet", async () => {
            const { provider } = await makeProvider();
            const other = makeIdentity({ mnemonic: OTHER_MNEMONIC });
            await expect(
                provider.signWithDescriptor([
                    {
                        descriptor: other.getSigningDescriptor(),
                        tx: {} as never,
                    },
                ])
            ).rejects.toThrow(/does not belong/);
        });
    });

    describe("error paths", () => {
        it("descriptor from consumeNextIndex never includes wildcard", async () => {
            const { provider } = await makeProvider();
            const { descriptor } = await provider.consumeNextIndex();
            expect(descriptor).not.toMatch(/\/\*\)$/);
        });

        it("throws a descriptive error when nextIndex hits the non-hardened cap", async () => {
            const repo = new InMemoryWalletRepository();
            // Prime storage one step below the cap so the next consume bumps
            // from 2^31-1 → 2^31, tripping the guard on the call after.
            const identity = makeIdentity();
            await repo.saveWalletState({
                settings: {
                    hd: {
                        template: identity.getAccountDescriptor(),
                        nextIndex: 0x7fffffff,
                        currentReceiveIndex: 0,
                    },
                },
            });
            const provider = await HDDescriptorProvider.create(identity, repo);
            // First call consumes 0x7fffffff (legal), bumping nextIndex to 0x80000000.
            await provider.consumeNextIndex();
            // Second call should trip the guard with a human-readable message.
            await expect(provider.consumeNextIndex()).rejects.toThrow(
                /HD wallet exhausted/i
            );
            await expect(provider.rotateReceive()).rejects.toThrow(
                /HD wallet exhausted/i
            );
        });

        it("throws when stored nextIndex is not a non-negative integer", async () => {
            const repo = new InMemoryWalletRepository();
            const identity = makeIdentity();
            await repo.saveWalletState({
                settings: {
                    hd: {
                        template: identity.getAccountDescriptor(),
                        // corrupted — simulates partial migration or bad write
                        nextIndex: "oops" as unknown as number,
                    },
                },
            });
            await expect(
                HDDescriptorProvider.create(identity, repo)
            ).rejects.toThrow(/corrupt hd settings.*nextindex/i);
        });

        it("throws when stored currentReceiveIndex is not a non-negative integer", async () => {
            const repo = new InMemoryWalletRepository();
            const identity = makeIdentity();
            await repo.saveWalletState({
                settings: {
                    hd: {
                        template: identity.getAccountDescriptor(),
                        nextIndex: 2,
                        currentReceiveIndex: -1,
                    },
                },
            });
            await expect(
                HDDescriptorProvider.create(identity, repo)
            ).rejects.toThrow(/corrupt hd settings.*currentreceiveindex/i);
        });
    });

    describe("concurrent wallet-state writers", () => {
        // The provider must serialise against other updateWalletState writers
        // (e.g. VTXO sync cursor advance) so that interleaved read-modify-write
        // cycles never silently drop either side's changes. Before the fix,
        // HDDescriptorProvider bypassed the shared per-repo mutex and could
        // lose index bumps under this exact race.
        it("does not lose an HD index bump when a sync cursor advance races it", async () => {
            const { advanceSyncCursor } = await import(
                "../src/utils/syncCursors"
            );
            const repo = new InMemoryWalletRepository();
            const { provider } = await makeProvider(repo);

            // Kick both mutations off together so they contend for the mutex.
            await Promise.all([
                provider.rotateReceive(),
                advanceSyncCursor(repo, 1_000_000),
                provider.rotateReceive(),
                advanceSyncCursor(repo, 2_000_000),
                provider.rotateReceive(),
            ]);

            const state = await repo.getWalletState();
            // Sync cursor landed at the higher of the two advances.
            expect(state?.lastSyncTime).toBe(2_000_000);
            // All three rotations are visible — currentReceiveIndex is 3
            // (started at 0, rotated three times → 1, 2, 3), nextIndex is 4.
            expect(state?.settings?.hd.currentReceiveIndex).toBe(3);
            expect(state?.settings?.hd.nextIndex).toBe(4);
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
                provider.rotateReceive(),
                clearSyncCursor(repo),
                provider.rotateReceive(),
            ]);

            const state = await repo.getWalletState();
            // Cursor was cleared.
            expect(state?.lastSyncTime).toBeUndefined();
            expect(state?.settings?.vtxoCursorMigrated).toBeUndefined();
            // HD rotations survived.
            expect(state?.settings?.hd.currentReceiveIndex).toBe(2);
            expect(state?.settings?.hd.nextIndex).toBe(3);
        });
    });

    describe("getCurrentReceivePubkey", () => {
        it("returns the x-only pubkey matching the identity's derived key at index 0", async () => {
            const { provider, identity } = await makeProvider();
            // At init, current receive = index 0, which is what the identity
            // itself was constructed at. xOnlyPublicKey() returns the identity's
            // derived key — they should match.
            const identityPubkey = await identity.xOnlyPublicKey();
            const providerPubkey = provider.getCurrentReceivePubkey();
            expect(providerPubkey).toHaveLength(32);
            expect(Array.from(providerPubkey)).toEqual(
                Array.from(identityPubkey)
            );
        });

        it("reflects the new index after a rotation", async () => {
            const { provider, identity } = await makeProvider();
            const before = provider.getCurrentReceivePubkey();
            await provider.rotateReceive();
            const after = provider.getCurrentReceivePubkey();

            expect(Array.from(after)).not.toEqual(Array.from(before));
            // The post-rotation pubkey should match what identity derives at
            // the new index directly.
            const newIndex = provider.getCurrentReceiveIndex();
            const newDesc = identity.deriveSigningDescriptor(newIndex);
            // Sanity — rotation advanced to a non-zero index
            expect(newIndex).toBeGreaterThan(0);
            expect(newDesc).toBe(provider.getSigningDescriptor());
        });
    });
});
