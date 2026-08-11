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
