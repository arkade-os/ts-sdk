/**
 * The property the scheme rests on: a preimage is a *function* of the seed
 * and one allocated index, so it survives a restart with nothing stored and
 * two artifacts never share one. Both are asserted directly here rather than
 * inferred from `aux_rand`.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    DescriptorIdentity,
    HDDescriptorProvider,
    InMemoryWalletRepository,
    MnemonicIdentity,
    SingleKey,
    strictSigningDescriptorIndex,
    type IWallet,
    resolveDescriptorSigner,
    ForeignDescriptorError,
    WalletCannotSignError,
} from "../src";
import {
    ARKADE_SWAP_PREIMAGE_TAG,
    adoptContractDescriptor,
    buildPreimageMessage,
    contractPreimage,
    contractSigner,
    isDeterministicSigner,
    isPerArtifactDescriptor,
    provisionClaimSecret,
    provisionRefundKey,
} from "../src/wallet/contractSecrets";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Set by `hdWallet()`; the vectors name indices the wallet has not allocated. */
let descriptorAt: (index: number) => string;

/**
 * An HD-capable wallet built on the real allocator and the real deterministic
 * signer — the two pieces the derivation depends on. Everything else an
 * `IWallet` has is irrelevant here and left off.
 */
const hdWallet = async (repository = new InMemoryWalletRepository()) => {
    const identity = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false });
    const provider = await HDDescriptorProvider.create(identity, repository);
    descriptorAt = (index: number) => provider.materializeDescriptorAt(index);
    return {
        repository,
        wallet: {
            identity,
            getCurrentSigningDescriptor: () => provider.getCurrentSigningDescriptor(),
            getNextSigningDescriptor: () => provider.getNextSigningDescriptor(),
            getUsedSigningDescriptors: async () => [],
            async advanceSigningDescriptorWatermark(descriptor: string) {
                await provider.advanceLastIndexUsed(strictSigningDescriptorIndex(descriptor)!);
            },
            async signerForDescriptor(descriptor: string) {
                return new DescriptorIdentity({ descriptor, signer: provider, base: identity });
            },
        } as unknown as IWallet,
    };
};

/** A wallet with no descriptor surface at all: its identity is its policy. */
const staticWallet = () => ({ identity: SingleKey.fromRandomBytes() }) as unknown as IWallet;

const indexOf = (descriptor: string): number => strictSigningDescriptorIndex(descriptor)!;

describe("buildPreimageMessage", () => {
    it("lays out TAG ‖ xonly(32) ‖ u32le(index)", () => {
        const xonly = new Uint8Array(32).fill(0xab);
        const message = buildPreimageMessage(xonly, 1);
        const tag = new TextEncoder().encode(ARKADE_SWAP_PREIMAGE_TAG);

        expect(message).toHaveLength(tag.length + 36);
        expect(message.slice(0, tag.length)).toEqual(tag);
        expect(message.slice(tag.length, tag.length + 32)).toEqual(xonly);
        // little-endian, so index 1 is 01 00 00 00
        expect([...message.slice(tag.length + 32)]).toEqual([1, 0, 0, 0]);
    });

    it("is scoped away from the Boltz corridor", () => {
        // Same key, same index: a shared tag would derive one preimage for both.
        expect(ARKADE_SWAP_PREIMAGE_TAG).toBe("Arkade-RFQ-Preimage-v1");
        expect(ARKADE_SWAP_PREIMAGE_TAG).not.toBe("Arkade-Boltz-Preimage-v1");
    });

    it.each([
        ["a short key", new Uint8Array(31)],
        ["a long key", new Uint8Array(33)],
    ])("rejects %s", (_label, xonly) => {
        expect(() => buildPreimageMessage(xonly, 0)).toThrow(/32 bytes/);
    });

    it.each([-1, 1.5, 0x1_0000_0000])("rejects index %s", (index) => {
        expect(() => buildPreimageMessage(new Uint8Array(32), index)).toThrow(/u32/);
    });
});

