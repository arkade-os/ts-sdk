/**
 * Resolution of the covenant co-signer ("emulator") key, shared by
 * `createOffer` and the rfq entrypoints: the caller's override if given, else
 * the SDK's per-network pin. See {@link resolveEmulatorPubkey} for the trust
 * model.
 */
import { hex } from "@scure/base";
import { resolveEmulatorPubkey, type Network } from "@arkade-os/sdk";

/** A caller-supplied co-signer key: bytes (x-only or 33-byte compressed) or
 * 33-byte compressed hex. */
export type EmulatorPubkeyOverride = Uint8Array | string;

/** Drop the prefix of a 33-byte compressed key; pass an x-only key through.
 * A malformed key would otherwise bind silently into a covenant and only
 * surface as an unspendable address once funded. */
export const xOnly = (key: Uint8Array, label: string): Uint8Array => {
    if (key.length === 32) return key;
    if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) {
        throw new Error(`${label} is not a compressed or x-only public key`);
    }
    return key.slice(1);
};

/** The x-only co-signer key for `network`: the override if given, else the
 * SDK's pinned key. Throws on a malformed override, and on a network with no
 * pin when no override is supplied. */
export function resolveEmulatorKey(
    network: Network,
    override?: EmulatorPubkeyOverride,
): Uint8Array {
    const key =
        override instanceof Uint8Array
            ? override
            : hex.decode(resolveEmulatorPubkey(network, override));
    return xOnly(key, "emulator pubkey");
}
