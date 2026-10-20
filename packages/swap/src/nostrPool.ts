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
 * closeSharedNostrPool(), for tests and short-lived scripts. Browsers keep it
 * for the app lifetime.
 */
import { SimplePool } from "nostr-tools";
import { CloseOnceWebSocket } from "./closeOnceWebSocket";

export type NostrPool = SimplePool;

let shared: SimplePool | undefined;

// SimplePool forwards websocketImplementation at runtime; its declared options just omit it.
export const createNostrPool = (): SimplePool =>
    new SimplePool(
        (CloseOnceWebSocket ? { websocketImplementation: CloseOnceWebSocket } : undefined) as
            | ConstructorParameters<typeof SimplePool>[0]
            | undefined,
    );

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
