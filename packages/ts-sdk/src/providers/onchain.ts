import { DEFAULT_NETWORK_NAME, type NetworkName } from "../networks";
import { Coin } from "../wallet";
import { hex } from "@scure/base";
import { baseFetch } from "../utils/fetch";

/**
 * The default base URLs for esplora API providers.
 *
 * Mainnet, mutinynet, and signet point at Ark Labs–operated
 * mempool deployments (mempool.space-compatible esplora API).
 * Testnet falls back to the public mempool.space deployment
 * because Ark doesn't host it. Regtest assumes a local arkade-regtest
 * stack exposing mempool's esplora API on the standard port.
 */
export const ESPLORA_URL: Record<NetworkName, string> = {
    bitcoin: "https://mempool.arkade.sh/api",
    testnet: "https://mempool.space/testnet/api",
    signet: "https://mempool.signet.arkade.sh/api",
    mutinynet: "https://mempool.mutinynet.arkade.sh/api",
    regtest: "http://localhost:3000/api",
};

export type ExplorerTransaction = {
    txid: string;
    /**
     * Inputs as returned by Esplora's `/address/:addr/txs`, each carrying the
     * outpoint it spends (`txid:vout`). Optional: not every provider populates
     * it (the electrum provider omits inputs), so consumers that correlate
     * spenders must tolerate its absence. Used to recover a boarding output's
     * spending (commitment) tx when `/outspends` omits the spender txid.
     */
    vin?: {
        txid: string;
        vout: number;
    }[];
    vout: {
        scriptpubkey_address: string;
        value: string;
    }[];
    status: {
        confirmed: boolean;
        block_time: number;
    };
};

export interface OnchainProvider {
    /**
     * Fetch spendable onchain outputs for an address.
     *
     * @param address - Bitcoin address to query
     * @returns Spendable onchain outputs for the address
     * @see Coin
     */
    getCoins(address: string): Promise<Coin[]>;

    /**
     * Fetch the current fastest fee rate estimate.
     *
     * @returns Fee rate in sats/vB, if available
     * @remarks
     * Implementations may return `undefined` when the backing service does not expose
     * a usable fee estimate.
     */
    getFeeRate(): Promise<number | undefined>;

    /**
     * Broadcast a single transaction or a 1P1C package.
     *
     * @param txs - One or more raw transaction hex strings
     * @returns Broadcast transaction id
     * @throws Error if the broadcast request fails or the package shape is invalid
     */
    broadcastTransaction(...txs: string[]): Promise<string>;

    /**
     * Fetch outspend information for every output in a transaction.
     *
     * @param txid - Transaction id to inspect
     * @returns Per-output spend status information. `txid` (the spender) may be
     *   absent even when `spent` is true: some Esplora deployments
     *   (e.g. mempool.arkade.sh) omit it from `/outspends`.
     * @see getTxStatus
     */
    getTxOutspends(txid: string): Promise<{ spent: boolean; txid?: string }[]>;

    /**
     * Fetch transactions associated with an address.
     *
     * @param address - Bitcoin address to query
     * @returns Transactions involving the address
     * @see ExplorerTransaction
     */
    getTransactions(address: string): Promise<ExplorerTransaction[]>;

    /**
     * Fetch the raw wire-format bytes of a transaction.
     *
     * @param txid - Transaction id to fetch
     * @returns Serialized transaction bytes
     * @throws Error if the transaction is unknown to the backend
     * @remarks
     * Needed to carry a boarding or commitment tx as a PSBT prevout field —
     * those have no off-chain source, so the indexer cannot serve them.
     */
    getRawTransaction(txid: string): Promise<Uint8Array>;

    /**
     * Fetch confirmation status for a transaction.
     *
     * @param txid - Transaction id to inspect
     * @returns Confirmation status and block metadata when confirmed
     * @see getTxOutspends
     */
    getTxStatus(
        txid: string,
    ): Promise<{ confirmed: false } | { confirmed: true; blockTime: number; blockHeight: number }>;
    /**
     * Fetch the current chain tip.
     *
     * @returns Current chain height, block time, and block hash
     */
    getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }>;

    /**
     * Watch a set of addresses and invoke the callback when transactions are observed.
     *
     * @param addresses - Addresses to monitor
     * @param eventCallback - Callback invoked when matching transactions are seen
     * @returns Stop function that cancels the watch
     * @remarks
     * Implementations may use websockets, server-sent events, polling, or a hybrid strategy.
     * @see getTransactions
     */
    watchAddresses(
        addresses: string[],
        eventCallback: (txs: ExplorerTransaction[]) => void,
    ): Promise<() => void>;
}

