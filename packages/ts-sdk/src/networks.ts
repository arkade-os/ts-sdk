import { NETWORK, TEST_NETWORK } from "@scure/btc-signer/utils.js";

export type NetworkName = "bitcoin" | "testnet" | "signet" | "mutinynet" | "regtest";

export interface Network {
    hrp: string;
    bech32: string;
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
    /**
     * Canonical name this network was resolved from, when known: the only way to tell the
     * tb-family apart (testnet, signet and mutinynet share every field above). Optional because a
     * hand-built `Network` has none — read a missing one as "unknown" and take the strictest branch.
     */
    name?: NetworkName;
}
export const getNetwork = (network: NetworkName): Network => {
    const found = networks[network];
    // Fail closed: an unknown network must never silently fall through to
    // mainnet params (e.g. via Address()'s default) when validating addresses.
    if (!found) throw new Error(`Unsupported network: ${network}`);
    return found;
};

/**
 * The {@link Network} an Arkade server's info names. {@link getNetwork} fails closed, so an
 * unrecognized server network throws here rather than resolving to mainnet parameters downstream.
 * Structurally typed so the network table doesn't depend on the provider layer.
 */
export const networkFromArkadeInfo = (info: { network: string }): Network =>
    getNetwork(info.network as NetworkName);

export const networks = {
    bitcoin: withArkPrefix(NETWORK, "ark", "bitcoin"),
    testnet: withArkPrefix(TEST_NETWORK, "tark", "testnet"),
    signet: withArkPrefix(TEST_NETWORK, "tark", "signet"),
    mutinynet: withArkPrefix(TEST_NETWORK, "tark", "mutinynet"),
    regtest: withArkPrefix(
        {
            ...TEST_NETWORK,
            bech32: "bcrt",
            pubKeyHash: 0x6f,
            scriptHash: 0xc4,
        },
        "tark",
        "regtest",
    ),
};

function withArkPrefix(
    network: Omit<Network, "hrp" | "name">,
    prefix: string,
    name: NetworkName,
): Network {
    return {
        ...network,
        hrp: prefix,
        name,
    };
}

export const DEFAULT_ARKADE_SERVER_URL = "https://arkade.computer" as const;
export const DEFAULT_NETWORK = networks.bitcoin;
export const DEFAULT_NETWORK_NAME = "bitcoin" as const satisfies NetworkName;

/**
 * 33-byte compressed secp256k1 point, lowercase hex. The covenant leaf is indifferent
 * (`computeArkadeScriptPublicKey` truncates by length and `lift_x`es, so even an odd-Y `03` key
 * tweaks the same), but compressed is lossless and what's on the wire: the emulator's `/v1/info`
 * returns `signerPubkey` compressed and `Arkade.connect` keeps all 33 bytes, so a pinned value is
 * byte-identical to a live fetch. x-only loses the parity bit; consumers needing 32 bytes (e.g.
 * the Arkade Intents offer TLV) normalize at their own boundary.
 */
const COMPRESSED_PUBKEY = /^0[23][0-9a-f]{64}$/;

/** Covenant co-signer ("emulator") for the mainnet Arkade deployment. */
export const BITCOIN_EMULATOR_PUBKEY =
    "0239c196415da47b26456a101daaa12ba9e445bfe153197f1e2b750bf40e52092e" as const;

/** Covenant co-signer ("emulator") for the hosted mutinynet Arkade deployment. */
export const MUTINYNET_EMULATOR_PUBKEY =
    "03f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a" as const;

/** Covenant co-signer ("emulator") shipped with the `arkade-regtest` stack. */
export const REGTEST_EMULATOR_PUBKEY =
    "02999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9" as const;

/**
 * The covenant co-signer each network's Arkade deployment runs — a property of the NETWORK, since
 * every participant on it co-signs with the same key; a per-deployment copy could only introduce
 * disagreement nothing downstream catches. `testnet`/`signet` have no emulator and throw rather
 * than resolve to a neighbour's key.
 */
const EMULATOR_PUBKEYS: Partial<Record<NetworkName, string>> = {
    bitcoin: BITCOIN_EMULATOR_PUBKEY,
    mutinynet: MUTINYNET_EMULATOR_PUBKEY,
    regtest: REGTEST_EMULATOR_PUBKEY,
};

/**
 * The pinned co-signer key for `network`, as 33-byte compressed lowercase hex.
 *
 * @throws if the network carries no name, or names one with no deployed emulator. Fail closed:
 *   the key ends up in a covenant leaf deciding who can move the funds. Guessing a tb-family
 *   neighbour's key locks funds to a co-signer that never signs; an empty string only moves the
 *   failure. Deliberately NOT falling back to the emulator's self-reported key — that is the
 *   trust this pin removes, and a silent fallback on an unnamed `Network` (which may carry
 *   mainnet-equivalent parameters) would lapse it exactly where it matters most. Callers who mean
 *   it pass {@link resolveEmulatorPubkey}'s override, which the thrown message names.
 */
export function defaultEmulatorPubkey(network: Network): string {
    const pinned = network.name ? EMULATOR_PUBKEYS[network.name] : undefined;
    if (!pinned) {
        // Name the remedy: whoever hits this usually has a working emulator, so a bare refusal
        // reads as the SDK being broken.
        const cause = network.name
            ? `no emulator is deployed for ${network.name}`
            : `this Network carries no name, so it cannot be matched ` +
              `(build it with getNetwork(...) rather than by hand)`;
        throw new Error(
            `No emulator co-signer key is pinned for this network: ${cause}; ` +
                `pass emulatorPubkey: "<33-byte compressed hex>" to Arkade.connect to ` +
                `co-sign with your own emulator instead. Pinned networks: ` +
                `${Object.keys(EMULATOR_PUBKEYS).join(", ")}`,
        );
    }
    return pinned;
}

/**
 * Resolve the co-signer key for `network`, letting a caller substitute its own, for:
 *
 * 1. **A network rotated its emulator key before this SDK shipped the new constant.**
 *    `Arkade.connect` no longer asks the service, so covenants would keep building against the
 *    retired key and fail only at claim time; the override makes rotation a config change.
 * 2. A private or self-hosted emulator, including on unpinned networks.
 * 3. Tests and local stacks.
 *
 * Supplying it means trusting that operator in place of the network's: covenants built from the
 * key can be completed by its holder and no one else. A malformed override throws rather than
 * surfacing later as an unspendable contract.
 */
export function resolveEmulatorPubkey(network: Network, override?: string): string {
    if (override === undefined) return defaultEmulatorPubkey(network);
    if (!COMPRESSED_PUBKEY.test(override)) {
        throw new Error(
            `Emulator pubkey override must be 33-byte compressed secp256k1 hex ` +
                `(66 lowercase chars, 02/03 prefix), got ${JSON.stringify(override)}.`,
        );
    }
    return override;
}
