import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";

export type NetworkName =
    | "bitcoin"
    | "testnet"
    | "signet"
    | "mutinynet"
    | "regtest";

export interface Network {
    hrp: string;
    bech32: string;
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
}
export const getNetwork = (network: NetworkName): Network => {
    return networks[network];
};

export const networks = {
    bitcoin: withArkPrefix(NETWORK, "ark"),
    testnet: withArkPrefix(TEST_NETWORK, "tark"),
    signet: withArkPrefix(TEST_NETWORK, "tark"),
    mutinynet: withArkPrefix(TEST_NETWORK, "tark"),
    regtest: withArkPrefix(
        {
            ...TEST_NETWORK,
            bech32: "bcrt",
            pubKeyHash: 0x6f,
            scriptHash: 0xc4,
        },
        "tark"
    ),
};

function withArkPrefix(network: Omit<Network, "hrp">, prefix: string): Network {
    return {
        ...network,
        hrp: prefix,
    };
}
