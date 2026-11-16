import { arkade } from "@arkade-os/sdk";
import wantAsset from "./swap-want-asset.program.v1.json";
import wantBtc from "./swap-want-btc.program.v1.json";

type Artifact = Parameters<typeof arkade.parseArtifact>[0];

export const legacySwapPrograms: Record<
    "wantAsset" | "wantBtc",
    ReturnType<typeof arkade.parseArtifact>
> = {
    wantAsset: arkade.parseArtifact(wantAsset as Artifact),
    wantBtc: arkade.parseArtifact(wantBtc as Artifact),
};