describe("provisionRefundKey", () => {
    it("gives every artifact its own key on an HD wallet", async () => {
        // The regression test for peeking instead of allocating: a peek
        // returns the same descriptor until the wallet rotates.
        const { wallet } = await hdWallet();
        const keys = [
            await provisionRefundKey(wallet),
            await provisionRefundKey(wallet),
            await provisionRefundKey(wallet),
        ];
        expect(new Set(keys.map((k) => k.descriptor)).size).toBe(3);
        expect(new Set(keys.map((k) => hex.encode(k.pubkey))).size).toBe(3);
        // and the pubkey really is the descriptor's key, not the baseline one
        for (const k of keys) {
            expect(
                hex.encode(await (await contractSigner(wallet, k.descriptor)).xOnlyPublicKey()),
            ).toBe(hex.encode(k.pubkey));
        }
    });

    it("refuses a descriptor the wallet cannot sign for, before anything is funded", async () => {
        // A wallet whose allocator hands back another seed's descriptor — a
        // worker rebound to a second identity, a restore onto the wrong seed.
        // Deriving the leaf key would succeed anyway (it is pure parsing), so
        // without a signer check the covenant binds a key we cannot spend and
        // the failure surfaces at refund time, funded.
        const { wallet } = await hdWallet();
        const other = MnemonicIdentity.fromMnemonic(
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
            { isMainnet: false },
        );
        const otherProvider = await HDDescriptorProvider.create(
            other,
            new InMemoryWalletRepository(),
        );
        // Resolution is honest — it goes through the same helper both real
        // wallets use. Only the allocator is rogue.
        const rogue = {
            ...wallet,
            getNextSigningDescriptor: async () => otherProvider.materializeDescriptorAt(1),
            signerForDescriptor: (d: string) => resolveDescriptorSigner(d, wallet.identity),
        } as unknown as IWallet;

        await expect(provisionRefundKey(rogue)).rejects.toThrow(/holds no key/);
        // and the claim-secret path inherits it, including the arm that
        // supplies its own preimage and so never derives one
        await expect(provisionClaimSecret(rogue)).rejects.toThrow(/holds no key/);
        await expect(
            provisionClaimSecret(rogue, { preimage: new Uint8Array(32).fill(1) }),
        ).rejects.toThrow(/holds no key/);
    });

    it("refuses a wallet that holds the key but cannot sign with it", async () => {
        // Watch-only, or a remote signer that is not attached. The pubkey
        // check passes — it IS our key — so without a capability check the
        // covenant binds it and the failure lands as a TypeError deep inside
        // the push, which the swap layer reads as retryable.
        const identity = SingleKey.fromRandomBytes();
        const watchOnly = {
            identity: {
                xOnlyPublicKey: () => identity.xOnlyPublicKey(),
                compressedPublicKey: () => identity.compressedPublicKey(),
                // no sign / signMessage / signerSession
            },
        } as unknown as IWallet;

        await expect(provisionRefundKey(watchOnly)).rejects.toBeInstanceOf(WalletCannotSignError);
        await expect(provisionClaimSecret(watchOnly)).rejects.toBeInstanceOf(WalletCannotSignError);
        // and it is told apart from "wrong wallet", which has a different remedy
        await expect(provisionRefundKey(watchOnly)).rejects.not.toBeInstanceOf(
            ForeignDescriptorError,
        );
    });

    it("answers with the identity key on a wallet that cannot allocate", async () => {
        // The wallet's policy, not the consumer's: static means the same key,
        // and the consumer never learns which case it got.
        const wallet = staticWallet();
        const first = await provisionRefundKey(wallet);
        const second = await provisionRefundKey(wallet);

        expect(first.descriptor).toBe(second.descriptor);
        expect(first.descriptor).toBe(`tr(${hex.encode(await wallet.identity.xOnlyPublicKey())})`);
        expect(hex.encode(first.pubkey)).toBe(hex.encode(await wallet.identity.xOnlyPublicKey()));
        expect(isPerArtifactDescriptor(first.descriptor)).toBe(false);
    });
});

