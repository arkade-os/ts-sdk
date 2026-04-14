import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { StaticDescriptorProvider } from "../src/identity/staticDescriptorProvider";
import { SingleKey } from "../src/identity/singleKey";

// Well-known test private key (32 bytes, all 0x01)
const TEST_PRIVKEY = new Uint8Array(32).fill(1);

describe("StaticDescriptorProvider", () => {
    let provider: StaticDescriptorProvider;
    let pubKeyHex: string;

    beforeEach(async () => {
        const identity = SingleKey.fromPrivateKey(TEST_PRIVKEY);
        provider = await StaticDescriptorProvider.create(identity);
        const pubKey = await identity.xOnlyPublicKey();
        pubKeyHex = hex.encode(pubKey);
    });

    describe("create", () => {
        it("should create from Identity", () => {
            expect(provider).toBeInstanceOf(StaticDescriptorProvider);
        });
    });

    describe("getSigningDescriptor", () => {
        it("should return tr(<pubkey>) format", () => {
            const descriptor = provider.getSigningDescriptor();
            expect(descriptor).toBe(`tr(${pubKeyHex})`);
        });

        it("should return consistent descriptor", () => {
            expect(provider.getSigningDescriptor()).toBe(
                provider.getSigningDescriptor()
            );
        });
    });

    describe("isOurs", () => {
        it("should return true for own descriptor", () => {
            expect(provider.isOurs(`tr(${pubKeyHex})`)).toBe(true);
        });

        it("should return true for raw hex pubkey", () => {
            expect(provider.isOurs(pubKeyHex)).toBe(true);
        });

        it("should return true for uppercase hex", () => {
            expect(provider.isOurs(pubKeyHex.toUpperCase())).toBe(true);
        });

        it("should return true for tr(UPPERCASE)", () => {
            expect(provider.isOurs(`tr(${pubKeyHex.toUpperCase()})`)).toBe(
                true
            );
        });

        it("should return false for different pubkey", () => {
            expect(provider.isOurs("tr(" + "b".repeat(64) + ")")).toBe(false);
        });

        it("should return false for HD descriptor", () => {
            expect(
                provider.isOurs("tr([12345678/86'/0'/0']xpubSomething/0/5)")
            ).toBe(false);
        });
    });

    describe("signMessageWithDescriptor", () => {
        it("should sign with schnorr by default", async () => {
            const message = new Uint8Array(32).fill(42);
            const signature = await provider.signMessageWithDescriptor(
                `tr(${pubKeyHex})`,
                message
            );
            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);
        });

        it("should sign with ecdsa", async () => {
            const message = new Uint8Array(32).fill(42);
            const signature = await provider.signMessageWithDescriptor(
                `tr(${pubKeyHex})`,
                message,
                "ecdsa"
            );
            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);
        });

        it("should accept raw hex pubkey", async () => {
            const message = new Uint8Array(32).fill(42);
            const signature = await provider.signMessageWithDescriptor(
                pubKeyHex,
                message
            );
            expect(signature).toHaveLength(64);
        });

        it("should throw for foreign descriptor", async () => {
            const message = new Uint8Array(32).fill(42);
            await expect(
                provider.signMessageWithDescriptor(
                    "tr(" + "b".repeat(64) + ")",
                    message
                )
            ).rejects.toThrow("does not belong");
        });
    });

    describe("signWithDescriptor", () => {
        it("should handle empty requests array", async () => {
            const results = await provider.signWithDescriptor([]);
            expect(results).toEqual([]);
        });

        it("should throw for foreign descriptor", async () => {
            await expect(
                provider.signWithDescriptor([
                    {
                        descriptor: "tr(" + "b".repeat(64) + ")",
                        tx: null as any,
                    },
                ])
            ).rejects.toThrow("does not belong");
        });
    });
});
