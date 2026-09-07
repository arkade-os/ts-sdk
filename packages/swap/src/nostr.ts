/**
 * The Nostr RFQ transport — the PRODUCTION one (the kind, the NIP-44 framing
 * and the payloads it carries are public at
 * https://docs.arkadeos.com/intents/reference/rfq).
 *
 * `rfq.ts` ships two other transports: `httpTransport`, and `relayTransport`
 * which speaks the dev broker's `{op:"sub"|"event"}` framing. Neither is what a
 * deployed solver listens on. This is, and it satisfies the same
 * {@link RfqTransport} interface, so everything above the transport — the user
 * flow, quote verification, the store — is identical whichever one it is handed.
 *
 * ## Why this is a separate entry point
 *
 * Imported as `@arkade-os/swap/nostr`, never from the package root, and
 * `nostr-tools` is an OPTIONAL peer dependency. A consumer doing HTTP-only
 * swaps should not pay for a Nostr library it never calls, and re-exporting
 * this from `index.ts` would put `nostr-tools` in every consumer's module graph
 * whether or not they resolve it. The subpath is what keeps that promise: the
 * module is only loaded if it is imported.
 *
 * The consequence, stated plainly: importing this subpath without `nostr-tools`
 * installed fails at resolution with a module-not-found. That is the intended
 * failure — loud, at the import, naming the missing package — rather than a
 * transport that silently degrades.
 *
 * A dynamic `await import()` inside the factory would also defer the cost, but
 * it would make construction async. This transport opens its subscription
 * eagerly, on purpose (see below), so an async factory would push a `await`
 * into every caller for no benefit the subpath does not already give.
 */
import { expectQuote, pairOf, type RfqStatus, type RfqTransport } from "./rfq";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip44,
    SimplePool,
    type Event,
} from "nostr-tools";

/**
 * Directed RFQ traffic. Provisional in the spec; kept in one place.
 *
 * MUST stay inside NIP-01's ephemeral range (20000–29999) and MUST match the
 * solver's `NOSTR_KIND_DIRECTED`. The two sides subscribe by `kinds`, so a
 * mismatch is not an error either can report — they simply never see each
 * other, and every request times out blaming the solver.
 *
 * Ephemeral because a negotiation is worthless once it is over: a request
 * nobody answered inside the timeout, and a quote past its `valid_until`, help
 * no one, while a retained copy is a permanent record of who negotiated what
 * with whom. The cost is no store-and-forward — a request sent while the solver
 * is disconnected is dropped rather than queued — which the timeout and the
 * caller's retry cover.
 */
export const RFQ_DIRECTED_KIND = 24859;

/**
 * Indicative solver advertisement — never binding; only a quote binds.
 *
 * Addressable (30000–39999) rather than ephemeral, deliberately: an ad is
 * standing state a relay should keep the current version of, not a message in a
 * negotiation. The two constants want OPPOSITE retention, and neither is a typo
 * of the other.
 */
export const RFQ_AD_KIND = 38859;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Every relay dropped the subscription, so no reply can arrive on it.
 *
 * Distinct from a timeout on purpose. Both look like "no answer", but they mean
 * opposite things: a timeout says the solver did not respond, while this says
 * we were never in a position to hear it. Without the distinction the transport
 * waits out the full timeout and then blames the solver for a failure on our
 * own side of the wire.
 */
export class RelayUnavailable extends Error {
    readonly reasons: string[];

    constructor(reasons: string[]) {
        super(`lost every relay connection: ${reasons.join("; ") || "connection closed"}`);
        this.name = "RelayUnavailable";
        this.reasons = reasons;
    }
}

/**
 * `close()` was called while a negotiation was still waiting on a reply.
 *
 * Distinct from both a timeout and {@link RelayUnavailable}, which describe the
 * wire; this describes a decision on our own side of it. A caller that closed
 * deliberately — a user leaving the screen, a flow abandoning its request — can
 * match on this and stay quiet, rather than reporting a solver failure that
 * never happened.
 */
export class TransportClosed extends Error {
    constructor() {
        super("transport closed before the solver replied");
        this.name = "TransportClosed";
    }
}

/**
 * Normalise whatever `subscribeMany`'s `onclose` hands back into readable text.
 *
 * nostr-tools changed this payload WITHIN its own 2.x line: earlier versions
 * pass `string[]`, later ones `{ url, reason }[]`. Because nostr-tools is a
 * PEER dependency here, the consumer picks the version anywhere inside
 * `^2.12.0` — so the transport has to accept either shape rather than pin the
 * range to whichever one it happened to be written against. Declaring a peer
 * range and then only tolerating one point in it is a promise the package would
 * not keep.
 */
const closeReasons = (raw: readonly unknown[]): string[] =>
    raw.map((entry) => {
        if (typeof entry === "string") return entry;
        const { url, reason } = (entry ?? {}) as { url?: string; reason?: string };
        return url ? `${url}: ${reason ?? "closed"}` : (reason ?? "closed");
    });

