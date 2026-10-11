/**
 * The Nostr RFQ transport — the PRODUCTION one; `httpTransport` and the dev-broker
 * `relayTransport` in `rfq.ts` are not what deployed solvers listen on. The kind, NIP-44 framing
 * and payloads are public at https://docs.arkadeos.com/intents/reference/rfq.
 *
 * A separate entry point (`@arkade-os/swap/nostr`) so `nostr-tools`, an OPTIONAL peer dependency,
 * stays out of HTTP-only consumers' module graphs. Importing it without `nostr-tools` installed
 * fails loudly at resolution, by design. A dynamic `import()` in the factory was rejected: it
 * would make construction async, and the subscription is opened eagerly.
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
 * Directed RFQ traffic. Provisional in the spec.
 *
 * MUST stay inside NIP-01's ephemeral range (20000–29999) and MUST match the solver's
 * `NOSTR_KIND_DIRECTED`: both sides subscribe by `kinds`, so a mismatch surfaces only as every
 * request timing out. Ephemeral because a finished negotiation is worthless and a retained copy
 * records who negotiated with whom; the cost (no store-and-forward) is covered by timeout + retry.
 */
export const RFQ_DIRECTED_KIND = 24859;

/**
 * Indicative solver advertisement — never binding; only a quote binds.
 * Addressable (30000–39999), not ephemeral: an ad is standing state relays should retain. The
 * opposite retention to {@link RFQ_DIRECTED_KIND} is intentional, not a typo.
 */
export const RFQ_AD_KIND = 38859;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Every relay dropped the subscription, so no reply can arrive on it. Distinct from a timeout:
 * that says the solver did not respond, this says we could never have heard it.
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
 * `close()` was called while a negotiation was still waiting on a reply. A deliberate local
 * decision, so a caller can match on it and stay quiet rather than report a solver failure.
 */
export class TransportClosed extends Error {
    constructor() {
        super("transport closed before the solver replied");
        this.name = "TransportClosed";
    }
}

/**
 * Normalise `subscribeMany`'s `onclose` payload into readable text. nostr-tools changed it within
 * 2.x (`string[]` → `{ url, reason }[]`), and as a peer dep in `^2.12.0` either may be installed.
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
     * Transport key. Defaults to a FRESH key per transport so the negotiation is not linkable to
     * a long-term identity; the quote binds to the covenant, not to who asked.
     */
    secretKey?: Uint8Array;
    /** Injectable for tests; a caller may also share one pool across swaps. */
    pool?: SimplePool;
    timeoutMs?: number;
}

/**
 * Build an `RfqTransport` speaking kind-24859 directed traffic. Replies arrive on one
 * long-lived subscription filtered to this transport key.
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

    // close() fires onclose too; that deliberate teardown must not reject as a lost relay.
    let closed = false;

    /** Waiters keyed by rfq_id, settled by a reply or by the subscription dying. */
    const waiters = new Map<
        string,
        { resolve: (payload: unknown) => void; reject: (error: Error) => void }
    >();

    // Opened eagerly so a fast solver cannot answer into a subscription that does not exist yet.
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
            // Called once every relay has closed: fail now with the real cause, not at timeout.
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
        // One accepting relay is enough; a single rejecting relay must not fail the negotiation.
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
            // null means "no status", matching the HTTP transport's 404.
            if (payload?.type !== "rfq_status") return null;
            return payload as RfqStatus;
        },

        async close() {
            closed = true;
            // Reject, don't just clear: otherwise each pending promise's timer fires later as
            // "no solver reply", blaming the solver for our own teardown.
            for (const waiter of waiters.values()) waiter.reject(new TransportClosed());
            waiters.clear();
            // Only tear down a pool we created (a shared one may serve other swaps). An owned
            // pool's close ends its subscriptions; closing the subscription first too makes the
            // browser log "WebSocket is already in CLOSING or CLOSED state".
            if (ownsPool) pool.close(relays);
            else subscription.close();
        },
    };
};
