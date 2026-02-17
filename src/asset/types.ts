export const TX_HASH_SIZE = 32;
export const ASSET_ID_SIZE = 34;
export const ASSET_VERSION = 0x01;

export enum AssetInputType {
    Unspecified = 0,
    Local = 1,
    Intent = 2,
}

export function assetTypeToString(type: AssetInputType): string {
    switch (type) {
        case AssetInputType.Local:
            return "local";
        case AssetInputType.Intent:
            return "intent";
        default:
            return "unspecified";
    }
}

export enum AssetRefType {
    Unspecified = 0,
    ByID = 1,
    ByGroup = 2,
}

// Presence byte masks for AssetGroup
export const MASK_ASSET_ID = 0x01;
export const MASK_CONTROL_ASSET = 0x02;
export const MASK_METADATA = 0x04;

// ARK magic bytes and marker
export const ARKADE_MAGIC = new Uint8Array([0x41, 0x52, 0x4b]); // "ARK"
export const MARKER_ASSET_PAYLOAD = 0x00;
