export const RFQ_CONTRACT_VERSIONS_KEY = "contract_versions";
export const RFQ_CONTRACT_VERSION_KEY = "contract_version";
export const RFQ_CONTRACT_VERSION_UNSUPPORTED = "contract_version_unsupported";

export const ASSET_SWAP_V2 = "asset-swap-v2";
export const ASSET_SWAP_V3 = "asset-swap-v3";
/** v3 whose `fulfill` also needs the quoting solver's `taker` signature. */
export const ASSET_SWAP_V4 = "asset-swap-v4";
/** A quote without a negotiated version uses this tree. */
export const ASSET_SWAP_BASELINE = ASSET_SWAP_V2;
