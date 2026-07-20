import { describe, it, expect } from "vitest";
import { ArkadeCash } from "../src/arkadeCash";
import { hex } from "@scure/base";
import { pubSchnorr } from "@scure/btc-signer/utils.js";

describe("ArkadeCash", () => {
    const testPrivKey = hex.decode(
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
    // Server pubkey must be a valid x-only secp256k1 public key
    const serverPrivKey = hex.decode(
        "a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0",
    );
    const testServerPubKey = pubSchnorr(serverPrivKey);

    describe("encode/decode roundtrip", () => {
        it("should roundtrip with blocks timelock", () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const encoded = cash.toString();
            expect(encoded.startsWith("arkcash1")).toBe(true);

            const decoded = ArkadeCash.fromString(encoded);
            expect(hex.encode(decoded.privateKey)).toBe(hex.encode(testPrivKey));
            expect(hex.encode(decoded.serverPubKey)).toBe(hex.encode(testServerPubKey));
            expect(decoded.csvTimelock.type).toBe("blocks");
            expect(decoded.csvTimelock.value).toBe(144n);
            expect(decoded.hrp).toBe("arkcash");
        });

        it("should roundtrip with seconds timelock", () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "seconds",
                value: 512n,
            });

            const encoded = cash.toString();
            const decoded = ArkadeCash.fromString(encoded);
            expect(decoded.csvTimelock.type).toBe("seconds");
            expect(decoded.csvTimelock.value).toBe(512n);
        });

        it("should roundtrip with custom HRP", () => {
            const cash = new ArkadeCash(
                testPrivKey,
                testServerPubKey,
                {
                    type: "blocks",
                    value: 144n,
                },
                "tarkcash",
            );

            const encoded = cash.toString();
            expect(encoded.startsWith("tarkcash1")).toBe(true);

            const decoded = ArkadeCash.fromString(encoded);
            expect(decoded.hrp).toBe("tarkcash");
        });
    });

    describe("key derivation", () => {
        it("should derive correct public key", () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const expectedPubKey = pubSchnorr(testPrivKey);
            expect(hex.encode(cash.publicKey)).toBe(hex.encode(expectedPubKey));
        });

        it("should return a SingleKey identity", async () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
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
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const script = cash.vtxoScript;
            expect(script).toBeDefined();
            expect(script.pkScript).toBeDefined();
            expect(script.pkScript.length).toBeGreaterThan(0);
        });

        it("should derive a valid ArkAddress", () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const address = cash.address("tark");
            const encoded = address.encode();
            expect(encoded.startsWith("tark1")).toBe(true);
        });
    });

    describe("generate", () => {
        it("should generate a random ArkadeCash", () => {
            const cash = ArkadeCash.generate(testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            expect(cash.privateKey.length).toBe(32);
            expect(cash.publicKey.length).toBe(32);
            expect(hex.encode(cash.serverPubKey)).toBe(hex.encode(testServerPubKey));
        });

        it("should generate unique keys each time", () => {
            const cash1 = ArkadeCash.generate(testServerPubKey, {
                type: "blocks",
                value: 144n,
            });
            const cash2 = ArkadeCash.generate(testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            expect(hex.encode(cash1.privateKey)).not.toBe(hex.encode(cash2.privateKey));
        });
    });

    describe("defensive key copies", () => {
        it("is unaffected by mutating the buffers passed to the constructor", () => {
            const priv = testPrivKey.slice();
            const server = testServerPubKey.slice();
            const cash = new ArkadeCash(priv, server, { type: "blocks", value: 144n });

            const encodedBefore = cash.toString();
            const pubBefore = hex.encode(cash.publicKey);

            // Mutating the caller's buffers must not change the note.
            priv.fill(0);
            server.fill(0);

            expect(cash.toString()).toBe(encodedBefore);
            expect(hex.encode(cash.privateKey)).toBe(hex.encode(testPrivKey));
            expect(hex.encode(cash.serverPubKey)).toBe(hex.encode(testServerPubKey));
            expect(hex.encode(cash.publicKey)).toBe(pubBefore);
        });

        it("is unaffected by mutating the buffers returned from getters", () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            const encodedBefore = cash.toString();
            cash.privateKey.fill(0);
            cash.serverPubKey.fill(0);
            cash.publicKey.fill(0);

            expect(cash.toString()).toBe(encodedBefore);
            expect(hex.encode(cash.privateKey)).toBe(hex.encode(testPrivKey));
            expect(hex.encode(cash.serverPubKey)).toBe(hex.encode(testServerPubKey));
            expect(hex.encode(cash.publicKey)).toBe(hex.encode(pubSchnorr(testPrivKey)));
        });

        it("returns a distinct copy on each getter access", () => {
            const cash = new ArkadeCash(testPrivKey, testServerPubKey, {
                type: "blocks",
                value: 144n,
            });

            expect(cash.privateKey).not.toBe(cash.privateKey);
            expect(cash.serverPubKey).not.toBe(cash.serverPubKey);
            expect(cash.publicKey).not.toBe(cash.publicKey);
        });
    });

    describe("validation", () => {
        it("should throw on invalid private key length", () => {
            expect(
                () =>
                    new ArkadeCash(new Uint8Array(16), testServerPubKey, {
                        type: "blocks",
                        value: 144n,
                    }),
            ).toThrow("Invalid private key length");
        });

        it("should throw on invalid server pubkey length", () => {
            expect(
                () =>
                    new ArkadeCash(testPrivKey, new Uint8Array(16), {
                        type: "blocks",
                        value: 144n,
                    }),
            ).toThrow("Invalid server public key length");
        });

        it("should throw on invalid bech32m string", () => {
            expect(() => ArkadeCash.fromString("notvalid")).toThrow();
        });

        it("should throw on wrong data length", () => {
            expect(() => ArkadeCash.fromString("arkcash1qqqqqqqqq0saqvp")).toThrow();
        });
    });
});
