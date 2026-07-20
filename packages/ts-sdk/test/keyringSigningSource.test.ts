import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { schnorr } from "@noble/secp256k1";
import { getNetwork } from "../src/networks";
import { KeyringSigningSource } from "../src/identity/keyringSigningSource";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { WalletRepository } from "../src/repositories/walletRepository";
import { Transaction } from "../src/utils/transaction";

const network = getNetwork("regtest");

// A key imported from outside the wallet's derivation tree.
const FOREIGN_PRIVKEY = new Uint8Array(32).fill(2);
const OTHER_FOREIGN_PRIVKEY = new Uint8Array(32).fill(3);

function xOnlyHex(privKey: Uint8Array): string {
    return hex.encode(schnorr.getPublicKey(privKey));
}

/** A key-path-spendable P2TR tx locked to `privKey`'s pubkey. */
function makeSignableTx(privKey: Uint8Array): Transaction {
    const pay = p2tr(schnorr.getPublicKey(privKey), undefined, network);
    const tx = new Transaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(9),
        index: 0,
        witnessUtxo: { script: pay.script, amount: 10_000n },
        tapInternalKey: pay.tapInternalKey,
    });
    tx.addOutput({ script: pay.script, amount: 9_000n });
    return tx;
}

/** A repository preloaded with a corrupt keyring record. */
async function repoWithKeyring(keys: unknown): Promise<WalletRepository> {
    const repo = new InMemoryWalletRepository();
    await repo.saveWalletState({ settings: { keyring: { keys } } });
    return repo;
}

