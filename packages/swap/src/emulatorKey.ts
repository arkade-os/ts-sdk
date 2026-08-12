/**
 * One place the whole package resolves the covenant co-signer ("emulator")
 * key, so `createOffer` and every rfq entrypoint agree on the rule:
 *
 * The key defaults to the SDK's per-network pin, resolved from the network the
 * Ark server reports — never fetched from the emulator itself, because the
 * service being authenticated must not name its own trust anchor. A caller
 * that means to co-sign with a different deployment (the solver card's
 * `emulator_pubkey`, a self-hosted emulator, an unpinned network, or a key
 * rotation the SDK hasn't shipped) passes the override — and in doing so takes
 * on the obligation of having checked that value against a source it
 * independently trusts.
 */
import { hex } from "@scure/base";
import { resolveEmulatorPubkey, type Network } from "@arkade-os/sdk";

/** A caller-supplied co-signer key: bytes (x-only or 33-byte compressed, e.g.
 * a solver card's `emulator_pubkey`) or 33-byte compressed hex (the same
 * contract as `Arkade.connect`'s `emulatorPubkey` option). */
export type EmulatorPubkeyOverride = Uint8Array | string;

/**
 * The x-only co-signer key for `network`: the override if given, else the
 * SDK's pinned key. Throws on a malformed override, and on a network with no
 * pin when no override is supplied (signet, testnet) — a wrong or guessed key
 * would bind a covenant nobody will ever co-sign.
 */
export function resolveEmulatorKey(
    network: Network,
    override?: EmulatorPubkeyOverride,
): Uint8Array {
    if (override instanceof Uint8Array) {
        // drop the prefix by length so an already-x-only key passes through
        // rather than being shortened to 31 bytes
        if (override.length === 32) return override;
        if (override.length !== 33 || (override[0] !== 0x02 && override[0] !== 0x03)) {
            throw new Error("emulator pubkey is not a compressed or x-only public key");
        }
        return override.slice(1);
    }
    // resolveEmulatorPubkey validates the hex form and returns 33-byte
    // compressed hex, so slicing the prefix cannot truncate a malformed key
    return hex.decode(resolveEmulatorPubkey(network, override)).slice(1);
}
