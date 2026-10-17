import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { RestDelegateeProvider, sealDelegateeSecrets } from "../src/providers/delegatee";

const secret = new Uint8Array(32).fill(2);
const pubkey = secp256k1.getPublicKey(secret, true);
const templateId = "11".repeat(32);
const info = {
    network: "regtest",
    serverPubkey: hex.encode(pubkey),
    emulatorPubkey: hex.encode(pubkey),
    encryptionPubkey: hex.encode(pubkey),
};

describe("delegatee", () => {
    it("authenticates a template and several secret fields in the deployed ECIES format", () => {
        const ciphertext = sealDelegateeSecrets({
            templateId,
            encryptionPubkey: pubkey,
            values: {
                preimage: new Uint8Array(32).fill(9),
                minimum_value: new Uint8Array([0x10, 0x27]),
            },
        });
        const ephemeral = ciphertext.subarray(0, 33);
        const shared = secp256k1.getSharedSecret(secret, ephemeral, true).subarray(1);
        const key = hkdf(
            sha256,
            shared,
            ephemeral,
            new TextEncoder().encode("covclaimd/preimage/v1"),
            32,
        );
        const plaintext = gcm(key, ciphertext.subarray(33, 45), ephemeral).decrypt(
            ciphertext.subarray(45),
        );
        expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
            format: "delegatee-secrets/v1",
            template_id: templateId,
            values: { preimage: "09".repeat(32), minimum_value: "1027" },
        });
        ciphertext[50] ^= 1;
        expect(() =>
            gcm(key, ciphertext.subarray(33, 45), ephemeral).decrypt(ciphertext.subarray(45)),
        ).toThrow();
    });

    it("discovers the distinct encryption key and registers a durable watch", async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json(info))
            .mockResolvedValueOnce(
                Response.json({
                    delegation: {
                        address: "tark1watch",
                        templateId,
                        status: "active",
                        expiresAt: "1700000000",
                    },
                }),
            );
        const provider = new RestDelegateeProvider("https://delegatee.example/", { fetchImpl });
        expect(await provider.getInfo()).toEqual(info);
        expect(
            await provider.registerDelegation({
                templateId,
                variables: { ciphertext: "ab" },
                expiresAt: 1_700_000_000,
            }),
        ).toMatchObject({ templateId, expiresAt: 1_700_000_000 });
        expect(fetchImpl.mock.calls[0][0]).toBe("https://delegatee.example/v1/info");
        expect(fetchImpl.mock.calls[1][1]?.redirect).toBe("error");
        expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)).toEqual({
            template_id: templateId,
            variables: { ciphertext: "ab" },
            expires_at: 1_700_000_000,
        });
    });

    it("refuses insecure discovery and a service without encryption keys", async () => {
        expect(() => new RestDelegateeProvider("http://delegatee.example")).toThrow(/HTTPS/);
        expect(() => new RestDelegateeProvider("http://localhost:7080")).not.toThrow();
        const provider = new RestDelegateeProvider("https://delegatee.example", {
            fetchImpl: vi
                .fn<typeof fetch>()
                .mockResolvedValue(Response.json({ ...info, encryptionPubkey: "" })),
        });
        await expect(provider.getInfo()).rejects.toThrow(/encryptionPubkey/);
    });
});
