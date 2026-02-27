import { describe, it, expect } from "vitest";
import { BIP322 } from "../src/bip322";
import { SingleKey } from "../src/identity/singleKey";
import { p2tr } from "@scure/btc-signer";

/**
 * Test vectors sourced from:
 * - Bitcoin Core util_tests.cpp (L2747): deterministic SIGHASH_ALL P2TR vector
 * - bip322-js (ACken2/bip322-js): round-trip and falsification tests
 * - BIP-322 specification: message hash vectors
 *
 * Private key (WIF): L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k
 */
const PRIVATE_KEY_HEX =
    "bb051cd0dda0246f33c5a9e133ebd8e7bc02a92af6c41adc131ccd7826c5b004";
const P2TR_ADDRESS =
    "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";

// Deterministic SIGHASH_ALL signature from Bitcoin Core test suite
const SIGHASH_ALL_SIGNATURE =
    "AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==";

// Wrong P2TR addresses (valid addresses, but different keys)
const WRONG_P2TR_ADDRESS =
    "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";

describe("BIP322", () => {
    const identity = SingleKey.fromHex(PRIVATE_KEY_HEX);

    describe("verify — deterministic SIGHASH_ALL vectors (Bitcoin Core)", () => {
        it("should verify known SIGHASH_ALL signature for 'Hello World'", () => {
            const valid = BIP322.verify(
                "Hello World",
                SIGHASH_ALL_SIGNATURE,
                P2TR_ADDRESS
            );
            expect(valid).toBe(true);
        });

        it("should reject SIGHASH_ALL signature against wrong message", () => {
            const valid = BIP322.verify(
                "Hello World - This should fail",
                SIGHASH_ALL_SIGNATURE,
                P2TR_ADDRESS
            );
            expect(valid).toBe(false);
        });

        it("should reject SIGHASH_ALL signature against wrong address", () => {
            const valid = BIP322.verify(
                "Hello World",
                SIGHASH_ALL_SIGNATURE,
                WRONG_P2TR_ADDRESS
            );
            expect(valid).toBe(false);
        });
    });

    describe("sign + verify — round-trip (SIGHASH_DEFAULT)", () => {
        it("should round-trip sign and verify 'Hello World'", async () => {
            const signature = await BIP322.sign("Hello World", identity);

            const valid = BIP322.verify("Hello World", signature, P2TR_ADDRESS);
            expect(valid).toBe(true);
        });

        it("should round-trip sign and verify empty message", async () => {
            const signature = await BIP322.sign("", identity);

            const valid = BIP322.verify("", signature, P2TR_ADDRESS);
            expect(valid).toBe(true);
        });

        it("should round-trip sign and verify long message", async () => {
            const longMsg = "A".repeat(1000);
            const signature = await BIP322.sign(longMsg, identity);

            const valid = BIP322.verify(longMsg, signature, P2TR_ADDRESS);
            expect(valid).toBe(true);
        });
    });

    describe("verify — falsification (bip322-js vectors)", () => {
        it("should reject valid signature against wrong message", async () => {
            const signature = await BIP322.sign("Hello World", identity);

            const valid = BIP322.verify("", signature, P2TR_ADDRESS);
            expect(valid).toBe(false);
        });

        it("should reject valid signature against wrong address", async () => {
            const signature = await BIP322.sign("Hello World", identity);

            const valid = BIP322.verify(
                "Hello World",
                signature,
                WRONG_P2TR_ADDRESS
            );
            expect(valid).toBe(false);
        });

        it("should reject empty witness", () => {
            // base64 of an empty witness (RawWitness.encode([]))
            // A valid base64 for 0-item witness: encode varint 0 = 0x00
            const emptyWitness = btoa(String.fromCharCode(0));
            const valid = BIP322.verify(
                "Hello World",
                emptyWitness,
                P2TR_ADDRESS
            );
            expect(valid).toBe(false);
        });
    });

    describe("verify — P2WPKH (BIP-322 spec vectors)", () => {
        // P2WPKH address from the BIP-322 spec, same private key
        const P2WPKH_ADDRESS = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";

        // Deterministic ECDSA signatures from BIP-322 spec
        const P2WPKH_SIG_EMPTY =
            "AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=";
        const P2WPKH_SIG_HELLO =
            "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=";

        it("should verify P2WPKH signature for empty message", () => {
            const valid = BIP322.verify("", P2WPKH_SIG_EMPTY, P2WPKH_ADDRESS);
            expect(valid).toBe(true);
        });

        it("should verify P2WPKH signature for 'Hello World'", () => {
            const valid = BIP322.verify(
                "Hello World",
                P2WPKH_SIG_HELLO,
                P2WPKH_ADDRESS
            );
            expect(valid).toBe(true);
        });

        it("should reject P2WPKH signature against wrong message", () => {
            const valid = BIP322.verify(
                "Wrong message",
                P2WPKH_SIG_HELLO,
                P2WPKH_ADDRESS
            );
            expect(valid).toBe(false);
        });

        it("should reject P2WPKH signature against wrong address", () => {
            const wrongP2WPKH = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
            const valid = BIP322.verify(
                "Hello World",
                P2WPKH_SIG_HELLO,
                wrongP2WPKH
            );
            expect(valid).toBe(false);
        });
    });

    describe("verify — edge cases", () => {
        it("should throw for unsupported address type", () => {
            // P2SH address — not supported by BIP-322 simple
            const p2shAddress = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
            expect(() =>
                BIP322.verify("Hello World", SIGHASH_ALL_SIGNATURE, p2shAddress)
            ).toThrow("unsupported address type");
        });

        it("should reject P2TR signature with invalid length", () => {
            // Craft a witness with a 32-byte item (not 64 or 65)
            // RawWitness format: varint count, then for each: varint len + bytes
            const invalidSig = new Uint8Array(32).fill(0x42);
            // Manual RawWitness encode: 1 item, 32 bytes
            const encoded = new Uint8Array([1, 32, ...invalidSig]);
            const b64 = btoa(String.fromCharCode(...encoded));

            const valid = BIP322.verify("Hello World", b64, P2TR_ADDRESS);
            expect(valid).toBe(false);
        });

        it("should return false for malformed address", () => {
            const valid = BIP322.verify(
                "Hello World",
                SIGHASH_ALL_SIGNATURE,
                "not-a-valid-address"
            );
            expect(valid).toBe(false);
        });

        it("should return false for invalid base64 signature", () => {
            const valid = BIP322.verify(
                "Hello World",
                "!!!not-base64!!!",
                P2TR_ADDRESS
            );
            expect(valid).toBe(false);
        });
    });

    describe("sign — address derivation consistency", () => {
        it("should produce signatures verifiable at the correct P2TR address", async () => {
            // Verify that the identity's derived address matches expected
            const xOnlyPub = await identity.xOnlyPublicKey();
            const payment = p2tr(xOnlyPub);
            expect(payment.address).toBe(P2TR_ADDRESS);

            // Sign and verify at that address
            const signature = await BIP322.sign("test message", identity);
            const valid = BIP322.verify(
                "test message",
                signature,
                P2TR_ADDRESS
            );
            expect(valid).toBe(true);
        });
    });
});
