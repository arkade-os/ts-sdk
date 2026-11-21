export const RFQ_CONTRACT_VERSIONS_KEY = "contract_versions";
export const RFQ_CONTRACT_VERSION_KEY = "contract_version";
export const RFQ_CONTRACT_VERSION_UNSUPPORTED = "contract_version_unsupported";

export const ASSET_SWAP_V2 = "asset-swap-v2";
/** The directed covenant: `fulfill` also needs the quoting solver's `taker` signature. */
export const ASSET_SWAP_DIRECTED = "asset-swap-directed";
export const ASSET_SWAP_DIRECTED_NONCE = "asset-swap-directed-nonce";
/** A quote without a negotiated version uses this tree. */
export const ASSET_SWAP_BASELINE = ASSET_SWAP_V2;
