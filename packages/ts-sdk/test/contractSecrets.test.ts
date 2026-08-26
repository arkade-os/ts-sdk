/**
 * The property the scheme rests on: a preimage is a *function* of the seed
 * and one allocated index, so it survives a restart with nothing stored and
 * two artifacts never share one. Both are asserted directly here rather than
 * inferred from `aux_rand`.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    DescriptorIdentity,
    HDDescriptorProvider,
    InMemoryWalletRepository,
    MnemonicIdentity,
    SingleKey,
    deriveDescriptorLeafPubKey,
    strictSigningDescriptorIndex,
    type IWallet,
    resolveDescriptorSigner,
    ForeignDescriptorError,
    WalletCannotSignError,
} from "../src";
import {
    ARKADE_SALTED_PREIMAGE_TAG,
    ARKADE_SWAP_PREIMAGE_TAG,
    adoptContractDescriptor,
    buildPreimageMessage,
    buildSaltedPreimageMessage,
    contractPreimage,
    contractSigner,
    isDeterministicSigner,
    isPerArtifactDescriptor,
    provisionClaimSecret,
    provisionRefundKey,
} from "../src/wallet/contractSecrets";
import { ArkAddress } from "../src/script/address";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Set by `hdWallet()`; the vectors name indices the wallet has not allocated. */
let descriptorAt: (index: number) => string;

/**
 * An HD-capable wallet built on the real allocator and the real deterministic
 * signer — the two pieces the derivation depends on. Everything else an
 * `IWallet` has is irrelevant here and left off.
 */
/**
 * A dummy server pubkey used to mint valid-looking ArkAddresses in tests.
 * The address exists only to give provisionRefundKey a decodable pkScript —
 * tests do not actually send to it.
 */
const DUMMY_SERVER_PUBKEY = new Uint8Array(32).fill(0x02);

/** Encode a valid ArkAddress whose vtxo taproot key is the identity's pubkey. */
async function fakeGetAddress(identity: {
    xOnlyPublicKey(): Promise<Uint8Array>;
}): Promise<string> {
    const vtxoKey = await identity.xOnlyPublicKey();
    return new ArkAddress(DUMMY_SERVER_PUBKEY, vtxoKey, "tark").encode();
}

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
            getAddress: () => fakeGetAddress(identity),
        } as unknown as IWallet,
    };
};

/** A wallet with no descriptor surface at all: its identity is its policy. */
const staticWallet = () => {
    const identity = SingleKey.fromRandomBytes();
    return {
        identity,
        getAddress: () => fakeGetAddress(identity),
    } as unknown as IWallet;
};

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

describe("buildSaltedPreimageMessage", () => {
    it("lays out TAG ‖ xonly(32) ‖ salt(32)", () => {
        const xonly = new Uint8Array(32).fill(0xab);
        const salt = new Uint8Array(32).fill(0xcd);
        const message = buildSaltedPreimageMessage(xonly, salt);
        const tag = new TextEncoder().encode(ARKADE_SALTED_PREIMAGE_TAG);

        expect(message).toHaveLength(tag.length + 64);
        expect(hex.encode(message)).toBe(hex.encode(tag) + "ab".repeat(32) + "cd".repeat(32));
    });

    it("cannot collide with the pinned-index message for the same key", () => {
        // Distinct tags are the whole separation between the two arms; a
        // shared prefix would let one key derive one P through both.
        const xonly = new Uint8Array(32).fill(0xab);
        expect(ARKADE_SALTED_PREIMAGE_TAG).not.toBe(ARKADE_SWAP_PREIMAGE_TAG);
        expect(hex.encode(buildSaltedPreimageMessage(xonly, new Uint8Array(32)))).not.toBe(
            hex.encode(buildPreimageMessage(xonly, 0)),
        );
    });

    it("rejects a salt or key that is not 32 bytes", () => {
        const ok = new Uint8Array(32);
        expect(() => buildSaltedPreimageMessage(new Uint8Array(20), ok)).toThrow(/32 bytes/);
        expect(() => buildSaltedPreimageMessage(ok, new Uint8Array(31))).toThrow(/32 bytes/);
    });
});

