/// <reference lib="webworker" />

import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./browser/service-worker-manager";
import { ArkProvider, RestArkProvider } from "../providers/ark";
import { RestDelegatorProvider } from "../providers/delegator";
import { ReadonlySingleKey, SingleKey } from "../identity";
import { ReadonlyWallet, Wallet } from "../wallet/wallet";
import { hex } from "@scure/base";
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
     * @param opts.arkProvider
     * @param opts.wallet Wallet with signature cababilities
     * @param opts.readonlyWallet Read-only Wallet
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
}

type Options = {
    messageHandlers: MessageHandler[];
    tickIntervalMs?: number;
    messageTimeoutMs?: number;
    debug?: boolean;
    buildServices?: (config: Initialize["config"]) => Promise<{
        arkProvider: ArkProvider;
        wallet?: Wallet;
        readonlyWallet: ReadonlyWallet;
    }>;
};

type Initialize = {
    type: "INITIALIZE_MESSAGE_BUS";
    id: string;
    config: {
        wallet:
            | {
                  privateKey: string;
              }
            | {
                  publicKey: string;
              };
        arkServer: {
            url: string;
            publicKey?: string;
        };
        delegatorUrl?: string;
        indexerUrl?: string;
        esploraUrl?: string;
        settlementConfig?: SettlementConfig | false;
        watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
    };
};

export class MessageBus {
    private handlers: Map<string, MessageHandler>;
    private tickIntervalMs: number;
    private messageTimeoutMs: number;
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

    constructor(
        private readonly walletRepository: WalletRepository,
        private readonly contractRepository: ContractRepository,
        {
            messageHandlers,
            tickIntervalMs = 10_000,
            messageTimeoutMs = 30_000,
            debug = false,
            buildServices,
        }: Options
    ) {
        this.handlers = new Map(messageHandlers.map((u) => [u.messageTag, u]));
        this.tickIntervalMs = tickIntervalMs;
        this.messageTimeoutMs = messageTimeoutMs;
        this.debug = debug;
        this.buildServicesFn = buildServices ?? this.buildServices.bind(this);
    }

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

    async stop() {
        if (this.debug) console.log("MessageBus stopping");
        this.running = false;
        this.tickInProgress = false;
        this.initialized = false;

        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

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
                    const response = await this.withTimeout(
                        updater.tick(now),
                        `${updater.messageTag}:tick`
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
        if ("privateKey" in config.wallet) {
            const identity = SingleKey.fromHex(config.wallet.privateKey);
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
        } else if ("publicKey" in config.wallet) {
            const identity = ReadonlySingleKey.fromPublicKey(
                hex.decode(config.wallet.publicKey)
            );
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
        } else {
            throw new Error(
                "Missing privateKey or publicKey in configuration object"
            );
        }
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
            event.source?.postMessage({ id, tag: "PONG" });
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
            event.source?.postMessage({ id, tag });
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
            event.source?.postMessage({
                id,
                tag: tag ?? "unknown",
                error: new MessageBusNotInitializedError(),
            });
            return;
        }

        if (!id || !tag) {
            if (this.debug)
                console.error(
                    "Invalid message received, missing required fields:",
                    event.data
                );
            event.source?.postMessage({
                id,
                tag: tag ?? "unknown",
                error: new TypeError(
                    "Invalid message received, missing required fields"
                ),
            });
            return;
        }

        if (broadcast) {
            const updaters = Array.from(this.handlers.values());
            const results = await Promise.allSettled(
                updaters.map((updater) =>
                    this.withTimeout(
                        updater.handleMessage(event.data),
                        updater.messageTag
                    )
                )
            );

            results.forEach((result, index) => {
                const updater = updaters[index];
                if (result.status === "fulfilled") {
                    const response = result.value;
                    if (response) {
                        event.source?.postMessage(response);
                    }
                } else {
                    if (this.debug)
                        console.error(
                            `[${updater.messageTag}] handleMessage failed`,
                            result.reason
                        );
                    const error =
                        result.reason instanceof Error
                            ? result.reason
                            : new Error(String(result.reason));
                    event.source?.postMessage({
                        id,
                        tag: updater.messageTag,
                        error,
                    });
                }
            });
            return;
        }

        const updater = this.handlers.get(tag);
        if (!updater) {
            if (this.debug)
                console.warn(`[${tag}] unknown message tag, ignoring message`);
            return;
        }

        try {
            const response = await this.withTimeout(
                updater.handleMessage(event.data),
                tag
            );
            if (this.debug)
                console.log(`[${tag}] outgoing response:`, response);
            if (response) {
                event.source?.postMessage(response);
            }
        } catch (err) {
            if (this.debug) console.error(`[${tag}] handleMessage failed`, err);
            const error = err instanceof Error ? err : new Error(String(err));
            event.source?.postMessage({ id, tag, error });
        }
    }

    /**
     * Race `promise` against a timeout. Note: this does NOT cancel the
     * underlying work — the original promise keeps running. This is safe
     * here because only the caller (not the handler) posts the response.
     */
    private withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
        if (this.messageTimeoutMs <= 0) return promise;
        return new Promise((resolve, reject) => {
            const timer = self.setTimeout(() => {
                reject(
                    new ServiceWorkerTimeoutError(
                        `Message handler timed out after ${this.messageTimeoutMs}ms (${label})`
                    )
                );
            }, this.messageTimeoutMs);
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
