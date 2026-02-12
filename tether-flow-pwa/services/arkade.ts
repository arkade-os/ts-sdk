/**
 * Arkade SDK integration layer for tether asset operations.
 *
 * This module provides the bridge between the Tether Flow PWA and the
 * @arkade-os/sdk. It wraps the SDK's wallet operations to expose a
 * tether-only interface, abstracting away Bitcoin internals entirely.
 *
 * Architecture:
 * - The SDK's Wallet class manages Bitcoin VTXOs on the Ark protocol
 * - Tether is issued as an Arkade Asset (from PR #279) on top of this
 * - Amounts are denominated in USDT, not satoshis
 * - Addresses use the Ark address format
 * - All Bitcoin details (fees, UTXOs, taproot) are hidden from the user
 */

// Types from @arkade-os/sdk that we'll use when integrating
// import {
//     Wallet,
//     SingleKey,
//     Ramps,
//     RestArkProvider,
//     RestIndexerProvider,
//     WalletConfig,
//     WalletBalance,
//     ArkTransaction,
//     TxType,
// } from "@arkade-os/sdk";
// import { IndexedDBStorageAdapter } from "@arkade-os/sdk/adapters/indexedDB";

/**
 * Configuration for connecting to an Arkade server with tether asset support.
 */
export interface ArkadeTetherConfig {
    /** URL of the Arkade server */
    serverUrl: string;
    /** Asset identifier for tether */
    assetId: string;
    /** Optional indexer URL (defaults to serverUrl) */
    indexerUrl?: string;
    /** Optional Esplora URL for on-chain lookups */
    esploraUrl?: string;
}

/**
 * Default configuration for tether on Arkade.
 * The asset ID "tether" maps to the USDT asset issued on the Ark protocol.
 */
export const DEFAULT_CONFIG: ArkadeTetherConfig = {
    serverUrl: "https://ark.arkade.fun",
    assetId: "tether",
};

/**
 * Initialize the Arkade wallet for tether operations.
 *
 * This will be the main entry point when the SDK integration is complete.
 * The wallet handles:
 * - Key management via SingleKey identity
 * - Storage via IndexedDB (for browser/PWA)
 * - Communication with the Ark server
 * - VTXO management for tether-denominated coins
 *
 * @example
 * ```typescript
 * import { initializeWallet } from './arkade';
 *
 * const wallet = await initializeWallet({
 *   serverUrl: "https://ark.arkade.fun",
 *   assetId: "tether",
 * });
 *
 * const balance = await wallet.getBalance();
 * console.log(`Balance: $${balance.available} USDT`);
 * ```
 */
export async function initializeWallet(_config: ArkadeTetherConfig = DEFAULT_CONFIG) {
    // TODO: When Arkade Assets (PR #279) is merged and the tether asset
    // is available, implement this as:
    //
    // const identity = new SingleKey(privateKey);
    // const wallet = await Wallet.create({
    //     arkServerUrl: config.serverUrl,
    //     identity,
    //     storageAdapter: new IndexedDBStorageAdapter(),
    //     asset: config.assetId, // "tether" - from PR #279
    // });
    //
    // return wallet;

    return null;
}

/**
 * Maps SDK balance (in satoshis) to USDT amounts.
 * When the tether asset is fully integrated, 1 unit = $0.01 USDT (2 decimals)
 * or 1 unit = $0.000001 USDT (6 decimals) depending on asset configuration.
 */
export function satoshisToUsdt(satoshis: bigint, decimals: number = 2): number {
    return Number(satoshis) / Math.pow(10, decimals);
}

/**
 * Maps USDT amounts to SDK units (asset-specific satoshis).
 */
export function usdtToSatoshis(usdt: number, decimals: number = 2): bigint {
    return BigInt(Math.round(usdt * Math.pow(10, decimals)));
}
