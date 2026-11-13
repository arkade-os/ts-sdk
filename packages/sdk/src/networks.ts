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
 * The {@link Network} the operator's info names. {@link getNetwork} fails closed, so an
 * unrecognized network throws here rather than resolving to mainnet parameters downstream.
 * Structurally typed so the network table doesn't depend on the provider layer.
 */
export const networkFromOperatorInfo = (info: { network: string }): Network =>
    getNetwork(info.network as NetworkName);

/** @deprecated Use {@link networkFromOperatorInfo}. */
export const networkFromArkadeInfo = networkFromOperatorInfo;

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
