import { arkade } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

import assetSwapDirectedNonceArtifact from "./contracts/asset-swap-directed-nonce.json";
import assetSwapDirectedArtifact from "./contracts/asset-swap-directed.json";
import satsSwapDirectedNonceArtifact from "./contracts/sats-swap-directed-nonce.json";
import satsSwapDirectedArtifact from "./contracts/sats-swap-directed.json";
import wantAssetProgramV1 from "./legacy/swap-want-asset.program.v1.json";
import wantBtcProgramV1 from "./legacy/swap-want-btc.program.v1.json";
import {
    ASSET_SWAP_BASELINE,
    ASSET_SWAP_V2,
    ASSET_SWAP_DIRECTED,
    ASSET_SWAP_DIRECTED_NONCE,
    ASSET_SWAP_DIRECTED_NONCE_V2,
} from "./rfq-contract";

export {
    ASSET_SWAP_BASELINE,
    ASSET_SWAP_V2,
    ASSET_SWAP_DIRECTED,
    ASSET_SWAP_DIRECTED_NONCE,
    ASSET_SWAP_DIRECTED_NONCE_V2,
} from "./rfq-contract";

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
    wantAsset: arkade.programFromArtifact(assetSwapDirectedArtifact as ContractArtifact),
    wantBtc: arkade.programFromArtifact(satsSwapDirectedArtifact as ContractArtifact),
};

const nonceSwapPrograms: typeof swapPrograms = {
    wantAsset: arkade.programFromArtifact(assetSwapDirectedNonceArtifact as ContractArtifact),
    wantBtc: arkade.programFromArtifact(satsSwapDirectedNonceArtifact as ContractArtifact),
};

const singleKey = { singleOperatorKey: true };
const nonceV2SwapPrograms: typeof swapPrograms = {
    wantAsset: arkade.programFromArtifact(
        assetSwapDirectedNonceArtifact as ContractArtifact,
        singleKey,
    ),
    wantBtc: arkade.programFromArtifact(
        satsSwapDirectedNonceArtifact as ContractArtifact,
        singleKey,
    ),
};

const assetRfqNonceDomain = new TextEncoder().encode("arkade/asset-rfq-nonce/v1");

/** Public commitment to the private RFQ status lookup ID. */
export const assetRfqNonce = (rfqId: string): Uint8Array => {
    if (!/^[0-9a-f]{64}$/i.test(rfqId)) throw new Error("rfqId must be 32 bytes of hex");
    return sha256.create().update(assetRfqNonceDomain).update(hex.decode(rfqId)).digest();
};

export type AssetSwapContractVersion =
    | typeof ASSET_SWAP_V2
    | typeof ASSET_SWAP_DIRECTED
    | typeof ASSET_SWAP_DIRECTED_NONCE
    | typeof ASSET_SWAP_DIRECTED_NONCE_V2;

/** What a version's constructor args are built from; asset fields are in internal byte order. */
export interface AssetSwapArgInputs {
    receiver: Uint8Array;
    amount: bigint;
    asset?: { txid: Uint8Array; groupIndex: number };
    user: Uint8Array;
    server: Uint8Array;
    exitDelay?: bigint;
    /** The x-only key that a directed `fulfill` requires. */
    taker?: Uint8Array;
    nonce?: Uint8Array;
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

const directedArgs = (inputs: AssetSwapArgInputs, version: string = ASSET_SWAP_DIRECTED) => {
    if (inputs.taker === undefined) throw new Error(`${version} needs a taker key`);
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
};

const nonceArgs = (version: string) => (inputs: AssetSwapArgInputs) => {
    if (inputs.nonce === undefined) throw new Error(`${version} needs a nonce`);
    return { ...directedArgs(inputs, version), nonce: inputs.nonce };
};

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
    [ASSET_SWAP_DIRECTED]: {
        programs: directedSwapPrograms,
        args: directedArgs,
    },
    [ASSET_SWAP_DIRECTED_NONCE]: {
        programs: nonceSwapPrograms,
        args: nonceArgs(ASSET_SWAP_DIRECTED_NONCE),
    },
    [ASSET_SWAP_DIRECTED_NONCE_V2]: {
        programs: nonceV2SwapPrograms,
        args: nonceArgs(ASSET_SWAP_DIRECTED_NONCE_V2),
    },
};

/** Advertise order. The single-key covenant is last until a deliberate reorder prefers it. */
export const ASSET_SWAP_CONTRACT_VERSIONS = [
    ASSET_SWAP_DIRECTED_NONCE,
    ASSET_SWAP_DIRECTED,
    ASSET_SWAP_DIRECTED_NONCE_V2,
] as const;

/** Whether `version`'s `fulfill` binds the RFQ nonce. */
export const bindsNonce = (version: string): boolean =>
    version === ASSET_SWAP_DIRECTED_NONCE || version === ASSET_SWAP_DIRECTED_NONCE_V2;

/** Every version this build derives: the registry's keys, not a preference. */
export const ASSET_SWAP_DERIVABLE_VERSIONS = [
    ...ASSET_SWAP_CONTRACT_VERSIONS,
    ASSET_SWAP_V2,
] as const;

/** Absent means {@link ASSET_SWAP_BASELINE}; an id this build cannot derive throws. */
export const assetSwapContractVersion = (id: string | undefined): AssetSwapContractVersion => {
    if (id === undefined) return ASSET_SWAP_BASELINE;
    if (Object.hasOwn(ASSET_SWAP_CONTRACTS, id)) return id as AssetSwapContractVersion;
    throw new Error(`unknown contract version ${id}`);
};
