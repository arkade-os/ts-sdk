/**
 * One shared Nostr pool for every swap-package reader and writer.
 *
 * nostr-tools' SimplePool already multiplexes subscriptions over one WebSocket
 * per relay, but only within a single pool instance. A pool per transport or
 * per card fetch means one socket per relay per concurrent use, each with its
 * own lifecycle, plus "already in CLOSING" races when two owners tear down the
 * same relay. Sharing one pool collapses that to one socket per relay per app,
 * with subscriptions multiplexed at the protocol level.
 *
 * The pool is process-wide and never closed by borrowers: transports and card
 * fetches close only their own subscription. Teardown is explicit via
 * closeSharedNostrPool(); browsers keep the pool for the app lifetime, but a
 * Node script must call it to exit, since the keep-alive ping holds the process.
 */
import { SimplePool } from "nostr-tools";
import type { AbstractRelay } from "nostr-tools/abstract-relay";
import { CloseOnceWebSocket } from "./closeOnceWebSocket";

export type NostrPool = SimplePool;

let shared: SimplePool | undefined;

/** The largest portable timer delay: `0` means nostr-tools' 20s default, `Infinity` fires at once. */
const NEVER_IDLE_MS = 2 ** 31 - 1;

const guarded = new WeakSet<AbstractRelay>();

/**
 * nostr-tools (through 2.25) decrements a relay's open-operation count on every
 * `Subscription.close()`, and closes the socket once it hits zero. A second close
 * (ours after a relay's `CLOSED`, or a caller's) therefore tears down every other
 * live subscription on the shared socket. Make close idempotent, and stop 2.24's
 * keep-alive REQ, which never counted itself, from decrementing on close.
 */
const guardRelay = (relay: AbstractRelay): void => {
    if (guarded.has(relay)) return;
    guarded.add(relay);
    const subscribe = relay.subscribe.bind(relay);
    relay.subscribe = (filters, params) => {
        const before = relay.ongoingOperations;
        const sub = subscribe(filters, params);
        const counted = relay.ongoingOperations !== before;
        const close = sub.close.bind(sub);
        let done = false;
        sub.close = (reason) => {
            if (done) return;
            done = true;
            const ops = relay.ongoingOperations;
            close(reason);
            if (!counted) relay.ongoingOperations = ops;
        };
        return sub;
    };
};

class GuardedPool extends SimplePool {
    override async ensureRelay(...args: Parameters<SimplePool["ensureRelay"]>) {
        const relay = await super.ensureRelay(...args);
        guardRelay(relay);
        return relay;
    }
}

/**
 * A pool safe to share: idempotent subscription close, no idle socket close (the
 * count it relies on is not trustworthy), and a keep-alive ping that drops a
 * half-open socket instead of letting every quote on it time out.
 */
export const createNostrPool = (): SimplePool =>
    // SimplePool forwards every option at runtime; its declared options just omit most of them.
    new GuardedPool({
        enablePing: true,
        idleTimeout: NEVER_IDLE_MS,
        ...(CloseOnceWebSocket ? { websocketImplementation: CloseOnceWebSocket } : {}),
    } as ConstructorParameters<typeof SimplePool>[0]);

/** The process-wide pool. Lazy, so HTTP-only consumers never touch the network. */
export const sharedNostrPool = (): SimplePool => (shared ??= createNostrPool());

/**
 * Tear down the shared pool. Borrowers must have closed their subscriptions
 * (transport.close(), or the card fetcher's own timeout/EOSE path). For tests
 * and short-lived scripts; browsers keep the pool for the app lifetime.
 */
export const closeSharedNostrPool = (): void => {
    const pool = shared;
    shared = undefined;
    if (!pool) return;
    try {
        pool.destroy();
    } catch {
        // Teardown best-effort: a half-closed relay must not fail a test.
    }
};
