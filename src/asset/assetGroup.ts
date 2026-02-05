import { hex } from "@scure/base";
import { MASK_ASSET_ID, MASK_CONTROL_ASSET, MASK_METADATA } from "./types";
import { AssetId } from "./assetId";
import { AssetRef } from "./assetRef";
import { AssetInput, AssetInputs } from "./assetInput";
import { AssetOutput, AssetOutputs } from "./assetOutput";
import {
    Metadata,
    serializeMetadataList,
    deserializeMetadataList,
} from "./metadata";
import { BufferReader, BufferWriter, serializeVarUint } from "./utils";

export class AssetGroup {
    readonly assetId: AssetId | null;
    readonly controlAsset: AssetRef | null;
    readonly immutable: boolean;
    readonly outputs: AssetOutput[];
    readonly inputs: AssetInput[];
    readonly metadata: Metadata[];

    constructor(
        assetId: AssetId | null,
        controlAsset: AssetRef | null,
        inputs: AssetInput[],
        outputs: AssetOutput[],
        metadata: Metadata[],
        immutable: boolean = true
    ) {
        this.assetId = assetId;
        this.controlAsset = controlAsset;
        this.immutable = immutable;
        this.inputs = inputs || [];
        this.outputs = outputs || [];
        this.metadata = metadata || [];
    }

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
            metadata,
            true
        );
        ag.validate();
        return ag;
    }

    // from hex encoded
    static fromString(s: string): AssetGroup {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid format, must be hex");
        }
        return AssetGroup.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): AssetGroup {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset");
        }
        const reader = new BufferReader(buf);
        return AssetGroup.fromReader(reader);
    }

    // an issuance is a group with null assetId
    isIssuance(): boolean {
        return this.assetId === null;
    }

    // a reissuance is a group that is not an issuance
    // but where the sum of the outputs is greater than the sum of the inputs
    isReissuance(): boolean {
        const sumReducer = (s: bigint, { amount }: { amount: bigint }) =>
            s + amount;
        const sumOutputs = this.outputs.reduce(sumReducer, 0n);
        const sumInputs = this.inputs.reduce(sumReducer, 0n);
        return !this.isIssuance() && sumInputs < sumOutputs;
    }

    serialize(): Uint8Array {
        this.validate();
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    validate(): void {
        if (this.isIssuance()) {
            if (this.inputs.length !== 0) {
                throw new Error("issuance must have no inputs");
            }
        } else {
            if (this.controlAsset !== null) {
                throw new Error("only issuance can have a control asset");
            }
        }

        if (!this.immutable) {
            throw new Error("asset must be immutable");
        }
    }

    toBatchLeafAssetGroup(intentTxid: Uint8Array): AssetGroup {
        const leafInput = AssetInput.createIntent(
            hex.encode(intentTxid),
            0,
            0n
        );
        return new AssetGroup(
            this.assetId,
            this.controlAsset,
            [leafInput],
            this.outputs,
            this.metadata,
            this.immutable
        );
    }

    toString(): string {
        return hex.encode(this.serialize());
    }

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
            metadata = deserializeMetadataList(reader);
        }

        const inputs = AssetInputs.fromReader(reader);
        const outputs = AssetOutputs.fromReader(reader);

        const ag = new AssetGroup(
            assetId,
            controlAsset,
            inputs.inputs,
            outputs.outputs,
            metadata,
            true
        );
        ag.validate();
        return ag;
    }

    serializeTo(writer: BufferWriter): void {
        let presence = 0;
        if (this.assetId !== null) {
            presence |= MASK_ASSET_ID;
        }
        if (this.controlAsset !== null) {
            presence |= MASK_CONTROL_ASSET;
        }
        if (this.metadata.length > 0) {
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
            serializeMetadataList(this.metadata, writer);
        }

        writer.write(serializeVarUint(this.inputs.length));
        for (const input of this.inputs) {
            input.serializeTo(writer);
        }

        writer.write(serializeVarUint(this.outputs.length));
        for (const output of this.outputs) {
            output.serializeTo(writer);
        }
    }
}
