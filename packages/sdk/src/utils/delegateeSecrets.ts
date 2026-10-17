import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";

export function sealDelegateeSecrets(input: {
    templateId: string;
    encryptionPubkey: Uint8Array;
    values: Record<string, Uint8Array>;
}): Uint8Array {
    if (!/^[0-9a-f]{64}$/.test(input.templateId)) throw new Error("invalid delegatee template id");
    if (input.encryptionPubkey.length !== 33) throw new Error("encryption key must be compressed");
    const plaintext = new TextEncoder().encode(
        JSON.stringify({
            format: "delegatee-secrets/v1",
            template_id: input.templateId,
            values: Object.fromEntries(
                Object.entries(input.values).map(([name, value]) => [name, hex.encode(value)]),
            ),
        }),
    );
    if (plaintext.length + 33 + 12 + 16 > 520) {
        throw new Error("delegatee secrets exceed the template byte limit");
    }
    const ephemeralKey = secp256k1.utils.randomSecretKey();
    const ephemeralPub = secp256k1.getPublicKey(ephemeralKey, true);
    const shared = secp256k1
        .getSharedSecret(ephemeralKey, input.encryptionPubkey, true)
        .subarray(1);
    const key = hkdf(
        sha256,
        shared,
        ephemeralPub,
        new TextEncoder().encode("covclaimd/preimage/v1"),
        32,
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return concatBytes(ephemeralPub, nonce, gcm(key, nonce, ephemeralPub).encrypt(plaintext));
}
