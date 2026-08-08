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
    type IWallet,
} from "@arkade-os/sdk";

import {
    RFQ_PREIMAGE_TAG,
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
                await provider.advanceLastIndexUsed(Number(descriptor.match(/\/(\d+)\)\s*$/)![1]));
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
    it("is what a wallet with no HD state gets", async () => {
        expect(await deriveSwapSecrets(staticWallet())).toBeUndefined();
    });

    it("carries the secrets, and a preimage only when asked", () => {
        expect(randomSwapSecrets()).toMatchObject({ derivable: false });
        expect(randomSwapSecrets().preimage).toBeUndefined();
        expect(randomSwapSecrets({ preimage: true }).preimage).toHaveLength(32);
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

    it("has nothing to reconstruct for a record with no descriptor", () => {
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

const indexOf = (descriptor: string): number => Number(descriptor.match(/\/(\d+)\)\s*$/)![1]);
