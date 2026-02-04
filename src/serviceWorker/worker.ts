/// <reference lib="webworker" />

import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./service-worker-manager";

declare const self: ServiceWorkerGlobalScope;

// Generic
export type RequestEnvelope = {
    targetTag: string;
    id: string;
    broadcast?: boolean;
    sourceTag?: string;
};
export type ResponseEnvelope = {
    sourceTag: string;
    id?: string;
    error?: Error;
    broadcast?: boolean;
};
export interface IUpdater<
    REQ extends RequestEnvelope = RequestEnvelope,
    RES extends ResponseEnvelope = ResponseEnvelope,
> {
    /**
     * A unique identifier for the updater.
     * This is used to route messages to the correct updater.
     */
    readonly messageTag: string;

    /** Called once when the SW is starting up */
    start(): Promise<void>;

    /** Called once when the SW is shutting down */
    stop(): Promise<void>;

    /**
     * Called by the scheduler to perform a tick.
     * Can be used by the updater to perform periodic tasks or return
     * delayed responses (eg: subscriptions) or requests for other updaters.
     * @param now The current time in milliseconds since the epoch.
     **/
    tick(now: number): Promise<Array<RES | RequestEnvelope>>;

    /**
     * Handle routed messages from the clients
     **/
    handleRequest(message: REQ): Promise<RES | RequestEnvelope | null>;

    /**
     * Handle routed responses from other updaters (optional).
     **/
    handleResponse?(
        response: RES
    ): Promise<RES | RequestEnvelope | null | void>;
}

type WorkerOptions = {
    updaters: IUpdater[];
    tickIntervalMs?: number;
    debug?: boolean;
    maxRouteIterations?: number;
};

/**
 * Orchestrates Service Worker lifecycle, message routing, and periodic ticks.
 *
 * @param options.updaters - List of updater instances to register.
 * @param options.tickIntervalMs - Tick interval in milliseconds (default: 10_000).
 * @param options.debug - Enable verbose logging.
 * @param options.maxRouteIterations - Max request/response routing iterations per tick
 * (default: 3) to prevent infinite loops.
 *
 * @see src/serviceWorker/README.md for architecture and usage.
 */
export class Worker {
    private updaters: Map<string, IUpdater>;
    private tickIntervalMs: number;
    private running = false;
    private tickTimeout: number | null = null;
    private tickInProgress = false;
    private debug = false;
    private maxRouteIterations = 3;

    constructor({
        updaters,
        tickIntervalMs = 10_000,
        debug = false,
        maxRouteIterations = 3,
    }: WorkerOptions) {
        this.updaters = new Map(updaters.map((u) => [u.messageTag, u]));
        this.tickIntervalMs = tickIntervalMs;
        this.debug = debug;
        this.maxRouteIterations = maxRouteIterations;
    }

    async start() {
        console.log("Starting service worker...");
        if (this.running) return;
        this.running = true;

        // Start all updaters
        for (const updater of this.updaters.values()) {
            if (this.debug)
                console.log(`Starting updater: ${updater.messageTag}`);
            await updater.start();
        }

        // Hook message routing
        self.addEventListener("message", this.onMessage);

        // activate service worker immediately
        self.addEventListener("install", () => {
            self.skipWaiting();
        });
        // take control of clients immediately
        self.addEventListener("activate", () => {
            self.clients.claim();
            this.runTick();
        });

        // Kick off scheduler
        this.scheduleNextTick();
    }

