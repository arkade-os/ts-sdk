/// <reference lib="webworker" />

import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./browser/service-worker-manager";
import { ArkProvider, RestArkProvider } from "../providers/ark";
import { RestDelegatorProvider } from "../providers/delegator";
import {
    type Identity,
    type ReadonlyIdentity,
    type SerializedIdentity,
    type LegacySerializedIdentity,
    hydrateIdentity,
    isSigningSerialized,
    normalizeSerializedIdentity,
} from "../identity";
import { ReadonlyWallet, Wallet } from "../wallet/wallet";
import type { SettlementConfig } from "../wallet/vtxo-manager";
import type { ContractWatcherConfig } from "../contracts/contractWatcher";
import { ContractRepository, WalletRepository } from "../repositories";
import { getRandomId } from "../wallet/utils";
import {
    MessageBusNotInitializedError,
    ServiceWorkerTimeoutError,
} from "./errors";

declare const self: ServiceWorkerGlobalScope;

// Generic
export type RequestEnvelope = {
    tag: string;
    id: string;
    broadcast?: boolean;
};
export type ResponseEnvelope = {
    tag: string;
    id?: string;
    error?: Error;
    broadcast?: boolean;
};
export interface MessageHandler<
    REQ extends RequestEnvelope = RequestEnvelope,
    RES extends ResponseEnvelope = ResponseEnvelope,
> {
    /**
     * A unique identifier for the updater.
     * This is used to route messages to the correct updater.
     */
    readonly messageTag: string;

    /**
     * Called once when the SW is starting up
     * @param services - Providers and wallet instances available to the handler.
     * @param repositories - Repositories available to the handler.
     **/
    start(
        services: {
            arkProvider: ArkProvider;
            wallet?: Wallet;
            readonlyWallet: ReadonlyWallet;
        },
        repositories: {
            walletRepository: WalletRepository;
        }
    ): Promise<void>;

    /** Called once when the SW is shutting down */
    stop(): Promise<void>;

    /**
     * Called by the scheduler to perform a tick.
     * Can be used by the updater to perform periodic tasks or return
     * delayed responses (eg: subscriptions).
     * @param now The current time in milliseconds since the epoch.
     **/
    tick(now: number): Promise<RES[]>;

    /**
     * Handle routed messages from the clients
     **/
    handleMessage(message: REQ): Promise<RES | null>;

    /**
     * Optional opt-out from the bus-level message timeout.
     *
     * Long-running flows (e.g. settlement) surrender control to remote peers
     * and can legitimately sit idle for longer than `messageTimeoutMs`. When
     * this returns true, the bus awaits `handleMessage` without a deadline.
     * Defaults to false.
     */
    isLongRunning?(message: REQ): boolean;
}

type Options = {
    messageHandlers: MessageHandler[];
    tickIntervalMs?: number;
    messageTimeoutMs?: number;
    /**
     * Per-operation timeout overrides. Keys are either message types
     * (e.g. "SETTLE") or handler tags (e.g. "WALLET_UPDATER"). Message-type
     * matches take precedence over tag matches. Unspecified operations use
     * `messageTimeoutMs`. These are treated as defaults: any map supplied
     * via `INITIALIZE_MESSAGE_BUS` overrides per-key and is re-applied on
     * every (re-)init.
     */
    messageTimeoutOverrides?: Record<string, number>;
    debug?: boolean;
    buildServices?: (config: Initialize["config"]) => Promise<{
        arkProvider: ArkProvider;
        wallet?: Wallet;
        readonlyWallet: ReadonlyWallet;
    }>;
};

/**
 * Grace period after a handler times out during which late handler
 * completion is still delivered to the client. Once this expires,
 * the bus sends an "Operation abandoned" error so the message id
 * never goes silent indefinitely.
 */
const LATE_DELIVERY_GRACE_MS = 5 * 60_000;

/**
 * Tracks one in-flight late-delivery watcher (a handler that has already
 * timed out but is still running). The `settled` flag guards against
 * double-delivery when the grace-period deadline and the handler's own
 * completion race; `stop()` iterates every live record, flips `settled`,
 * and clears the deadline so no response is posted after shutdown.
 */
type LateDelivery = {
    settled: boolean;
    deadline: number;
};

type Initialize = {
    type: "INITIALIZE_MESSAGE_BUS";
    id: string;
    config: {
        wallet: SerializedIdentity | LegacySerializedIdentity;
        arkServer: {
            url: string;
            publicKey?: string;
        };
        delegatorUrl?: string;
        indexerUrl?: string;
        esploraUrl?: string;
        settlementConfig?: SettlementConfig | false;
        watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
        /**
         * Page-supplied per-operation timeout map. Keys are message types
         * (e.g. "SETTLE"). Overrides constructor-supplied
         * `messageTimeoutOverrides` per-key; re-applied on every init.
         */
        messageTimeouts?: Record<string, number>;
    };
};

