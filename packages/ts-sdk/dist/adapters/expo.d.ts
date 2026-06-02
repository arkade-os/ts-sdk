import { j as RestArkProvider, h as SettlementEvent, T as TxNotification, k as RestIndexerProvider, l as SubscriptionResponse } from '../ark-BCdDnaIQ.js';
export { m as ArkProvider, n as IndexerProvider } from '../ark-BCdDnaIQ.js';
import '@scure/btc-signer/transaction.js';
import '@scure/btc-signer/utils.js';
import '@scure/btc-signer/psbt.js';
import '@scure/btc-signer';

/**
 * Expo-compatible Arkade provider implementation using expo/fetch for SSE support.
 * This provider works specifically in React Native/Expo environments where
 * standard EventSource is not available but expo/fetch provides SSE capabilities.
 *
 * @example
 * ```typescript
 * import { ExpoArkProvider } from '@arkade-os/sdk/providers/expo';
 *
 * const provider = new ExpoArkProvider('https://arkade.computer');
 * const info = await provider.getInfo();
 * ```
 */
declare class ExpoArkProvider extends RestArkProvider {
    constructor(serverUrl?: string);
    getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<SettlementEvent>;
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;
}

/**
 * Expo-compatible Indexer provider implementation using expo/fetch for streaming support.
 * This provider works specifically in React Native/Expo environments where
 * standard fetch streaming may not work properly but expo/fetch provides streaming capabilities.
 *
 * @example
 * ```typescript
 * import { ExpoIndexerProvider } from '@arkade-os/sdk/adapters/expo';
 *
 * const provider = new ExpoIndexerProvider('https://indexer.example.com');
 * const vtxos = await provider.getVtxos({ scripts: ['script1'] });
 * ```
 */
declare class ExpoIndexerProvider extends RestIndexerProvider {
    constructor(serverUrl?: string);
    getSubscription(subscriptionId: string, abortSignal: AbortSignal): AsyncIterableIterator<SubscriptionResponse>;
}

export { ExpoArkProvider, ExpoIndexerProvider };
