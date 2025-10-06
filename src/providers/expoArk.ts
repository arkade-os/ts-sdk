import {
    RestArkProvider,
    SettlementEvent,
    TxNotification,
    isFetchTimeoutError,
} from "./ark";
import { getExpoFetch, sseStreamIterator } from "./utils";

/**
 * Expo-compatible Ark provider implementation using expo/fetch for SSE support.
 * This provider works specifically in React Native/Expo environments where
 * standard EventSource is not available but expo/fetch provides SSE capabilities.
 *
 * @example
 * ```typescript
 * import { ExpoArkProvider } from '@arkade-os/sdk/providers/expo';
 *
 * const provider = new ExpoArkProvider('https://ark.example.com');
 * const info = await provider.getInfo();
 * ```
 */
export class ExpoArkProvider extends RestArkProvider {
    constructor(serverUrl: string) {
        super(serverUrl);
    }

    override async *getEventStream(
        signal: AbortSignal,
        topics: string[]
    ): AsyncIterableIterator<SettlementEvent> {
        const expoFetch = await getExpoFetch();
        const url = `${this.serverUrl}/v1/batch/events`;
        const queryParams =
            topics.length > 0
                ? `?${topics.map((topic) => `topics=${encodeURIComponent(topic)}`).join("&")}`
                : "";

        while (!signal?.aborted) {
            try {
                yield* sseStreamIterator(
                    url + queryParams,
                    signal,
                    expoFetch,
                    {},
                    (data) => {
                        // Handle different response structures
                        // v8 mesh API might wrap in {result: ...} or send directly
                        const eventData = data.result || data;

                        // Skip heartbeat messages
                        if (eventData.heartbeat !== undefined) {
                            return null;
                        }

                        return this.parseSettlementEvent(eventData);
                    }
                );
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }

                // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                // these timeouts are set by expo/fetch function
                if (isFetchTimeoutError(error)) {
                    console.debug("Timeout error ignored");
                    continue;
                }

                console.error("Event stream error:", error);
                throw error;
            }
        }
    }

    override async *getTransactionsStream(
        signal: AbortSignal
    ): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }> {
        const expoFetch = await getExpoFetch();
        const url = `${this.serverUrl}/v1/txs`;

        while (!signal?.aborted) {
            try {
                yield* sseStreamIterator(url, signal, expoFetch, {}, (data) => {
                    return this.parseTransactionNotification(data.result);
                });
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }

                // ignore timeout errors, they're expected when the server is not sending anything for 5 min
                // these timeouts are set by expo/fetch function
                if (isFetchTimeoutError(error)) {
                    console.debug("Timeout error ignored");
                    continue;
                }

                console.error("Transaction stream error:", error);
                throw error;
            }
        }
    }
}