describe("KeyringSigningSource", () => {
    let keyring: KeyringSigningSource;
    let walletRepo: WalletRepository;
    const foreignDescriptor = `tr(${xOnlyHex(FOREIGN_PRIVKEY)})`;
    const otherForeignDescriptor = `tr(${xOnlyHex(OTHER_FOREIGN_PRIVKEY)})`;

    beforeEach(() => {
        walletRepo = new InMemoryWalletRepository();
        keyring = new KeyringSigningSource(walletRepo);
    });

    describe("importKey", () => {
        it("returns the tr(<x-only pubkey>) descriptor handle", async () => {
            expect(await keyring.importKey(FOREIGN_PRIVKEY)).toBe(foreignDescriptor);
        });

        it("is idempotent — re-importing yields the same descriptor and one entry", async () => {
            const first = await keyring.importKey(FOREIGN_PRIVKEY);
            const second = await keyring.importKey(FOREIGN_PRIVKEY);

            expect(second).toBe(first);
            expect(await keyring.listDescriptors()).toEqual([foreignDescriptor]);
        });

        it("holds several keys at once", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);
            await keyring.importKey(OTHER_FOREIGN_PRIVKEY);

            expect((await keyring.listDescriptors()).sort()).toEqual(
                [foreignDescriptor, otherForeignDescriptor].sort(),
            );
        });

        it("owns its copy — zeroizing the caller's buffer does not break signing", async () => {
            const caller = new Uint8Array(FOREIGN_PRIVKEY);
            const descriptor = await keyring.importKey(caller);
            caller.fill(0);

            const message = new Uint8Array(32).fill(9);
            const sig = await keyring.signMessageWithDescriptor(descriptor, message);

            expect(
                await schnorr.verifyAsync(sig, message, schnorr.getPublicKey(FOREIGN_PRIVKEY)),
            ).toBe(true);
        });
    });

    describe("persistence", () => {
        it("survives a restart — a fresh source on the same repo resolves the key", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);

            const rebooted = new KeyringSigningSource(walletRepo);

            expect(await rebooted.canProvide(foreignDescriptor)).toBe(true);
        });

        it("stores keys under settings.keyring without touching other settings", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ lastSyncTime: 12345, settings: { other: "preserved" } });
            await new KeyringSigningSource(repo).importKey(FOREIGN_PRIVKEY);

            const state = await repo.getWalletState();
            expect(state?.settings?.other).toBe("preserved");
            expect(state?.lastSyncTime).toBe(12345);
            expect(state?.settings?.keyring.keys[xOnlyHex(FOREIGN_PRIVKEY)]).toBe(
                hex.encode(FOREIGN_PRIVKEY),
            );
        });

        it("writes nothing until a key is imported", async () => {
            expect(await keyring.canProvide(foreignDescriptor)).toBe(false);
            expect(await keyring.listDescriptors()).toEqual([]);

            const state = await walletRepo.getWalletState();
            expect(state?.settings?.keyring).toBeUndefined();
        });

        it("does not materialize a keyring record when a purge removes nothing", async () => {
            expect(await keyring.deleteKey(foreignDescriptor)).toBe(false);

            const state = await walletRepo.getWalletState();
            expect(state?.settings?.keyring).toBeUndefined();
        });

        it("keeps concurrent imports on the same repo from clobbering each other", async () => {
            const a = new KeyringSigningSource(walletRepo);
            const b = new KeyringSigningSource(walletRepo);

            await Promise.all([a.importKey(FOREIGN_PRIVKEY), b.importKey(OTHER_FOREIGN_PRIVKEY)]);

            const rebooted = new KeyringSigningSource(walletRepo);
            expect((await rebooted.listDescriptors()).sort()).toEqual(
                [foreignDescriptor, otherForeignDescriptor].sort(),
            );
        });
    });

    // Storage is the source of truth, so two sources over one repository
    // agree with no sharing machinery between them. These pin that
    // property directly: every scenario below used to require a
    // repository-scoped in-memory keyring to pass.
    describe("two sources over one repository", () => {
        let sibling: KeyringSigningSource;

        beforeEach(() => {
            sibling = new KeyringSigningSource(walletRepo);
        });

        it("shows a key imported by one source to the other", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);

            expect(await sibling.canProvide(foreignDescriptor)).toBe(true);
        });

        it("purges from the sibling too", async () => {
            // a stale per-instance mirror would keep claiming the purged
            // descriptor and keep signing with the key
            await keyring.importKey(FOREIGN_PRIVKEY);
            expect(await sibling.canProvide(foreignDescriptor)).toBe(true);

            expect(await keyring.deleteKey(foreignDescriptor)).toBe(true);

            expect(await sibling.canProvide(foreignDescriptor)).toBe(false);
            await expect(
                sibling.signMessageWithDescriptor(foreignDescriptor, new Uint8Array(32).fill(7)),
            ).rejects.toThrow(/does not belong to this keyring/);
        });

        it("leaves the sibling's other keys intact", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);
            await keyring.importKey(OTHER_FOREIGN_PRIVKEY);

            await keyring.deleteKey(foreignDescriptor);

            expect(await sibling.listDescriptors()).toEqual([otherForeignDescriptor]);
        });

        it("does not resurrect keys after the repo is cleared", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);
            await walletRepo.clear();

            expect(await keyring.canProvide(foreignDescriptor)).toBe(false);
            expect(await sibling.canProvide(foreignDescriptor)).toBe(false);
        });
    });

    // The throw site moved from construction to first use: the source is
    // constructed synchronously and never reads storage until asked.
    describe("corrupt settings", () => {
        it("throws when `keys` is not an object", async () => {
            const source = new KeyringSigningSource(await repoWithKeyring("nope"));

            await expect(source.canProvide(foreignDescriptor)).rejects.toThrow(
                /`keys` is not an object/,
            );
        });

        it("throws on a private key that is not 32-byte hex", async () => {
            const source = new KeyringSigningSource(
                await repoWithKeyring({ [xOnlyHex(FOREIGN_PRIVKEY)]: "not-a-key" }),
            );

            await expect(source.canProvide(foreignDescriptor)).rejects.toThrow(
                /not a 32-byte hex private key/,
            );
        });

        it("throws on a map key that is not a 32-byte hex pubkey", async () => {
            const source = new KeyringSigningSource(
                await repoWithKeyring({ abcd: hex.encode(FOREIGN_PRIVKEY) }),
            );

            await expect(source.canProvide(foreignDescriptor)).rejects.toThrow(
                /not a 32-byte hex x-only pubkey/,
            );
        });

        it("throws when an entry is filed under a pubkey its private key does not derive", async () => {
            // the mismatch canProvide would otherwise assert away: claims
            // the descriptor, then signs it with the wrong key
            const source = new KeyringSigningSource(
                await repoWithKeyring({
                    [xOnlyHex(OTHER_FOREIGN_PRIVKEY)]: hex.encode(FOREIGN_PRIVKEY),
                }),
            );

            await expect(source.canProvide(otherForeignDescriptor)).rejects.toThrow(
                /does not match its private key/,
            );
        });

        it("throws on a private key outside the curve order", async () => {
            const source = new KeyringSigningSource(
                await repoWithKeyring({ [xOnlyHex(FOREIGN_PRIVKEY)]: "00".repeat(32) }),
            );

            await expect(source.canProvide(foreignDescriptor)).rejects.toThrow(
                /not a valid private key/,
            );
        });

        it("fails a signing call, not just resolution", async () => {
            const source = new KeyringSigningSource(
                await repoWithKeyring({ [xOnlyHex(FOREIGN_PRIVKEY)]: "not-a-key" }),
            );

            await expect(
                source.signWithDescriptor([
                    { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
                ]),
            ).rejects.toThrow(/not a 32-byte hex private key/);
        });

        it("normalizes an uppercase persisted pubkey so lookups still resolve", async () => {
            const source = new KeyringSigningSource(
                await repoWithKeyring({
                    [xOnlyHex(FOREIGN_PRIVKEY).toUpperCase()]: hex.encode(FOREIGN_PRIVKEY),
                }),
            );

            expect(await source.canProvide(foreignDescriptor)).toBe(true);
            expect(await source.listDescriptors()).toEqual([foreignDescriptor]);
        });
    });

    describe("deleteKey", () => {
        it("purges the entry from storage", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);

            expect(await keyring.deleteKey(foreignDescriptor)).toBe(true);
            expect(await keyring.canProvide(foreignDescriptor)).toBe(false);

            const rebooted = new KeyringSigningSource(walletRepo);
            expect(await rebooted.canProvide(foreignDescriptor)).toBe(false);
        });

        it("returns false for an unknown descriptor and is a safe no-op when repeated", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);
            await keyring.deleteKey(foreignDescriptor);

            expect(await keyring.deleteKey(foreignDescriptor)).toBe(false);
            expect(await keyring.deleteKey("tr()")).toBe(false);
        });

        it("leaves the other keys intact", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);
            await keyring.importKey(OTHER_FOREIGN_PRIVKEY);
            await keyring.deleteKey(foreignDescriptor);

            expect(await keyring.listDescriptors()).toEqual([otherForeignDescriptor]);
        });
    });

    describe("canProvide", () => {
        it("rejects a foreign descriptor before import and claims it after", async () => {
            expect(await keyring.canProvide(foreignDescriptor)).toBe(false);
            await keyring.importKey(FOREIGN_PRIVKEY);
            expect(await keyring.canProvide(foreignDescriptor)).toBe(true);
        });

        it("resolves a bare pubkey and mixed case to the same entry", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);

            expect(await keyring.canProvide(xOnlyHex(FOREIGN_PRIVKEY))).toBe(true);
            expect(
                await keyring.canProvide(foreignDescriptor.toUpperCase().replace("TR(", "tr(")),
            ).toBe(true);
        });

        it("rejects malformed input", async () => {
            expect(await keyring.canProvide("tr()")).toBe(false);
            expect(await keyring.canProvide("")).toBe(false);
        });
    });

    describe("signWithDescriptor", () => {
        it("signs an imported input with its key", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);

            const [signed] = await keyring.signWithDescriptor([
                { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
            ]);

            expect(signed.getInput(0).tapKeySig).toBeDefined();
            signed.finalize();
        });

        it("signs a multi-request batch in request order", async () => {
            await keyring.importKey(FOREIGN_PRIVKEY);
            await keyring.importKey(OTHER_FOREIGN_PRIVKEY);
            const requests = [
                { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
                { descriptor: otherForeignDescriptor, tx: makeSignableTx(OTHER_FOREIGN_PRIVKEY) },
            ];

            const signed = await keyring.signWithDescriptor(requests);

            expect(signed).toHaveLength(2);
            for (const [i, result] of signed.entries()) {
                expect(result.getInput(0).tapKeySig).toBeDefined();
                expect(hex.encode(result.getInput(0)!.witnessUtxo!.script)).toBe(
                    hex.encode(requests[i].tx.getInput(0)!.witnessUtxo!.script),
                );
            }
        });

        it("throws rather than skipping a descriptor it does not hold", async () => {
            await expect(
                keyring.signWithDescriptor([
                    { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
                ]),
            ).rejects.toThrow(/does not belong to this keyring/);
        });
    });

    describe("signMessageWithDescriptor", () => {
        it("signs with the imported key, verifiable against its pubkey", async () => {
            const message = new Uint8Array(32).fill(7);
            await keyring.importKey(FOREIGN_PRIVKEY);

            const sig = await keyring.signMessageWithDescriptor(foreignDescriptor, message);

            expect(
                await schnorr.verifyAsync(sig, message, schnorr.getPublicKey(FOREIGN_PRIVKEY)),
            ).toBe(true);
        });

        it("throws for a descriptor it does not hold", async () => {
            await expect(
                keyring.signMessageWithDescriptor(foreignDescriptor, new Uint8Array(32)),
            ).rejects.toThrow(/does not belong to this keyring/);
        });
    });
});