export class MessageBus {
    private handlers: Map<string, MessageHandler>;
    private tickIntervalMs: number;
    private messageTimeoutMs: number;
    private readonly constructorTimeoutOverrides: Record<string, number>;
    private messageTimeoutOverrides: Record<string, number>;
    private lateDeliveries = new Set<LateDelivery>();
    private running = false;
    private tickTimeout: number | null = null;
    private tickInProgress = false;
    private debug = false;
    private initialized = false;
    private readonly buildServicesFn: (
        config: Initialize["config"]
    ) => Promise<{
        arkProvider: ArkProvider;
        wallet?: Wallet;
        readonlyWallet: ReadonlyWallet;
    }>;
    private readonly boundOnMessage = this.onMessage.bind(this);

    /** Create the service-worker message bus with repositories and handler configuration. */
    constructor(
        private readonly walletRepository: WalletRepository,
        private readonly contractRepository: ContractRepository,
        {
            messageHandlers,
            tickIntervalMs = 10_000,
            messageTimeoutMs = 30_000,
            messageTimeoutOverrides = {},
            debug = false,
            buildServices,
        }: Options
    ) {
        this.handlers = new Map(messageHandlers.map((u) => [u.messageTag, u]));
        this.tickIntervalMs = tickIntervalMs;
        this.messageTimeoutMs = messageTimeoutMs;
        this.constructorTimeoutOverrides = { ...messageTimeoutOverrides };
        this.messageTimeoutOverrides = { ...this.constructorTimeoutOverrides };
        this.debug = debug;
        this.buildServicesFn = buildServices ?? this.buildServices.bind(this);
    }

    /** Start the message bus and attach service-worker event listeners. */
    async start() {
        if (this.running) return;
        this.running = true;
        if (this.debug) console.log("MessageBus starting");

        // Hook message routing
        self.addEventListener("message", this.boundOnMessage);

        // activate service worker immediately
        self.addEventListener("install", () => {
            self.skipWaiting();
        });
        // take control of clients immediately
        self.addEventListener("activate", () => {
            self.clients.claim();
            if (this.initialized) {
                this.runTick();
            }
        });
    }

    /** Stop the message bus, cancel ticks, and stop all registered handlers. */
    async stop() {
        if (this.debug) console.log("MessageBus stopping");
        this.running = false;
        this.tickInProgress = false;
        this.initialized = false;

        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

        for (const record of this.lateDeliveries) {
            record.settled = true;
            self.clearTimeout(record.deadline);
        }
        this.lateDeliveries.clear();

        self.removeEventListener("message", this.boundOnMessage);

        await Promise.all(
            Array.from(this.handlers.values()).map((updater) => updater.stop())
        );
    }

    private scheduleNextTick() {
        if (!this.running) return;
        if (this.tickTimeout !== null) return;
        if (this.tickInProgress) return;

        this.tickTimeout = self.setTimeout(
            () => this.runTick(),
            this.tickIntervalMs
        );
    }

    private async runTick() {
        if (!this.running) return;
        if (this.tickInProgress) return;
        this.tickInProgress = true;
        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

        try {
            const now = Date.now();

            for (const updater of this.handlers.values()) {
                try {
                    const tickLabel = `${updater.messageTag}:tick`;
                    const response = await this.withTimeout(
                        updater.tick(now),
                        this.resolveTimeoutMs(tickLabel, updater.messageTag),
                        tickLabel
                    );
                    if (this.debug)
                        console.log(
                            `[${updater.messageTag}] outgoing tick response:`,
                            response
                        );
                    if (response && response.length > 0) {
                        self.clients
                            .matchAll({
                                includeUncontrolled: true,
                                type: "window",
                            })
                            .then((clients) => {
                                for (const message of response) {
                                    clients.forEach((client) => {
                                        client.postMessage(message);
                                    });
                                }
                            });
                    }
                } catch (err) {
                    if (this.debug)
                        console.error(
                            `[${updater.messageTag}] tick failed`,
                            err
                        );
                }
            }
        } finally {
            this.tickInProgress = false;
            this.scheduleNextTick();
        }
    }

