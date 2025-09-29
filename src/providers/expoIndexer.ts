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
        // Dynamic import to avoid bundling expo/fetch in non-Expo environments
        let expoFetch: typeof fetch;
        try {
            // Use eval to avoid TypeScript compilation errors when expo/fetch is not available
            const importFunc = new Function(
                "specifier",
                "return import(specifier)"
            );
            const expoFetchModule = await importFunc("expo/fetch");
            expoFetch = expoFetchModule.fetch;
        } catch (error) {
            throw new Error(
                "expo/fetch is required for ExpoIndexerProvider. Please install expo package."
            );
        }

        const url = `${this.serverUrl}/v1/script/subscription/${subscriptionId}`;

        while (!abortSignal.aborted) {
            try {
                const res = await expoFetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                    signal: abortSignal,
                });

                if (!res.ok) {
                    throw new Error(
                        `Unexpected status ${res.status} when subscribing to address updates`
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
                            const data = JSON.parse(line);
                            if ("result" in data) {
                                yield {
                                    txid: data.result.txid,
                                    scripts: data.result.scripts || [],
                                    newVtxos: (data.result.newVtxos || []).map(
                                        convertVtxo
                                    ),
                                    spentVtxos: (
                                        data.result.spentVtxos || []
                                    ).map(convertVtxo),
                                    tx: data.result.tx,
                                    checkpointTxs: data.result.checkpointTxs,
                                };
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
