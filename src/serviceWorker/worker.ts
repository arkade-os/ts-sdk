/// <reference lib="webworker" />

import {
    getActiveServiceWorker,
    setupServiceWorkerOnce,
} from "./service-worker-manager";
import { ReadonlyWallet, Wallet } from "../wallet/wallet";
import { ExtendedVirtualCoin } from "../wallet";

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
    private tickInProgress = false;
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
        this.tickInProgress = false;

        if (this.tickTimeout !== null) {
            self.clearTimeout(this.tickTimeout);
            this.tickTimeout = null;
        }

        self.removeEventListener("message", this.onMessage);

        for (const updater of this.updaters.values()) {
            updater.stop();
        }
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

    private onMessage = async (event: ExtendableMessageEvent) => {
        const { id, tag, broadcast } = event.data as RequestEnvelope;

        if (!id || !tag) {
            console.error(event.data);
            throw new Error(
                "Invalid message received, missing required fields"
            );
        }

        if (this.debug) {
            console.log(
                `[${tag}] incoming ${broadcast ? "broadcast " : ""}message:`,
                event.data
            );
        }

        if (broadcast) {
            const updaters = Array.from(this.updaters.values());
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
                    event.source?.postMessage({
                        id,
                        tag: updater.messageTag,
                        error: String(result.reason),
                    });
                }
            });
            return;
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

export class ReadonlyHandler {
    constructor(protected readonly wallet: ReadonlyWallet) {}

    get offchainTapscript() {
        return this.wallet.offchainTapscript;
    }
    get boardingTapscript() {
        return this.wallet.boardingTapscript;
    }
    get onchainProvider() {
        return this.wallet.onchainProvider;
    }
    get dustAmount() {
        return this.wallet.dustAmount;
    }
    get identity() {
        return this.wallet.identity;
    }

    notifyIncomingFunds(
        ...args: Parameters<ReadonlyWallet["notifyIncomingFunds"]>
    ) {
        return this.wallet.notifyIncomingFunds(...args);
    }

    getAddress() {
        return this.wallet.getAddress();
    }

    getBoardingAddress() {
        return this.wallet.getBoardingAddress();
    }

    getBoardingTxs() {
        return this.wallet.getBoardingTxs();
    }

    async handleReload(
        _: ExtendedVirtualCoin[]
    ): Promise<Awaited<ReturnType<Wallet["finalizePendingTxs"]>>> {
        const pending = await this.wallet.fetchPendingTxs();
        return { pending, finalized: [] };
    }

    async handleSettle(
        ..._: Parameters<Wallet["settle"]>
    ): Promise<Awaited<ReturnType<Wallet["settle"]>> | undefined> {
        return undefined;
    }

    async handleSendBitcoin(
        ..._: Parameters<Wallet["sendBitcoin"]>
    ): Promise<Awaited<ReturnType<Wallet["sendBitcoin"]>> | undefined> {
        return undefined;
    }

    async handleSignTransaction(
        ..._: Parameters<Wallet["identity"]["sign"]>
    ): Promise<Awaited<ReturnType<Wallet["identity"]["sign"]>> | undefined> {
        return undefined;
    }
}

export class Handler extends ReadonlyHandler {
    constructor(protected readonly wallet: Wallet) {
        super(wallet);
    }

    async handleReload(vtxos: ExtendedVirtualCoin[]) {
        return this.wallet.finalizePendingTxs(
            vtxos.filter(
                (vtxo) =>
                    vtxo.virtualStatus.state !== "swept" &&
                    vtxo.virtualStatus.state !== "settled"
            )
        );
    }

    async handleSettle(...args: Parameters<Wallet["settle"]>) {
        return this.wallet.settle(...args);
    }

    async handleSendBitcoin(
        ...args: Parameters<Wallet["sendBitcoin"]>
    ): Promise<Awaited<ReturnType<Wallet["sendBitcoin"]>> | undefined> {
        return this.wallet.sendBitcoin(...args);
    }

    async handleSignTransaction(
        ...args: Parameters<Wallet["identity"]["sign"]>
    ) {
        return this.wallet.identity.sign(...args);
    }
}
