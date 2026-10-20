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
 * fetches close only their own subscription, and a relay's socket closes once
 * nothing has used it for IDLE_CLOSE_MS. closeSharedNostrPool() tears it all
 * down at once, for tests and short-lived scripts.
 */
import { SimplePool } from "nostr-tools";
import { normalizeURL } from "nostr-tools/utils";
import { CloseOnceWebSocket } from "./closeOnceWebSocket";

export type NostrPool = SimplePool;

let shared: SimplePool | undefined;

/** How long a relay's socket outlives its last subscription or publish. */
export const IDLE_CLOSE_MS = 30_000;

/** The largest portable timer delay: `0` means nostr-tools' 20s default, `Infinity` fires at once. */
const NEVER_IDLE_MS = 2 ** 31 - 1;

/** nostr-tools' rejection when a relay never answers an EVENT with OK. */
const PUBLISH_TIMED_OUT = "publish timed out";

const urlKey = (url: string): string => {
    try {
        return normalizeURL(url);
    } catch {
        return url; // nostr-tools rejects it on connect; it only has to match itself here
    }
};

/**
 * Counts its own users per relay and closes a socket once they are all gone.
 *
 * nostr-tools' idle close relies on a per-relay count that every
 * `Subscription.close()` decrements, a repeated one included (a relay's `CLOSED`
 * followed by ours), and on a shared socket a miscount closes every other live
 * subscription. So that close is turned off, and this pool counts through public
 * methods only: `subscribeMap`, which every subscribe and query goes through,
 * and `publish`. A relay used behind them (`ensureRelay(url).subscribe()`) is
 * not counted, and its subscriptions end when the counted ones go idle.
 */
class SharedPool extends SimplePool {
    readonly #users = new Map<string, number>();
    readonly #idle = new Map<string, ReturnType<typeof setTimeout>>();

    /** Count one user on each relay; the returned release is idempotent. */
    #hold(urls: readonly string[]): () => void {
        const held = [...new Set(urls.map(urlKey))];
        for (const url of held) {
            clearTimeout(this.#idle.get(url));
            this.#idle.delete(url);
            this.#users.set(url, (this.#users.get(url) ?? 0) + 1);
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const url of held) {
                const left = (this.#users.get(url) ?? 1) - 1;
                if (left > 0) {
                    this.#users.set(url, left);
                    continue;
                }
                this.#users.delete(url);
                const timer = setTimeout(() => {
                    this.#idle.delete(url);
                    if (!this.#users.has(url)) this.close([url]);
                }, IDLE_CLOSE_MS);
                // An idle socket must not keep a Node process alive.
                (timer as { unref?: () => void }).unref?.();
                this.#idle.set(url, timer);
            }
        };
    }

    override subscribeMap(...[requests, params]: Parameters<SimplePool["subscribeMap"]>) {
        const release = this.#hold(requests.map((request) => request.url));
        const closer = super.subscribeMap(requests, {
            ...params,
            // Every relay dropped it: nothing is left to hold the sockets for.
            onclose: (reasons) => {
                release();
                params.onclose?.(reasons);
            },
        });
        let closed = false;
        return {
            close: (reason?: string) => {
                if (closed) return;
                closed = true;
                release();
                closer.close(reason);
            },
        };
    }

    override publish(...[relays, event, params]: Parameters<SimplePool["publish"]>) {
        const release = this.#hold(relays);
        const sent = super.publish(relays, event, params);
        // A relay that never acknowledges is a half-open socket (sleep, network change): every
        // later use would time out the same way until the ping notices, up to ~50s. Evict it so
        // the next use reconnects. A timeout means the socket was never closed in between (a
        // close rejects the publish first), so the URL still names that same socket.
        sent.forEach((publish, i) => {
            publish.catch((error: unknown) => {
                if (error instanceof Error && error.message === PUBLISH_TIMED_OUT)
                    this.close([relays[i]!]);
            });
        });
        void Promise.allSettled(sent).then(release);
        return sent;
    }

    override destroy(): void {
        for (const timer of this.#idle.values()) clearTimeout(timer);
        this.#idle.clear();
        this.#users.clear();
        super.destroy();
    }
}

/**
 * A pool safe to share: per-subscription idle accounting, and a keep-alive ping
 * that drops a half-open socket instead of letting every quote on it time out.
 */
export const createNostrPool = (): SimplePool =>
    // SimplePool forwards every option at runtime; its declared options just omit most of them.
    new SharedPool({
        enablePing: true,
        idleTimeout: NEVER_IDLE_MS,
        ...(CloseOnceWebSocket ? { websocketImplementation: CloseOnceWebSocket } : {}),
    } as ConstructorParameters<typeof SimplePool>[0]);

/** The process-wide pool. Lazy, so HTTP-only consumers never touch the network. */
export const sharedNostrPool = (): SimplePool => (shared ??= createNostrPool());

/**
 * Tear down the shared pool. Borrowers must have closed their subscriptions
 * (transport.close(), or the card fetcher's own timeout/EOSE path). For tests
 * and short-lived scripts that should not wait out IDLE_CLOSE_MS.
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
