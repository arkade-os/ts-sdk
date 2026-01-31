import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { StaticDescriptorProvider } from "../src/identity/staticDescriptorProvider";
import { SingleKey } from "../src/identity";

describe("StaticDescriptorProvider", () => {
    // A known private key for testing
    const TEST_PRIVATE_KEY = hex.decode(
        "0000000000000000000000000000000000000000000000000000000000000001"
    );

    it("should create from Identity", async () => {
        const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
        const provider = await StaticDescriptorProvider.create(identity);

        expect(provider).toBeDefined();
    });

    describe("getSigningDescriptor", () => {
        it("should return tr(pubkey) format", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);

            const descriptor = provider.getSigningDescriptor();

            expect(descriptor).toMatch(/^tr\([0-9a-f]{64}\)$/);
        });

        it("should return consistent descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);

            const desc1 = provider.getSigningDescriptor();
            const desc2 = provider.getSigningDescriptor();

            expect(desc1).toBe(desc2);
        });
    });

    describe("isOurs", () => {
        it("should return true for own descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const descriptor = provider.getSigningDescriptor();

            expect(provider.isOurs(descriptor)).toBe(true);
        });

        it("should return true for raw hex pubkey", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const pubKeyHex = hex.encode(await identity.xOnlyPublicKey());

            expect(provider.isOurs(pubKeyHex)).toBe(true);
        });

        it("should return true for uppercase hex pubkey", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const pubKeyHex = hex
                .encode(await identity.xOnlyPublicKey())
                .toUpperCase();

            expect(provider.isOurs(pubKeyHex)).toBe(true);
        });

        it("should return true for tr(UPPERCASE) descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const pubKeyHex = hex
                .encode(await identity.xOnlyPublicKey())
                .toUpperCase();

            expect(provider.isOurs(`tr(${pubKeyHex})`)).toBe(true);
        });

        it("should return false for different pubkey", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);

            expect(provider.isOurs("tr(" + "a".repeat(64) + ")")).toBe(false);
        });

        it("should return false for HD descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);

            // HD descriptors cannot be verified by static provider
            expect(
                provider.isOurs("tr([12345678/86'/0'/0']xpubABC123/0/5)")
            ).toBe(false);
        });
    });

    describe("signMessageWithDescriptor", () => {
        it("should sign message with own descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const descriptor = provider.getSigningDescriptor();
            const message = new Uint8Array(32).fill(42);

            const signature = await provider.signMessageWithDescriptor(
                descriptor,
                message,
                "schnorr"
            );

            expect(signature).toHaveLength(64);
        });

        it("should sign message with raw hex pubkey", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const pubKeyHex = hex.encode(await identity.xOnlyPublicKey());
            const message = new Uint8Array(32).fill(42);

            const signature = await provider.signMessageWithDescriptor(
                pubKeyHex,
                message,
                "schnorr"
            );

            expect(signature).toHaveLength(64);
        });

        it("should sign with ecdsa", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const descriptor = provider.getSigningDescriptor();
            const message = new Uint8Array(32).fill(42);

            const signature = await provider.signMessageWithDescriptor(
                descriptor,
                message,
                "ecdsa"
            );

            expect(signature).toHaveLength(64);
        });

        it("should default to schnorr", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const descriptor = provider.getSigningDescriptor();
            const message = new Uint8Array(32).fill(42);

            const signature = await provider.signMessageWithDescriptor(
                descriptor,
                message
            );

            expect(signature).toHaveLength(64);
        });

        it("should throw for foreign descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const message = new Uint8Array(32).fill(42);

            await expect(
                provider.signMessageWithDescriptor(
                    "tr(" + "a".repeat(64) + ")",
                    message
                )
            ).rejects.toThrow("does not belong to this provider");
        });
    });

    describe("signWithDescriptor", () => {
        it("should return empty array for empty requests", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);
            const descriptor = provider.getSigningDescriptor();

            const results = await provider.signWithDescriptor(descriptor, []);

            expect(results).toEqual([]);
        });

        it("should throw for foreign descriptor", async () => {
            const identity = SingleKey.fromPrivateKey(TEST_PRIVATE_KEY);
            const provider = await StaticDescriptorProvider.create(identity);

            await expect(
                provider.signWithDescriptor("tr(" + "a".repeat(64) + ")", [])
            ).rejects.toThrow("does not belong to this provider");
        });
    });
});
