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

/** The version used when none is named or negotiated: a solver that did not negotiate (it
 * predates the field, or was asked without the list) fills only this tree. */
export const ASSET_SWAP_BASELINE = ASSET_SWAP_V2;

export type AssetSwapContractVersion = typeof ASSET_SWAP_V2 | typeof ASSET_SWAP_V3;

/** What a version's constructor args are built from; asset fields are in internal byte order. */
export interface AssetSwapArgInputs {
    receiver: Uint8Array;
    amount: bigint;
    asset?: { txid: Uint8Array; groupIndex: number };
    user: Uint8Array;
    server: Uint8Array;
    exitDelay?: bigint;
}

export interface AssetSwapContract {
    programs: typeof swapPrograms;
    args(inputs: AssetSwapArgInputs): ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];
}

const sharedArgs = ({ user, server, exitDelay }: AssetSwapArgInputs) => ({
    user,
    server,
    ...(exitDelay && { exitDelay }),
});

export const ASSET_SWAP_CONTRACTS: Readonly<Record<AssetSwapContractVersion, AssetSwapContract>> = {
    [ASSET_SWAP_V2]: {
        programs: legacySwapPrograms,
        args: (inputs) => ({
            makerWP: inputs.receiver,
            wantAmount: inputs.amount,
            ...(inputs.asset && {
                wantAssetTxid: inputs.asset.txid,
                wantAssetGroupIndex: inputs.asset.groupIndex,
            }),
            ...sharedArgs(inputs),
        }),
    },
    [ASSET_SWAP_V3]: {
        programs: swapPrograms,
        args: (inputs) => ({
            receiver: inputs.receiver,
            amount: inputs.amount,
            ...(inputs.asset && {
                assetTxid: inputs.asset.txid,
                assetGroupIndex: inputs.asset.groupIndex,
            }),
            ...sharedArgs(inputs),
        }),
    },
};

/** The versions every asset RFQ advertises by default, most preferred first. */
export const ASSET_SWAP_CONTRACT_VERSIONS = [ASSET_SWAP_V3, ASSET_SWAP_V2] as const;

/** Absent means {@link ASSET_SWAP_BASELINE}; an id this build cannot derive throws. */
export const assetSwapContractVersion = (id: string | undefined): AssetSwapContractVersion => {
    if (id === undefined) return ASSET_SWAP_BASELINE;
    if (Object.hasOwn(ASSET_SWAP_CONTRACTS, id)) return id as AssetSwapContractVersion;
    throw new Error(`unknown contract version ${id}`);
};
