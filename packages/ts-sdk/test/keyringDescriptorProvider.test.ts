import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { schnorr } from "@noble/secp256k1";
import { getNetwork } from "../src/networks";
import { KeyringDescriptorProvider } from "../src/identity/keyringDescriptorProvider";
import { StaticDescriptorProvider } from "../src/identity/staticDescriptorProvider";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";
import { MnemonicIdentity } from "../src/identity/seedIdentity";
import { SingleKey } from "../src/identity/singleKey";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { WalletRepository } from "../src/repositories/walletRepository";
import { Transaction } from "../src/utils/transaction";
import type { DescriptorProvider } from "../src/identity/descriptorProvider";

const network = getNetwork("regtest");

// Wallet's own key vs. a key imported from outside the derivation tree.
const BASE_PRIVKEY = new Uint8Array(32).fill(1);
const FOREIGN_PRIVKEY = new Uint8Array(32).fill(2);
const OTHER_FOREIGN_PRIVKEY = new Uint8Array(32).fill(3);

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

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

async function makeProvider(repo?: WalletRepository) {
    const walletRepo = repo ?? new InMemoryWalletRepository();
    const base = await StaticDescriptorProvider.create(SingleKey.fromPrivateKey(BASE_PRIVKEY));
    const provider = await KeyringDescriptorProvider.create(base, walletRepo);
    return { provider, base, walletRepo };
}