export interface NostrRfqOptions {
    /** Relay URLs from the solver's card. The rendezvous, not solver endpoints. */
    relays: string[];
    /** The card's `discovery_pubkey`, x-only hex — who we address. */
    solverPubkey: string;
    /**
     * Transport key. Defaults to a FRESH key per transport, deliberately: the
     * negotiation should not be linkable to a long-term identity, and nothing in
     * the protocol needs a stable client key — the quote binds to the covenant,
     * not to who asked for it.
     */
    secretKey?: Uint8Array;
    /** Injectable for tests; a caller may also share one pool across swaps. */
    pool?: SimplePool;
    timeoutMs?: number;
}

/**
 * Build an `RfqTransport` speaking kind-24859 directed traffic.
 *
 * Sends are fire-and-forget publishes; replies arrive on a single long-lived
 * subscription filtered to this transport key, so a reply that arrives before
 * the publish promise settles is not missed.
 */
export const nostrRfqTransport = (options: NostrRfqOptions): RfqTransport => {
    const relays = options.relays;
    const solverPubkey = options.solverPubkey;
    const secretKey = options.secretKey ?? generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const pool = options.pool ?? new SimplePool();
    const ownsPool = !options.pool;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, solverPubkey);

    // close() closes the subscription, which fires onclose; that is a deliberate
    // teardown, not a lost relay, so it must not reject anything.
    let closed = false;

    /** Waiters keyed by rfq_id, settled by a reply or by the subscription dying. */
    const waiters = new Map<
        string,
        { resolve: (payload: unknown) => void; reject: (error: Error) => void }
    >();

    // One subscription for the whole transport. Opened eagerly so a fast solver
    // cannot answer into a subscription that does not exist yet.
    const subscription = pool.subscribeMany(
        relays,
        { kinds: [RFQ_DIRECTED_KIND], "#p": [pubkey], authors: [solverPubkey] },
        {
            onevent(event: Event) {
                let payload: unknown;
                try {
                    payload = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
                } catch {
                    return; // not for us, or malformed: silence, never a throw on the socket
                }
                const rfqId = (payload as { rfq_id?: string } | null)?.rfq_id;
                if (!rfqId) return;
                waiters.get(rfqId)?.resolve(payload);
            },
            // subscribeMany calls this once every relay has closed. Nothing will
            // arrive after it, so failing now beats waiting out the timeout — and
            // it names the real cause instead of implicating the solver.
            onclose(reasons: readonly unknown[]) {
                if (closed) return;
                const error = new RelayUnavailable(closeReasons(reasons));
                for (const waiter of waiters.values()) waiter.reject(error);
                waiters.clear();
            },
        },
    );

    const send = async (payload: Record<string, unknown>): Promise<void> => {
        const event = finalizeEvent(
            {
                kind: RFQ_DIRECTED_KIND,
                created_at: Math.floor(Date.now() / 1000),
                tags: [["p", solverPubkey]],
                content: nip44.v2.encrypt(JSON.stringify(payload), conversationKey),
            },
            secretKey,
        );
        // Publishing to several relays: one accepting is enough, so a single
        // rejecting relay must not fail the negotiation.
        const results = await Promise.allSettled(pool.publish(relays, event));
        if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("no relay accepted the RFQ message");
        }
    };

    /** Await the reply for one rfq_id, with a timeout and guaranteed cleanup. */
    const awaitReply = (rfqId: string): Promise<unknown> =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiters.delete(rfqId);
                reject(new Error(`no solver reply within ${timeoutMs}ms`));
            }, timeoutMs);
            waiters.set(rfqId, {
                resolve: (payload) => {
                    clearTimeout(timer);
                    waiters.delete(rfqId);
                    resolve(payload);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    waiters.delete(rfqId);
                    reject(error);
                },
            });
        });

    return {
        async requestQuote(payload) {
            const rfqId = String(payload.rfq_id);
            // Register the waiter BEFORE publishing: the reply can land while the
            // publish promise is still settling.
            const reply = awaitReply(rfqId);
            await send(payload);
            return expectQuote(await reply, rfqId, pairOf(payload));
        },

        async status(rfqId) {
            const reply = awaitReply(rfqId);
            await send({ v: 1, type: "rfq_status_request", rfq_id: rfqId });
            const payload = (await reply) as { type?: string } | null;
            // A solver that has forgotten the negotiation answers nothing useful;
            // null means "no status", matching the HTTP transport's 404.
            if (payload?.type !== "rfq_status") return null;
            return payload as RfqStatus;
        },

        async close() {
            closed = true;
            // Reject, don't drop. `waiters.clear()` alone empties the map without
            // ever calling the stored closures, so each caller's promise stays
            // pending and its timer stays armed: a close mid-negotiation surfaces
            // `timeoutMs` later as "no solver reply", blaming the solver for a
            // teardown we chose. Each reject clears its own timer and map entry,
            // as in `onclose` above — the two teardown paths agree on what
            // happens to a waiter.
            for (const waiter of waiters.values()) waiter.reject(new TransportClosed());
            waiters.clear();
            // Only tear down a pool this transport created; a shared one belongs
            // to the caller and may still be serving other swaps. On an owned
            // pool, `pool.close()` already ends every subscription on those
            // relays — closing the subscription first as well sends a CLOSE
            // frame on a socket the pool is about to close, and the browser
            // logs "WebSocket is already in CLOSING or CLOSED state" on every
            // negotiation. One teardown path each, per ownership.
            if (ownsPool) pool.close(relays);
            else subscription.close();
        },
    };
};
