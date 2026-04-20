import { hex } from "@scure/base";
import {
    AssetInputType,
    MASK_ASSET_ID,
    MASK_CONTROL_ASSET,
    MASK_METADATA,
} from "./types";
import { AssetId } from "./assetId";
import { AssetRef } from "./assetRef";
import { AssetInput, AssetInputs } from "./assetInput";
import { AssetOutput, AssetOutputs } from "./assetOutput";
import { Metadata, MetadataList } from "./metadata";
import { BufferReader, BufferWriter } from "./utils";

/**
 * An asset group contains inputs, outputs, and all data related to a given asset id.
 *
 * @see Packet
 * @see AssetId
 * @see AssetRef
 *
 * @example
 * ```typescript
 * const group = AssetGroup.create(
 *   null,                              // asset ID: null for new issuance
 *   null,                              // control asset ID: null when reissuance not needed
 *   [],                                // asset inputs: empty for new issuance
 *   [AssetOutput.create(0, 1000)],     // asset outputs: 1000 units at vout index 0
 *   []                                 // metadata: can be empty
 * )
 * ```
 */
export class AssetGroup {
    private readonly metadataList: MetadataList;

    /** @see create */
    constructor(
        readonly assetId: AssetId | null,
        readonly controlAsset: AssetRef | null,
        readonly inputs: AssetInput[],
        readonly outputs: AssetOutput[],
        metadata: Metadata[]
    ) {
        this.metadataList = new MetadataList(metadata);
    }

    /**
     * Create and validate an asset group.
     *
     * @param assetId - Asset id for this group, or `null` for fresh issuance
     * @param controlAsset - Optional control asset reference for (re) issuance
     * @param inputs - Asset inputs in the group
     * @param outputs - Asset outputs in the group
     * @param metadata - Metadata entries associated with the group
     * @returns A validated asset group
     * @throws Error if the group fails validation
     * @see validate
     */
    static create(
        assetId: AssetId | null,
        controlAsset: AssetRef | null,
        inputs: AssetInput[],
        outputs: AssetOutput[],
        metadata: Metadata[]
    ): AssetGroup {
        const ag = new AssetGroup(
            assetId,
            controlAsset,
            inputs,
            outputs,
            metadata
        );
        ag.validate();
        return ag;
    }

    /**
     * Decode an asset group from its hex string form.
     *
     * @param s - Hex-encoded asset group
     * @returns Decoded asset group
     * @throws Error if the string is not valid hex or does not encode a valid asset group
     * @see toString
     */
    static fromString(s: string): AssetGroup {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid format, must be hex");
        }
        return AssetGroup.fromBytes(buf);
    }

    /**
     * Decode an asset group from its serialized bytes.
     *
     * @param buf - Serialized asset group bytes
     * @returns Decoded asset group
     * @throws Error if the buffer is empty or malformed
     */
    static fromBytes(buf: Uint8Array): AssetGroup {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset group");
        }
        const reader = new BufferReader(buf);
        return AssetGroup.fromReader(reader);
    }

    /**
     * Return true when the group represents an issuance.
     *
     * @returns `true` when the group has no asset id
     */
    isIssuance(): boolean {
        return this.assetId === null;
    }

    /**
     * Return true when the group represents a reissuance.
     *
     * @returns `true` when the group has an asset id and outputs exceed local inputs
     * @remarks
     * Only local inputs contribute to the comparison; intent-backed inputs contribute `0` here.
     */
    isReissuance(): boolean {
        const sumReducer = (s: bigint, { amount }: { amount: bigint }) =>
            s + amount;
        const sumOutputs = this.outputs.reduce(sumReducer, 0n);
        const sumInputs = this.inputs
            .map((i) => ({
                amount:
                    i.input.type === AssetInputType.Local ? i.input.amount : 0n,
            }))
            .reduce(sumReducer, 0n);
        return !this.isIssuance() && sumInputs < sumOutputs;
    }

    /**
     * Serialize the asset group to raw bytes.
     *
     * @returns Serialized asset group bytes
     * @see fromBytes
     */
    serialize(): Uint8Array {
        this.validate();
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    /**
     * Validate the asset group and its child structures.
     *
     * @throws Error if the group is empty or violates issuance invariants
     */
    validate(): void {
        if (this.inputs.length === 0 && this.outputs.length === 0) {
            throw new Error("empty asset group");
        }
        if (this.isIssuance()) {
            if (this.inputs.length !== 0) {
                throw new Error("issuance must have no inputs");
            }
        } else {
            if (this.controlAsset !== null) {
                throw new Error("only issuance can have a control asset");
            }
        }
    }

    /**
     * Convert the group into its batch-leaf representation for the given intent txid.
     *
     * @param intentTxid - Intent transaction id used to build the leaf input reference
     * @returns Batch-leaf asset group
     * @see AssetInput.createIntent
     */
    toBatchLeafAssetGroup(intentTxid: Uint8Array): AssetGroup {
        const leafInput = AssetInput.createIntent(hex.encode(intentTxid), 0, 0);
        return new AssetGroup(
            this.assetId,
            this.controlAsset,
            [leafInput],
            this.outputs,
            this.metadataList.items
        );
    }

    /**
     * Encode the asset group to a hex string.
     *
     * @returns Hex-encoded asset group
     * @see fromString
     */
    toString(): string {
        return hex.encode(this.serialize());
    }

    /**
     * Decode an asset group from a binary reader.
     *
     * @param reader - Reader positioned at an asset group
     * @returns Decoded asset group
     * @throws Error if the encoded group is malformed
     */
    static fromReader(reader: BufferReader): AssetGroup {
        const presence = reader.readByte();

        let assetId: AssetId | null = null;
        let controlAsset: AssetRef | null = null;
        let metadata: Metadata[] = [];

        if (presence & MASK_ASSET_ID) {
            assetId = AssetId.fromReader(reader);
        }

        if (presence & MASK_CONTROL_ASSET) {
            controlAsset = AssetRef.fromReader(reader);
        }

        if (presence & MASK_METADATA) {
            metadata = MetadataList.fromReader(reader).items;
        }

        const inputs = AssetInputs.fromReader(reader);
        const outputs = AssetOutputs.fromReader(reader);

        const ag = new AssetGroup(
            assetId,
            controlAsset,
            inputs.inputs,
            outputs.outputs,
            metadata
        );
        ag.validate();
        return ag;
    }

    /**
     * Serialize the asset group into an existing binary writer.
     *
     * @param writer - Writer to append the asset group to
     */
    serializeTo(writer: BufferWriter): void {
        let presence = 0;
        if (this.assetId !== null) {
            presence |= MASK_ASSET_ID;
        }
        if (this.controlAsset !== null) {
            presence |= MASK_CONTROL_ASSET;
        }
        if (this.metadataList.length > 0) {
            presence |= MASK_METADATA;
        }
        writer.writeByte(presence);

        if (presence & MASK_ASSET_ID) {
            this.assetId!.serializeTo(writer);
        }

        if (presence & MASK_CONTROL_ASSET) {
            this.controlAsset!.serializeTo(writer);
        }

        if (presence & MASK_METADATA) {
            this.metadataList.serializeTo(writer);
        }

        writer.writeVarUint(this.inputs.length);
        for (const input of this.inputs) {
            input.serializeTo(writer);
        }

        writer.writeVarUint(this.outputs.length);
        for (const output of this.outputs) {
            output.serializeTo(writer);
        }
    }
}
