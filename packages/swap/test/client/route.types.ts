/**
 * Type-level assertions for the route union. Not a vitest file: it is checked
 * by `tsconfig.test.json`, which the package's `typecheck` script runs, so
 * every `@ts-expect-error` below is an assertion CI enforces. A `@ts-expect-error`
 * that stops erroring fails the build.
 */
import type { AssetId } from "../../src/client/assetId";
import type { Ep, Instrument, Route } from "../../src/client/route";

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