    private async waitForInit(config: Initialize["config"]) {
        if (this.initialized) {
            // Stop existing handlers before re-initializing.
            // This handles the case where CLEAR was called, which nullifies
            // handler state (readonlyWallet, etc.) without resetting the
            // initialized flag. Without this, handlers never get start()
            // called again and all messages fail with "not initialized".
            //
            // Clear the flag first so onMessage() rejects incoming messages
            // during the stop/start window instead of routing them to
            // half-reset handlers. Restored to true after start() completes.
            this.initialized = false;
            await Promise.all(
                Array.from(this.handlers.values()).map((h) =>
                    h.stop().catch(() => {})
                )
            );
        }
        // Recompute the active timeout map from scratch so a prior init's
        // keys cannot linger after re-init with a smaller map.
        this.messageTimeoutOverrides = {
            ...this.constructorTimeoutOverrides,
            ...(config.messageTimeouts ?? {}),
        };

        const services = await this.buildServicesFn(config);
        // Start all handlers
        for (const updater of this.handlers.values()) {
            if (this.debug)
                console.log(`Starting updater: ${updater.messageTag}`);
            await updater.start(services, {
                walletRepository: this.walletRepository,
            });
        }

        // Kick off scheduler
        this.scheduleNextTick();
        this.initialized = true;
    }

    private async buildServices(config: Initialize["config"]): Promise<{
        arkProvider: ArkProvider;
        wallet?: Wallet;
        readonlyWallet: ReadonlyWallet;
    }> {
        const arkProvider = new RestArkProvider(config.arkServer.url);
        const storage = {
            walletRepository: this.walletRepository,
            contractRepository: this.contractRepository,
        };
        const delegatorProvider = config.delegatorUrl
            ? new RestDelegatorProvider(config.delegatorUrl)
            : undefined;

        const serialized = normalizeSerializedIdentity(config.wallet);

        if (isSigningSerialized(serialized)) {
            const identity = hydrateIdentity(serialized) as Identity;
            const wallet = await Wallet.create({
                identity,
                arkServerUrl: config.arkServer.url,
                arkServerPublicKey: config.arkServer.publicKey,
                indexerUrl: config.indexerUrl,
                esploraUrl: config.esploraUrl,
                storage,
                delegatorProvider,
                settlementConfig: config.settlementConfig,
                watcherConfig: config.watcherConfig,
            });
            return { wallet, arkProvider, readonlyWallet: wallet };
        }

        const identity = hydrateIdentity(serialized) as ReadonlyIdentity;
        const readonlyWallet = await ReadonlyWallet.create({
            identity,
            arkServerUrl: config.arkServer.url,
            arkServerPublicKey: config.arkServer.publicKey,
            indexerUrl: config.indexerUrl,
            esploraUrl: config.esploraUrl,
            storage,
            delegatorProvider,
            watcherConfig: config.watcherConfig,
        });
        return { readonlyWallet, arkProvider };
    }

    private onMessage(event: ExtendableMessageEvent) {
        // Keep the service worker alive while async work is pending.
        // Without this, the browser may terminate the SW mid-operation,
        // causing all pending responses to be lost silently.
        const promise = this.processMessage(event);
        if (typeof event.waitUntil === "function") {
            event.waitUntil(promise);
        }
        return promise;
    }

