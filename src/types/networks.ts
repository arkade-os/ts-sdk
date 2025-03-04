import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";

export type NetworkName =
    | "bitcoin"
    | "testnet"
    | "signet"
    | "mutinynet"
    | "regtest";

export interface Network {
    bech32: string;
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
}
export const getNetwork = (network: NetworkName): Network => {
    return networks[network];
};

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;

export const DEFAULT_SEQUENCE = 0xfffffffd; // Opt-in RBF
export const DEFAULT_LOCKTIME = 0;

export const networks = {
    bitcoin: NETWORK,
    testnet: TEST_NETWORK,
    signet: TEST_NETWORK,
    mutinynet: {
        ...TEST_NETWORK,
    },
    regtest: {
        ...TEST_NETWORK,
        bech32: "bcrt",
        pubKeyHash: 0x6f,
        scriptHash: 0xc4,
    },
};
