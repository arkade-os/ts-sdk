import type { VmTx, VmTxOut } from "./tx";

// Structural mirrors of the ark-lib / emulator packet types. The VM owns no packet wire format:
// src/extension adapts its codecs to these shapes.

/** `txid` in internal byte order; the asset wire format carries it reversed. */
export interface AssetIdLike {
    readonly txid: Uint8Array;
    readonly index: number;
}

export interface AssetRefLike {
    readonly type: number;
    readonly assetId: AssetIdLike;
    readonly groupIndex: number;
}

export interface AssetInputLike {
    readonly type: number;
    readonly vin: number;
    readonly txid: Uint8Array;
    readonly amount: bigint;
}

export interface AssetOutputLike {
    readonly type: number;
    readonly vout: number;
    readonly amount: bigint;
}

export interface AssetMetadataLike {
    serialize(): Uint8Array;
}

export interface AssetGroupLike {
    /** null for a fresh issuance, whose id is (this tx's hash, group position). */
    readonly assetId: AssetIdLike | null;
    readonly controlAsset: AssetRefLike | null;
    readonly inputs: readonly AssetInputLike[];
    readonly outputs: readonly AssetOutputLike[];
    readonly metadata: readonly AssetMetadataLike[];
}

export type AssetPacketLike = readonly AssetGroupLike[];

export interface EmulatorEntryLike {
    readonly vin: number;
    readonly script: Uint8Array;
    readonly witness: readonly Uint8Array[];
}

/** Validated: non-empty, no empty script, no duplicate vin, every vin a valid input index. */
export type EmulatorPacketLike = readonly EmulatorEntryLike[];

export interface ExtensionPacketLike {
    readonly type: number;
    /** Canonical re-encode (not the raw on-chain slice); may throw. */
    serialize(): Uint8Array;
}

export interface ExtensionLike {
    readonly packets: readonly ExtensionPacketLike[];
    /** Extension.GetAssetPacket. */
    readonly assetPacket: AssetPacketLike | null;
}

export interface ExtensionCodec {
    /** extension.NewExtensionFromTx: null for ErrExtensionNotFound, throws on a malformed one. */
    readExtension(tx: VmTx): ExtensionLike | null;
    /** FindEmulatorPacket: null when absent, throws on a malformed packet or out-of-range vin. */
    findEmulatorPacket(tx: VmTx): EmulatorPacketLike | null;
    /**
     * maskExtensionOutput (sigvalidate.go:297-337): the first extension output with every emulator
     * witness blob dropped. Fail-open: null on any parse failure; throws only if re-encoding fails.
     */
    maskExtensionOutput(tx: VmTx): { readonly index: number; readonly output: VmTxOut } | null;
}
