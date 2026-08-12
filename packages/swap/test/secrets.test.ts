/**
 * The property the whole scheme rests on is that a preimage is a *function* of
 * the seed and one allocated index — so it survives a restart with nothing
 * stored, and two swaps never share one. Both are asserted directly here
 * rather than inferred from `aux_rand`.
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
} from "@arkade-os/sdk";

import {
    RFQ_PREIMAGE_TAG,
    RefundNotLocallyPossibleError,
    adoptSwapDescriptor,
    buildPreimageMessage,
    derivePreimage,
    deriveSwapSecrets,
    isDeterministicSigner,
    preimageForRfqSecrets,
    randomSwapSecrets,
    rfqSecretsOfRecord,
    rfqSecretsToRecord,
    senderIdentityForRfqSecrets,
    senderIdentityForSwapRecord,
    senderPubkeyForRfqSecrets,
} from "../src/secrets";
import { paymentHashOf } from "../src/onchainHtlc";

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
            async getUsedSigningDescriptors(opts?: { lookAhead?: number }) {
                const last = await provider.getLastIndexUsed();
                const out: string[] = [];
                for (let i = 0; i <= (last ?? -1) + (opts?.lookAhead ?? 0); i++) {
                    out.push(provider.materializeDescriptorAt(i));
                }
                return out;
            },
            async advanceSigningDescriptorWatermark(descriptor: string) {
                await provider.advanceLastIndexUsed(strictSigningDescriptorIndex(descriptor)!);
            },
            async signerForDescriptor(descriptor: string) {
                return new DescriptorIdentity({ descriptor, signer: provider, base: identity });
            },
        } as unknown as IWallet,
    };
};

/** A wallet with no HD state at all — the fallback corridor. */
const staticWallet = () => ({ identity: SingleKey.fromRandomBytes() }) as unknown as IWallet;

describe("buildPreimageMessage", () => {
    it("lays out TAG ‖ xonly(32) ‖ u32le(index)", () => {
        const xonly = new Uint8Array(32).fill(0xab);
        const message = buildPreimageMessage(xonly, 1);
        const tag = new TextEncoder().encode(RFQ_PREIMAGE_TAG);

        expect(message).toHaveLength(tag.length + 36);
        expect(message.slice(0, tag.length)).toEqual(tag);
        expect(message.slice(tag.length, tag.length + 32)).toEqual(xonly);
        // little-endian, so index 1 is 01 00 00 00
        expect([...message.slice(tag.length + 32)]).toEqual([1, 0, 0, 0]);
    });

    it("is scoped away from the Boltz corridor", () => {
        // Same key, same index: a shared tag would derive one preimage for
        // both corridors.
        expect(RFQ_PREIMAGE_TAG).toBe("Arkade-RFQ-Preimage-v1");
        expect(RFQ_PREIMAGE_TAG).not.toBe("Arkade-Boltz-Preimage-v1");
    });

    it.each([
        ["a short key", new Uint8Array(31), 0],
        ["a long key", new Uint8Array(33), 0],
    ])("rejects %s", (_label, xonly, index) => {
        expect(() => buildPreimageMessage(xonly, index)).toThrow(/32 bytes/);
    });

    it.each([-1, 1.5, 0x1_0000_0000])("rejects index %s", (index) => {
        expect(() => buildPreimageMessage(new Uint8Array(32), index)).toThrow(/u32/);
    });
});

