/**
 * Type-level assertions for the route union. Not a vitest file: it is checked
 * by `tsconfig.test.json`, which the package's `typecheck` script runs, so
 * every `@ts-expect-error` below is an assertion CI enforces. A `@ts-expect-error`
 * that stops erroring fails the build.
 */
import type { AssetId } from "../../src/client/assetId";
import type { Artifact, Endpoint, Ep, Instrument, Route } from "../../src/client/route";

const wallet: Instrument = { kind: "wallet" };

export const arkadeBtc: Ep<"arkade"> = {
    corridor: "arkade",
    asset: "arkade:regtest/slip44:0",
    instrument: wallet,
};

export const lightningBtc: Ep<"lightning"> = {
    corridor: "lightning",
    asset: "bolt11:regtest/slip44:0",
    instrument: wallet,
};

export const onchainBtc: Ep<"onchain"> = {
    corridor: "onchain",
    asset: "bitcoin:regtest/slip44:0",
    instrument: wallet,
};

// The four implemented routes are representable.
export const assetSwap: Route = { give: arkadeBtc, take: arkadeBtc };
export const lightningSend: Route = { give: arkadeBtc, take: lightningBtc };
export const lightningReceive: Route = { give: lightningBtc, take: arkadeBtc };
export const onchainSend: Route = { give: arkadeBtc, take: onchainBtc };

const inbound = { give: onchainBtc, take: arkadeBtc };
// @ts-expect-error `onchain -> arkade` is outside the union until the manager owns the L1 refund path
export const inboundOnchain: Route = inbound;

const lightningToOnchain = { give: lightningBtc, take: onchainBtc };
// @ts-expect-error no route crosses two non-arkade corridors
export const crossCorridor: Route = lightningToOnchain;

const l1Btc: AssetId = "bitcoin:regtest/slip44:0";
// @ts-expect-error an endpoint's corridor and its asset's rail cannot disagree
export const crossedRail: Ep<"arkade">["asset"] = l1Btc;

const corridorNamedRail: AssetId<"arkade"> | string = "lightning:regtest/slip44:0";
// @ts-expect-error the lightning rail is spelled `bolt11`: `lightning` overruns CAIP-2's namespace cap
export const wrongLightningRail: Ep<"lightning">["asset"] = corridorNamedRail;

const noRail = "slip44:0";
// @ts-expect-error an asset part on its own is not an id
export const bareAssetPart: AssetId = noRail;

/**
 * The pairing has to survive the default type argument. `Endpoint` unwitnessed
 * is what every signature that takes "some endpoint" lands on, and a shape whose
 * two fields widen independently correlates nothing.
 */
export const anyEndpoint: Endpoint = arkadeBtc;

// @ts-expect-error the corridor is arkade and the asset is on the bitcoin rail
export const bareEndpointCrossed: Endpoint = {
    corridor: "arkade",
    asset: "bitcoin:regtest/slip44:0",
    instrument: wallet,
};

export const crossedDeposit: Artifact = {
    kind: "deposit",
    corridor: "onchain",
    // @ts-expect-error same crossing, reached through the deposit artifact
    asset: "arkade:regtest/slip44:0",
    address: "bcrt1qexample",
    amount: 1_000n,
    expiresAt: undefined,
};

export const deposit: Artifact = {
    kind: "deposit",
    corridor: "onchain",
    asset: "bitcoin:regtest/slip44:0",
    address: "bcrt1qexample",
    amount: 1_000n,
};

/**
 * §9's EVM corridor carries its chain in the corridor id, so the tie is the
 * whole chain part and not just the `eip155` rail: a contract address is a
 * chain's fact, and the same address is deployed on chains that copied the token.
 */
const usdcOnBase = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const baseUsdc: Ep<"eip155:8453"> = {
    corridor: "eip155:8453",
    asset: usdcOnBase,
    instrument: wallet,
};

const usdcOnMainnet: AssetId<"eip155"> =
    "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
// @ts-expect-error chain 1 is not chain 8453, though both are the eip155 rail
export const wrongChain: Ep<"eip155:8453">["asset"] = usdcOnMainnet;