/**
 * Implementation of the onchain provider interface for esplora REST API.
 *
 * @see https://mempool.space/docs/api/rest
 * @example
 * ```typescript
 * const provider = new EsploraProvider("https://mempool.space/api");
 * const outputs = await provider.getCoins("bcrt1q679zsd45msawvr7782r0twvmukns3drlstjt77");
 * ```
 */
export class EsploraProvider implements OnchainProvider {
    readonly pollingInterval: number;
    readonly forcePolling: boolean;

    /**
     * Live {@link watchAddresses} subscriptions, keyed by their address set.
     *
     * Concurrent watchers over the same addresses share one transport, so a
     * caller that opens watchers in a loop — or leaks them by abandoning
     * {@link waitForIncomingFunds} — costs one entry in a `Set` rather than
     * another WebSocket plus another full-history polling loop. Entries are
     * dropped once their last subscriber stops.
     */
    private readonly addressWatches = new Map<string, SharedAddressWatch>();

    constructor(
        private baseUrl: string = ESPLORA_URL[DEFAULT_NETWORK_NAME],
        opts?: {
            /** Polling interval in milliseconds. */
            pollingInterval?: number;

            /** Force polling even when websocket transport is available. */
            forcePolling?: boolean;
        },
    ) {
        this.pollingInterval = opts?.pollingInterval ?? 15_000;
        this.forcePolling = opts?.forcePolling ?? false;
    }

    async getCoins(address: string): Promise<Coin[]> {
        const response = await baseFetch(`${this.baseUrl}/address/${address}/utxo`);
        if (!response.ok) {
            throw new Error(`Failed to fetch UTXOs: ${response.statusText}`);
        }
        return response.json();
    }

