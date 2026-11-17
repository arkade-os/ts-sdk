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
    ReturnType<typeof arkade.parseArtifact>
> = {
    wantAsset: arkade.programFromArtifact(assetSwapArtifact as ContractArtifact),
    wantBtc: arkade.programFromArtifact(satsSwapArtifact as ContractArtifact),
};

/** Previous fulfill leaf. A funded script that matches one of these still binds it. */
export const legacySwapPrograms: typeof swapPrograms = {
    wantAsset: arkade.parseArtifact(wantAssetProgramV1 as Artifact),
    wantBtc: arkade.parseArtifact(wantBtcProgramV1 as Artifact),
};

/** Contract version ids for the arkade↔arkade corridor; mirror the solver's RFQ vocabulary.
 * One id covers both trees: `asset-swap` and `sats-swap` move between versions together. */
export const ASSET_SWAP_V3 = "asset-swap-v3";
export const ASSET_SWAP_V2 = "asset-swap-v2";

/** The covenants this build can derive, most preferred first: the list every asset RFQ
 * advertises by default. Keep in step with `offerGenerationFor`. */
export const ASSET_SWAP_CONTRACT_VERSIONS = [ASSET_SWAP_V3, ASSET_SWAP_V2] as const;

/** No version is `asset-swap-v2`: a solver that did not negotiate (it predates the field, or
 * was asked without the list) fills only that tree. An id this build cannot derive throws. */
export const offerGenerationFor = (contractVersion: string | undefined): "current" | "previous" => {
    if (contractVersion === ASSET_SWAP_V3) return "current";
    if (contractVersion === undefined || contractVersion === ASSET_SWAP_V2) return "previous";
    throw new Error(`unknown contract version ${contractVersion}`);
};