describe("provisionClaimSecret", () => {
    it("derives a preimage that survives a restart with nothing stored", async () => {
        const a = await hdWallet();
        const secret = await provisionClaimSecret(a.wallet);
        expect(secret.mustPersistPreimage).toBe(false);

        // A fresh wallet on the same seed, holding only the public descriptor.
        const b = await hdWallet();
        expect(hex.encode(await contractPreimage(b.wallet, secret.descriptor))).toBe(
            hex.encode(secret.preimage),
        );
        expect(secret.preimage).toHaveLength(32);
        expect(hex.encode(secret.paymentHash)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("never repeats a preimage, on either kind of wallet", async () => {
        // HD: uniqueness comes from a fresh index. Static: the key repeats by
        // design, so uniqueness has to come from the stored preimage instead —
        // deriving there would hand two artifacts one P, and one counterparty
        // learning its own would learn the other's.
        const { wallet: hd } = await hdWallet();
        const hdSecrets = [await provisionClaimSecret(hd), await provisionClaimSecret(hd)];
        expect(new Set(hdSecrets.map((s) => hex.encode(s.preimage))).size).toBe(2);
        expect(hdSecrets.every((s) => !s.mustPersistPreimage)).toBe(true);

        const stat = staticWallet();
        const statSecrets = [await provisionClaimSecret(stat), await provisionClaimSecret(stat)];
        expect(statSecrets[0].descriptor).toBe(statSecrets[1].descriptor);
        expect(new Set(statSecrets.map((s) => hex.encode(s.preimage))).size).toBe(2);
        expect(statSecrets.every((s) => s.mustPersistPreimage)).toBe(true);
    });

    it("takes a caller's preimage verbatim and marks it for storage", async () => {
        const { wallet } = await hdWallet();
        const preimage = new Uint8Array(32).fill(7);
        const secret = await provisionClaimSecret(wallet, { preimage });

        expect(secret.preimage).toEqual(preimage);
        // The wallet did not choose it, so it cannot re-derive it.
        expect(secret.mustPersistPreimage).toBe(true);
    });

    it("rejects a preimage that is not 32 bytes before consuming an index", async () => {
        // The HTLC claim leaf pins OP_SIZE 32: any other length funds an
        // unclaimable contract, so it must be refused before money moves.
        const { wallet } = await hdWallet();
        await expect(
            provisionClaimSecret(wallet, { preimage: new Uint8Array(20) }),
        ).rejects.toThrow(/32 bytes/);
        expect(
            await (
                wallet as unknown as { getCurrentSigningDescriptor(): Promise<string> }
            ).getCurrentSigningDescriptor(),
        ).toBeUndefined();
    });
});

describe("contractSigner", () => {
    it("refuses a wallet that answers with its own identity for a foreign descriptor", async () => {
        // A broken or proxy wallet may answer with its baseline identity for a
        // descriptor it cannot derive. That identity signs happily with the
        // wrong key, so the refusal comes from checking the KEY of what came
        // back, not from asking the wallet what shape it is.
        const { wallet } = await hdWallet();
        // Burn index 0 first: a fresh seed's baseline key aliases the index-0
        // child key, and an aliased key would be a RIGHT answer.
        await provisionRefundKey(wallet);
        const { descriptor } = await provisionRefundKey(wallet);
        const broken = {
            ...wallet,
            signerForDescriptor: async () => wallet.identity,
        } as unknown as IWallet;

        // Typed, so consumers can tell "wrong wallet" (permanent, stop) from
        // a transient signing failure (retry) — the documented contract.
        await expect(contractSigner(broken, descriptor)).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
        await expect(contractPreimage(broken, descriptor)).rejects.toThrow(/holds no key/);
    });

    it("refuses a wallet with no descriptor surface for another wallet's record", async () => {
        const { wallet } = await hdWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        await expect(contractSigner(staticWallet(), descriptor)).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
    });

    it("signs deterministically, from the same identity the message is built from", async () => {
        const { wallet } = await hdWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        const signer = await contractSigner(wallet, descriptor);

        // Passing a different key in is the silent-failure mode: a
        // valid-looking preimage that nothing on chain will ever match.
        expect(isDeterministicSigner(signer)).toBe(true);
    });
});

describe("contractPreimage", () => {
    it("prefers a stored preimage over deriving one", async () => {
        const { wallet } = await hdWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        const stored = new Uint8Array(32).fill(3);
        expect(await contractPreimage(wallet, descriptor, stored)).toEqual(stored);
    });

    it("refuses a stored preimage that is not 32 bytes", async () => {
        // The check the deleted record decoder made. A truncated column or a
        // partial write would otherwise restore silently and be caught only
        // when the claim is built, with the timeout margin already spent.
        const { wallet } = await hdWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        await expect(
            contractPreimage(wallet, descriptor, new Uint8Array(20).fill(3)),
        ).rejects.toThrow(/stored preimage must be 32 bytes/);
    });

    it("refuses to derive for a descriptor that carries none", async () => {
        // Deriving off a shared key would hand two artifacts one preimage —
        // without accusing the record of losing anything: a leg whose P
        // belongs to the counterparty legitimately has none, and lands here.
        const wallet = staticWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        await expect(contractPreimage(wallet, descriptor)).rejects.toThrow(
            /names no single artifact/,
        );
    });
});

describe("adoptContractDescriptor", () => {
    it("claims a restored index so the next artifact cannot reuse it", async () => {
        // Reallocating it would derive that artifact's preimage for a new one.
        const source = await hdWallet();
        let ahead = "";
        for (let i = 0; i < 3; i++) ahead = (await provisionRefundKey(source.wallet)).descriptor;

        const fresh = await hdWallet();
        await adoptContractDescriptor(fresh.wallet, ahead);

        const next = (await provisionRefundKey(fresh.wallet)).descriptor;
        expect(next).not.toBe(ahead);
        expect(indexOf(next)).toBeGreaterThan(indexOf(ahead));
    });

    it("is a no-op where there is no index to reserve", async () => {
        // Restores iterate whole histories, so a descriptor this wallet cannot
        // place must not abort the loop.
        await expect(
            adoptContractDescriptor(staticWallet(), "tr(deadbeef)"),
        ).resolves.toBeUndefined();

        const { wallet } = await hdWallet();
        const spy = vi.spyOn(wallet, "advanceSigningDescriptorWatermark" as never);
        await expect(
            adoptContractDescriptor(wallet, `tr(${"ab".repeat(32)})`),
        ).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });

    it("is a no-op for another seed's artifact", async () => {
        // A repository can hold records from two seeds — a device migration, a
        // seed rotation. The foreign record has no index of ours to reserve,
        // and the loop must reach the own records that follow it.
        const { wallet } = await hdWallet();
        const other = MnemonicIdentity.fromMnemonic(
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
            { isMainnet: false },
        );
        const otherProvider = await HDDescriptorProvider.create(
            other,
            new InMemoryWalletRepository(),
        );
        // Honest resolution: the wallet refuses the foreign descriptor with
        // the typed error, exactly as the real wallets do.
        const honest = {
            ...wallet,
            signerForDescriptor: (d: string) => resolveDescriptorSigner(d, wallet.identity),
        } as unknown as IWallet;
        const spy = vi.spyOn(honest, "advanceSigningDescriptorWatermark" as never);

        await expect(
            adoptContractDescriptor(honest, otherProvider.materializeDescriptorAt(2)),
        ).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();

        // and an own artifact still adopts through the same path
        const own = (await provisionRefundKey(wallet)).descriptor;
        await adoptContractDescriptor(honest, own);
        expect(spy).toHaveBeenCalledWith(own);
    });
});

describe("cross-SDK vectors", () => {
    // Generated from this implementation, because NArk has no RFQ corridor to
    // pin against — these are what it should reproduce when it grows one.
    // BIP-39 test mnemonic, testnet, `m/86'/1'/0'/0/i`.
    it.each([
        {
            index: 0,
            xonly: "55355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116",
            preimage: "82e569a01f30760031a1f5bf119ae8ef9bd4fa916cf14bf27b7936f6a715c48e",
        },
        {
            index: 1,
            xonly: "3058679f6d60b87ef921d98a2a9a1f1e0779dae27bedbd1cdb2f147a07835ac9",
            preimage: "5bfb00043a3cc0bae4992083db44a4af3bf255cc29d83180c16bd3d47f86b599",
        },
        {
            index: 5,
            xonly: "b46c5983819186bd7df9ca386c25d27e86c7293e953d765df34f954c6ece2ba6",
            preimage: "6ae5a4570b8f57454d72f9b4f0a00518865df11dca5b595c8cc3e29a567b295c",
        },
    ])("index $index", async ({ index, xonly, preimage }) => {
        const { wallet } = await hdWallet();
        const descriptor = descriptorAt(index);

        expect(hex.encode(await (await contractSigner(wallet, descriptor)).xOnlyPublicKey())).toBe(
            xonly,
        );
        expect(hex.encode(await contractPreimage(wallet, descriptor))).toBe(preimage);
        // The message these hash from, spelled out for a reimplementation.
        expect(hex.encode(buildPreimageMessage(hex.decode(xonly), 0))).toBe(
            hex.encode(new TextEncoder().encode(ARKADE_SWAP_PREIMAGE_TAG)) + xonly + "00000000",
        );
    });
});
