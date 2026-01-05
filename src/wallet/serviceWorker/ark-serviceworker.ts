import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./service-worker-manager";

declare const self: ServiceWorkerGlobalScope;

// Generic
export type RequestEnvelope = {
    tag: string;
    id: string;
};
export type ResponseEnvelope = {
    tag: string;
    id?: string;
    error?: Error;
    broadcast?: boolean;
};
export interface IUpdater<
    REQ extends RequestEnvelope = RequestEnvelope,
    RES extends ResponseEnvelope = ResponseEnvelope,
> {
    readonly messageTag: string;

    start(): Promise<void>;

    /** Called once when the SW is shutting down */
    stop(): Promise<void>;

    /** Called periodically by the Worker */
    tick(now: number): Promise<RES[]>;

    /** Handle routed messages */
    handleMessage(message: REQ): Promise<RES | null>;
}

type WorkerOptions = {
    updaters: IUpdater[];
    tickIntervalMs?: number;
    debug?: boolean;
};

export class ArkSW {
    private updaters: Map<string, IUpdater>;
    private tickIntervalMs: number;
    private running = false;
    private tickTimeout: number | null = null;
    private debug = false;

    constructor({
        updaters,
        tickIntervalMs = 30_000,
        debug = false,
    }: WorkerOptions) {
        this.updaters = new Map(updaters.map((u) => [u.messageTag, u]));
        this.tickIntervalMs = tickIntervalMs;
        this.debug = debug;
    }

    async start() {
        console.log("Starting service worker...");
        if (this.running) return;
        this.running = true;

        // Start all updaters
        for (const updater of this.updaters.values()) {
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

        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
        }

        self.removeEventListener("message", this.onMessage);

        for (const updater of this.updaters.values()) {
            updater.stop();
        }
    }

    private scheduleNextTick() {
        if (!this.running) return;
        if (this.tickTimeout !== null) return;

        this.tickTimeout = self.setTimeout(
            () => this.runTick(),
            this.tickIntervalMs
        );
    }

    private async runTick() {
        if (!this.running) return;
        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

        const now = Date.now();

        for (const updater of this.updaters.values()) {
            try {
                const response = await updater.tick(now);
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
                    self.clients
                        .matchAll({ includeUncontrolled: true, type: "window" })
                        .then((clients) => {
                            for (const message of response) {
                                if (message.broadcast)
                                    console.log(
                                        `[${updater.messageTag}] broadcasting to ${clients.length} clients: ${message.id}`
                                    );
                                clients.forEach((client) => {
                                    // in wallet we expect data to be present in the `event.data`
                                    // it will be a breaking change
                                    let backwardCompatibleMessage = message;
                                    if ("payload" in message) {
                                        backwardCompatibleMessage = {
                                            ...message,
                                            // @ts-ignore
                                            ...message.payload,
                                        };
                                    }

                                    client.postMessage(
                                        backwardCompatibleMessage
                                    );
                                });
                            }
                        });
                }
            } catch (err) {
                console.error(`[${updater.messageTag}] tick failed`, err);
            }
        }

        this.scheduleNextTick();
    }

    private onMessage = async (event: ExtendableMessageEvent) => {
        const { id, tag } = event.data as RequestEnvelope;

        if (!id || !tag) {
            console.error(event.data);
            throw new Error(
                "Invalid message received, missing required fields"
            );
        }

        if (this.debug) {
            console.log(`[${tag}] incoming message:`, event.data);
        }

        const updater = this.updaters.get(tag);
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
            event.source?.postMessage({ id, error: String(err) });
        }
    };

    // TODO: will be moved to the SDK and use utils package, need to manage the registration state somehow
    static async getServiceWorker(path?: string) {
        return getActiveServiceWorker(path);
    }
    static async setup(path: string) {
        await setupServiceWorkerOnce(path);
        return getActiveServiceWorker(path);
    }
}
