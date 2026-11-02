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
