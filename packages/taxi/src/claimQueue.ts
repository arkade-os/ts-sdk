import type { ExtendedVirtualCoin, Identity } from "@arkade-os/sdk";
import {
    ClaimSpent,
    claimVerified,
    guardedClaimIdentity,
    isFreeReceiverClaim,
    offerKey,
    planReceiverClaim,
    type ClaimPlan,
    type VerifiedClaim,
} from "./claims";

export interface ClaimQueueOptions {
    identity: Identity;
    /** Fresh spendable coins with wallet reservations and pending send inputs excluded. */
    getCoins: () => Promise<ExtendedVirtualCoin[]>;
    coordinate?: (run: () => Promise<void>) => Promise<void>;
    reload: () => Promise<void>;
    allowed: () => boolean;
    automatic?: boolean;
    recordClaim: (offer: VerifiedClaim, plan: ClaimPlan, txid: string) => void | Promise<void>;
    onError?: (error: unknown, key: string) => void;
}

export interface ClaimQueueSnapshot {
    offers: readonly VerifiedClaim[];
    busy?: string;
    plans: ReadonlyMap<string, ClaimPlan>;
    errors: ReadonlyMap<string, unknown>;
    spent: ReadonlySet<string>;
}

export class TaxiClaimQueue {
    private readonly offers = new Map<string, VerifiedClaim>();
    private readonly plans = new Map<string, ClaimPlan>();
    private readonly errors = new Map<string, unknown>();
    private readonly spent = new Set<string>();
    private readonly claimed = new Set<string>();
    private readonly consumed = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private running?: Promise<void>;
    private busy?: string;
    private alive = true;
    private active = true;
    private epoch = 0;
    private automatic: boolean;
    private revision = 0;
    private scheduled = false;
    private state: ClaimQueueSnapshot;

    constructor(private readonly options: ClaimQueueOptions) {
        this.automatic = options.automatic !== false && Boolean(options.coordinate);
        this.state = this.snapshotState();
    }

    snapshot = (): ClaimQueueSnapshot => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    offer(offer: VerifiedClaim): void {
        const key = offerKey(offer);
        if (!this.alive || this.claimed.has(key)) return;
        if (!this.offers.has(key)) this.offers.set(key, offer);
        this.publish();
        this.wake();
    }

    withdraw(key: string): void {
        this.offers.delete(key);
        this.plans.delete(key);
        this.errors.delete(key);
        this.publish();
    }

    setAutomatic(enabled: boolean): void {
        this.automatic = enabled && Boolean(this.options.coordinate);
        this.wake();
    }

    setActive(active: boolean): void {
        if (!this.alive || this.active === active) return;
        this.active = active;
        this.epoch++;
        this.wake();
    }

    wake(): void {
        this.revision++;
        if (
            !this.alive ||
            !this.active ||
            this.running ||
            this.scheduled ||
            !this.options.allowed()
        )
            return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (!this.alive || !this.active || this.running || !this.options.allowed()) return;
            const epoch = this.epoch;
            this.start(async () => {
                const tried = new Set<string>();
                while (this.authorized(epoch)) {
                    const next = [...this.offers.values()].find(
                        (offer) => !tried.has(offerKey(offer)),
                    );
                    if (!next) return;
                    tried.add(offerKey(next));
                    await this.run(next, true, epoch);
                }
            });
        });
    }

    async claim(key: string): Promise<void> {
        const epoch = this.epoch;
        await this.running;
        const offer = this.offers.get(key);
        if (!offer || this.running || !this.authorized(epoch)) return;
        await this.start(() => this.run(offer, false, epoch));
    }

    dispose(): void {
        this.alive = false;
        this.epoch++;
        this.listeners.clear();
    }

    private start(run: () => Promise<void>): Promise<void> {
        const revision = this.revision;
        this.running = Promise.resolve()
            .then(run)
            .finally(() => {
                this.running = undefined;
                this.busy = undefined;
                this.publish();
                if (this.revision !== revision) this.wake();
            });
        return this.running;
    }

    private async run(offer: VerifiedClaim, automatic: boolean, epoch: number): Promise<void> {
        const key = offerKey(offer);
        const valid = () => this.authorized(epoch) && this.offers.get(key) === offer;
        if (!valid() || this.spent.has(key)) return;
        const execute = async () => {
            if (!valid()) return;
            this.busy = key;
            this.publish();
            const coins = await this.options.getCoins();
            if (!valid()) return;
            const plan = planReceiverClaim(
                offer.claim,
                coins.filter((coin) => !this.consumed.has(`${coin.txid}:${coin.vout}`)),
            );
            this.plans.set(key, plan);
            this.errors.delete(key);
            this.publish();
            if (
                plan.kind === "wait-for-reclaim" ||
                (automatic && (!this.automatic || !isFreeReceiverClaim(offer.claim, plan)))
            )
                return;
            if (plan.kind === "recycle") this.consumed.add(`${plan.coin.txid}:${plan.coin.vout}`);
            const identity = guardedClaimIdentity(
                this.options.identity,
                () => valid() && (!automatic || this.automatic),
            );
            const txid = await claimVerified(offer, plan, identity);
            try {
                await this.options.recordClaim(offer, plan, txid);
            } catch (error) {
                this.report(error, key);
            }
            this.claimed.add(key);
            if (this.offers.get(key) === offer) {
                this.offers.delete(key);
                this.plans.delete(key);
                this.errors.delete(key);
            }
            this.publish();
            if (!this.authorized(epoch)) return;
            await this.options.reload();
        };
        try {
            if (this.options.coordinate) await this.options.coordinate(execute);
            else await execute();
        } catch (error) {
            if (error instanceof ClaimSpent) this.spent.add(key);
            if (this.offers.get(key) === offer) this.errors.set(key, error);
            this.report(error, key);
            this.publish();
        }
    }

    private authorized(epoch: number): boolean {
        return this.alive && this.active && this.epoch === epoch && this.options.allowed();
    }

    private report(error: unknown, key: string): void {
        try {
            this.options.onError?.(error, key);
        } catch {
            // A reporting callback cannot abort the next delivery.
        }
    }

    private snapshotState(): ClaimQueueSnapshot {
        return {
            offers: [...this.offers.values()],
            busy: this.busy,
            plans: new Map(this.plans),
            errors: new Map(this.errors),
            spent: new Set(this.spent),
        };
    }

    private publish(): void {
        this.state = this.snapshotState();
        if (this.alive) for (const listener of this.listeners) listener();
    }
}
