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
import {
    SOLVER_CARD_KIND,
    type TransportCard,
    type TransportCardFetcher,
} from "@arkade-os/solver-discovery";
import { expectQuote, pairOf, type RfqStatus, type RfqTransport } from "./rfq";
import { sharedNostrPool } from "./nostrPool";
import { assertTimerMs } from "@arkade-os/sdk";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip44,
    SimplePool,
    verifyEvent,
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

const DEFAULT_TIMEOUT_MS = 30_000;
const CARD_FETCH_TIMEOUT_MS = 5_000;

export {
    closeSharedNostrPool,
    createNostrPool,
    sharedNostrPool,
    type NostrPool,
} from "./nostrPool";

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
    assertTimerMs("timeoutMs", options.timeoutMs);
    const relays = options.relays;
    const solverPubkey = options.solverPubkey;
    const secretKey = options.secretKey ?? generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const pool = options.pool ?? sharedNostrPool();
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
            if (closed) return;
            closed = true;
            // Reject, don't just clear: otherwise each pending promise's timer fires later as
            // "no solver reply", blaming the solver for our own teardown.
            for (const waiter of waiters.values()) waiter.reject(new TransportClosed());
            waiters.clear();
            // The pool is shared (or lent): many transports multiplex over one socket per
            // relay, so only the subscription closes here. The socket stays for the next
            // negotiation; teardown is explicit via closeSharedNostrPool().
            subscription.close();
        },
    };
};

export interface NostrCardFetcherOptions {
    /** Injectable for tests; a lent pool is never closed, only the subscription on it. */
    pool?: SimplePool;
    /** How long to wait for every relay's EOSE before answering with what arrived. */
    timeoutMs?: number;
}

/**
 * Reads listed solvers' {@link SOLVER_CARD_KIND} cards: one REQ over the union of their relays,
 * closed on EOSE or `timeoutMs`, keeping each author's latest event. It authenticates delivery
 * (the event signature) only; the discovery client validates the card itself.
 */
/** NIP-01 replaceable order: the later `created_at`, a same-second tie to the lower id. */
const isNewer = (event: Event, held: Event | undefined): boolean =>
    !held ||
    event.created_at > held.created_at ||
    (event.created_at === held.created_at && event.id < held.id);

export const nostrCardFetcher = (options: NostrCardFetcherOptions = {}): TransportCardFetcher => {
    assertTimerMs("timeoutMs", options.timeoutMs);
    if (options.timeoutMs === 0) throw new Error("timeoutMs must be positive");
    const seen = new Map<string, Event>();
    const inflight = new Map<string, Promise<TransportCard[]>>();
    return {
        async fetch(solvers, network) {
            const asked = new Set(solvers.map((solver) => solver.discovery_pubkey));
            const authors = [...asked];
            const relays = [
                ...new Set(solvers.flatMap((solver) => solver.transports?.nostr?.relays ?? [])),
            ];
            if (authors.length === 0 || relays.length === 0) return [];
            const key = network + ":" + [...asked].sort().join(",");
            const pending = inflight.get(key);
            if (pending) return pending;
            const task = (async (): Promise<TransportCard[]> => {
                const timeoutMs = options.timeoutMs ?? CARD_FETCH_TIMEOUT_MS;
                const pool = options.pool ?? sharedNostrPool();
                const latest = new Map<string, Event>();
                let subscription: { close: () => void } | undefined;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, timeoutMs);
                        subscription = pool.subscribeMany(
                            relays,
                            { kinds: [SOLVER_CARD_KIND], authors, "#d": [network] },
                            {
                                // Relays are untrusted: re-check the filter and the signature, so a stray
                                // or forged later event cannot shadow the real card.
                                onevent(event: Event) {
                                    if (event.kind !== SOLVER_CARD_KIND || !asked.has(event.pubkey))
                                        return;
                                    if (!verifyEvent(event)) return;
                                    if (event.tags.find((tag) => tag[0] === "d")?.[1] !== network)
                                        return;
                                    if (isNewer(event, latest.get(event.pubkey)))
                                        latest.set(event.pubkey, event);
                                },
                                oneose: () => resolve(),
                                onclose: () => resolve(),
                            },
                        );
                    });
                } finally {
                    clearTimeout(timer);
                    subscription?.close();
                }
                // A card seen before fills a missed delivery; the discovery client's age check bounds it.
                for (const author of authors) {
                    const key = `${network}:${author}`;
                    const event = latest.get(author);
                    if (event && isNewer(event, seen.get(key))) seen.set(key, event);
                    const best = seen.get(key);
                    if (best) latest.set(author, best);
                }
                const cards: TransportCard[] = [];
                for (const event of latest.values()) {
                    try {
                        const card: unknown = JSON.parse(event.content);
                        cards.push({ pubkey: event.pubkey, createdAt: event.created_at, card });
                    } catch {
                        // Not an older card instead: the newest event is the solver's current statement.
                    }
                }
                return cards;
            })();
            inflight.set(key, task);
            try {
                return await task;
            } finally {
                if (inflight.get(key) === task) inflight.delete(key);
            }
        },
    };
};
