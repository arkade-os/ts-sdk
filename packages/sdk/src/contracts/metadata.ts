/**
 * Sentinel stored in `contract.metadata.source` to mark a contract the
 * wallet generated for its own rotating receive address. Lives here (the
 * contracts layer) so contract handlers can tag/discover without importing
 * the wallet module. Re-exported from `wallet/walletReceiveRotator` for
 * backward compatibility of existing import paths.
 *
 * Tagging makes the boot lookup unambiguous — the rotator filters on
 * `metadata.source === WALLET_RECEIVE_SOURCE` rather than on "any active
 * default contract", so a contract repo that also holds default contracts
 * created for other reasons (legacy timelock variants, external
 * integrations) doesn't confuse the wallet's display state.
 */
export const WALLET_RECEIVE_SOURCE = "wallet-receive";
