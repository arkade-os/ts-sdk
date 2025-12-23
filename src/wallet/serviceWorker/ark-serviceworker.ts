import { setupServiceWorker } from "./utils";

// there can be only one SW per scope
let currentSW: ServiceWorker | null = null;

const isReady = () => {
    return navigator.serviceWorker.ready;
};

export const ArkServiceworker = {
    setup: async (path: string) => {
        currentSW = await setupServiceWorker(path);
        return currentSW;
    },
    isReady,
    getServiceWorker: (): ServiceWorker => {
        if (currentSW === null) {
            throw new Error("SW not ready yet, try again later");
        }
        return currentSW;
    },
};

declare const self: ServiceWorkerGlobalScope;

// Generic
export type RequestEnvelope = {
    prefix: string;
    id: string;
};
export type ResponseEnvelope = {
    prefix: string;
    id?: string;
    error?: Error;
    broadcast?: boolean;
};
export interface IUpdater<
    REQ extends RequestEnvelope = RequestEnvelope,
    RES extends ResponseEnvelope = ResponseEnvelope,
> {
    readonly messagePrefix: string;

    /** Called once when the SW starts */
    // TODO: paramteric start?
    // start(
    //     message: RequestEnvelope<M, MP>
    // ): Promise<ResponseEnvelope<R, RP> | null>;
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
        this.updaters = new Map(updaters.map((u) => [u.messagePrefix, u]));
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
            clearTimeout(this.tickTimeout);
        }

        self.removeEventListener("message", this.onMessage);

        for (const updater of this.updaters.values()) {
            updater.stop();
        }
    }

    private scheduleNextTick() {
        if (!this.running) return;

        this.tickTimeout = self.setTimeout(
            () => this.runTick(),
            this.tickIntervalMs
        );
    }

    private async runTick() {
        if (!this.running) return;

        const now = Date.now();

        for (const updater of this.updaters.values()) {
            try {
                const response = await updater.tick(now);
                if (this.debug)
                    console.log(
                        `[${updater.messagePrefix}] outgoing tick response:`,
                        response
                    );
                if (response && response.length > 0) {
                    console.log(
                        `[${updater.messagePrefix}] tick result`,
                        response
                    );
                    self.clients
                        .matchAll({ includeUncontrolled: true, type: "window" })
                        .then((clients) => {
                            for (const message of response) {
                                if (message.broadcast)
                                    console.log(
                                        `[${updater.messagePrefix}] broadcasting to ${clients.length} clients: ${message.id}`
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
                console.error(`[${updater.messagePrefix}] tick failed`, err);
            }
        }

        this.scheduleNextTick();
    }

    private onMessage = async (event: ExtendableMessageEvent) => {
        const { id, prefix } = event.data as RequestEnvelope;

        if (!id || !prefix) {
            console.error(event.data);
            throw new Error(
                "Invalid message received, missing required fields"
            );
        }

        if (this.debug) {
            console.log(`[${prefix}] incoming message:`, event.data);
        }

        const updater = this.updaters.get(prefix);
        if (!updater) {
            console.warn(
                `[${prefix}] unknown message prefix '${prefix}', ignoring message`
            );
            return;
        }

        try {
            const response = await updater.handleMessage(event.data);
            if (this.debug)
                console.log(`[${prefix}] outgoing response:`, response);
            if (response) {
                event.source?.postMessage(response);
            }
        } catch (err) {
            console.error(`[${prefix}] handleMessage failed`, err);
            event.source?.postMessage({ id, error: String(err) });
        }
    };

    // TODO: will be moved to the SDK and use utils package, need to manage the registration state somehow
    static getServiceWorker() {
        return ArkServiceworker.getServiceWorker();
    }
    static async setup(path: string) {
        return ArkServiceworker.setup(path);
    }
}