    async stop() {
        this.running = false;
        this.tickInProgress = false;

        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

        self.removeEventListener("message", this.onMessage);

        await Promise.all(
            Array.from(this.updaters.values()).map((updater) => updater.stop())
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
            const updaters = Array.from(this.updaters.values());
            const tickResults = await Promise.allSettled(
                updaters.map((updater) => updater.tick(now))
            );

            // Collect all tick outputs (responses and cross-updater requests).
            const messages: Array<ResponseEnvelope | RequestEnvelope> = [];
            tickResults.forEach((result, index) => {
                const updater = updaters[index];
                if (result.status === "fulfilled") {
                    const response = result.value;
                    if (this.debug)
                        console.log(
                            `[${updater.messageTag}] outgoing tick response:`,
                            response
                        );
                    if (response && response.length > 0) {
                        console.log(
                            `[${updater.messageTag}] tick result`,
                            response
                        );
                        messages.push(...response);
                    }
                } else {
                    console.error(
                        `[${updater.messageTag}] tick failed`,
                        result.reason
                    );
                }
            });

            if (messages.length === 0) return;

            const clients = await self.clients.matchAll({
                includeUncontrolled: true,
                type: "window",
            });

            const isRequest = (
                message: ResponseEnvelope | RequestEnvelope
            ): message is RequestEnvelope => "targetTag" in message;

            // Partition tick outputs into client responses vs. routed requests.
            const queue: RequestEnvelope[] = [];
            for (const message of messages) {
                if (isRequest(message)) {
                    queue.push(message);
                    continue;
                }
                if (message.broadcast)
                    console.log(
                        `[${message.sourceTag}] broadcasting to ${clients.length} clients: ${message.id}`
                    );
                clients.forEach((client) => {
                    client.postMessage(message);
                });
            }

            let iterations = 0;
            while (queue.length > 0 && iterations < this.maxRouteIterations) {
                // Route requests in batches to avoid deep recursion and allow concurrency.
                const batch = queue.splice(0, queue.length);
                const routed = await Promise.all(
                    batch.map(async (request) => {
                        const target = this.updaters.get(request.targetTag);
                        if (!target) {
                            console.warn(
                                `[${request.sourceTag ?? "unknown"}] unknown targetTag '${request.targetTag}', ignoring tick request`
                            );
                            return {
                                request,
                                response: null as ResponseEnvelope | null,
                                error: null as Error | null,
                            };
                        }
                        try {
                            const response = await target.handleRequest(
                                request as RequestEnvelope
                            );
                            return { request, response, error: null };
                        } catch (err) {
                            const error =
                                err instanceof Error
                                    ? err
                                    : new Error(String(err));
                            return { request, response: null, error };
                        }
                    })
                );

                const responseCallbacks: Promise<void>[] = [];
                routed.forEach(({ request, response, error }) => {
                    if (error) {
                        if (request.sourceTag) {
                            const origin = this.updaters.get(request.sourceTag);
                            if (origin?.handleResponse) {
                                responseCallbacks.push(
                                    origin.handleResponse({
                                        id: request.id,
                                        sourceTag: request.targetTag,
                                        error,
                                    } as ResponseEnvelope)
                                );
                            }
                        }

                        if (request.broadcast) {
                            clients.forEach((client) => {
                                client.postMessage({
                                    id: request.id,
                                    sourceTag: request.targetTag,
                                    error,
                                });
                            });
                        }
                        return;
                    }

                    if (!response) return;

                    if ("targetTag" in response) {
                        queue.push(response as RequestEnvelope);
                        return;
                    }

                    if (request.sourceTag) {
                        const origin = this.updaters.get(request.sourceTag);
                        if (origin?.handleResponse) {
                            responseCallbacks.push(
                                (async () => {
                                    const followup =
                                        await origin.handleResponse(response);
                                    if (!followup) return;
                                    if ("targetTag" in followup) {
                                        queue.push(followup as RequestEnvelope);
                                        return;
                                    }
                                    if (followup.broadcast) {
                                        console.log(
                                            `[${followup.sourceTag}] broadcasting to ${clients.length} clients: ${followup.id}`
                                        );
                                        clients.forEach((client) => {
                                            client.postMessage(followup);
                                        });
                                    }
                                })()
                            );
                        } else {
                            console.warn(
                                `[${request.targetTag}] no handleResponse for origin '${request.sourceTag}', dropping routed response`
                            );
                        }
                    }

                    if (response.broadcast) {
                        console.log(
                            `[${response.sourceTag}] broadcasting to ${clients.length} clients: ${response.id}`
                        );
                        clients.forEach((client) => {
                            client.postMessage(response);
                        });
                    }
                });

                // Flush any async response callbacks before the next batch.
                if (responseCallbacks.length > 0) {
                    await Promise.allSettled(responseCallbacks);
                }

                iterations += 1;
            }

            if (queue.length > 0) {
                // Circuit breaker: drop remaining queued requests to avoid infinite loops.
                console.warn(
                    `maxRouteIterations (${this.maxRouteIterations}) reached, dropping ${queue.length} queued requests`
                );
            }
        } finally {
            this.tickInProgress = false;
            this.scheduleNextTick();
        }
    }

