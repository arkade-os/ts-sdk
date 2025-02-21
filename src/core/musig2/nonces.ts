import * as musig from "@scure/btc-signer/musig2";

/**
 * MuSig2 nonce pair containing public and secret values.
 * Public nonces are two compressed points (33 bytes each).
 * Secret nonces are the corresponding private scalars plus pubkey.
 */
export type Nonces = {
    pubNonce: Uint8Array;
    secNonce: Uint8Array;
};

/**
 * Generates a pair of public and secret nonces for MuSig2 signing
 */
export function generateNonces(publicKey: Uint8Array): Nonces {
    const nonces = musig.nonceGen(publicKey);
    return { secNonce: nonces.secret, pubNonce: nonces.public };
}
