import { RestArkProvider, isFetchTimeoutError, RestIndexerProvider } from './chunk-DODG3PG2.js';
import { DEFAULT_ARKADE_SERVER_URL } from './chunk-HAYJZIA4.js';

// src/providers/expoUtils.ts
async function getExpoFetch(options) {
  try {
    const expoFetchModule = await import('expo/fetch');
    console.debug("Using expo/fetch for streaming");
    return expoFetchModule.fetch;
  } catch (error) {
    console.warn(
      "Using standard fetch instead of expo/fetch. Streaming may not be fully supported in some environments.",
      error
    );
    return fetch;
  }
}
async function* sseStreamIterator(url, abortSignal, fetchFn, headers, parseData) {
  const fetchController = new AbortController();
  const cleanup = () => fetchController.abort();
  abortSignal?.addEventListener("abort", cleanup, { once: true });
  try {
    const response = await fetchFn(url, {
      headers: {
        Accept: "text/event-stream",
        ...headers
      },
      signal: fetchController.signal
    });
    if (!response.ok) {
      throw new Error(`Unexpected status ${response.status} when fetching SSE stream`);
    }
    if (!response.body) {
      throw new Error("Response body is null");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abortSignal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith("data:")) {
          const jsonStr = line.substring(5).trim();
          if (!jsonStr) continue;
          try {
            const data = JSON.parse(jsonStr);
            const parsed = parseData(data);
            if (parsed !== null) {
              yield parsed;
            }
          } catch (parseError) {
            console.error("Failed to parse SSE data:", parseError);
            throw parseError;
          }
        }
      }
      buffer = lines[lines.length - 1];
    }
  } finally {
    abortSignal?.removeEventListener("abort", cleanup);
  }
}

// src/providers/expoArk.ts
var ExpoArkProvider = class extends RestArkProvider {
  constructor(serverUrl = DEFAULT_ARKADE_SERVER_URL) {
    super(serverUrl);
  }
  async *getEventStream(signal, topics) {
    const expoFetch = await getExpoFetch();
    const url = `${this.serverUrl}/v1/batch/events`;
    const queryParams = topics.length > 0 ? `?${topics.map((topic) => `topics=${encodeURIComponent(topic)}`).join("&")}` : "";
    while (!signal?.aborted) {
      try {
        yield* sseStreamIterator(url + queryParams, signal, expoFetch, {}, (data) => {
          const eventData = data.result || data;
          if (eventData.heartbeat !== void 0) {
            return null;
          }
          return this.parseSettlementEvent(eventData);
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          break;
        }
        if (isFetchTimeoutError(error)) {
          console.debug("Timeout error ignored");
          continue;
        }
        console.error("Event stream error:", error);
        throw error;
      }
    }
  }
  async *getTransactionsStream(signal) {
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
        if (isFetchTimeoutError(error)) {
          console.debug("Timeout error ignored");
          continue;
        }
        console.error("Transaction stream error:", error);
        throw error;
      }
    }
  }
};

// src/providers/expoIndexer.ts
function convertVtxo(vtxo) {
  return {
    txid: vtxo.outpoint.txid,
    vout: vtxo.outpoint.vout,
    value: Number(vtxo.amount),
    status: {
      confirmed: !vtxo.isSwept && !vtxo.isPreconfirmed,
      isLeaf: !vtxo.isPreconfirmed
    },
    virtualStatus: {
      state: vtxo.isSwept ? "swept" : vtxo.isPreconfirmed ? "preconfirmed" : "settled",
      commitmentTxIds: vtxo.commitmentTxids,
      batchExpiry: vtxo.expiresAt ? Number(vtxo.expiresAt) * 1e3 : void 0
    },
    spentBy: vtxo.spentBy ?? "",
    settledBy: vtxo.settledBy,
    arkTxId: vtxo.arkTxid,
    createdAt: new Date(Number(vtxo.createdAt) * 1e3),
    isUnrolled: vtxo.isUnrolled,
    isSpent: vtxo.isSpent,
    script: vtxo.script,
    assets: vtxo.assets?.map((a) => ({
      assetId: a.assetId,
      amount: BigInt(a.amount)
    }))
  };
}
var ExpoIndexerProvider = class extends RestIndexerProvider {
  constructor(serverUrl = DEFAULT_ARKADE_SERVER_URL) {
    super(serverUrl);
  }
  async *getSubscription(subscriptionId, abortSignal) {
    const isReactNative = typeof navigator !== "undefined" && navigator.product === "ReactNative";
    const expoFetch = await getExpoFetch().catch((error) => {
      if (isReactNative) {
        throw new Error(
          "expo/fetch is unavailable in React Native environment. Please ensure expo/fetch is installed and properly configured. Streaming support may not work with standard fetch in React Native."
        );
      }
      throw error;
    });
    const url = `${this.serverUrl}/v1/indexer/script/subscription/${subscriptionId}`;
    while (!abortSignal.aborted) {
      try {
        yield* sseStreamIterator(
          url,
          abortSignal,
          expoFetch,
          { "Content-Type": "application/json" },
          (data) => {
            if (data.heartbeat !== void 0) {
              return null;
            }
            if (data.event) {
              return {
                txid: data.event.txid,
                scripts: data.event.scripts || [],
                newVtxos: (data.event.newVtxos || []).map(convertVtxo),
                spentVtxos: (data.event.spentVtxos || []).map(convertVtxo),
                sweptVtxos: (data.event.sweptVtxos || []).map(convertVtxo),
                tx: data.event.tx,
                checkpointTxs: data.event.checkpointTxs
              };
            }
            return null;
          }
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          break;
        }
        if (isFetchTimeoutError(error)) {
          console.debug("Timeout error ignored");
          continue;
        }
        console.error("Subscription error:", error);
        throw error;
      }
    }
  }
};

export { ExpoArkProvider, ExpoIndexerProvider };
//# sourceMappingURL=chunk-DJTXHUIQ.js.map
//# sourceMappingURL=chunk-DJTXHUIQ.js.map