    private onMessage = async (event: ExtendableMessageEvent) => {
        const { id, targetTag, broadcast } = event.data as RequestEnvelope;

        if (!id || !targetTag) {
            console.error(
                "Invalid message received, missing required fields:",
                event.data
            );
            event.source?.postMessage({
                id,
                sourceTag: "service-worker",
                error: new TypeError(
                    "Invalid message received, missing required fields"
                ),
            });
            return;
        }

        if (this.debug) {
            console.log(
                `[${targetTag}] incoming ${
                    broadcast ? "broadcast " : ""
                }message:`,
                event.data
            );
        }

        if (broadcast) {
            const updaters = Array.from(this.updaters.values());
            const results = await Promise.allSettled(
                updaters.map((updater) => updater.handleRequest(event.data))
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
                    if (response && !("targetTag" in response)) {
                        event.source?.postMessage(response);
                    }
                } else {
                    console.error(
                        `[${updater.messageTag}] handleRequest failed`,
                        result.reason
                    );
                    const error =
                        result.reason instanceof Error
                            ? result.reason
                            : new Error(String(result.reason));
                    event.source?.postMessage({
                        id,
                        sourceTag: updater.messageTag,
                        error,
                    });
                }
            });
            return;
        }

        const updater = this.updaters.get(targetTag);
        if (!updater) {
            console.warn(
                `[${targetTag}] unknown targetTag '${targetTag}', ignoring message`
            );
            return;
        }

        try {
            const response = await updater.handleRequest(event.data);
            if (this.debug)
                console.log(
                    `[${updater.messageTag}] outgoing response:`,
                    response
                );
            if (!response) return;

            if ("targetTag" in response) {
                const queue = [response as RequestEnvelope];
                const clients = await self.clients.matchAll({
                    includeUncontrolled: true,
                    type: "window",
                });
                let iterations = 0;
                while (
                    queue.length > 0 &&
                    iterations < this.maxRouteIterations
                ) {
                    const batch = queue.splice(0, queue.length);
                    const routed = await Promise.all(
                        batch.map(async (request) => {
                            const target = this.updaters.get(request.targetTag);
                            if (!target) {
                                return {
                                    request,
                                    response: null as ResponseEnvelope | null,
                                    error: new Error(
                                        `Unknown targetTag '${request.targetTag}'`
                                    ),
                                };
                            }
                            try {
                                const routedResponse =
                                    await target.handleRequest(
                                        request as RequestEnvelope
                                    );
                                return {
                                    request,
                                    response: routedResponse as
                                        | ResponseEnvelope
                                        | RequestEnvelope
                                        | null,
                                    error: null,
                                };
                            } catch (err) {
                                const error =
                                    err instanceof Error
                                        ? err
                                        : new Error(String(err));
                                return { request, response: null, error };
                            }
                        })
                    );

                    const responseCallbacks: Promise<void>[] = [];
                    routed.forEach(({ request, response, error }) => {
                        if (error) {
                            if (request.sourceTag) {
                                const origin = this.updaters.get(
                                    request.sourceTag
                                );
                                if (origin?.handleResponse) {
                                    responseCallbacks.push(
                                        (async () => {
                                            const followup =
                                                await origin.handleResponse({
                                                    id: request.id,
                                                    sourceTag:
                                                        request.targetTag,
                                                    error,
                                                } as ResponseEnvelope);
                                            if (!followup) return;
                                            if ("targetTag" in followup) {
                                                queue.push(
                                                    followup as RequestEnvelope
                                                );
                                                return;
                                            }
                                            event.source?.postMessage(followup);
                                        })()
                                    );
                                }
                            }

                            if (request.broadcast) {
                                clients.forEach((client) => {
                                    client.postMessage({
                                        id: request.id,
                                        sourceTag: request.targetTag,
                                        error,
                                    });
                                });
                            }
                            return;
                        }

                        if (!response) return;

                        if ("targetTag" in response) {
                            queue.push(response as RequestEnvelope);
                            return;
                        }

                        if (request.sourceTag) {
                            const origin = this.updaters.get(request.sourceTag);
                            if (origin?.handleResponse) {
                                responseCallbacks.push(
                                    (async () => {
                                        const followup =
                                            await origin.handleResponse(
                                                response as ResponseEnvelope
                                            );
                                        if (!followup) return;
                                        if ("targetTag" in followup) {
                                            queue.push(
                                                followup as RequestEnvelope
                                            );
                                            return;
                                        }
                                        event.source?.postMessage(followup);
                                    })()
                                );
                            }
                        }

                        if (response.broadcast) {
                            clients.forEach((client) => {
                                client.postMessage(response);
                            });
                        }
                    });

                    if (responseCallbacks.length > 0) {
                        await Promise.allSettled(responseCallbacks);
                    }

                    iterations += 1;
                }

                if (queue.length > 0) {
                    console.warn(
                        `maxRouteIterations (${this.maxRouteIterations}) reached, dropping ${queue.length} queued requests`
                    );
                }
                return;
            }
            event.source?.postMessage(response);
        } catch (err) {
            console.error(`[${updater.messageTag}] handleRequest failed`, err);
            const error = err instanceof Error ? err : new Error(String(err));
            event.source?.postMessage({
                id,
                sourceTag: updater.messageTag,
                error,
            });
        }
    };

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