    async getFeeRate(): Promise<number | undefined> {
        const response = await baseFetch(`${this.baseUrl}/fee-estimates`);
        // Not every Esplora backend serves /fee-estimates — mempool returns 404
        // on regtest, where it has no fee history. Every caller falls back to
        // MIN_FEE_RATE when this is undefined, so degrade gracefully on a missing
        // endpoint rather than throwing and defeating those fallbacks. Other
        // (e.g. 5xx) failures still surface.
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`Failed to fetch fee rate: ${response.statusText}`);
        }
        const fees = (await response.json()) as Record<string, number>;
        return fees["1"] ?? undefined;
    }

    async broadcastTransaction(...txs: string[]): Promise<string> {
        switch (txs.length) {
            case 1:
                return this.broadcastTx(txs[0]);
            case 2:
                return this.broadcastPackage(txs[0], txs[1]);
            default:
                throw new Error("Only 1 or 1C1P package can be broadcast");
        }
    }

    async getTxOutspends(txid: string): Promise<{ spent: boolean; txid?: string }[]> {
        const response = await baseFetch(`${this.baseUrl}/tx/${txid}/outspends`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get transaction outspends: ${error}`);
        }

        return response.json();
    }

    async getTransactions(address: string): Promise<ExplorerTransaction[]> {
        const response = await baseFetch(`${this.baseUrl}/address/${address}/txs`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get transactions: ${error}`);
        }

        return response.json();
    }

    async getRawTransaction(txid: string): Promise<Uint8Array> {
        const response = await baseFetch(`${this.baseUrl}/tx/${txid}/hex`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get raw transaction ${txid}: ${error}`);
        }
        return hex.decode((await response.text()).trim());
    }

    async getTxStatus(txid: string): Promise<
        | {
              confirmed: false;
          }
        | {
              confirmed: true;
              blockTime: number;
              blockHeight: number;
          }
    > {
        // make sure tx exists in mempool or in block
        const txresponse = await baseFetch(`${this.baseUrl}/tx/${txid}`);
        if (!txresponse.ok) {
            throw new Error(txresponse.statusText);
        }

        const tx = await txresponse.json();
        if (!tx.status.confirmed) {
            return { confirmed: false };
        }

        const response = await baseFetch(`${this.baseUrl}/tx/${txid}/status`);
        if (!response.ok) {
            throw new Error(`Failed to get transaction status: ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.confirmed) {
            return { confirmed: false };
        }

        return {
            confirmed: data.confirmed,
            blockTime: data.block_time,
            blockHeight: data.block_height,
        };
    }

    async watchAddresses(
        addresses: string[],
        callback: (txs: ExplorerTransaction[]) => void,
    ): Promise<() => void> {
        // Address order is not significant to the subscription, so normalise it
        // before keying — otherwise ["a","b"] and ["b","a"] open two watchers
        // over identical data. NUL-joined so an address can't forge a boundary.
        const key = [...addresses].sort().join("\u0000");

        let watch = this.addressWatches.get(key);
        if (!watch) {
            watch = this.createAddressWatch(addresses, () => this.addressWatches.delete(key));
            this.addressWatches.set(key, watch);
        }

        // Register before awaiting startup: the refcount must never read zero
        // while the transport is still coming up, or a concurrent stop would
        // tear down a watch this caller is about to depend on.
        const subscriber: AddressWatchSubscriber = { callback };
        watch.subscribers.add(subscriber);

        const shared = watch;
        await shared.started;

        let released = false;
        return () => {
            // Idempotent per subscriber: a caller that stops twice must not
            // decrement the refcount twice and strand the other subscribers.
            if (released) return;
            released = true;

            shared.subscribers.delete(subscriber);
            if (shared.subscribers.size === 0) shared.teardown();
        };
    }

    /**
     * Bring up one shared address watch: a WebSocket subscription where the
     * explorer supports it, degrading to HTTP polling when it doesn't.
     *
     * @param addresses - Addresses this watch covers
     * @param onTeardown - Invoked when the watch retires, to drop the registry entry
     */
    private createAddressWatch(addresses: string[], onTeardown: () => void): SharedAddressWatch {
        const subscribers = new Set<AddressWatchSubscriber>();
        const wsUrl = this.baseUrl.replace(/^http(s)?:/, "ws$1:") + "/v1/ws";

        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let pollStarted = false;
        let ws: WebSocket | null = null;

        const emit = (txs: ExplorerTransaction[]) => {
            if (stopped || txs.length === 0) return;
            // Snapshot: a subscriber may stop (mutating the set) from its callback.
            for (const subscriber of [...subscribers]) {
                try {
                    subscriber.callback(txs);
                } catch (error) {
                    console.error("Address watch subscriber threw:", error);
                }
            }
        };

        // block_time is part of the key so a tx is re-reported when it confirms.
        const txKey = (tx: ExplorerTransaction) => `${tx.txid}_${tx.status.block_time}`;
        const getAllTxs = async () => {
            const txArrays = await Promise.all(
                addresses.map((address) => this.getTransactions(address)),
            );
            return txArrays.flat();
        };

        const startPolling = async () => {
            // `pollStarted` makes this idempotent: a WebSocket can emit `error`
            // more than once, and each call used to install another interval
            // over the top of the previous handle, orphaning it.
            if (stopped || pollStarted) return;
            pollStarted = true;

            // Worth surfacing: address history (`/address/{a}/txs`) is far more
            // expensive than the socket it replaces, and a silent fallback is
            // what turns an explorer blip into sustained polling traffic.
            console.warn(
                `Esplora websocket unavailable (${wsUrl}); falling back to HTTP polling every ${this.pollingInterval}ms for ${addresses.length} address(es)`,
            );

            // Undefined until the first successful pass, which only establishes
            // the baseline — transactions that predate the watch aren't
            // "incoming" and must not be reported.
            let seen: Set<string> | undefined;
            let failures = 0;

            const schedule = () => {
                if (stopped) return;
                // Self-rescheduling rather than setInterval: a fixed interval
                // stacks overlapping full-history fetches when the explorer is
                // slower than pollingInterval, and offers nowhere to back off
                // when it starts failing or rate-limiting.
                timer = setTimeout(tick, this.pollingInterval * 2 ** failures);
            };

            const tick = async () => {
                try {
                    const currentTxs = await getAllTxs();

                    // teardown may have run while that fetch was in flight.
                    // Returning before `schedule()` is what keeps stop() honest:
                    // otherwise the timer is installed *after* teardown, with no
                    // handle left to clear it, and the loop hammers the explorer
                    // until the process exits.
                    if (stopped) return;

                    if (seen === undefined) {
                        seen = new Set(currentTxs.map(txKey));
                    } else {
                        const newTxs = currentTxs.filter((tx) => !seen!.has(txKey(tx)));
                        if (newTxs.length > 0) {
                            newTxs.forEach((tx) => seen!.add(txKey(tx)));
                            emit(newTxs);
                        }
                    }
                    failures = 0;
                } catch (error) {
                    // Includes the baseline pass: a transient explorer failure
                    // backs off and retries rather than leaving a watch that is
                    // registered but permanently blind.
                    failures = Math.min(failures + 1, MAX_POLL_BACKOFF_EXPONENT);
                    console.error("Error polling watched addresses:", error);
                }

                schedule();
            };

            // Seed straight away so the baseline is in place without waiting a
            // full interval, then fall into the scheduled loop.
            await tick();
        };

        const teardown = () => {
            if (stopped) return;
            // Flag first: closing the socket can itself surface an `error`
            // event, and that must not start the HTTP fallback we just retired.
            stopped = true;
            onTeardown();

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (ws) {
                try {
                    ws.close();
                } catch {
                    // already closing or never opened; nothing to release
                }
                ws = null;
            }
            subscribers.clear();
        };

        let started: Promise<void> = Promise.resolve();

        if (this.forcePolling) {
            started = startPolling();
        } else {
            try {
                ws = new WebSocket(wsUrl);
                ws.addEventListener("open", () => {
                    const subscribeMsg: SubscribeMessage = {
                        "track-addresses": addresses,
                    };
                    ws?.send(JSON.stringify(subscribeMsg));
                });

                ws.addEventListener("message", (event: MessageEvent) => {
                    try {
                        const newTxs: ExplorerTransaction[] = [];
                        const message: WebSocketMessage = JSON.parse(event.data.toString());
                        if (!message["multi-address-transactions"]) return;
                        const aux = message["multi-address-transactions"];

                        for (const address in aux) {
                            for (const type of ["mempool", "confirmed", "removed"] as const) {
                                if (!aux[address][type]) continue;
                                newTxs.push(...aux[address][type].filter(isExplorerTransaction));
                            }
                        }
                        emit(newTxs);
                    } catch (error) {
                        console.error("Failed to process WebSocket message:", error);
                    }
                });

                // Not `async`: `startPolling` handles its own failures, and an
                // async listener's rejection would surface as an unhandled one.
                ws.addEventListener("error", () => {
                    void startPolling();
                });
            } catch {
                started = startPolling();
            }
        }

        return { subscribers, teardown, started };
    }

    async getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }> {
        // Use the standard Esplora `/blocks` route (newest-first array of recent
        // blocks) rather than `/blocks/tip`: the latter is not part of the Esplora
        // spec — electrs happens to serve it as an alias for `/blocks`, but a
        // strict backend like mempool returns an empty array, which surfaced here
        // as "No chain tip found". `/blocks` works across every Esplora backend.
        const tipBlocks = await baseFetch(`${this.baseUrl}/blocks`);
        if (!tipBlocks.ok) {
            throw new Error(`Failed to get chain tip: ${tipBlocks.statusText}`);
        }

        const tip = await tipBlocks.json();
        if (!isValidBlocksTip(tip)) {
            throw new Error(`Invalid chain tip: ${JSON.stringify(tip)}`);
        }

        if (tip.length === 0) {
            throw new Error("No chain tip found");
        }

        const hash = tip[0].id;
        return {
            height: tip[0].height,
            time: tip[0].mediantime,
            hash,
        };
    }

    private async broadcastPackage(parent: string, child: string): Promise<string> {
        const response = await baseFetch(`${this.baseUrl}/txs/package`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify([parent, child]),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to broadcast package: ${error}`);
        }

        // `/txs/package` proxies Bitcoin Core's `submitpackage`, which reports
        // per-transaction results in the body. A package whose transactions
        // were all rejected still answers 200, so the HTTP status alone cannot
        // tell acceptance from refusal:
        //
        //   200 {"package_msg":"transaction failed",
        //        "tx-results":{"<wtxid>":{"txid":"...",
        //                                 "error":"bad-txns-inputs-missingorspent"}}}
        //
        // Returning that as success is worse than failing: the caller believes
        // the transaction is in flight and waits for a confirmation that cannot
        // come, while the node already said exactly why it will not.
        const result = await response.json();
        assertPackageAccepted(result);
        return result;
    }

    private async broadcastTx(tx: string): Promise<string> {
        const response = await baseFetch(`${this.baseUrl}/tx`, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
            },
            body: tx,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to broadcast transaction: ${error}`);
        }

        return response.text();
    }
}

