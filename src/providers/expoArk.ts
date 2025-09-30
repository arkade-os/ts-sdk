import {
    RestArkProvider,
    SettlementEvent,
    TxNotification,
    isFetchTimeoutError,
} from "./ark";

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

    async *getEventStream(
        signal: AbortSignal,
        topics: string[]
    ): AsyncIterableIterator<SettlementEvent> {
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
            console.debug("Using expo/fetch for SSE");
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

        const url = `${this.serverUrl}/v1/batch/events`;
        const queryParams =
            topics.length > 0
                ? `?${topics.map((topic) => `topics=${encodeURIComponent(topic)}`).join("&")}`
                : "";

        while (!signal?.aborted) {
            // Create a new AbortController for this specific fetch attempt
            // to prevent accumulating listeners on the parent signal
            const fetchController = new AbortController();
            const cleanup = () => fetchController.abort();
            signal?.addEventListener("abort", cleanup);

            try {
                const response = await expoFetch(url + queryParams, {
                    headers: {
                        Accept: "text/event-stream",
                    },
                    signal: fetchController.signal,
                });

                if (!response.ok) {
                    throw new Error(
                        `Unexpected status ${response.status} when fetching event stream`
                    );
                }

                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!signal?.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    // Append new data to buffer and split by newlines
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    // Process all complete lines
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            // Parse SSE format: "data: {json}"
                            if (line.startsWith("data:")) {
                                const jsonStr = line.substring(5).trim();
                                if (!jsonStr) continue;

                                const data = JSON.parse(jsonStr);

                                // Handle different response structures
                                // v8 mesh API might wrap in {result: ...} or send directly
                                const eventData = data.result || data;

                                // Skip heartbeat messages
                                if (eventData.heartbeat !== undefined) {
                                    continue;
                                }

                                const event =
                                    this.parseSettlementEvent(eventData);
                                if (event) {
                                    yield event;
                                }
                            }
                        } catch (err) {
                            console.error("Failed to parse event:", line);
                            console.error("Parse error:", err);
                            throw err;
                        }
                    }

                    // Keep the last partial line in the buffer
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

                console.error("Event stream error:", error);
                throw error;
            } finally {
                // Clean up the abort listener
                signal?.removeEventListener("abort", cleanup);
            }
        }
    }

    async *getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }> {
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
            console.debug("Using expo/fetch for transaction stream");
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

        const url = `${this.serverUrl}/v1/txs`;

        while (!signal?.aborted) {
            // Create a new AbortController for this specific fetch attempt
            // to prevent accumulating listeners on the parent signal
            const fetchController = new AbortController();
            const cleanup = () => fetchController.abort();
            signal?.addEventListener("abort", cleanup);

            try {
                const response = await expoFetch(url, {
                    headers: {
                        Accept: "text/event-stream",
                    },
                    signal: fetchController.signal,
                });

                if (!response.ok) {
                    throw new Error(
                        `Unexpected status ${response.status} when fetching transaction stream`
                    );
                }

                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!signal?.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    // Append new data to buffer and split by newlines
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    // Process all complete lines
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        const data = JSON.parse(line);
                        const txNotification =
                            this.parseTransactionNotification(data.result);
                        if (txNotification) {
                            yield txNotification;
                        }
                    }

                    // Keep the last partial line in the buffer
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

                console.error("Address subscription error:", error);
                throw error;
            } finally {
                // Clean up the abort listener
                signal?.removeEventListener("abort", cleanup);
            }
        }
    }
}
