/**
 * ClaimPacket sealing to the executor. The scheme matches the executor's
 * `pkg/template/ecies`; TLV framing is covered in `claimPacketCodec.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { EXECUTOR_CLAIM_TEMPLATE_ID, sealClaimPacket } from "../src/claimPacket";
import {
    ciphertextOf,
    claimPacketHex,
    openClaimPacket,
    sealClaimPacketDeterministic,
} from "./helpers/claimPacket";

const PREIMAGE = new Uint8Array(32).fill(7);
const RECIPIENT_SK = new Uint8Array(32).fill(0x22);
const RECIPIENT_PK = secp256k1.getPublicKey(RECIPIENT_SK, true);

const deterministic = () =>
    sealClaimPacketDeterministic(
        {
            preimage: PREIMAGE,
            encryptionPubkey: RECIPIENT_PK,
        },
        new Uint8Array(32).fill(0x11),
        new Uint8Array(12).fill(0x0a),
    );

const sealedValue = (packet: string) => ciphertextOf(packet);

describe("sealClaimPacket", () => {
    it("produces the pinned wire bytes for the fixed ephemeral key and nonce", async () => {
        const packet = await deterministic();
        expect(hex.encode(sealedValue(packet.packet))).toBe(
            "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa" +
                "0a0a0a0a0a0a0a0a0a0a0a0a" +
                "14ec375e22b0f016fb127e4740e9599f6b07d04bd040751d9fade4c5427b9787" +
                "50ce62b0260bb392ad65b3396ed6dfa1",
        );
    });

    it("seals with the template id as additional data", async () => {
        const { packet } = await deterministic();
        const value = sealedValue(packet);
        const ephPub = value.subarray(0, 33);
        const nonce = value.subarray(33, 45);
        const sharedX = secp256k1.getSharedSecret(RECIPIENT_SK, ephPub, true).subarray(1);
        const key = hkdf(
            sha256,
            sharedX,
            ephPub,
            new TextEncoder().encode("covclaimd/preimage/v1"),
            32,
        );
        const aad = new Uint8Array([
            ...ephPub,
            ...new TextEncoder().encode(EXECUTOR_CLAIM_TEMPLATE_ID),
        ]);
        expect(hex.encode(gcm(key, nonce, aad).decrypt(value.subarray(45)))).toBe(
            hex.encode(PREIMAGE),
        );
        expect(() => gcm(key, nonce, ephPub).decrypt(value.subarray(45))).toThrow();
    });

    it("binds the ciphertext to the template id", async () => {
        const sealed = await sealClaimPacketDeterministic(
            { preimage: PREIMAGE, encryptionPubkey: RECIPIENT_PK, templateId: "other" },
            new Uint8Array(32).fill(0x11),
            new Uint8Array(12).fill(0x0a),
        );
        await expect(openClaimPacket(sealed.packet, RECIPIENT_SK)).rejects.toThrow();
        const opened = await openClaimPacket(sealed.packet, RECIPIENT_SK, "other");
        expect(hex.encode(opened)).toBe(hex.encode(PREIMAGE));
    });

    it("frames the packet as TLV 0x01 + 0x03, and omits 0x02", async () => {
        const sealed = await deterministic();
        const raw = base64.decode(sealed.packet);
        const ct = sealedValue(sealed.packet);

        // type(1) ‖ length(2 BE) ‖ value, twice
        expect(raw[0]).toBe(0x01);
        expect((raw[1]! << 8) | raw[2]!).toBe(ct.length);

        const at = 3 + ct.length;
        expect(raw[at]).toBe(0x03);
        expect((raw[at + 1]! << 8) | raw[at + 2]!).toBe(33);
        expect(hex.encode(raw.subarray(at + 3, at + 36))).toBe(hex.encode(RECIPIENT_PK));

        // 0x02 is the funder's to add
        expect(raw.length).toBe(at + 36);
    });

    it("round-trips: the recipient key recovers exactly P", async () => {
        const packet = await deterministic();
        const opened = await openClaimPacket(packet.packet, RECIPIENT_SK);
        expect(hex.encode(opened)).toBe(hex.encode(PREIMAGE));
    });

    it("authenticates: a tampered ciphertext refuses to open", async () => {
        const packet = await deterministic();
        const bytes = hex.decode(claimPacketHex(packet.packet));
        bytes[50] ^= 0x01;
        await expect(openClaimPacket(base64.encode(bytes), RECIPIENT_SK)).rejects.toThrow();
    });

    it("rejects malformed inputs", async () => {
        await expect(
            sealClaimPacket({ preimage: PREIMAGE.slice(1), encryptionPubkey: RECIPIENT_PK }),
        ).rejects.toThrow(/32 bytes/);
        await expect(
            sealClaimPacket({ preimage: PREIMAGE, encryptionPubkey: RECIPIENT_PK.slice(1) }),
        ).rejects.toThrow(/compressed/);
        await expect(
            sealClaimPacketDeterministic(
                { preimage: PREIMAGE, encryptionPubkey: RECIPIENT_PK },
                new Uint8Array(32).fill(0x11),
                new Uint8Array(11),
            ),
        ).rejects.toThrow(/12 bytes/);
    });

    // Hermes has no `crypto.subtle`; the suite otherwise runs only where it exists.
    it("seals without crypto.subtle", async () => {
        const { getRandomValues } = globalThis.crypto;
        vi.stubGlobal("crypto", {
            getRandomValues: getRandomValues.bind(globalThis.crypto),
        });
        const packet = await (async () => {
            try {
                expect(globalThis.crypto.subtle).toBeUndefined();
                return await sealClaimPacket({
                    preimage: PREIMAGE,
                    encryptionPubkey: RECIPIENT_PK,
                });
            } finally {
                vi.unstubAllGlobals();
            }
        })();
        const opened = await openClaimPacket(packet.packet, RECIPIENT_SK);
        expect(hex.encode(opened)).toBe(hex.encode(PREIMAGE));
    });

    it("fresh randomness per packet: two seals of the same P differ", async () => {
        const a = await sealClaimPacket({ preimage: PREIMAGE, encryptionPubkey: RECIPIENT_PK });
        const b = await sealClaimPacket({ preimage: PREIMAGE, encryptionPubkey: RECIPIENT_PK });
        expect(a.packet).not.toBe(b.packet);
    });
});