describe("derivation", () => {
    it("derives the same preimage from the same seed and index, across instances", async () => {
        // Two wallets built independently from one mnemonic, as a restart
        // would produce.
        const a = await hdWallet();
        const secrets = (await deriveSwapSecrets(a.wallet))!;
        const first = await preimageForRfqSecrets(a.wallet, secrets);

        const b = await hdWallet();
        const second = await preimageForRfqSecrets(b.wallet, secrets);

        expect(hex.encode(second)).toBe(hex.encode(first));
        expect(first).toHaveLength(32);
    });

    it("gives every swap its own descriptor, key and preimage", async () => {
        // The regression test for peeking instead of allocating: a peek
        // returns the same descriptor until the wallet rotates, and two swaps
        // sharing a descriptor derive the IDENTICAL preimage.
        const { wallet } = await hdWallet();
        const descriptors: string[] = [];
        const pubkeys: string[] = [];
        const preimages: string[] = [];

        for (let i = 0; i < 4; i++) {
            const secrets = (await deriveSwapSecrets(wallet))!;
            descriptors.push(secrets.signingDescriptor);
            pubkeys.push(hex.encode(await senderPubkeyForRfqSecrets(wallet, secrets)));
            preimages.push(hex.encode(await preimageForRfqSecrets(wallet, secrets)));
        }

        expect(new Set(descriptors).size).toBe(4);
        expect(new Set(pubkeys).size).toBe(4);
        expect(new Set(preimages).size).toBe(4);
    });

    it("signs with the same identity the message is built from", async () => {
        const { wallet } = await hdWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;
        const signer = await senderIdentityForRfqSecrets(wallet, secrets);

        // Passing a different key in is the silent-failure mode: the result is
        // a valid-looking preimage that nothing on chain will ever match.
        expect(isDeterministicSigner(signer)).toBe(true);
        if (!isDeterministicSigner(signer)) throw new Error("expected deterministic signer");
        expect(hex.encode(await derivePreimage(signer))).toBe(
            hex.encode(await preimageForRfqSecrets(wallet, secrets)),
        );
    });

    it("refuses a wallet that answers with its own identity for a foreign descriptor", async () => {
        // Both `Wallet.signerForDescriptor` and the service-worker one fall
        // back to the wallet identity for a descriptor they cannot derive — a
        // different seed, a wiped HD state. That identity signs happily with
        // the wrong key, so the refusal has to come from checking what came
        // back, not from asking the wallet whether it is HD-capable.
        const { wallet } = await hdWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;
        const foreign = {
            ...wallet,
            signerForDescriptor: async () => wallet.identity,
        } as unknown as IWallet;

        await expect(senderIdentityForRfqSecrets(foreign, secrets)).rejects.toThrow(
            /cannot derive .*; the swap was created on another wallet/,
        );
        await expect(preimageForRfqSecrets(foreign, secrets)).rejects.toThrow(/cannot derive/);
        // typed at the throw site — and a faithful subclass, so the message
        // assertions above are unchanged
        await expect(senderIdentityForRfqSecrets(foreign, secrets)).rejects.toMatchObject({
            name: "RefundNotLocallyPossibleError",
            reason: "foreign-descriptor",
        });
    });

    it("refuses a wallet with no HD surface at all for a derivable record", async () => {
        const { wallet } = await hdWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;

        await expect(senderIdentityForRfqSecrets(staticWallet(), secrets)).rejects.toThrow(
            /cannot derive/,
        );
        await expect(senderIdentityForRfqSecrets(staticWallet(), secrets)).rejects.toBeInstanceOf(
            RefundNotLocallyPossibleError,
        );
    });
});

