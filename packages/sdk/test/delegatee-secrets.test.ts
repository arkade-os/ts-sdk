import { describe, expect, it } from "vitest";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { sealDelegateeSecrets } from "../src/utils/delegateeSecrets";

describe("delegatee encrypted secret fields", () => {
    const secret = new Uint8Array(32).fill(2);
    const templateId = "11".repeat(32);
    const encryptionPubkey = secp256k1.getPublicKey(secret, true);
    const values = { preimage: new Uint8Array(32).fill(3) };

    it("authenticates the template and named values with the deployed ECIES wire format", () => {
        const packet = sealDelegateeSecrets({ templateId, encryptionPubkey, values });
        const ephemeral = packet.subarray(0, 33);
        const shared = secp256k1.getSharedSecret(secret, ephemeral, true).subarray(1);
        const key = hkdf(
            sha256,
            shared,
            ephemeral,
            new TextEncoder().encode("covclaimd/preimage/v1"),
            32,
        );
        const open = (encrypted: Uint8Array) =>
            gcm(key, encrypted.subarray(33, 45), encrypted.subarray(0, 33)).decrypt(
                encrypted.subarray(45),
            );

        expect(JSON.parse(new TextDecoder().decode(open(packet)))).toEqual({
            format: "delegatee-secrets/v1",
            template_id: templateId,
            values: { preimage: "03".repeat(32) },
        });
        packet[packet.length - 1] ^= 1;
        expect(() => open(packet)).toThrow();
    });

    it("uses fresh encryption and refuses payloads that templates cannot hold", () => {
        const input = { templateId, encryptionPubkey, values };
        expect(hex.encode(sealDelegateeSecrets(input))).not.toBe(
            hex.encode(sealDelegateeSecrets(input)),
        );
        expect(() =>
            sealDelegateeSecrets({ ...input, values: { large: new Uint8Array(256) } }),
        ).toThrow("byte limit");
        expect(() => sealDelegateeSecrets({ ...input, templateId: "wrong" })).toThrow(
            "template id",
        );
    });
});
