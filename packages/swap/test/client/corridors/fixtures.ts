/**
 * A {@link CorridorBase} without a wallet behind it.
 *
 * `matches` reads three things off the base — the network name, its address
 * parameters and the operator's signer set — and every one of them is a value
 * the live info read produced. Building them directly keeps the parsing matrix
 * about parsing.
 */
import { ArkAddress, getNetwork, type IWallet, type NetworkName } from "@arkade-os/sdk";
import type { CorridorBase } from "../../../src/client/corridors/deps";
import type { SwapOperator } from "../../../src/refund";

/** The operator this wallet talks to, x-only hex. */
export const OPERATOR_SIGNER = "aa".repeat(32);
/** Somebody else's. Well-formed, and not ours. */
export const FOREIGN_SIGNER = "bb".repeat(32);

const VTXO_KEY = "cc".repeat(32);

const bytes = (hexString: string): Uint8Array =>
    Uint8Array.from(hexString.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);

/** An Arkade address under `signer`, on `network`'s hrp. */
export const arkAddressFor = (network: NetworkName, signer = OPERATOR_SIGNER): string =>
    new ArkAddress(bytes(signer), bytes(VTXO_KEY), getNetwork(network).hrp).encode();

export const corridorBaseFor = (
    networkName: NetworkName,
    over: Partial<CorridorBase> = {},
): CorridorBase => ({
    // Neither seam is reached by a parse: `matches` is sync and non-throwing,
    // so anything needing a round trip has already happened by the time it runs.
    wallet: {} as IWallet,
    operator: {} as SwapOperator,
    networkName,
    network: getNetwork(networkName),
    signerSet: { active: OPERATOR_SIGNER, deprecated: new Map() },
    ...over,
});
