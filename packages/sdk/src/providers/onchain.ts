import { DEFAULT_NETWORK_NAME, type NetworkName } from "../networks";
import { Coin } from "../wallet";
import { hex } from "@scure/base";
import { baseFetch } from "../utils/fetch";

/**
 * The default base URLs for esplora API providers: Ark Labs–operated mempool deployments, except
 * testnet (public mempool.space; Ark doesn't host it) and regtest (a local arkade-regtest stack).
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
     * Spent outpoints, as returned by Esplora's `/address/:addr/txs`; the electrum provider omits
     * them. Used to recover a boarding output's commitment tx when `/outspends` omits the spender.
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
        /** Set by Esplora; the electrum provider omits it. */
        block_height?: number;
    };
};

type AddressActivity = {
    tx_count: number;
    funded_txo_count: number;
    spent_txo_count: number;
};

/** Esplora's per-address summary (`GET /address/{addr}`). */
type AddressStats = {
    chain_stats: AddressActivity;
    mempool_stats: AddressActivity;
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
     * @returns Current chain height, median-time-past, and block hash
     * @remarks
     * `time` is the tip's **median-time-past**, not the header's `nTime`: BIP-113 evaluates
     * seconds-typed CLTV/CSV against MTP (~1h behind the tip; header time may be 2h ahead).
     * Returning header time would call a timelock mature early, and the node rejects the broadcast.
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
     * Live {@link watchAddresses} subscriptions, keyed by address set. Sharing means a leaked
     * watcher (e.g. an abandoned {@link waitForIncomingFunds}) costs a `Set` entry, not another
     * WebSocket plus full-history polling loop.
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
        // mempool 404s /fee-estimates on regtest (no fee history); callers fall back to
        // MIN_FEE_RATE on undefined, so don't throw. Other failures still surface.
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

    /** Orders of magnitude smaller than `/address/{addr}/txs`: the polling fallback's probe. */
    private async getAddressStats(address: string): Promise<AddressStats> {
        const response = await baseFetch(`${this.baseUrl}/address/${address}`);
        if (!response.ok) {
            throw new Error(`Failed to get address stats: ${response.statusText}`);
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

    /**
     * Watch a set of addresses over the explorer's WebSocket, degrading to HTTP polling while the
     * socket is unavailable and returning to it once re-established.
     *
     * Concurrent calls covering the same address set share one transport. The returned function
     * releases **this** subscription only (idempotent); the last release tears the transport down.
     *
     * @param addresses - Addresses to monitor; order is not significant
     * @param callback - Invoked with transactions seen after the watch started
     * @returns A function releasing this subscription
     * @remarks
     * The HTTP fallback fetches full history per address per cycle, far costlier than the socket,
     * so release watches you no longer need rather than relying on sharing.
     * @see {@link waitForIncomingFunds} for the cancellation-aware wallet-level helper
     */
    async watchAddresses(
        addresses: string[],
        callback: (txs: ExplorerTransaction[]) => void,
    ): Promise<() => void> {
        // Sorted so ["a","b"] and ["b","a"] share a watch; NUL-joined so an address can't forge a
        // boundary.
        const key = [...addresses].sort().join("\u0000");

        let watch = this.addressWatches.get(key);
        if (!watch) {
            watch = this.createAddressWatch(addresses, () => this.addressWatches.delete(key));
            this.addressWatches.set(key, watch);
        }

        // Register before awaiting startup, else a concurrent stop could see zero subscribers and
        // tear down a watch this caller is about to depend on.
        const subscriber: AddressWatchSubscriber = { callback };
        watch.subscribers.add(subscriber);

        const shared = watch;
        await shared.started;

        let released = false;
        return () => {
            if (released) return;
            released = true;

            shared.subscribers.delete(subscriber);
            if (shared.subscribers.size === 0) shared.teardown();
        };
    }

    /** @param onTeardown - Invoked when the watch retires, to drop the registry entry */
    private createAddressWatch(addresses: string[], onTeardown: () => void): SharedAddressWatch {
        const subscribers = new Set<AddressWatchSubscriber>();
        const wsUrl = this.baseUrl.replace(/^http(s)?:/, "ws$1:") + "/v1/ws";

        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let pollStarted = false;
        let ws: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectFailures = 0;
        // Bumped when a poll loop is retired, so a cycle suspended on its fetch knows it's stale.
        let pollSession = 0;

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

        /**
         * Everything reported (or predating the watch), shared by both transports for the watch's
         * whole life — not rebuilt per poll session — so a deposit that landed while the socket was
         * down still reads as new to the first poll pass.
         *
         * ponytail: never compacted, so a watch left open on a high-volume address accumulates;
         * retain only recent blocks if that ever matters.
         */
        const seen = new Set<string>();
        let baselined = false;

        /** Chain height at watch start, used if the history baseline fails. */
        let anchorHeight: number | undefined;

        /**
         * Establish what predates the watch. Seeded additively: the socket may report a tx while
         * this fetch is in flight, which must not be undone or duplicated. The tip is fetched
         * alongside so the anchor is the height at watch start, not when history gives up.
         */
        const baseline = (async () => {
            const [history, tip] = await Promise.allSettled([getAllTxs(), this.getChainTip()]);
            if (history.status === "fulfilled") {
                for (const tx of history.value) seen.add(txKey(tx));
                baselined = true;
                return;
            }

            console.warn(
                "Could not baseline watched addresses; the first poll pass will establish it instead:",
                history.reason,
            );
            if (tip.status === "fulfilled") anchorHeight = tip.value.height;
        })();

        /**
         * Deliver only what hasn't been reported yet. Marks as it goes, not filter-then-mark: a
         * batch can hold the same tx twice (one payment to two watched addresses — ordinary with
         * rotated boarding addresses), which would otherwise be counted twice downstream.
         */
        const report = (txs: ExplorerTransaction[]) => {
            const fresh: ExplorerTransaction[] = [];
            for (const tx of txs) {
                const key = txKey(tx);
                if (seen.has(key)) continue;
                seen.add(key);
                fresh.push(tx);
            }
            if (fresh.length === 0) return;
            emit(fresh);
        };

        const startPolling = async () => {
            // Idempotent: a WebSocket can emit `error` more than once.
            if (stopped || pollStarted) return;
            pollStarted = true;

            // Surfaced because polling history is far costlier than the socket it replaces.
            console.warn(
                `Esplora websocket unavailable (${wsUrl}); falling back to HTTP polling every ${this.pollingInterval}ms for ${addresses.length} address(es) while retrying the socket`,
            );

            let failures = 0;

            /**
             * Cheap "has anything changed" probe; `undefined` = cannot answer, never "unchanged".
             *
             * Counts, not `/utxo`: a tx confirming after its output was spent moves nothing there,
             * yet changes `txKey`. Any mempool activity is "cannot answer": a replacement can keep
             * every count while changing the txid. Residual: a reorg re-mining a tx at a new
             * `block_time` moves no count, so its re-report waits for the next real change.
             */
            const activityFingerprint = async (): Promise<string | undefined> => {
                try {
                    const stats = await Promise.all(
                        addresses.map((address) => this.getAddressStats(address)),
                    );

                    const counted = (activity?: AddressActivity) =>
                        typeof activity?.tx_count === "number" &&
                        typeof activity.funded_txo_count === "number" &&
                        typeof activity.spent_txo_count === "number";
                    const usable = stats.every(
                        (s) => counted(s?.chain_stats) && counted(s?.mempool_stats),
                    );
                    if (!usable) return undefined;

                    if (stats.some((s) => s.mempool_stats.tx_count > 0)) return undefined;

                    return stats
                        .map(
                            ({ chain_stats: chain }) =>
                                `${chain.tx_count}:${chain.funded_txo_count}:${chain.spent_txo_count}`,
                        )
                        .join(",");
                } catch {
                    return undefined;
                }
            };

            let lastFingerprint: string | undefined;

            // `stopped` alone isn't enough: the watch outlives this loop when the socket returns.
            const session = pollSession;
            const isCurrentLoop = () => !stopped && session === pollSession;

            const schedule = () => {
                if (!isCurrentLoop()) return;
                // Not setInterval: that stacks overlapping fetches on a slow explorer and can't
                // back off.
                timer = setTimeout(tick, this.pollingInterval * 2 ** failures);
            };

            const tick = async () => {
                try {
                    // Only pay for the expensive history once the counts say something moved.
                    const fingerprint = await activityFingerprint();
                    if (!isCurrentLoop()) return;

                    if (fingerprint !== undefined && fingerprint === lastFingerprint) {
                        failures = 0;
                        schedule();
                        return;
                    }

                    const currentTxs = await getAllTxs();

                    // Teardown or a returning socket may have retired this loop mid-fetch; bail
                    // before `schedule()` or an orphaned timer keeps hitting the explorer.
                    if (!isCurrentLoop()) return;

                    // Committed only after history succeeds, else a transient failure would mask
                    // the deposit until a *second* change.
                    lastFingerprint = fingerprint;

                    if (baselined) {
                        report(currentTxs);
                    } else if (anchorHeight !== undefined) {
                        // Unconfirmed counts as new: a duplicate notification beats a missed deposit.
                        const arrivedAfterStart = (tx: ExplorerTransaction) =>
                            !tx.status.confirmed ||
                            tx.status.block_height === undefined ||
                            tx.status.block_height > anchorHeight!;

                        for (const tx of currentTxs) {
                            if (!arrivedAfterStart(tx)) seen.add(txKey(tx));
                        }
                        baselined = true;
                        report(currentTxs);
                    } else {
                        // No reference: adopt current history rather than announce it, and warn —
                        // a silent miss is unexplainable later.
                        console.warn(
                            `Esplora address watch established its baseline late for ${addresses.length} address(es); deposits arriving before now may not have been reported`,
                        );
                        for (const tx of currentTxs) seen.add(txKey(tx));
                        baselined = true;
                    }
                    failures = 0;
                } catch (error) {
                    failures = Math.min(failures + 1, MAX_POLL_BACKOFF_EXPONENT);
                    console.error("Error polling watched addresses:", error);
                }

                schedule();
            };

            // A half-built `seen` would make everything predating the watch look new.
            await baseline;
            if (!isCurrentLoop()) return;

            // Straight away: this stands in for a dead socket, so the gap matters.
            await tick();
        };

        const stopPolling = () => {
            // Clearing `timer` isn't enough: a cycle suspended on its fetch has no timer yet.
            pollSession++;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            pollStarted = false;
        };

        const handleSocketFailure = (): Promise<void> => {
            if (stopped) return Promise.resolve();
            scheduleReconnect();
            return startPolling();
        };

        const scheduleReconnect = () => {
            // One pending attempt: `error` and `close` both fire for the same dead socket.
            if (stopped || reconnectTimer !== null) return;

            const delay =
                RECONNECT_BASE_DELAY_MS *
                2 ** Math.min(reconnectFailures, MAX_RECONNECT_BACKOFF_EXPONENT);
            reconnectFailures++;

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, delay);
        };

        const connect = (): Promise<void> => {
            if (stopped) return Promise.resolve();

            // Clear `ws` first so the retired socket's `close`/`error` fail `isCurrent` and can't
            // drive a second reconnect.
            const previous = ws;
            ws = null;
            if (previous) {
                try {
                    previous.close();
                } catch {
                    // already closing; nothing to release
                }
            }

            let socket: WebSocket;
            try {
                socket = new WebSocket(wsUrl);
            } catch {
                // Synchronous throw (e.g. SecurityError in a sandbox) counts as a socket failure.
                return handleSocketFailure();
            }
            ws = socket;

            const isCurrent = () => !stopped && ws === socket;

            socket.addEventListener("open", () => {
                if (!isCurrent()) return;
                reconnectFailures = 0;

                const subscribeMsg: SubscribeMessage = {
                    "track-addresses": addresses,
                };
                socket.send(JSON.stringify(subscribeMsg));

                stopPolling();
            });

            socket.addEventListener("message", (event: MessageEvent) => {
                if (!isCurrent()) return;
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
                    report(newTxs);
                } catch (error) {
                    console.error("Failed to process WebSocket message:", error);
                }
            });

            // Not `async`: the handler's own rejection would surface as an
            // unhandled one; `handleSocketFailure` absorbs its failures.
            socket.addEventListener("error", () => {
                if (isCurrent()) void handleSocketFailure();
            });

            // A clean close (server restart, idle timeout, LB cycling) fires `close`, never `error`.
            socket.addEventListener("close", () => {
                if (isCurrent()) void handleSocketFailure();
            });

            return Promise.resolve();
        };

        const teardown = () => {
            if (stopped) return;
            // Flag first: closing the socket can itself surface `error`/`close`.
            stopped = true;
            onTeardown();

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
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

        // Socket path: connect first so the subscription is live, then await the baseline.
        const started: Promise<void> = this.forcePolling
            ? startPolling()
            : connect().then(() => baseline);

        return { subscribers, teardown, started };
    }

    async getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }> {
        // Not `/blocks/tip`: outside the Esplora spec — electrs aliases it, but mempool returns [].
        let tipBlocks = await baseFetch(`${this.baseUrl}/blocks`);
        if (tipBlocks.status === 404) {
            // mempool-only instances (no electrs passthrough, e.g. the default mutinynet one)
            // serve the same newest-first array only at `/v1/blocks`.
            tipBlocks = await baseFetch(`${this.baseUrl}/v1/blocks`);
        }
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
            // `mediantime`, never `timestamp` (header `nTime`): this field is specified as MTP.
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

        // `/txs/package` proxies Core's `submitpackage`, which answers 200 even when every tx was
        // rejected, e.g. {"package_msg":"transaction failed","tx-results":{"<wtxid>":{"txid":"…",
        // "error":"bad-txns-inputs-missingorspent"}}}. Treating that as success would leave the
        // caller waiting on a confirmation that cannot come.
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
 * Throw when a 200 response describes a rejected package. Deliberately permissive: only a body
 * carrying Core's own verdict is judged, since not every Esplora deployment proxies that shape.
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
 * HTTP-poll backoff exponent cap: `pollingInterval * 2^4` (4 min at the 15s default). A
 * latency/relief trade — it bounds how late a deposit is noticed while the socket is down,
 * while still cutting a failing explorer's load 16x.
 */
const MAX_POLL_BACKOFF_EXPONENT = 4;

/**
 * First socket reconnect delay; short because the socket is far cheaper than the polling that
 * stands in for it. Doubles per failure up to {@link MAX_RECONNECT_BACKOFF_EXPONENT}.
 */
const RECONNECT_BASE_DELAY_MS = 1_000;

/** Ceiling on the reconnect backoff exponent (32s at the 1s base). */
const MAX_RECONNECT_BACKOFF_EXPONENT = 5;

interface AddressWatchSubscriber {
    callback: (txs: ExplorerTransaction[]) => void;
}

/** One transport (socket or polling fallback) serving every watcher of an address set. */
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
