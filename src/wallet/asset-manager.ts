import {
    AssetDetails,
    AssetMetadata,
    BurnParams,
    IAssetManager,
    IReadonlyAssetManager,
    IssuanceParams,
    IssuanceResult,
    ReissuanceParams,
} from ".";
import {
    AssetGroup,
    AssetId,
    AssetInput,
    AssetOutput,
    AssetRef,
    Metadata,
    Packet,
} from "../asset";
import { IndexerProvider } from "../providers/indexer";
import { ArkAddress } from "../script/address";
import { selectedCoinsToAssetInputs, selectCoinsWithAsset } from "./asset";
import { selectVirtualCoins, Wallet } from "./wallet";

export class ReadonlyAssetManager implements IReadonlyAssetManager {
    constructor(readonly indexer: IndexerProvider) {}

    async getAssetDetails(assetId: string): Promise<AssetDetails> {
        // TODO: rely on db, and fallback to indexer if not found
        return this.indexer.getAssetDetails(assetId);
    }
}

export class AssetManager
    extends ReadonlyAssetManager
    implements IAssetManager
{
    constructor(readonly wallet: Wallet) {
        super(wallet.indexerProvider);
    }

    /**
     * Issue a new asset.
     * @param params - Parameters for asset issuance
     * @param params.amount - Amount of asset units to issue
     * @param params.controlAsset - Optional control asset (for reissuable assets)
     * @param params.metadata - Optional metadata to attach to the asset
     * @returns Promise resolving to the ark transaction ID and asset ID
     *
     * @example
     * ```typescript
     * // Issue a simple non-reissuable asset
     * const result = await wallet.issueAsset({ amount: 1000 });
     * console.log('Asset ID:', result.assetId);
     *
     * // Issue a reissuable asset with a new control asset
     * const result = await wallet.issueAsset({
     *   amount: 1000,
     *   controlAsset: 1 // creates new control asset with amount 1
     * });
     * console.log('Control Asset ID:', result.controlAssetId);
     * console.log('Asset ID:', result.assetId);
     *
     * // Issue a reissuable asset with an existing control asset
     * const result = await wallet.issueAsset({
     *   amount: 1000,
     *   controlAsset: 'controlAssetId'
     * });
     * console.log('Control Asset ID:', result.controlAssetId);
     * console.log('Asset ID:', result.assetId);
     * ```
     */
    async issue(params: IssuanceParams): Promise<IssuanceResult> {
        if (params.amount <= 0) {
            throw new Error(
                `Issue amount must be greater than 0, got ${params.amount}`
            );
        }

        const metadata = castMetadata(params.metadata);

        const virtualCoins = await this.wallet.getVtxos({
            withRecoverable: false,
        });

        const controlAssetRef = params.controlAssetId
            ? AssetRef.fromId(AssetId.fromString(params.controlAssetId))
            : null;

        const coinSelection = selectVirtualCoins(
            virtualCoins,
            Number(this.wallet.dustAmount)
        );
        let totalBtcSelected = 0n;

        // keep track of asset changes
        const assetChanges = new Map<string, bigint>();

        for (const coin of coinSelection.inputs) {
            totalBtcSelected += BigInt(coin.value);
            if (!coin.assets) continue;
            for (const { assetId, amount } of coin.assets) {
                const existing = assetChanges.get(assetId) ?? 0n;
                assetChanges.set(assetId, existing + BigInt(amount));
            }
        }

        const groups: AssetGroup[] = [];

        // issued asset group
        const issuedAssetOutput = AssetOutput.create(0, BigInt(params.amount));
        const issuedAssetGroup = AssetGroup.create(
            null,
            controlAssetRef,
            [],
            [issuedAssetOutput],
            metadata
        );
        groups.push(issuedAssetGroup);

        // add asset groups for each asset change
        if (assetChanges.size > 0) {
            const assetInputs = selectedCoinsToAssetInputs(
                coinSelection.inputs
            );

            for (const [assetId, amount] of assetChanges) {
                const changeInputs: AssetInput[] = [];

                // collect all inputs for the asset change
                for (const [inputIndex, assets] of assetInputs) {
                    for (const asset of assets) {
                        if (asset.assetId !== assetId) continue;
                        changeInputs.push(
                            AssetInput.create(inputIndex, BigInt(asset.amount))
                        );
                    }
                }

                // add the change asset group
                groups.push(
                    AssetGroup.create(
                        AssetId.fromString(assetId),
                        null,
                        changeInputs,
                        [AssetOutput.create(0, amount)],
                        []
                    )
                );
            }
        }

        // build transaction outputs
        const address = await this.wallet.getAddress();
        const outputAddress = ArkAddress.decode(address);
        const outputs = [
            {
                script: outputAddress.pkScript,
                amount: BigInt(totalBtcSelected),
            },
            Packet.create(groups).txOut(),
        ];

        const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(
            coinSelection.inputs,
            outputs
        );
        return {
            arkTxId: arkTxid,
            assetId: AssetId.create(arkTxid, 0).toString(),
        };
    }

    /**
     * Reissue more units of an existing asset.
     * Requires ownership of the control asset.
     *
     * @param params - Parameters for asset reissuance
     * @param params.assetId - The asset ID to reissue (control asset ID is resolved via getAssetDetails)
     * @param params.amount - Amount of additional units to issue
     * @returns Promise resolving to the ark transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.assetManager.reissue({
     *   assetId: 'def456...',
     *   amount: 500
     * });
     * ```
     */
    async reissue(params: ReissuanceParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error(
                `Reissuance amount must be greater than 0, got ${params.amount}`
            );
        }

        const { controlAssetId } = await this.getAssetDetails(params.assetId);
        if (!controlAssetId) {
            throw new Error(`Asset ${params.assetId} is not reissuable`);
        }

        const virtualCoins = await this.wallet.getVtxos({
            withRecoverable: false,
        });

        const assetChanges = new Map<string, bigint>();

        // select control asset inputs
        const { selected: controlCoins } = selectCoinsWithAsset(
            virtualCoins,
            controlAssetId,
            1n
        );

        let selectedCoins = [...controlCoins];
        let assetToReissueAmount = 0n;

        // all control inputs assets go to asset changes, including the control asset itself
        for (const coin of controlCoins) {
            if (!coin.assets) continue;
            for (const { assetId, amount } of coin.assets) {
                if (assetId === params.assetId) {
                    assetToReissueAmount += BigInt(amount);
                    continue;
                }
                const existing = assetChanges.get(assetId) ?? 0n;
                assetChanges.set(assetId, existing + BigInt(amount));
            }
        }

        // select at least dust amount
        const minBtcNeeded = Number(this.wallet.dustAmount);
        let totalBtcSelected = selectedCoins.reduce(
            (sum, c) => sum + c.value,
            0
        );

        if (totalBtcSelected < minBtcNeeded) {
            const remainingCoins = virtualCoins.filter(
                (c) =>
                    !selectedCoins.find(
                        (sc) => sc.txid === c.txid && sc.vout === c.vout
                    )
            );
            const additional = selectVirtualCoins(
                remainingCoins,
                minBtcNeeded - totalBtcSelected
            );
            for (const coin of additional.inputs) {
                // additional inputs assets go to asset changes
                if (!coin.assets) continue;
                for (const { assetId, amount } of coin.assets) {
                    if (assetId === params.assetId) {
                        assetToReissueAmount += BigInt(amount);
                        continue;
                    }
                    const existing = assetChanges.get(assetId) ?? 0n;
                    assetChanges.set(assetId, existing + BigInt(amount));
                }
            }
            selectedCoins = [...selectedCoins, ...additional.inputs];
            totalBtcSelected += additional.inputs.reduce(
                (sum, c) => sum + c.value,
                0
            );
        }

        const assetInputs = selectedCoinsToAssetInputs(selectedCoins);

        // collect all inputs for the asset to reissue
        const reissueInputs: AssetInput[] = [];
        for (const [inputIndex, assets] of assetInputs) {
            for (const asset of assets) {
                if (asset.assetId !== params.assetId) continue;
                reissueInputs.push(
                    AssetInput.create(inputIndex, BigInt(asset.amount))
                );
            }
        }

        // the total output amount of the asset to reissue = new + (optional) selected amount
        const totalAssetAmount = assetToReissueAmount + BigInt(params.amount);
        const reissueAssetIdObj = AssetId.fromString(params.assetId);

        // create the reissuance asset group
        const reissueAssetGroup = AssetGroup.create(
            reissueAssetIdObj,
            null,
            reissueInputs,
            [AssetOutput.create(0, totalAssetAmount)],
            []
        );

        const groups = [reissueAssetGroup];

        // for each asset change, create a new asset group
        for (const [assetId, amount] of assetChanges) {
            const changeInputs: AssetInput[] = [];
            for (const [inputIndex, assets] of assetInputs) {
                for (const asset of assets) {
                    if (asset.assetId !== assetId) continue;
                    changeInputs.push(
                        AssetInput.create(inputIndex, BigInt(asset.amount))
                    );
                }
            }
            groups.push(
                AssetGroup.create(
                    AssetId.fromString(assetId),
                    null,
                    changeInputs,
                    [AssetOutput.create(0, amount)],
                    []
                )
            );
        }

        // build transaction outputs
        const address = await this.wallet.getAddress();
        const outputAddress = ArkAddress.decode(address);
        const outputs = [
            {
                script: outputAddress.pkScript,
                amount: BigInt(totalBtcSelected),
            },
            Packet.create(groups).txOut(),
        ];

        const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(
            selectedCoins,
            outputs
        );
        return arkTxid;
    }

    /**
     * Burn assets.
     * @param params - Parameters for burning
     * @param params.assetId - The asset ID to burn
     * @param params.amount - Amount of units to burn
     * @returns Promise resolving to the ark transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.assetManager.burn({
     *   assetId: 'abc123...',
     *   amount: 100
     * });
     * ```
     */
    async burn(params: BurnParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error(
                `Burn amount must be greater than 0, got ${params.amount}`
            );
        }

        const virtualCoins = await this.wallet.getVtxos({
            withRecoverable: false,
        });

        const assetChanges = new Map<string, bigint>();

        // select vtxos with the asset to burn
        const { selected: assetCoins } = selectCoinsWithAsset(
            virtualCoins,
            params.assetId,
            BigInt(params.amount)
        );

        const selectedCoins = [...assetCoins];
        let totalBtcSelected = 0;

        // add the selected coins to asset changes, including the asset to burn
        for (const coin of assetCoins) {
            totalBtcSelected += coin.value;
            if (!coin.assets) continue;
            for (const { assetId, amount } of coin.assets) {
                const existing = assetChanges.get(assetId) ?? 0n;
                assetChanges.set(assetId, existing + BigInt(amount));
            }
        }
        // subtract the amount to burn from the asset change
        assetChanges.set(
            params.assetId,
            (assetChanges.get(params.assetId) ?? 0n) - BigInt(params.amount)
        );

        const minBtcNeeded = Number(this.wallet.dustAmount);

        // we need to ensure at least dust amount is selected
        // if not, select additional coins
        if (totalBtcSelected < minBtcNeeded) {
            const remainingCoins = virtualCoins.filter(
                (c) =>
                    !selectedCoins.find(
                        (sc) => sc.txid === c.txid && sc.vout === c.vout
                    )
            );
            const additional = selectVirtualCoins(
                remainingCoins,
                minBtcNeeded - totalBtcSelected
            );

            // additional inputs assets go to asset changes
            for (const coin of additional.inputs) {
                totalBtcSelected += coin.value;
                if (!coin.assets) continue;
                for (const { assetId, amount } of coin.assets) {
                    const existing = assetChanges.get(assetId) ?? 0n;
                    assetChanges.set(assetId, existing + BigInt(amount));
                }
            }

            selectedCoins.push(...additional.inputs);
        }

        const groups: AssetGroup[] = [];
        const assetInputs = selectedCoinsToAssetInputs(selectedCoins);

        // for each asset, create a new asset group
        for (const [assetId, amount] of assetChanges) {
            const changeInputs: AssetInput[] = [];
            for (const [inputIndex, assets] of assetInputs) {
                for (const asset of assets) {
                    if (asset.assetId !== assetId) continue;
                    changeInputs.push(
                        AssetInput.create(inputIndex, BigInt(asset.amount))
                    );
                }
            }
            groups.push(
                AssetGroup.create(
                    AssetId.fromString(assetId),
                    null,
                    changeInputs,
                    amount > 0n ? [AssetOutput.create(0, amount)] : [],
                    []
                )
            );
        }

        // build transaction outputs
        const address = await this.wallet.getAddress();
        const outputAddress = ArkAddress.decode(address);
        const outputs = [
            {
                script: outputAddress.pkScript,
                amount: BigInt(totalBtcSelected),
            },
            Packet.create(groups).txOut(),
        ];

        const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(
            selectedCoins,
            outputs
        );
        return arkTxid;
    }
}

function castMetadata(metadata?: AssetMetadata): Metadata[] {
    if (!metadata) {
        return [];
    }

    const md: Metadata[] = [];
    const textEncoder = new TextEncoder();
    for (const [key, value] of Object.entries(metadata)) {
        // convert value to bytes
        let valueBytes: Uint8Array;
        if (typeof value === "string") {
            valueBytes = textEncoder.encode(value);
        } else if (typeof value === "number") {
            valueBytes = textEncoder.encode(String(value));
        } else if (value instanceof Uint8Array) {
            valueBytes = value;
        } else if (value instanceof ArrayBuffer) {
            valueBytes = new Uint8Array(value);
        } else {
            throw new Error("Invalid metadata value type");
        }

        md.push(Metadata.create(textEncoder.encode(key), valueBytes));
    }
    return md;
}
