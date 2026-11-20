import { arkade } from "@arkade-os/sdk";

import assetSwapV4Artifact from "./contracts/asset-swap-v4.json";
import satsSwapV4Artifact from "./contracts/sats-swap-v4.json";
import wantAssetProgramV1 from "./legacy/swap-want-asset.program.v1.json";
import wantBtcProgramV1 from "./legacy/swap-want-btc.program.v1.json";
import { ASSET_SWAP_BASELINE, ASSET_SWAP_V2, ASSET_SWAP_V4 } from "./rfq-contract";

export { ASSET_SWAP_BASELINE, ASSET_SWAP_V2, ASSET_SWAP_V4 } from "./rfq-contract";

// json imports widen "type": "pubkey" to string; the parsers validate at runtime
type Artifact = Parameters<typeof arkade.parseArtifact>[0];
type ContractArtifact = Parameters<typeof arkade.programFromArtifact>[0];

/** The `asset-swap-v2` programs a fresh offer compiles. Exit is appended later; it is in neither.
 *
 * @deprecated Internal to `accept()`; no replacement. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const swapPrograms: Record<
    "wantAsset" | "wantBtc",
    ReturnType<typeof arkade.parseArtifact>
> = {
    wantAsset: arkade.parseArtifact(wantAssetProgramV1 as Artifact),
    wantBtc: arkade.parseArtifact(wantBtcProgramV1 as Artifact),
};

const directedSwapPrograms: typeof swapPrograms = {
    wantAsset: arkade.programFromArtifact(assetSwapV4Artifact as ContractArtifact),
    wantBtc: arkade.programFromArtifact(satsSwapV4Artifact as ContractArtifact),
};

export type AssetSwapContractVersion = typeof ASSET_SWAP_V2 | typeof ASSET_SWAP_V4;

/** What a version's constructor args are built from; asset fields are in internal byte order. */
export interface AssetSwapArgInputs {
    receiver: Uint8Array;
    amount: bigint;
    asset?: { txid: Uint8Array; groupIndex: number };
    user: Uint8Array;
    server: Uint8Array;
    exitDelay?: bigint;
    /** x-only key `asset-swap-v4`'s `fulfill` requires; every other version refuses one. */
    taker?: Uint8Array;
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
        programs: swapPrograms,
        args: (inputs) => {
            // v2 declares no `taker`, so one passed to it would silently drop out of the covenant.
            if (inputs.taker !== undefined) throw new Error(`${ASSET_SWAP_V2} binds no taker key`);
            return {
                makerWP: inputs.receiver,
                wantAmount: inputs.amount,
                ...(inputs.asset && {
                    wantAssetTxid: inputs.asset.txid,
                    wantAssetGroupIndex: inputs.asset.groupIndex,
                }),
                ...sharedArgs(inputs),
            };
        },
    },
    [ASSET_SWAP_V4]: {
        programs: directedSwapPrograms,
        args: (inputs) => {
            if (inputs.taker === undefined) throw new Error(`${ASSET_SWAP_V4} needs a taker key`);
            return {
                receiver: inputs.receiver,
                amount: inputs.amount,
                ...(inputs.asset && {
                    assetTxid: inputs.asset.txid,
                    assetGroupIndex: inputs.asset.groupIndex,
                }),
                ...sharedArgs(inputs),
                taker: inputs.taker,
            };
        },
    },
};

/** What every asset RFQ advertises: the directed covenant alone. */
export const ASSET_SWAP_CONTRACT_VERSIONS = [ASSET_SWAP_V4] as const;

/** Every version this build derives: the registry's keys, not a preference. */
export const ASSET_SWAP_DERIVABLE_VERSIONS = [ASSET_SWAP_V4, ASSET_SWAP_V2] as const;

/** Absent means {@link ASSET_SWAP_BASELINE}; an id this build cannot derive throws. */
export const assetSwapContractVersion = (id: string | undefined): AssetSwapContractVersion => {
    if (id === undefined) return ASSET_SWAP_BASELINE;
    if (Object.hasOwn(ASSET_SWAP_CONTRACTS, id)) return id as AssetSwapContractVersion;
    throw new Error(`unknown contract version ${id}`);
};
