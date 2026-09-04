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
        /** Set by Esplora; the electrum provider omits it. */
        block_height?: number;
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

    /**
     * Watch a set of addresses over the explorer's WebSocket, degrading to HTTP
     * polling whenever the socket is unavailable and returning to the socket as
     * soon as it can be re-established.
     *
     * Concurrent calls covering the same address set share one transport. The
     * returned function releases **this** subscription only; the transport is
     * torn down when the last subscriber releases it. Calling it more than once
     * is a no-op.
     *
     * @param addresses - Addresses to monitor; order is not significant
     * @param callback - Invoked with transactions seen after the watch started
     * @returns A function releasing this subscription
     * @remarks
     * The HTTP fallback fetches full address history per address per cycle,
     * which is dramatically more expensive than the socket — so callers should
     * release watches they no longer need rather than relying on sharing.
     * @see {@link waitForIncomingFunds} for the cancellation-aware wallet-level helper
     */
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
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectFailures = 0;
        // Bumped whenever a poll loop is retired, so a cycle suspended across
        // its fetch can tell that the loop it belongs to is no longer wanted.
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
         * Everything already reported (or predating the watch), shared by both
         * transports and held for the watch's whole life — not rebuilt per poll
         * session. That is what lets a deposit which landed while the socket was
         * down still be reported: it is absent from this set, so the first poll
         * pass after the failure sees it as new.
         *
         * Grows with the watched addresses' transaction count and is never
         * compacted. Bounded in practice by how many transactions touch one
         * address set, but a watch left open on a high-volume address will
         * accumulate: retaining only recent blocks would cap it, deferred until
         * something actually needs it.
         */
        const seen = new Set<string>();
        let baselined = false;

        /** Chain height at watch start, used if the history baseline fails. */
        let anchorHeight: number | undefined;

        /**
         * Establish what predates the watch, so the first poll pass has
         * something to compare against other than "everything is new".
         *
         * Seeded additively rather than by replacing the set: the socket may
         * report a transaction while this fetch is still in flight, and that
         * report must not be undone (nor duplicated) when the fetch lands.
         *
         * The tip is fetched alongside the history so an anchor — if needed —
         * is the height at watch start, not at the moment the history fetch
         * later gives up. A deposit confirmed while that fetch is still
         * failing must still read as new.
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
         * Deliver only what hasn't been reported yet, from either transport.
         *
         * Marks each key as it goes rather than filtering and then marking: a
         * batch can contain the same transaction twice — history is fetched per
         * address and flattened, and a socket message lists a transaction under
         * every address it pays — so one payment to two watched addresses would
         * otherwise be delivered twice and counted twice downstream. Boarding
         * makes that ordinary rather than exotic: the watch covers the current
         * and historical rotated addresses together.
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
            // `pollStarted` makes this idempotent: a WebSocket can emit `error`
            // more than once, and each call used to install another interval
            // over the top of the previous handle, orphaning it.
            if (stopped || pollStarted) return;
            pollStarted = true;

            // Worth surfacing: address history (`/address/{a}/txs`) is far more
            // expensive than the socket it replaces, and a silent fallback is
            // what turns an explorer blip into sustained polling traffic.
            console.warn(
                `Esplora websocket unavailable (${wsUrl}); falling back to HTTP polling every ${this.pollingInterval}ms for ${addresses.length} address(es) while retrying the socket`,
            );

            let failures = 0;

            // This loop's identity. `stopped` alone is not enough: the watch can
            // stay alive while *this* loop is retired, which is what happens when
            // the socket comes back.
            const session = pollSession;
            const isCurrentLoop = () => !stopped && session === pollSession;

            const schedule = () => {
                if (!isCurrentLoop()) return;
                // Self-rescheduling rather than setInterval: a fixed interval
                // stacks overlapping full-history fetches when the explorer is
                // slower than pollingInterval, and offers nowhere to back off
                // when it starts failing or rate-limiting.
                timer = setTimeout(tick, this.pollingInterval * 2 ** failures);
            };

            const tick = async () => {
                try {
                    const currentTxs = await getAllTxs();

                    // teardown may have run while that fetch was in flight, or
                    // the socket may have come back and retired this loop.
                    // Returning before `schedule()` is what keeps both honest:
                    // otherwise a timer is installed after the loop was retired,
                    // and the explorer keeps getting hit — either with no handle
                    // left to clear it, or alongside a perfectly healthy socket.
                    if (!isCurrentLoop()) return;

                    if (baselined) {
                        report(currentTxs);
                    } else if (anchorHeight !== undefined) {
                        // Anything confirmed above the anchor arrived after we
                        // started. Unconfirmed counts as new too: a duplicate
                        // notification is cheaper than a missed deposit.
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
                        // No reference at all: anything arriving before now is
                        // indistinguishable from history, so adopt rather than
                        // announce one. Warn — a silent miss is unexplainable later.
                        console.warn(
                            `Esplora address watch established its baseline late for ${addresses.length} address(es); deposits arriving before now may not have been reported`,
                        );
                        for (const tx of currentTxs) seen.add(txKey(tx));
                        baselined = true;
                    }
                    failures = 0;
                } catch (error) {
                    // A transient explorer failure backs off and retries rather
                    // than leaving a watch that is registered but blind.
                    failures = Math.min(failures + 1, MAX_POLL_BACKOFF_EXPONENT);
                    console.error("Error polling watched addresses:", error);
                }

                schedule();
            };

            // Don't compare against a half-built `seen`: if the creation-time
            // baseline is still in flight, everything predating the watch would
            // look new.
            await baseline;
            if (!isCurrentLoop()) return;

            // Poll straight away rather than waiting a full interval — this is
            // standing in for a dead socket, so the gap matters.
            await tick();
        };

        // Retire the HTTP safety net once the socket carries events again, and
        // allow a later failure to bring it back.
        const stopPolling = () => {
            // Retire the current loop first. Clearing `timer` is not enough: a
            // cycle suspended on its fetch has no timer yet, and would re-arm
            // itself the moment that fetch resolved.
            pollSession++;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            pollStarted = false;
        };

        /**
         * React to a dead socket: cover the gap with HTTP polling straight
         * away, then try to win the cheap transport back.
         */
        const handleSocketFailure = (): Promise<void> => {
            if (stopped) return Promise.resolve();
            scheduleReconnect();
            return startPolling();
        };

        const scheduleReconnect = () => {
            // One pending attempt at a time: `error` and `close` both fire for
            // the same dead socket, and each used to be a separate trigger.
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

            // Drop the outgoing socket before wiring the new one. Clearing `ws`
            // first means the retired socket's own `close`/`error` events fail
            // the `isCurrent` check below, so its teardown can't drive a second
            // reconnect on top of the live one.
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
                // A synchronous throw (e.g. SecurityError in a sandboxed
                // context) counts as a socket failure: fall back to polling and
                // schedule a retry. That retry increments `reconnectFailures`,
                // which a later successful `open` resets — so a transient throw
                // can't leave the backoff permanently inflated.
                return handleSocketFailure();
            }
            ws = socket;

            // Guards every listener: only the socket this provider currently
            // considers live may act on its events.
            const isCurrent = () => !stopped && ws === socket;

            socket.addEventListener("open", () => {
                if (!isCurrent()) return;
                reconnectFailures = 0;

                const subscribeMsg: SubscribeMessage = {
                    "track-addresses": addresses,
                };
                socket.send(JSON.stringify(subscribeMsg));

                // Events are flowing over the socket again; retire the
                // expensive full-history loop that was standing in for it.
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

            // A clean close fires `close` and never `error` — a server restart,
            // an idle timeout, a load balancer cycling the connection. Handling
            // only `error` left the watch silently dead: no fallback, no retry,
            // and no log to say so.
            socket.addEventListener("close", () => {
                if (isCurrent()) void handleSocketFailure();
            });

            return Promise.resolve();
        };

        const teardown = () => {
            if (stopped) return;
            // Flag first: closing the socket can itself surface `error`/`close`,
            // and neither may revive the fallback we are retiring here.
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

        // `startPolling` already waits for the baseline; on the socket path,
        // connect first (so the subscription is in place immediately) and then
        // let callers await the baseline, so the watch is armed on return.
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
 * rate-limiting explorer is retried at `pollingInterval * 2^4` (4 minutes at
 * the 15s default) rather than escalating without bound.
 *
 * The cap is a latency/relief trade, not just a relief knob: this is a payments
 * SDK, and the backoff bounds how late an incoming deposit can be noticed while
 * the socket is down. 2^4 still cuts a failing explorer's load by 16x, which is
 * ample once watchers are shared per address set, without pushing worst-case
 * notification delay into the tens of minutes.
 */
const MAX_POLL_BACKOFF_EXPONENT = 4;

/**
 * First delay before retrying a failed address-watch WebSocket. Short on
 * purpose: the socket is far cheaper than the HTTP polling that stands in for
 * it, so it is worth reaching for again quickly. Doubles per consecutive
 * failure, capped by {@link MAX_RECONNECT_BACKOFF_EXPONENT}.
 */
const RECONNECT_BASE_DELAY_MS = 1_000;

/** Ceiling on the reconnect backoff exponent (32s at the 1s base). */
const MAX_RECONNECT_BACKOFF_EXPONENT = 5;

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