describe("provisionRefundKey", () => {
    it("reuses the identity key on every call — no HD index is consumed", async () => {
        // provisionRefundKey now binds to the wallet's identity key, not to a
        // fresh HD child. Every call for the same wallet returns the same
        // descriptor and pubkey, and the HD watermark does not advance.
        const { wallet } = await hdWallet();
        const keys = [
            await provisionRefundKey(wallet),
            await provisionRefundKey(wallet),
            await provisionRefundKey(wallet),
        ];
        // All three calls return the same identity descriptor.
        expect(new Set(keys.map((k) => k.descriptor)).size).toBe(1);
        expect(new Set(keys.map((k) => hex.encode(k.pubkey))).size).toBe(1);
        // The pubkey is the wallet's own identity key.
        const identityPubkey = hex.encode(await wallet.identity.xOnlyPublicKey());
        for (const k of keys) {
            expect(hex.encode(k.pubkey)).toBe(identityPubkey);
        }
        // The descriptor is not per-artifact — it is the bare identity descriptor.
        expect(isPerArtifactDescriptor(keys[0].descriptor)).toBe(false);
        // pkScript is returned and is a non-empty Uint8Array.
        for (const k of keys) {
            expect(k.pkScript).toBeInstanceOf(Uint8Array);
            expect(k.pkScript.length).toBeGreaterThan(0);
        }
        // The HD watermark has not advanced: getCurrentSigningDescriptor is still undefined.
        expect(
            await (
                wallet as unknown as { getCurrentSigningDescriptor(): Promise<string | undefined> }
            ).getCurrentSigningDescriptor(),
        ).toBeUndefined();
    });

    it("provisionClaimSecret refuses a descriptor the wallet cannot sign for, before anything is funded", async () => {
        // A wallet whose allocator hands back another seed's descriptor — a
        // worker rebound to a second identity, a restore onto the wrong seed.
        // provisionRefundKey is not affected because it no longer calls the
        // allocator; it binds to wallet.identity directly. But provisionClaimSecret
        // calls provisionDescriptor which does call getNextSigningDescriptor.
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

        // provisionRefundKey uses identity directly — rogue allocator has no effect.
        await expect(provisionRefundKey(rogue)).resolves.toBeDefined();
        // provisionClaimSecret still calls the allocator and gets a foreign descriptor.
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

    it("answers with the identity key on any wallet — static or HD", async () => {
        // provisionRefundKey always reuses wallet.identity. Static wallets
        // behave as before; HD wallets no longer bump an index.
        for (const makeWallet of [staticWallet, () => hdWallet().then((r) => r.wallet)]) {
            const wallet = await makeWallet();
            const first = await provisionRefundKey(wallet);
            const second = await provisionRefundKey(wallet);

            expect(first.descriptor).toBe(second.descriptor);
            expect(first.descriptor).toBe(
                `tr(${hex.encode(await wallet.identity.xOnlyPublicKey())})`,
            );
            expect(hex.encode(first.pubkey)).toBe(
                hex.encode(await wallet.identity.xOnlyPublicKey()),
            );
            expect(isPerArtifactDescriptor(first.descriptor)).toBe(false);
            // pkScript matches the wallet address
            const address = await wallet.getAddress();
            const { pkScript } = ArkAddress.decode(address);
            expect(hex.encode(first.pkScript)).toBe(hex.encode(pkScript));
        }
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
        // design, so uniqueness comes from a fresh salt instead. This is the
        // regression test for the collision the salted arm exists to avoid —
        // it fails if anyone reuses a constant salt.
        const { wallet: hd } = await hdWallet();
        const hdSecrets = [await provisionClaimSecret(hd), await provisionClaimSecret(hd)];
        expect(new Set(hdSecrets.map((s) => hex.encode(s.preimage))).size).toBe(2);
        expect(hdSecrets.every((s) => !s.mustPersistPreimage)).toBe(true);
        expect(hdSecrets.every((s) => s.preimageSalt === undefined)).toBe(true);

        const stat = staticWallet();
        const statSecrets = [
            await provisionClaimSecret(stat),
            await provisionClaimSecret(stat),
            await provisionClaimSecret(stat),
        ];
        // One descriptor, three swaps, three different everything-else.
        expect(new Set(statSecrets.map((s) => s.descriptor)).size).toBe(1);
        expect(new Set(statSecrets.map((s) => hex.encode(s.preimageSalt!))).size).toBe(3);
        expect(new Set(statSecrets.map((s) => hex.encode(s.preimage))).size).toBe(3);
        expect(new Set(statSecrets.map((s) => hex.encode(s.paymentHash))).size).toBe(3);
        // And nothing secret to store: the salt is public.
        expect(statSecrets.every((s) => !s.mustPersistPreimage)).toBe(true);
    });

    it("derives a static wallet's preimage from the seed and the salt alone", async () => {
        // The property the salted arm rests on: two independently constructed
        // wallets on one key agree, given only the record's public fields.
        const key = SingleKey.fromRandomBytes();
        const first = { identity: key } as unknown as IWallet;
        const secret = await provisionClaimSecret(first);
        expect(secret.mustPersistPreimage).toBe(false);
        expect(secret.preimageSalt).toHaveLength(32);

        const second = {
            identity: SingleKey.fromHex(key.toHex()),
        } as unknown as IWallet;
        const rederived = await contractPreimage(second, secret.descriptor, {
            salt: secret.preimageSalt,
        });
        expect(hex.encode(rederived)).toBe(hex.encode(secret.preimage));
    });

    it("separates the salted arm from the pinned-index arm by tag", async () => {
        // Same key, both derivations: distinct tags must keep them apart, or
        // one corridor's preimage would be the other's.
        const key = SingleKey.fromRandomBytes();
        const secret = await provisionClaimSecret({ identity: key } as unknown as IWallet);
        const xonly = await key.xOnlyPublicKey();

        const asIfPinned = sha256(
            await key.signSchnorrDeterministic(sha256(buildPreimageMessage(xonly, 0))),
        );
        expect(hex.encode(secret.preimage)).not.toBe(hex.encode(asIfPinned));
    });

    it("falls back to a stored preimage when the signer cannot derive", async () => {
        // Both signers here are COMPLETE identities — `contractSigner` refuses
        // a partial one outright (WalletCannotSignError), so the fallback arm
        // is for a wallet that can spend the leg but cannot sign
        // deterministically: an extension or remote signer.
        //
        // Two distinct refusals: one missing the method entirely, and one that
        // exposes it and throws at call time (DescriptorIdentity's shape). The
        // structural guard only sees the first, so both must land here.
        const base = SingleKey.fromRandomBytes();
        const signing = {
            sign: (tx: unknown) => base.sign(tx as never),
            signMessage: (m: Uint8Array) => base.signMessage(m),
            signerSession: () => base.signerSession(),
            xOnlyPublicKey: () => base.xOnlyPublicKey(),
        };

        for (const identity of [
            signing,
            {
                ...signing,
                signSchnorrDeterministic: async () => {
                    throw new Error("this signer refuses");
                },
            },
        ]) {
            const secret = await provisionClaimSecret({ identity } as unknown as IWallet);
            expect(secret.mustPersistPreimage).toBe(true);
            expect(secret.preimage).toHaveLength(32);
            // No salt: a record carrying one it cannot derive from is worse
            // than none, because it reads as recoverable.
            expect(secret.preimageSalt).toBeUndefined();
        }
    });

    it("propagates a key refusal instead of degrading it to a stored preimage", async () => {
        // The salted arm's fallback may absorb "cannot sign deterministically"
        // and nothing else. A wallet that does not hold the key must not come
        // back with a random preimage and a success — that funds a leg nothing
        // can spend.
        const base = SingleKey.fromRandomBytes();
        const wallet = {
            identity: base,
            getCurrentSigningDescriptor: async () => undefined,
            getNextSigningDescriptor: async () => undefined,
            getUsedSigningDescriptors: async () => [],
            advanceSigningDescriptorWatermark: async () => {},
            // Resolves once for provisioning, then stops holding the key —
            // the only way to reach the salted arm's catch with a key error.
            signerForDescriptor: vi
                .fn()
                .mockResolvedValueOnce(base)
                .mockRejectedValue(new ForeignDescriptorError("tr(deadbeef)")),
        } as unknown as IWallet;

        await expect(provisionClaimSecret(wallet)).rejects.toBeInstanceOf(ForeignDescriptorError);
    });

    it("refuses a watch-only identity before it reaches the salted arm", async () => {
        // The fallback must not paper over a wallet that cannot spend the leg
        // at all: #738's check fires first, so such a wallet learns before it
        // funds rather than at refund time.
        const base = SingleKey.fromRandomBytes();
        const watchOnly = { xOnlyPublicKey: () => base.xOnlyPublicKey() };

        await expect(
            provisionClaimSecret({ identity: watchOnly } as unknown as IWallet),
        ).rejects.toThrow(/cannot sign with it/);
    });

    it("still raises loudly for an HD descriptor whose signer cannot derive", async () => {
        // A per-artifact descriptor that cannot sign deterministically is a
        // broken wallet, not a fallback case — the salted arm's tolerance must
        // not leak into this one.
        // Use provisionClaimSecret to obtain an HD child descriptor: provisionRefundKey
        // no longer allocates one.
        const { wallet } = await hdWallet();
        const { descriptor } = await provisionClaimSecret(wallet);
        const identity = (wallet as unknown as { identity: Record<string, unknown> }).identity;
        const broken = {
            identity,
            getCurrentSigningDescriptor: async () => undefined,
            getNextSigningDescriptor: async () => descriptor,
            getUsedSigningDescriptors: async () => [],
            advanceSigningDescriptorWatermark: async () => {},
            getAddress: () => fakeGetAddress(identity as { xOnlyPublicKey(): Promise<Uint8Array> }),
            // A COMPLETE identity for the right key that simply cannot sign
            // deterministically — otherwise `contractSigner` refuses it as
            // watch-only first and this asserts the wrong refusal.
            signerForDescriptor: async () => ({
                sign: identity.sign,
                signMessage: identity.signMessage,
                signerSession: identity.signerSession,
                xOnlyPublicKey: async () => deriveDescriptorLeafPubKey(descriptor),
            }),
        } as unknown as IWallet;

        await expect(provisionClaimSecret(broken)).rejects.toThrow(/not derivable/);
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
        // Use provisionClaimSecret (not provisionRefundKey) to get an HD child
        // descriptor — provisionRefundKey now always returns the identity descriptor,
        // which the identity key IS the right answer for.
        // Burn index 0 first: a fresh seed's baseline key aliases the index-0
        // child key, and an aliased key would be a RIGHT answer for index 0.
        await provisionClaimSecret(wallet);
        const { descriptor } = await provisionClaimSecret(wallet);
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
        expect(await contractPreimage(wallet, descriptor, { stored })).toEqual(stored);
    });

    it("prefers a stored preimage over a salt, on a static descriptor", async () => {
        // Precedence, not a coin flip: a stored P is the artifact's, whatever
        // the wallet could derive now.
        const wallet = staticWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        const stored = new Uint8Array(32).fill(9);
        expect(
            await contractPreimage(wallet, descriptor, {
                stored,
                salt: new Uint8Array(32).fill(1),
            }),
        ).toEqual(stored);
    });

    it("refuses a stored preimage that is not 32 bytes", async () => {
        // The check the deleted record decoder made — a truncated column would
        // otherwise restore silently and be caught only when the claim is
        // built. The empty case is the one an explicit length test buys: a
        // zero-length array is truthy, so it would be handed straight back.
        const wallet = staticWallet();
        const { descriptor } = await provisionRefundKey(wallet);
        for (const stored of [new Uint8Array(0), new Uint8Array(20).fill(3), new Uint8Array(31)]) {
            await expect(contractPreimage(wallet, descriptor, { stored })).rejects.toThrow(
                /stored preimage must be 32 bytes/,
            );
        }
    });

    it("refuses to derive for a descriptor that carries none", async () => {
        // Deriving off a shared key with no salt would hand two artifacts one
        // preimage — without accusing the record of losing anything: a leg
        // whose P belongs to the counterparty legitimately has none.
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
        // Use provisionClaimSecret (not provisionRefundKey) to advance the HD watermark —
        // provisionRefundKey no longer allocates a fresh index.
        const source = await hdWallet();
        let ahead = "";
        for (let i = 0; i < 3; i++) ahead = (await provisionClaimSecret(source.wallet)).descriptor;

        const fresh = await hdWallet();
        await adoptContractDescriptor(fresh.wallet, ahead);

        // provisionClaimSecret still allocates a fresh index, so the next one is beyond `ahead`.
        const next = (await provisionClaimSecret(fresh.wallet)).descriptor;
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
        // (using provisionClaimSecret since provisionRefundKey returns the identity
        // descriptor which has no HD index to adopt)
        const own = (await provisionClaimSecret(wallet)).descriptor;
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

    // The salted arm. Keyed off a raw private key rather than the mnemonic,
    // because this arm is what a wallet with no HD stream uses — a
    // reimplementation needs no derivation path to reproduce it.
    it.each([
        {
            privateKey: "0101010101010101010101010101010101010101010101010101010101010101",
            xonly: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
            salt: "0000000000000000000000000000000000000000000000000000000000000000",
            preimage: "b4d9da14ae18b0de26571983e689846d02f58ff19449104d05f3578b0081a828",
        },
        {
            privateKey: "0202020202020202020202020202020202020202020202020202020202020202",
            xonly: "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
            salt: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            preimage: "7fc76ad065dbfa7cdba6905d04b1f37c93f970c03fb123b5612cec3a185dfad5",
        },
        {
            privateKey: "4242424242424242424242424242424242424242424242424242424242424242",
            xonly: "24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c",
            salt: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            preimage: "dbaf93e66f2149482c6be3b6ebeccb033d6ae7adb3a20547d411a0577d6f135d",
        },
    ])("salted, key $privateKey", async ({ privateKey, xonly, salt, preimage }) => {
        const key = SingleKey.fromHex(privateKey);
        const wallet = { identity: key } as unknown as IWallet;
        expect(hex.encode(await key.xOnlyPublicKey())).toBe(xonly);

        expect(
            hex.encode(await contractPreimage(wallet, `tr(${xonly})`, { salt: hex.decode(salt) })),
        ).toBe(preimage);
        expect(hex.encode(buildSaltedPreimageMessage(hex.decode(xonly), hex.decode(salt)))).toBe(
            hex.encode(new TextEncoder().encode(ARKADE_SALTED_PREIMAGE_TAG)) + xonly + salt,
        );
    });
});