describe("senderIdentityForSwapRecord", () => {
    // The composition `rfqSecretsOfRecord` deliberately does not do. Each cause
    // reaches a consumer as one catchable type carrying WHICH one it was:
    // "restore the other wallet" and "this record never had secrets" are
    // different instructions to a user.
    const refusal = async (promise: Promise<unknown>) =>
        promise.catch((error: unknown) => error as RefundNotLocallyPossibleError);

    it("refuses a record that names no arm", async () => {
        // The cause that is a RETURN VALUE one level down, so a consumer wiring
        // `senderIdentityForRfqSecrets` would skip it and hit a TypeError at
        // the push site instead — which the manager would retry for hours.
        const { wallet } = await hdWallet();
        const error = await refusal(senderIdentityForSwapRecord(wallet, {}));

        expect(error).toBeInstanceOf(RefundNotLocallyPossibleError);
        expect(error.reason).toBe("no-secrets");
        // and the totality it is built on is untouched
        expect(rfqSecretsOfRecord({})).toBeUndefined();
    });

    it("refuses a fallback record this version cannot read", async () => {
        const { wallet } = await hdWallet();
        const error = await refusal(
            senderIdentityForSwapRecord(wallet, {
                fallbackSecrets: {
                    version: 2,
                    type: "stored",
                    senderPrivateKeyHex: "11".repeat(32),
                } as unknown as AssetSwapFallbackSecrets,
            }),
        );

        expect(error).toBeInstanceOf(RefundNotLocallyPossibleError);
        expect(error.reason).toBe("unreadable-secrets");
        expect(error.message).toMatch(/unsupported RFQ fallback secrets record/);
    });

    it("refuses a descriptor from another seed", async () => {
        const { wallet } = await hdWallet();
        const record = rfqSecretsToRecord((await deriveSwapSecrets(wallet))!);
        const error = await refusal(senderIdentityForSwapRecord(staticWallet(), record));

        expect(error).toBeInstanceOf(RefundNotLocallyPossibleError);
        expect(error.reason).toBe("foreign-descriptor");
    });

    it("hands back the signer for a record this wallet can derive", async () => {
        const { wallet } = await hdWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;
        const identity = await senderIdentityForSwapRecord(wallet, rfqSecretsToRecord(secrets));

        expect(await identity.xOnlyPublicKey()).toEqual(
            await senderPubkeyForRfqSecrets(wallet, secrets),
        );
    });

    it("hands back the stored key for a fallback record, on any wallet", async () => {
        const record = rfqSecretsToRecord(randomSwapSecrets({ preimage: true }));
        const identity = await senderIdentityForSwapRecord(staticWallet(), record);

        expect(await identity.xOnlyPublicKey()).toHaveLength(32);
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
        const signer = await wallet.signerForDescriptor!(descriptorAt(index));

        expect(hex.encode(await signer.xOnlyPublicKey())).toBe(xonly);
        expect(isDeterministicSigner(signer)).toBe(true);
        if (!isDeterministicSigner(signer)) throw new Error("expected deterministic signer");
        expect(hex.encode(await derivePreimage(signer))).toBe(preimage);
        // The message these hash from, spelled out for a reimplementation.
        expect(hex.encode(buildPreimageMessage(hex.decode(xonly), 0))).toBe(
            hex.encode(new TextEncoder().encode(RFQ_PREIMAGE_TAG)) + xonly + "00000000",
        );
    });
});

describe("the fallback arm", () => {
    it("is no longer what a wallet with no HD state gets — it gets the baseline arm", async () => {
        // Was `undefined`, which sent every entry point into `randomSwapSecrets()`
        // and a minted private key persisted as plaintext hex. A wallet that
        // cannot allocate still HAS a key; see "the baseline arm" below.
        const secrets = await deriveSwapSecrets(staticWallet());
        expect(secrets).toBeDefined();
        expect(secrets).not.toHaveProperty("senderPrivateKey");
    });

    it("carries the secrets, and a preimage only when asked", () => {
        expect(randomSwapSecrets()).toMatchObject({ derivable: false });
        expect(randomSwapSecrets().preimage).toBeUndefined();
        expect(randomSwapSecrets({ preimage: true }).preimage).toHaveLength(32);
    });

    it("rejects a supplied preimage that is not 32 bytes", () => {
        // The HTLC claim leaf pins OP_SIZE 32: any other length funds an
        // unclaimable swap, so it must be refused before money moves.
        expect(() => randomSwapSecrets({ preimage: new Uint8Array(20) })).toThrow(
            /preimage must be 32 bytes/,
        );
    });

    it("resolves its signer and preimage from the stored bytes", async () => {
        const wallet = staticWallet();
        const secrets = randomSwapSecrets({ preimage: true });

        expect(hex.encode(await preimageForRfqSecrets(wallet, secrets))).toBe(
            hex.encode(secrets.preimage!),
        );
        const signer = await senderIdentityForRfqSecrets(wallet, secrets);
        expect(hex.encode(await signer.xOnlyPublicKey())).toBe(
            hex.encode(await senderPubkeyForRfqSecrets(wallet, secrets)),
        );
    });

    it("refuses to invent a preimage it was never given", async () => {
        await expect(preimageForRfqSecrets(staticWallet(), randomSwapSecrets())).rejects.toThrow(
            /no stored preimage/,
        );
    });

    it("serializes enough fallback data to restore the sender identity", async () => {
        const wallet = staticWallet();
        const secrets = randomSwapSecrets({ preimage: true });
        const record = rfqSecretsToRecord(secrets);

        expect(record).toEqual({
            fallbackSecrets: {
                version: 1,
                type: "stored",
                senderPrivateKeyHex: hex.encode(secrets.senderPrivateKey),
                preimageHex: hex.encode(secrets.preimage!),
            },
        });

        const restored = rfqSecretsOfRecord(record)!;
        expect(restored.derivable).toBe(false);
        if (restored.derivable) throw new Error("expected stored secrets");
        expect(hex.encode(restored.senderPrivateKey)).toBe(hex.encode(secrets.senderPrivateKey));
        expect(hex.encode(await preimageForRfqSecrets(wallet, restored))).toBe(
            hex.encode(secrets.preimage!),
        );
        expect(hex.encode(await senderPubkeyForRfqSecrets(wallet, restored))).toBe(
            hex.encode(await senderPubkeyForRfqSecrets(wallet, secrets)),
        );
    });
});

