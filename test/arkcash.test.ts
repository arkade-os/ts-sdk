import { describe, it, expect } from "vitest";
import { ArkCash } from "../src/arkcash";
import { hex } from "@scure/base";
import { pubSchnorr } from "@scure/btc-signer/utils.js";

describe("ArkCash", () => {
    const testPrivKey = hex.decode(
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    );
    // Server pubkey must be a valid x-only secp256k1 public key
    const serverPrivKey = hex.decode(
        "a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0"
    );
    const testServerPubKey = pubSchnorr(serverPrivKey);

    describe("encode/decode roundtrip", () => {
        it("should roundtrip with blocks timelock", () => {
            const cash = new ArkCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const encoded = cash.toString();
            expect(encoded.startsWith("arkcash1")).toBe(true);

            const decoded = ArkCash.fromString(encoded);
            expect(hex.encode(decoded.privateKey)).toBe(
                hex.encode(testPrivKey)
            );
            expect(hex.encode(decoded.serverPubKey)).toBe(
                hex.encode(testServerPubKey)
            );
            expect(decoded.csvTimelock.type).toBe("blocks");
            expect(decoded.csvTimelock.value).toBe(144n);
            expect(decoded.hrp).toBe("arkcash");
        });

        it("should roundtrip with seconds timelock", () => {
            const cash = new ArkCash(testPrivKey, testServerPubKey, {
                type: "seconds",
                value: 512n,
            });

            const encoded = cash.toString();
            const decoded = ArkCash.fromString(encoded);
            expect(decoded.csvTimelock.type).toBe("seconds");
            expect(decoded.csvTimelock.value).toBe(512n);
        });

        it("should roundtrip with custom HRP", () => {
            const cash = new ArkCash(
                testPrivKey,
                testServerPubKey,
                {
                    type: "blocks",
                    value: 144n,
                },
                "tarkcash"
            );

            const encoded = cash.toString();
            expect(encoded.startsWith("tarkcash1")).toBe(true);

            const decoded = ArkCash.fromString(encoded);
            expect(decoded.hrp).toBe("tarkcash");
        });
    });

    describe("key derivation", () => {
        it("should derive correct public key", () => {
            const cash = new ArkCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const expectedPubKey = pubSchnorr(testPrivKey);
            expect(hex.encode(cash.publicKey)).toBe(hex.encode(expectedPubKey));
        });

        it("should return a SingleKey identity", async () => {
            const cash = new ArkCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const identity = cash.identity;
            const pubKey = await identity.xOnlyPublicKey();
            expect(hex.encode(pubKey)).toBe(hex.encode(cash.publicKey));
        });
    });

    describe("vtxo script", () => {
        it("should create a valid DefaultVtxo script", () => {
            const cash = new ArkCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const script = cash.vtxoScript;
            expect(script).toBeDefined();
            expect(script.pkScript).toBeDefined();
            expect(script.pkScript.length).toBeGreaterThan(0);
        });

        it("should derive a valid ArkAddress", () => {
            const cash = new ArkCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const address = cash.address("tark");
            const encoded = address.encode();
            expect(encoded.startsWith("tark1")).toBe(true);
        });
    });

    describe("generate", () => {
        it("should generate a random ArkCash", () => {
            const cash = ArkCash.generate(testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            expect(cash.privateKey.length).toBe(32);
            expect(cash.publicKey.length).toBe(32);
            expect(hex.encode(cash.serverPubKey)).toBe(
                hex.encode(testServerPubKey)
            );
        });

        it("should generate unique keys each time", () => {
            const cash1 = ArkCash.generate(testServerPubKey, {
                type: "blocks",
                value: 144n,
            });
            const cash2 = ArkCash.generate(testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            expect(hex.encode(cash1.privateKey)).not.toBe(
                hex.encode(cash2.privateKey)
            );
        });
    });

    describe("validation", () => {
        it("should throw on invalid private key length", () => {
            expect(
                () =>
                    new ArkCash(new Uint8Array(16), testServerPubKey, {
                        type: "blocks",
                        value: 144n,
                    })
            ).toThrow("Invalid private key length");
        });

        it("should throw on invalid server pubkey length", () => {
            expect(
                () =>
                    new ArkCash(testPrivKey, new Uint8Array(16), {
                        type: "blocks",
                        value: 144n,
                    })
            ).toThrow("Invalid server public key length");
        });

        it("should throw on invalid bech32m string", () => {
            expect(() => ArkCash.fromString("notvalid")).toThrow();
        });

        it("should throw on wrong data length", () => {
            expect(() =>
                ArkCash.fromString("arkcash1qqqqqqqqq0saqvp")
            ).toThrow();
        });
    });
});
