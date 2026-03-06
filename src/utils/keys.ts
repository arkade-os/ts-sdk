/**
 * Validate we are using a x-only public key
 *
 * @param publicKey
 * @param keyName
 * @param swapId
 * @returns Uint8Array
 */
export function normalizeToXOnlyPublicKey(
    publicKey: Uint8Array,
    keyName: string,
    swapId?: string
): Uint8Array {
    if (publicKey.length === 33) {
        return publicKey.slice(1);
    }
    if (publicKey.length !== 32) {
        throw new Error(
            `Invalid ${keyName} public key length: ${publicKey.length} ${swapId ? "for swap " + swapId : ""}`
        );
    }
    return publicKey;
}
