export const TX_HASH_SIZE = 32;
export const ASSET_ID_SIZE = 34;
export const ASSET_VERSION = 0x01;

export enum AssetInputType {
    Unspecified = 0,
    Local = 1,
    Intent = 2,
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