/**
 * The arm a wallet that cannot allocate a descriptor gets.
 *
 * Modelled on boltz-swap's `swapSigner`, which falls back to
 * `this.wallet.identity` rather than minting: a wallet without HD state still
 * holds a key, and the covenant can simply be bound to it. The difference from
 * boltz-swap is the preimage — the baseline key is the SAME every swap, so the
 * pinned-index derivation would repeat it, and it is generated per swap instead.
 */
describe("the baseline arm", () => {
    it("binds to the wallet's own identity and mints nothing", async () => {
        const wallet = staticWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;

        expect(secrets.derivable).toBe(true);
        expect(secrets).not.toHaveProperty("senderPrivateKey");
        expect(hex.encode(await senderPubkeyForRfqSecrets(wallet, secrets))).toBe(
            hex.encode(await wallet.identity.xOnlyPublicKey()),
        );
    });

    it("gives each swap its own preimage, because the key repeats", async () => {
        // The whole reason this arm cannot reuse the derived path: two swaps on
        // one baseline key would derive the IDENTICAL preimage at the pinned
        // index, and one solver learning its own would learn the other's.
        const wallet = staticWallet();
        const first = (await deriveSwapSecrets(wallet, { preimage: true }))!;
        const second = (await deriveSwapSecrets(wallet, { preimage: true }))!;

        expect(first.preimage).toHaveLength(32);
        expect(hex.encode(second.preimage!)).not.toBe(hex.encode(first.preimage!));
    });

    it("carries no preimage when none was asked for", async () => {
        // A lightning send's preimage belongs to the payee.
        expect((await deriveSwapSecrets(staticWallet()))!.preimage).toBeUndefined();
    });

    it("round-trips through a record without persisting a private key", async () => {
        const wallet = staticWallet();
        const secrets = (await deriveSwapSecrets(wallet, { preimage: true }))!;
        const record = rfqSecretsToRecord(secrets);

        expect(record.fallbackSecrets).toBeUndefined();
        expect(JSON.stringify(record)).not.toContain("senderPrivateKey");

        const restored = rfqSecretsOfRecord(record)!;
        expect(hex.encode(await preimageForRfqSecrets(wallet, restored))).toBe(
            hex.encode(secrets.preimage!),
        );
        expect(hex.encode(await senderPubkeyForRfqSecrets(wallet, restored))).toBe(
            hex.encode(await senderPubkeyForRfqSecrets(wallet, secrets)),
        );
    });

    it("resolves the refund signer to the wallet's identity, not a refusal", async () => {
        // `senderIdentityForRfqSecrets` refuses a DESCRIPTOR this wallet cannot
        // derive, because signing that with the baseline key would produce a
        // dead script. The baseline arm is the opposite case: the covenant was
        // deliberately bound to this key, so returning it is correct.
        const wallet = staticWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;
        const signer = await senderIdentityForRfqSecrets(wallet, secrets);
        expect(hex.encode(await signer.xOnlyPublicKey())).toBe(
            hex.encode(await wallet.identity.xOnlyPublicKey()),
        );
    });

    it("keeps allocating a fresh descriptor when the wallet can", async () => {
        // The HD path must not regress into the baseline arm.
        const { wallet } = await hdWallet();
        const secrets = (await deriveSwapSecrets(wallet, { preimage: true }))!;
        expect(secrets.signingDescriptor).toBeDefined();
        // derived, not generated: nothing secret at rest on this arm
        expect(secrets.preimage).toBeUndefined();
    });
});