/**
 * Throw when a 200 response describes a rejected package.
 *
 * Deliberately permissive: only a body that carries Core's own verdict is
 * judged. Not every Esplora deployment proxies that shape, and treating an
 * unrecognised body as failure would break broadcasting against the ones that
 * do not.
 */
function assertPackageAccepted(result: unknown): void {
    if (!result || typeof result !== "object") return;
    const r = result as {
        package_msg?: unknown;
        "tx-results"?: Record<string, { txid?: unknown; error?: unknown }>;
    };
    const msg = typeof r.package_msg === "string" ? r.package_msg : undefined;
    if (msg === undefined || msg === "success") return;

    const reasons: string[] = [];
    const results = r["tx-results"];
    if (results && typeof results === "object") {
        for (const entry of Object.values(results)) {
            if (!entry || typeof entry !== "object" || entry.error === undefined) continue;
            const txid = typeof entry.txid === "string" ? entry.txid : "unknown tx";
            reasons.push(`${txid}: ${String(entry.error)}`);
        }
    }

    throw new Error(
        reasons.length > 0
            ? `Package rejected (${msg}) — ${reasons.join("; ")}`
            : `Package rejected (${msg})`,
    );
}

function isValidBlocksTip(tip: any): tip is { id: string; height: number; mediantime: number }[] {
    return (
        Array.isArray(tip) &&
        tip.every((t) => {
            return (
                t &&
                typeof t === "object" &&
                typeof t.id === "string" &&
                t.id.length > 0 &&
                typeof t.height === "number" &&
                t.height >= 0 &&
                typeof t.mediantime === "number" &&
                t.mediantime > 0
            );
        })
    );
}