    private async processMessage(event: ExtendableMessageEvent) {
        const { id, tag, broadcast } = event.data as RequestEnvelope;

        if (tag === "PING") {
            this.deliverResponse(
                event.source,
                { id, tag: "PONG" },
                { id, tag: "PONG" }
            );
            return;
        }

        if (tag === "INITIALIZE_MESSAGE_BUS") {
            if (this.debug) {
                console.log("Init Command received");
            }
            // Intentionally not wrapped with withTimeout: initialization
            // performs network calls (buildServices) and handler startup
            // that may legitimately exceed the message timeout.
            await this.waitForInit(event.data.config);
            this.deliverResponse(event.source, { id, tag }, { id, tag });
            if (this.debug) {
                console.log("MessageBus initialized");
            }
            return;
        }

        if (!this.initialized) {
            if (this.debug)
                console.warn(
                    "Event received before initialization, dropping",
                    event.data
                );
            // Send error response so the caller's promise rejects instead of
            // hanging forever. This happens when the browser kills and restarts
            // the service worker — the new instance has initialized=false and
            // messages arrive before INITIALIZE_MESSAGE_BUS is re-sent.
            const fallbackTag = tag ?? "unknown";
            this.deliverResponse(
                event.source,
                {
                    id,
                    tag: fallbackTag,
                    error: new MessageBusNotInitializedError(),
                },
                { id, tag: fallbackTag }
            );
            return;
        }

        if (!id || !tag) {
            if (this.debug)
                console.error(
                    "Invalid message received, missing required fields:",
                    event.data
                );
            const fallbackTag = tag ?? "unknown";
            this.deliverResponse(
                event.source,
                {
                    id,
                    tag: fallbackTag,
                    error: new TypeError(
                        "Invalid message received, missing required fields"
                    ),
                },
                { id, tag: fallbackTag }
            );
            return;
        }

        const messageType = this.extractMessageType(event.data);

        if (broadcast) {
            const updaters = Array.from(this.handlers.values());
            const entries = updaters.map((updater) => {
                const label = this.labelFor(messageType, updater.messageTag);
                const timeoutMs = this.resolveTimeoutMs(
                    messageType,
                    updater.messageTag
                );
                const handlerPromise = updater.handleMessage(event.data);
                const raced = updater.isLongRunning?.(event.data)
                    ? handlerPromise
                    : this.withTimeout(handlerPromise, timeoutMs, label);
                return { updater, handlerPromise, raced };
            });

            const results = await Promise.allSettled(
                entries.map((e) => e.raced)
            );

            results.forEach((result, index) => {
                const { updater, handlerPromise } = entries[index];
                const handlerTag = updater.messageTag;
                const context = { id, tag: handlerTag, messageType };
                if (result.status === "fulfilled") {
                    const response = result.value;
                    // Always deliver a response so the caller's message id
                    // never goes silent. Handlers returning null/undefined
                    // get an explicit ack envelope.
                    this.deliverResponse(
                        event.source,
                        response ?? { id, tag: handlerTag },
                        context
                    );
                } else {
                    if (this.debug)
                        console.error(
                            `[${handlerTag}] handleMessage failed`,
                            result.reason
                        );
                    const error = toError(result.reason);
                    this.deliverResponse(
                        event.source,
                        { id, tag: handlerTag, error },
                        context
                    );
                    // If the error was a timeout, keep watching the
                    // underlying handler and surface its eventual result
                    // under the same id.
                    if (result.reason instanceof ServiceWorkerTimeoutError) {
                        this.attachLateDelivery(
                            handlerPromise,
                            event.source,
                            id,
                            handlerTag,
                            messageType
                        );
                    }
                }
            });
            return;
        }

        const updater = this.handlers.get(tag);
        if (!updater) {
            if (this.debug)
                console.warn(`[${tag}] unknown message tag, ignoring message`);
            this.deliverResponse(
                event.source,
                {
                    id,
                    tag,
                    error: new Error(`Unknown handler tag: ${tag}`),
                },
                { id, tag, messageType }
            );
            return;
        }

        const label = this.labelFor(messageType, tag);
        const timeoutMs = this.resolveTimeoutMs(messageType, tag);
        const handlerPromise = updater.handleMessage(event.data);
        const context = { id, tag, messageType };
        try {
            const response = updater.isLongRunning?.(event.data)
                ? await handlerPromise
                : await this.withTimeout(handlerPromise, timeoutMs, label);
            if (this.debug)
                console.log(`[${tag}] outgoing response:`, response);
            // Always deliver a response so the caller's message id never
            // goes silent. A handler returning null/undefined yields an
            // explicit ack envelope.
            this.deliverResponse(
                event.source,
                response ?? { id, tag },
                context
            );
        } catch (err) {
            if (this.debug) console.error(`[${tag}] handleMessage failed`, err);
            const error = toError(err);
            this.deliverResponse(event.source, { id, tag, error }, context);
            // When we abandoned the handler via timeout, keep watching it
            // so the client's message id eventually gets a final response.
            if (err instanceof ServiceWorkerTimeoutError) {
                this.attachLateDelivery(
                    handlerPromise,
                    event.source,
                    id,
                    tag,
                    messageType
                );
            }
        }
    }