describe("restore", () => {
    it("re-derives from a record carrying nothing but the descriptor", async () => {
        const a = await hdWallet();
        const secrets = (await deriveSwapSecrets(a.wallet))!;
        const record = {
            paymentHash: "ab".repeat(32),
            signingDescriptor: secrets.signingDescriptor,
        };

        // A fresh wallet on the same seed, holding only the public record.
        const b = await hdWallet();
        const restored = rfqSecretsOfRecord(record)!;
        expect(restored.derivable).toBe(true);
        expect(hex.encode(await preimageForRfqSecrets(b.wallet, restored))).toBe(
            hex.encode(await preimageForRfqSecrets(a.wallet, secrets)),
        );
    });

    it("has nothing to reconstruct for a record with no secrets fields", () => {
        expect(rfqSecretsOfRecord({})).toBeUndefined();
    });

    it("stays total for a record with no arm, so a history loop cannot abort", () => {
        // A bare preimage names no arm: neither descriptor nor stored sender
        // key. Callers iterate history with this, so it reports "nothing to
        // reconstruct" rather than throwing on one record and losing the rest.
        expect(rfqSecretsOfRecord({ preimageHex: "cd".repeat(32) })).toBeUndefined();
    });

    it("claims a restored index so the next swap cannot reuse it", async () => {
        // The restored record's index is ahead of this wallet's watermark —
        // reallocating it would derive that swap's preimage for a new swap.
        const source = await hdWallet();
        let ahead = "";
        for (let i = 0; i < 3; i++)
            ahead = (await deriveSwapSecrets(source.wallet))!.signingDescriptor;

        const fresh = await hdWallet();
        await adoptSwapDescriptor(fresh.wallet, ahead);

        const next = (await deriveSwapSecrets(fresh.wallet))!.signingDescriptor;
        expect(next).not.toBe(ahead);
        expect(indexOf(next)).toBeGreaterThan(indexOf(ahead));
    });

    it("is a no-op on a wallet that cannot allocate", async () => {
        await expect(adoptSwapDescriptor(staticWallet(), "tr(deadbeef)")).resolves.toBeUndefined();
    });
});

describe("nothing secret reaches the record", () => {
    it("leaves a derivable swap's record free of 64-hex fields", async () => {
        const { wallet } = await hdWallet();
        const secrets = (await deriveSwapSecrets(wallet))!;

        // What a consumer would persist for an HD swap.
        const preimage = await preimageForRfqSecrets(wallet, secrets);
        const record = {
            paymentHash: paymentHashOf(preimage),
            signingDescriptor: secrets.signingDescriptor,
        };

        expect(Object.keys(secrets)).toEqual(["derivable", "signingDescriptor"]);
        expect(record.paymentHash).toMatch(/^[0-9a-f]{64}$/i);
        expect(record.paymentHash).not.toBe(hex.encode(preimage));
        expect(record.signingDescriptor).toBe(secrets.signingDescriptor);
        for (const [field, value] of Object.entries(record)) {
            expect({ field, isHex64: /^[0-9a-f]{64}$/i.test(value) }).toEqual({
                field,
                isHex64: field === "paymentHash",
            });
        }
    });
});

const indexOf = (descriptor: string): number => strictSigningDescriptorIndex(descriptor)!;
