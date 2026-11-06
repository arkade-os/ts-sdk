import {
    RestIndexerProvider,
    SubscriptionEvent,
    SubscriptionHeartbeat,
    toSubscriptionMessage,
} from "./indexer";
import { isFetchTimeoutError } from "./ark";
import { getExpoFetch, sseStreamIterator } from "./expoUtils";
import { DEFAULT_ARKADE_SERVER_URL } from "../networks";

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
export class ExpoIndexerProvider extends RestIndexerProvider {
    constructor(serverUrl: string = DEFAULT_ARKADE_SERVER_URL) {
        super(serverUrl);
    }

    protected override async *subscriptionStream(
        url: string,
        abortSignal: AbortSignal,
    ): AsyncIterableIterator<SubscriptionEvent | SubscriptionHeartbeat> {
        // Detect if we're running in React Native/Expo environment
        const isReactNative =
            typeof navigator !== "undefined" && navigator.product === "ReactNative";

        const expoFetch = await getExpoFetch({ requireExpo: isReactNative }).catch((error) => {
            // In React Native/Expo, expo/fetch is required for proper streaming support
            if (isReactNative) {
                throw new Error(
                    "expo/fetch is unavailable in React Native environment. " +
                        "Please ensure expo/fetch is installed and properly configured. " +
                        "Streaming support may not work with standard fetch in React Native.",
                );
            }
            throw error;
        });

        while (!abortSignal.aborted) {
            try {
                yield* sseStreamIterator(
                    url,
                    abortSignal,
                    expoFetch,
                    { "Content-Type": "application/json" },
                    toSubscriptionMessage,
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

                console.error("Subscription error:", error);
                throw error;
            }
        }
    }
}
