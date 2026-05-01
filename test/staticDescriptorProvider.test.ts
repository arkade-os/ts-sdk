import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { StaticDescriptorProvider } from "../src/identity/staticDescriptorProvider";
import { SingleKey } from "../src/identity/singleKey";
import type { BatchSignableIdentity, SignRequest } from "../src/identity";
import type { Transaction } from "../src/utils/transaction";

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

    describe("getNextSigningDescriptor", () => {
        it("should return tr(<pubkey>) format", async () => {
            const descriptor = await provider.getNextSigningDescriptor();
            expect(descriptor).toBe(`tr(${pubKeyHex})`);
        });

        it("should return the same descriptor on every call (no rotation)", async () => {
            expect(await provider.getNextSigningDescriptor()).toBe(
                await provider.getNextSigningDescriptor()
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

        it("should return false for empty string (not throw)", () => {
            expect(provider.isOurs("")).toBe(false);
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

        it("should throw when signMultiple returns fewer results than requests", async () => {
            // Mirror the wallet-side guard in src/wallet/wallet.ts: a
            // BatchSignableIdentity that violates the "one result per request"
            // contract must be surfaced, not silently trusted.
            const singleKey = SingleKey.fromPrivateKey(TEST_PRIVKEY);
            const brokenIdentity: BatchSignableIdentity = Object.assign(
                Object.create(Object.getPrototypeOf(singleKey)),
                singleKey,
                {
                    signMultiple: async (
                        _requests: SignRequest[]
                    ): Promise<Transaction[]> => [],
                }
            );
            const brokenProvider =
                await StaticDescriptorProvider.create(brokenIdentity);
            await expect(
                brokenProvider.signWithDescriptor([
                    {
                        descriptor: `tr(${pubKeyHex})`,
                        tx: null as any,
                    },
                ])
            ).rejects.toThrow(
                "signMultiple returned 0 transactions, expected 1"
            );
        });
    });
});