describe("KeyringDescriptorProvider", () => {
    let provider: KeyringDescriptorProvider;
    let walletRepo: WalletRepository;
    const baseDescriptor = `tr(${xOnlyHex(BASE_PRIVKEY)})`;
    const foreignDescriptor = `tr(${xOnlyHex(FOREIGN_PRIVKEY)})`;

    beforeEach(async () => {
        ({ provider, walletRepo } = await makeProvider());
    });

    describe("importKey", () => {
        it("returns the tr(<x-only pubkey>) descriptor handle", async () => {
            expect(await provider.importKey(FOREIGN_PRIVKEY)).toBe(foreignDescriptor);
        });

        it("is idempotent — re-importing yields the same descriptor and one entry", async () => {
            const first = await provider.importKey(FOREIGN_PRIVKEY);
            const second = await provider.importKey(FOREIGN_PRIVKEY);

            expect(second).toBe(first);
            expect(provider.listKeyringDescriptors()).toEqual([foreignDescriptor]);
        });

        it("holds several keys at once", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);
            await provider.importKey(OTHER_FOREIGN_PRIVKEY);

            expect(provider.listKeyringDescriptors()).toHaveLength(2);
            expect(provider.hasKey(foreignDescriptor)).toBe(true);
            expect(provider.hasKey(`tr(${xOnlyHex(OTHER_FOREIGN_PRIVKEY)})`)).toBe(true);
        });
    });

    describe("persistence", () => {
        it("survives a restart — a fresh provider on the same repo resolves the key", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);

            const { provider: rebooted } = await makeProvider(walletRepo);

            expect(rebooted.hasKey(foreignDescriptor)).toBe(true);
            expect(rebooted.isOurs(foreignDescriptor)).toBe(true);
        });

        it("stores keys under settings.keyring without touching other settings", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ lastSyncTime: 12345, settings: { other: "preserved" } });
            const { provider } = await makeProvider(repo);
            await provider.importKey(FOREIGN_PRIVKEY);

            const state = await repo.getWalletState();
            expect(state?.settings?.other).toBe("preserved");
            expect(state?.lastSyncTime).toBe(12345);
            expect(state?.settings?.keyring.keys[xOnlyHex(FOREIGN_PRIVKEY)]).toBe(
                hex.encode(FOREIGN_PRIVKEY),
            );
        });

        it("writes nothing until a key is imported", async () => {
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.keyring).toBeUndefined();
        });

        it("keeps concurrent imports on the same repo from clobbering each other", async () => {
            const { provider: a } = await makeProvider(walletRepo);
            const { provider: b } = await makeProvider(walletRepo);

            await Promise.all([a.importKey(FOREIGN_PRIVKEY), b.importKey(OTHER_FOREIGN_PRIVKEY)]);

            const { provider: rebooted } = await makeProvider(walletRepo);
            expect(rebooted.listKeyringDescriptors().sort()).toEqual(
                [foreignDescriptor, `tr(${xOnlyHex(OTHER_FOREIGN_PRIVKEY)})`].sort(),
            );
        });

        it("throws on corrupt persisted state rather than deriving garbage", async () => {
            const repo = new InMemoryWalletRepository();
            await repo.saveWalletState({ settings: { keyring: { keys: { abcd: "not-a-key" } } } });

            await expect(makeProvider(repo)).rejects.toThrow(/Corrupt keyring settings/);
        });
    });

    describe("deleteKey", () => {
        it("purges the entry from memory and from storage", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);

            expect(await provider.deleteKey(foreignDescriptor)).toBe(true);
            expect(provider.hasKey(foreignDescriptor)).toBe(false);

            const { provider: rebooted } = await makeProvider(walletRepo);
            expect(rebooted.hasKey(foreignDescriptor)).toBe(false);
        });

        it("returns false for an unknown descriptor and is a safe no-op when repeated", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);
            await provider.deleteKey(foreignDescriptor);

            expect(await provider.deleteKey(foreignDescriptor)).toBe(false);
            expect(await provider.deleteKey(baseDescriptor)).toBe(false);
        });

        it("leaves the other keys intact", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);
            await provider.importKey(OTHER_FOREIGN_PRIVKEY);
            await provider.deleteKey(foreignDescriptor);

            expect(provider.listKeyringDescriptors()).toEqual([
                `tr(${xOnlyHex(OTHER_FOREIGN_PRIVKEY)})`,
            ]);
        });
    });

    describe("isOurs", () => {
        it("claims the base provider's descriptor", () => {
            expect(provider.isOurs(baseDescriptor)).toBe(true);
        });

        it("rejects a foreign descriptor before import and claims it after", async () => {
            expect(provider.isOurs(foreignDescriptor)).toBe(false);
            await provider.importKey(FOREIGN_PRIVKEY);
            expect(provider.isOurs(foreignDescriptor)).toBe(true);
        });

        it("resolves a bare pubkey and mixed case to the same entry", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);

            expect(provider.isOurs(xOnlyHex(FOREIGN_PRIVKEY))).toBe(true);
            expect(provider.isOurs(foreignDescriptor.toUpperCase().replace("TR(", "tr("))).toBe(
                true,
            );
        });

        it("rejects malformed input", () => {
            expect(provider.isOurs("tr()")).toBe(false);
            expect(provider.isOurs("")).toBe(false);
        });
    });

    describe("getNextSigningDescriptor", () => {
        it("delegates to the base provider — the keyring never allocates", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);
            expect(await provider.getNextSigningDescriptor()).toBe(baseDescriptor);
        });
    });

    describe("signWithDescriptor", () => {
        it("signs a keyring-owned input with the imported key", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);

            const [signed] = await provider.signWithDescriptor([
                { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
            ]);

            expect(signed.getInput(0).tapKeySig).toBeDefined();
            signed.finalize();
        });

        it("delegates a base-owned input to the base provider", async () => {
            const [signed] = await provider.signWithDescriptor([
                { descriptor: baseDescriptor, tx: makeSignableTx(BASE_PRIVKEY) },
            ]);

            expect(signed.getInput(0).tapKeySig).toBeDefined();
        });

        it("splits a mixed batch and returns results in request order", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);

            const signed = await provider.signWithDescriptor([
                { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
                { descriptor: baseDescriptor, tx: makeSignableTx(BASE_PRIVKEY) },
                { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
            ]);

            expect(signed).toHaveLength(3);
            for (const tx of signed) {
                expect(tx.getInput(0).tapKeySig).toBeDefined();
            }
            // request order preserved: index 1 is the base-key tx
            expect(hex.encode(signed[1].getInput(0)!.witnessUtxo!.script)).toBe(
                hex.encode(p2tr(schnorr.getPublicKey(BASE_PRIVKEY), undefined, network).script),
            );
        });

        it("hands the base provider its requests in one batched call", async () => {
            const calls: number[] = [];
            const base: DescriptorProvider = {
                getNextSigningDescriptor: async () => baseDescriptor,
                isOurs: (d) => d === baseDescriptor,
                signWithDescriptor: async (requests) => {
                    calls.push(requests.length);
                    return requests.map((r) => r.tx);
                },
                signMessageWithDescriptor: async () => new Uint8Array(64),
            };
            const provider = await KeyringDescriptorProvider.create(
                base,
                new InMemoryWalletRepository(),
            );
            await provider.importKey(FOREIGN_PRIVKEY);

            await provider.signWithDescriptor([
                { descriptor: baseDescriptor, tx: makeSignableTx(BASE_PRIVKEY) },
                { descriptor: foreignDescriptor, tx: makeSignableTx(FOREIGN_PRIVKEY) },
                { descriptor: baseDescriptor, tx: makeSignableTx(BASE_PRIVKEY) },
            ]);

            expect(calls).toEqual([2]);
        });

        it("propagates the base provider's error for an unknown descriptor", async () => {
            const unknown = `tr(${xOnlyHex(OTHER_FOREIGN_PRIVKEY)})`;

            await expect(
                provider.signWithDescriptor([
                    { descriptor: unknown, tx: makeSignableTx(OTHER_FOREIGN_PRIVKEY) },
                ]),
            ).rejects.toThrow(/does not belong to this provider/);
        });

        it("keeps a key already in the base provider on the base signing path", async () => {
            // importing the wallet's own key must not reroute its contracts
            await provider.importKey(BASE_PRIVKEY);

            const calls: string[] = [];
            const base: DescriptorProvider = {
                getNextSigningDescriptor: async () => baseDescriptor,
                isOurs: (d) => d === baseDescriptor,
                signWithDescriptor: async (requests) => {
                    calls.push(...requests.map((r) => r.descriptor));
                    return requests.map((r) => r.tx);
                },
                signMessageWithDescriptor: async () => new Uint8Array(64),
            };
            const wrapped = await KeyringDescriptorProvider.create(base, walletRepo);

            await wrapped.signWithDescriptor([
                { descriptor: baseDescriptor, tx: makeSignableTx(BASE_PRIVKEY) },
            ]);

            expect(calls).toEqual([baseDescriptor]);
        });
    });

    describe("signMessageWithDescriptor", () => {
        const message = new Uint8Array(32).fill(7);

        it("signs with the imported key, verifiable against its pubkey", async () => {
            await provider.importKey(FOREIGN_PRIVKEY);

            const sig = await provider.signMessageWithDescriptor(foreignDescriptor, message);

            expect(
                await schnorr.verifyAsync(sig, message, schnorr.getPublicKey(FOREIGN_PRIVKEY)),
            ).toBe(true);
        });

        it("delegates a base-owned descriptor to the base provider", async () => {
            const sig = await provider.signMessageWithDescriptor(baseDescriptor, message);

            expect(
                await schnorr.verifyAsync(sig, message, schnorr.getPublicKey(BASE_PRIVKEY)),
            ).toBe(true);
        });
    });

    describe("decorating an HD provider", () => {
        it("forwards allocation, rotation capability and the descriptor peek", async () => {
            const repo = new InMemoryWalletRepository();
            const hd = await HDDescriptorProvider.create(
                MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: true }),
                repo,
            );
            const wrapped = (await KeyringDescriptorProvider.create(
                hd,
                repo,
            )) as KeyringDescriptorProvider & {
                createReceiveRotator?: unknown;
                getCurrentSigningDescriptor?: () => Promise<string | undefined>;
            };

            const first = await wrapped.getNextSigningDescriptor();
            expect(first).toBe(await hd.materializeDescriptorAt(0));
            expect(await wrapped.getNextSigningDescriptor()).toBe(
                await hd.materializeDescriptorAt(1),
            );

            expect(typeof wrapped.createReceiveRotator).toBe("function");
            expect(await wrapped.getCurrentSigningDescriptor!()).toBe(
                await hd.materializeDescriptorAt(1),
            );

            // HD descriptors are the base's, imported keys are the keyring's
            expect(wrapped.isOurs(first)).toBe(true);
            expect(wrapped.hasKey(first)).toBe(false);
            await wrapped.importKey(FOREIGN_PRIVKEY);
            expect(wrapped.isOurs(foreignDescriptor)).toBe(true);
        });

        it("does not claim rotation capability a static base lacks", async () => {
            const wrapped = provider as KeyringDescriptorProvider & {
                createReceiveRotator?: unknown;
                getCurrentSigningDescriptor?: unknown;
            };

            expect(wrapped.createReceiveRotator).toBeUndefined();
            expect(wrapped.getCurrentSigningDescriptor).toBeUndefined();
        });
    });
});
