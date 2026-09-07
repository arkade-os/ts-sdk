import { NETWORK, TEST_NETWORK } from "@scure/btc-signer/utils.js";

export type NetworkName = "bitcoin" | "testnet" | "signet" | "mutinynet" | "regtest";

export interface Network {
    hrp: string;
    bech32: string;
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
    /**
     * Canonical name this network was resolved from, when known.
     *
     * `bech32` cannot separate the tb-family — testnet, signet and mutinynet
     * share every field above — so anything that has to tell them apart (a
     * per-network timelock floor, for one) has no other handle. Optional
     * because a hand-built `Network` carries no name: consumers must read a
     * missing one as "unknown" and fall back to their strictest branch rather
     * than guess at one.
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
 * 33-byte compressed secp256k1 point, lowercase hex.
 *
 * Compressed rather than the 32-byte x-only form, for two reasons that are not
 * about the covenant leaf. The leaf itself is indifferent:
 * `computeArkadeScriptPublicKey` truncates by length and `lift_x`es, so a
 * compressed key and its x-only tail tweak to the same point — even for an
 * odd-Y (`03`) key like mutinynet's.
 *
 * What decides it is that compressed is the lossless form and the one actually
 * on the wire. The emulator's `/v1/info` returns `signerPubkey` compressed and
 * `Arkade.connect` keeps all 33 bytes of it (unlike the Arkade server key on
 * the line above, which it slices), so a value pinned here in compressed form
 * is byte-identical to what a live fetch yields and can substitute for it
 * directly. Going the other way is a one-way door: x-only can always be
 * recovered by dropping the prefix, but the parity bit cannot be recovered
 * from x-only. Consumers that need 32 bytes — the Arkade Intents offer TLV,
 * for one — already normalize at their own boundary.
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
 * The covenant co-signer each network's Arkade deployment runs.
 *
 * This is a property of the NETWORK, not of whoever happens to be talking to
 * it: every participant building a covenant contract on one network co-signs
 * with the same key, so carrying a per-deployment copy of it can only ever
 * introduce disagreement — two peers on one network advertising two keys is a
 * misconfiguration nothing downstream is positioned to catch.
 *
 * `testnet` and `signet` are absent because no emulator is deployed for them;
 * they resolve to a throw rather than to a neighbouring network's key.
 */
const EMULATOR_PUBKEYS: Partial<Record<NetworkName, string>> = {
    bitcoin: BITCOIN_EMULATOR_PUBKEY,
    mutinynet: MUTINYNET_EMULATOR_PUBKEY,
    regtest: REGTEST_EMULATOR_PUBKEY,
};

/**
 * The pinned co-signer key for `network`, as 33-byte compressed lowercase hex.
 *
 * @throws if the network carries no name, or names one with no deployed
 *   emulator. Fail closed on both counts: the return value ends up in a
 *   covenant leaf that decides who can move the funds, so there is no
 *   defensible fallback. Guessing a neighbour's key (the tb-family share every
 *   other field on {@link Network}) would build a leaf co-signed by a service
 *   that will never sign for it — funds locked to a key nobody holds — and
 *   returning an empty string just moves the same failure somewhere harder to
 *   read. A hand-assembled `Network` carries no `name` and lands here too,
 *   matching how the per-network timelock floors treat an unnamed network.
 *
 *   Deliberately NOT falling back to whatever key the emulator reports about
 *   itself: that is the self-report this pin exists to stop trusting, and doing
 *   it only on unpinned networks would make the guarantee depend on
 *   `network.name` with no signal to the caller that it had lapsed. The
 *   unnamed case is the sharp one — a hand-built `Network` can carry
 *   bitcoin-equivalent parameters, so a silent fallback would drop to
 *   "trust the endpoint" on exactly the input that looks most like mainnet.
 *   Callers who mean it pass {@link resolveEmulatorPubkey}'s override, which
 *   the thrown message names.
 */
export function defaultEmulatorPubkey(network: Network): string {
    const pinned = network.name ? EMULATOR_PUBKEYS[network.name] : undefined;
    if (!pinned) {
        // Name the remedy, not just the refusal. Whoever hits this usually has
        // a working emulator in front of them, so a bare "not pinned" reads as
        // the SDK being broken rather than as one argument being missing.
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
 * Resolve the co-signer key for `network`, letting a caller substitute its own.
 *
 * The override is the escape hatch for three situations, and the first is the
 * one that matters operationally:
 *
 * 1. **A network rotated its emulator key and this SDK has not shipped the new
 *    constant yet.** Since `Arkade.connect` no longer asks the service which
 *    key it signs with, a rotation is invisible here until the constant is
 *    updated — covenants keep building against the retired key and fail only
 *    when a claim is attempted. Passing the new key restores service without
 *    waiting for a release, so a rotation is a config change rather than an
 *    outage.
 * 2. A private or self-hosted emulator, including on a network with no pinned
 *    key at all (signet, testnet, a hand-built `Network`).
 * 3. Tests and local stacks.
 *
 * Supplying it means co-signing with a different service: every covenant built
 * from the returned key can be completed by whoever holds it and by no one
 * else, so it is a statement that you trust that operator in place of the
 * network's. Prefer {@link defaultEmulatorPubkey} unless that is deliberate.
 *
 * A malformed override throws rather than being passed through — a typo here
 * would otherwise surface as an unspendable contract long after the fact.
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