    /**
     * Race `promise` against a timeout. Note: this does NOT cancel the
     * underlying work — the original promise keeps running. Call
     * `attachLateDelivery` after catching the timeout to surface the
     * eventual result so the message id does not go silent.
     */
    private withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        label: string
    ): Promise<T> {
        if (timeoutMs <= 0) return promise;
        return new Promise((resolve, reject) => {
            const timer = self.setTimeout(() => {
                reject(
                    new ServiceWorkerTimeoutError(
                        `Message handler timed out after ${timeoutMs}ms (${label})`
                    )
                );
            }, timeoutMs);
            promise.then(
                (val) => {
                    self.clearTimeout(timer);
                    resolve(val);
                },
                (err) => {
                    self.clearTimeout(timer);
                    reject(err);
                }
            );
        });
    }

    /**
     * Extract the declared `type` from a request envelope (e.g. "SETTLE").
     * Not every envelope carries a type (PING/INIT are special cased
     * earlier), so this returns undefined for envelopes that lack one.
     */
    private extractMessageType(data: RequestEnvelope): string | undefined {
        const maybeType = (data as RequestEnvelope & { type?: unknown }).type;
        return typeof maybeType === "string" ? maybeType : undefined;
    }

    /**
     * Resolve the timeout for an operation. Message-type overrides take
     * precedence over handler-tag overrides, with the bus-wide default
     * (`messageTimeoutMs`) as the final fallback.
     */
    private resolveTimeoutMs(
        messageType: string | undefined,
        handlerTag: string
    ): number {
        if (
            messageType &&
            Object.prototype.hasOwnProperty.call(
                this.messageTimeoutOverrides,
                messageType
            )
        ) {
            return this.messageTimeoutOverrides[messageType];
        }
        if (
            Object.prototype.hasOwnProperty.call(
                this.messageTimeoutOverrides,
                handlerTag
            )
        ) {
            return this.messageTimeoutOverrides[handlerTag];
        }
        return this.messageTimeoutMs;
    }

    /**
     * Build a human-readable label for timeout errors. Format:
     * `"<MESSAGE_TYPE> via <HANDLER_TAG>"` when both are known, else the
     * handler tag alone. Used so timeout errors name the operation the
     * client actually triggered (e.g. SETTLE) rather than just the
     * handler that received it (e.g. WALLET_UPDATER).
     */
    private labelFor(
        messageType: string | undefined,
        handlerTag: string
    ): string {
        return messageType ? `${messageType} via ${handlerTag}` : handlerTag;
    }

    /**
     * Post a response to the originating client. When `source` is null
     * (client tab closed, detached frame, etc.) the response cannot be
     * delivered; we log the drop in debug mode so it is not invisible.
     */
    private deliverResponse(
        source: ExtendableMessageEvent["source"],
        response: ResponseEnvelope,
        context: { id?: string; tag: string; messageType?: string }
    ): void {
        if (!source) {
            if (this.debug)
                console.warn(
                    `[${context.tag}] cannot deliver response: event.source is null`,
                    {
                        id: context.id,
                        messageType: context.messageType,
                    }
                );
            return;
        }
        source.postMessage(response);
    }

    /**
     * After a handler times out the client has already received a timeout
     * error, but the handler keeps running. Attach a follow-up so the
     * handler's eventual result (or error) is delivered under the same
     * message id, or — if the handler never completes within
     * {@link LATE_DELIVERY_GRACE_MS} — an "Operation abandoned" error is
     * sent so the client's listener (if still attached) does not hang.
     */
    private attachLateDelivery(
        handlerPromise: Promise<ResponseEnvelope | null>,
        source: ExtendableMessageEvent["source"],
        id: string,
        tag: string,
        messageType: string | undefined
    ): void {
        const context = { id, tag, messageType };
        const record: LateDelivery = {
            settled: false,
            deadline: self.setTimeout(() => {
                if (record.settled) return;
                record.settled = true;
                this.lateDeliveries.delete(record);
                this.deliverResponse(
                    source,
                    {
                        id,
                        tag,
                        error: new Error(
                            `Operation abandoned: handler did not complete within ${LATE_DELIVERY_GRACE_MS}ms after timeout (${this.labelFor(messageType, tag)})`
                        ),
                    },
                    context
                );
            }, LATE_DELIVERY_GRACE_MS),
        };
        this.lateDeliveries.add(record);

        handlerPromise.then(
            (response) => {
                if (record.settled) return;
                record.settled = true;
                self.clearTimeout(record.deadline);
                this.lateDeliveries.delete(record);
                this.deliverResponse(source, response ?? { id, tag }, context);
            },
            (err) => {
                if (record.settled) return;
                record.settled = true;
                self.clearTimeout(record.deadline);
                this.lateDeliveries.delete(record);
                this.deliverResponse(
                    source,
                    { id, tag, error: toError(err) },
                    context
                );
            }
        );
    }

    /**
     * Returns the registered SW for the path.
     * It uses the functions in `service-worker-manager.ts` module.
     * @param path
     * @return the Service Worker
     * @throws if not running in a browser environment
     */
    static async getServiceWorker(path?: string) {
        return getActiveServiceWorker(path);
    }

    /**
     * Set up and register the Service Worker, ensuring it's done once at most.
     * It uses the functions in `service-worker-manager.ts` module.
     * @param path
     * @return the Service Worker
     * @throws if not running in a browser environment
     */
    static async setup(path: string) {
        await setupServiceWorkerOnce(path);
        return getActiveServiceWorker(path);
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
