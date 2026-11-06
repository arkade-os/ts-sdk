import { arkade } from "@arkade-os/sdk";

import assetSwapArtifact from "./contracts/asset-swap.json";
import satsSwapArtifact from "./contracts/sats-swap.json";
import wantAssetProgramV1 from "./legacy/swap-want-asset.program.v1.json";
import wantBtcProgramV1 from "./legacy/swap-want-btc.program.v1.json";

// json imports widen "type": "pubkey" to string; the parsers validate at runtime
type Artifact = Parameters<typeof arkade.parseArtifact>[0];
type ContractArtifact = Parameters<typeof arkade.programFromArtifact>[0];

/** `asset-swap` and `sats-swap`. Exit is appended later; it is not in either artifact.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const swapPrograms: Record<
    "wantAsset" | "wantBtc",
    ReturnType<typeof arkade.programFromArtifact>
> = {
    wantAsset: arkade.programFromArtifact(assetSwapArtifact as ContractArtifact),
    wantBtc: arkade.programFromArtifact(satsSwapArtifact as ContractArtifact),
};

/** Previous fulfill leaf. A funded script that matches one of these still binds it. */
export const legacySwapPrograms: typeof swapPrograms = {
    wantAsset: arkade.parseArtifact(wantAssetProgramV1 as Artifact),
    wantBtc: arkade.parseArtifact(wantBtcProgramV1 as Artifact),
};

/** Covenant version ids for the arkade↔arkade corridor; mirror the solver's RFQ vocabulary. */
export const ASSET_SWAP_V3 = "asset-swap-v3";
export const ASSET_SWAP_V2 = "asset-swap-v2";

/** The covenants this build can derive, most preferred first. */
export const ASSET_SWAP_COVENANT_VERSIONS = [ASSET_SWAP_V3, ASSET_SWAP_V2] as const;

// Unknown or absent maps to `previous`: the covenant every pre-negotiation solver serves.
export const offerGenerationFor = (covenantVersion: string | undefined): "current" | "previous" =>
    covenantVersion === ASSET_SWAP_V3 ? "current" : "previous";
