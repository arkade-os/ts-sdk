/// <reference lib="webworker" />

import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./browser/service-worker-manager";
import { ArkProvider, RestArkProvider } from "../providers/ark";
import { ReadonlySingleKey, SingleKey } from "../identity";
import { ReadonlyWallet, Wallet } from "../wallet/wallet";
import { hex } from "@scure/base";
import { ContractRepository, WalletRepository } from "../repositories";
import { getRandomId } from "../wallet/utils";

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
    };
};

export class MessageBus {
    private handlers: Map<string, MessageHandler>;
    private tickIntervalMs: number;
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

    constructor(
        private readonly walletRepository: WalletRepository,
        private readonly contractRepository: ContractRepository,
        {
            messageHandlers,
            tickIntervalMs = 10_000,
            debug = false,
            buildServices,
        }: Options
    ) {
        this.handlers = new Map(messageHandlers.map((u) => [u.messageTag, u]));
        this.tickIntervalMs = tickIntervalMs;
        this.debug = debug;
        this.buildServicesFn = buildServices ?? this.buildServices.bind(this);
    }

    async start() {
        console.log("Starting service worker...");
        if (this.running) return;
        this.running = true;

        // Hook message routing
        self.addEventListener("message", this.onMessage.bind(this));

        // activate service worker immediately
        self.addEventListener("install", () => {
            self.skipWaiting();
        });
        // take control of clients immediately
        self.addEventListener("activate", () => {
            console.log(`event: activate ${this.initialized}`);
            self.clients.claim();
            if (this.initialized) {
                this.runTick();
            }
        });
    }

    async stop() {
        this.running = false;
        this.tickInProgress = false;
        this.initialized = false;

        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

        self.removeEventListener("message", this.onMessage.bind(this));

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
                    const response = await updater.tick(now);
                    // if (this.debug)
                    //     console.log(
                    //         `[${updater.messageTag}] outgoing tick response:`,
                    //         response
                    //     );
                    if (response && response.length > 0) {
                        console.log(
                            `[${updater.messageTag}] tick result`,
                            response
                        );
                        self.clients
                            .matchAll({
                                includeUncontrolled: true,
                                type: "window",
                            })
                            .then((clients) => {
                                for (const message of response) {
                                    if (message.broadcast)
                                        console.log(
                                            `[${updater.messageTag}] broadcasting to ${clients.length} clients: ${message.id}`
                                        );
                                    clients.forEach((client) => {
                                        client.postMessage(message);
                                    });
                                }
                            });
                    }
                } catch (err) {
                    console.error(`[${updater.messageTag}] tick failed`, err);
                }
            }
        } finally {
            this.tickInProgress = false;
            this.scheduleNextTick();
        }
    }

    private async waitForInit(config: Initialize["config"]) {
        if (this.initialized) return;
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
        if ("privateKey" in config.wallet) {
            const identity = SingleKey.fromHex(config.wallet.privateKey);
            const wallet = await Wallet.create({
                identity,
                arkServerUrl: config.arkServer.url,
                arkServerPublicKey: config.arkServer.publicKey,
                storage,
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
                storage,
            });
            return { readonlyWallet, arkProvider };
        } else {
            throw new Error(
                "Missing privateKey or publicKey in configuration object"
            );
        }
    }

    private async onMessage(event: ExtendableMessageEvent) {
        const { id, tag, broadcast } = event.data as RequestEnvelope;
        console.log(`-- ${tag} incoming, is initialized? ${this.initialized} `);

        if (tag === "INITIALIZE_MESSAGE_BUS") {
            if (this.debug) {
                console.log("Init Command received");
            }
            await this.waitForInit(event.data.config);
            event.source?.postMessage({ id, tag });
            if (this.debug) {
                console.log("MessageBus initialized");
            }
            return;
        }

        if (!this.initialized) {
            console.warn(
                "Event received before initialization, dropping ",
                event.data
            );
        }

        if (!id || !tag) {
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

        if (this.debug) {
            console.log(
                `[${tag}] incoming ${broadcast ? "broadcast " : ""}message:`,
                event.data
            );
        }

        if (broadcast) {
            const updaters = Array.from(this.handlers.values());
            const results = await Promise.allSettled(
                updaters.map((updater) => updater.handleMessage(event.data))
            );

            results.forEach((result, index) => {
                const updater = updaters[index];
                if (result.status === "fulfilled") {
                    const response = result.value;
                    if (this.debug)
                        console.log(
                            `[${updater.messageTag}] outgoing response:`,
                            response
                        );
                    if (response) {
                        event.source?.postMessage(response);
                    }
                } else {
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
            console.warn(
                `[${tag}] unknown message tag '${tag}', ignoring message`
            );
            return;
        }

        try {
            const response = await updater.handleMessage(event.data);
            if (this.debug)
                console.log(`[${tag}] outgoing response:`, response);
            if (response) {
                event.source?.postMessage(response);
            }
        } catch (err) {
            console.error(`[${tag}] handleMessage failed`, err);
            const error = err instanceof Error ? err : new Error(String(err));
            event.source?.postMessage({ id, tag, error });
        }
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
