import {
    AssetGroup,
    AssetId,
    AssetRef,
    AssetInput,
    AssetOutput,
    Packet,
} from "../asset";
import { Asset, Recipient, VirtualCoin } from "./index";

/**
 * Creates an asset packet from asset inputs and receivers.
 * Groups inputs and outputs by asset ID and creates the Packet object
 * @param assetInputs - map input index -> assets
 * @param receivers - array of recipients with their asset allocations
 * @param changeReceiver - (optional) change receiver containing remaining assets
 * @returns packet containing all asset groups
 */
export function createAssetPacket(
    assetInputs: Map<number, Asset[]>,
    receivers: Recipient[],
    changeReceiver?: Recipient
): Packet {
    // map inputs by asset id
    const inputsByAssetId = new Map<string, AssetInput[]>();

    for (const [inputIndex, assets] of assetInputs) {
        for (const asset of assets) {
            const existing = inputsByAssetId.get(asset.assetId);
            inputsByAssetId.set(asset.assetId, [
                ...(existing ?? []),
                AssetInput.create(inputIndex, BigInt(asset.amount)),
            ]);
        }
    }

    // map outputs by asset id
    const outputsByAssetId = new Map<string, AssetOutput[]>();

    // track tx output index
    let outputIndex = 0;

    for (const receiver of receivers) {
        if (receiver.assets) {
            for (const asset of receiver.assets) {
                const existing = outputsByAssetId.get(asset.assetId);
                outputsByAssetId.set(asset.assetId, [
                    ...(existing ?? []),
                    AssetOutput.create(outputIndex, BigInt(asset.amount)),
                ]);
            }
        }
        outputIndex++;
    }

    // add change receiver assets if present
    if (changeReceiver?.assets) {
        for (const asset of changeReceiver.assets) {
            const existing = outputsByAssetId.get(asset.assetId);
            outputsByAssetId.set(asset.assetId, [
                ...(existing ?? []),
                AssetOutput.create(outputIndex, BigInt(asset.amount)),
            ]);
        }
    }

    const groups: AssetGroup[] = [];

    // get all unique asset ids from both inputs and outputs
    const allAssetIds = new Set([
        ...inputsByAssetId.keys(),
        ...outputsByAssetId.keys(),
    ]);

    for (const assetIdStr of allAssetIds) {
        const inputs = inputsByAssetId.get(assetIdStr);
        const outputs = outputsByAssetId.get(assetIdStr);

        const assetId = AssetId.fromString(assetIdStr);

        const group = AssetGroup.create(
            assetId,
            null,
            inputs ?? [],
            outputs ?? [],
            []
        );

        groups.push(group);
    }

    return Packet.create(groups);
}

/**
 * Creates an asset packet for reissuance.
 * Combines existing asset inputs with new outputs and handles control asset reference.
 *
 * @param assetInputs - Map of input index to assets (includes control asset)
 * @param assetId - The asset ID to reissue
 * @param reissueAmount - Amount to reissue
 * @param vout - Output index for the reissued asset
 * @param controlAssetId - The control asset ID
 * @param controlAssetVout - Output index for control asset change
 * @returns Packet containing the reissuance group(s)
 */
export function createReissuancePacket(
    assetInputs: Map<number, Asset[]>,
    assetId: string,
    reissueAmount: bigint,
    vout: number,
    controlAssetId: string,
    controlAssetVout: number
): Packet {
    const groups: AssetGroup[] = [];

    const controlInputs: AssetInput[] = [];
    let controlInputAmount = 0n;

    for (const [inputIndex, assets] of assetInputs) {
        for (const asset of assets) {
            if (asset.assetId === controlAssetId) {
                controlInputs.push(
                    AssetInput.create(inputIndex, BigInt(asset.amount))
                );
                controlInputAmount += BigInt(asset.amount);
            }
        }
    }

    if (controlInputs.length > 0) {
        const controlAssetIdObj = AssetId.fromString(controlAssetId);
        const controlGroup = AssetGroup.create(
            controlAssetIdObj,
            null,
            controlInputs,
            [AssetOutput.create(controlAssetVout, controlInputAmount)],
            []
        );
        groups.push(controlGroup);
    }

    const reissueInputs: AssetInput[] = [];
    let existingAmount = 0n;

    for (const [inputIndex, assets] of assetInputs) {
        for (const asset of assets) {
            if (asset.assetId === assetId) {
                reissueInputs.push(
                    AssetInput.create(inputIndex, BigInt(asset.amount))
                );
                existingAmount += BigInt(asset.amount);
            }
        }
    }

    const totalOutput = existingAmount + reissueAmount;
    const reissueOutputs = [AssetOutput.create(vout, totalOutput)];

    const controlAssetRef = AssetRef.fromId(AssetId.fromString(controlAssetId));

    const reissueAssetIdObj = AssetId.fromString(assetId);
    const reissueGroup = AssetGroup.create(
        reissueAssetIdObj,
        controlAssetRef,
        reissueInputs,
        reissueOutputs,
        []
    );
    groups.push(reissueGroup);

    return Packet.create(groups);
}

/**
 * Selects coins that contain a specific asset.
 * Returns coins sorted by amount (smallest first for better coin selection).
 */
export function selectCoinsWithAsset(
    coins: VirtualCoin[],
    assetId: string,
    requiredAmount: bigint
): { selected: VirtualCoin[]; totalAssetAmount: bigint } {
    // filter only coins that have the specified asset
    const coinsWithAsset = coins.filter((coin) =>
        coin.assets?.some((a) => a.assetId === assetId)
    );

    // sort by asset amount (smallest first for better selection)
    coinsWithAsset.sort((a, b) => {
        const amountA =
            a.assets?.find((asset) => asset.assetId === assetId)?.amount ?? 0;
        const amountB =
            b.assets?.find((asset) => asset.assetId === assetId)?.amount ?? 0;
        return amountA - amountB;
    });

    const selected: VirtualCoin[] = [];
    let totalAssetAmount = 0n;

    for (const coin of coinsWithAsset) {
        if (totalAssetAmount >= requiredAmount) break;

        selected.push(coin);
        const assetAmount =
            coin.assets?.find((a) => a.assetId === assetId)?.amount ?? 0;
        totalAssetAmount += BigInt(assetAmount);
    }

    if (totalAssetAmount < requiredAmount) {
        throw new Error(
            `Insufficient asset balance: have ${totalAssetAmount}, need ${requiredAmount}`
        );
    }

    return { selected, totalAssetAmount };
}

export function computeAssetChange(
    inputAssets: Map<string, bigint>,
    outputAssets: Map<string, bigint>
): Map<string, bigint> {
    const change = new Map<string, bigint>();

    for (const [assetId, inputAmount] of inputAssets) {
        const outputAmount = outputAssets.get(assetId) ?? 0n;
        const changeAmount = inputAmount - outputAmount;
        if (changeAmount > 0n) {
            change.set(assetId, changeAmount);
        }
    }

    return change;
}

export function selectedCoinsToAssetInputs(
    selectedCoins: VirtualCoin[]
): Map<number, Asset[]> {
    const assetInputs = new Map<number, Asset[]>();

    for (let inputIndex = 0; inputIndex < selectedCoins.length; inputIndex++) {
        const coin = selectedCoins[inputIndex];
        if (!coin.assets || coin.assets.length === 0) {
            continue;
        }
        assetInputs.set(inputIndex, coin.assets);
    }

    return assetInputs;
}