const isExplorerTransaction = (tx: any): tx is ExplorerTransaction => {
    return (
        typeof tx.txid === "string" &&
        (tx.vin === undefined ||
            (Array.isArray(tx.vin) &&
                tx.vin.every(
                    (vin: any) => typeof vin.txid === "string" && typeof vin.vout === "number",
                ))) &&
        Array.isArray(tx.vout) &&
        tx.vout.every(
            (vout: any) =>
                typeof vout.scriptpubkey_address === "string" && typeof vout.value === "number",
        ) &&
        typeof tx.status === "object" &&
        typeof tx.status.confirmed === "boolean"
    );
};

/**
 * Ceiling on the HTTP-poll backoff exponent, so a persistently failing or
 * rate-limiting explorer is retried at `pollingInterval * 2^5` (8 minutes at
 * the 15s default) rather than escalating without bound.
 */
const MAX_POLL_BACKOFF_EXPONENT = 5;

/** One caller's registration against a {@link SharedAddressWatch}. */
interface AddressWatchSubscriber {
    callback: (txs: ExplorerTransaction[]) => void;
}

/**
 * One transport (WebSocket, or its HTTP-polling fallback) serving every
 * concurrent watcher of the same address set.
 */
interface SharedAddressWatch {
    /** Live registrations; the watch retires when this empties. */
    subscribers: Set<AddressWatchSubscriber>;
    /** Resolves once the transport is up (or has fallen back to polling). */
    started: Promise<void>;
    /** Releases the transport. Idempotent. */
    teardown: () => void;
}

interface SubscribeMessage {
    "track-addresses": string[];
}

interface WebSocketMessage {
    "multi-address-transactions"?: Record<
        string,
        {
            mempool: ExplorerTransaction[];
            confirmed: ExplorerTransaction[];
            removed: ExplorerTransaction[];
        }
    >;
}
