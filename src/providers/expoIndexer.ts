import { RestIndexerProvider, SubscriptionResponse, Vtxo } from "./indexer";
import { isFetchTimeoutError } from "./ark";
import { VirtualCoin } from "../wallet";

// Helper function to convert Vtxo to VirtualCoin (same as in indexer.ts)
function convertVtxo(vtxo: Vtxo): VirtualCoin {
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !vtxo.isSwept && !vtxo.isPreconfirmed,
        },
        virtualStatus: {
            state: vtxo.isSwept
                ? "swept"
                : vtxo.isPreconfirmed
                  ? "preconfirmed"
                  : "settled",
            commitmentTxIds: vtxo.commitmentTxids,
            batchExpiry: vtxo.expiresAt
                ? Number(vtxo.expiresAt) * 1000
                : undefined,
        },
        spentBy: vtxo.spentBy ?? "",
        settledBy: vtxo.settledBy,
        arkTxId: vtxo.arkTxid,
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
        isUnrolled: vtxo.isUnrolled,
        isSpent: vtxo.isSpent,
    };
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
export class ExpoIndexerProvider extends RestIndexerProvider {
    constructor(serverUrl: string) {
        super(serverUrl);
    }

    async *getSubscription(subscriptionId: string, abortSignal: AbortSignal) {
        // Detect if we're running in React Native/Expo environment
        const isReactNative =
            typeof navigator !== "undefined" &&
            navigator.product === "ReactNative";

        // Dynamic import to avoid bundling expo/fetch in non-Expo environments
        let expoFetch: typeof fetch = fetch; // Default to standard fetch
        try {
            const expoFetchModule = await import("expo/fetch");
            // expo/fetch returns a compatible fetch function but with different types
            expoFetch = expoFetchModule.fetch as unknown as typeof fetch;
            console.debug("Using expo/fetch for indexer subscription");
        } catch (error) {
            // In React Native/Expo, expo/fetch is required for proper streaming support
            if (isReactNative) {
                throw new Error(
                    "expo/fetch is unavailable in React Native environment. " +
                        "Please ensure expo/fetch is installed and properly configured. " +
                        "Streaming support may not work with standard fetch in React Native."
                );
            }
            // In non-RN environments, fall back to standard fetch but warn about potential streaming issues
            console.warn(
                "Using standard fetch instead of expo/fetch. " +
                    "Streaming may not be fully supported in some environments.",
                error
            );
        }

        const url = `${this.serverUrl}/v1/indexer/script/subscription/${subscriptionId}`;

        while (!abortSignal.aborted) {
            try {
                const res = await expoFetch(url, {
                    headers: {
                        Accept: "text/event-stream",
                        "Content-Type": "application/json",
                    },
                    signal: abortSignal,
                });

                if (!res.ok) {
                    throw new Error(
                        `Unexpected status ${res.status} when subscribing to address updates`
                    );
                }

                // Check if response is the expected content type
                const contentType = res.headers.get("content-type");
                if (
                    contentType &&
                    !contentType.includes("text/event-stream") &&
                    !contentType.includes("application/json")
                ) {
                    throw new Error(
                        `Unexpected content-type: ${contentType}. Expected text/event-stream or application/json`
                    );
                }

                if (!res.body) {
                    throw new Error("Response body is null");
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!abortSignal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            // Parse SSE format: "data: {json}"
                            if (line.startsWith("data:")) {
                                const jsonStr = line.substring(5).trim();
                                if (!jsonStr) continue;

                                const data = JSON.parse(jsonStr);
                                // Handle new v8 proto format with heartbeat or event
                                if (data.heartbeat !== undefined) {
                                    // Skip heartbeat messages
                                    continue;
                                }
                                // Process event messages
                                if (data.event) {
                                    yield {
                                        txid: data.event.txid,
                                        scripts: data.event.scripts || [],
                                        newVtxos: (
                                            data.event.newVtxos || []
                                        ).map(convertVtxo),
                                        spentVtxos: (
                                            data.event.spentVtxos || []
                                        ).map(convertVtxo),
                                        sweptVtxos: (
                                            data.event.sweptVtxos || []
                                        ).map(convertVtxo),
                                        tx: data.event.tx,
                                        checkpointTxs: data.event.checkpointTxs,
                                    };
                                }
                            }
                        } catch (parseError) {
                            console.error(
                                "Failed to parse subscription response:",
                                parseError
                            );
                            throw parseError;
                        }
                    }

                    buffer = lines[lines.length - 1];
                }
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
