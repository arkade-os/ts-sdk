/**
 * Open RFQ over Nostr — publish the broadcast, collect the sealed bids.
 *
 * Kept apart from `nostr.ts` because this is NOT a variant of the directed
 * transport, and trying to make it one goes wrong in three places:
 *
 *  - `nostrRfqTransport` subscribes with `authors: [solverPubkey]`. An open RFQ
 *    is answered by solvers the client has not chosen and cannot name, so the
 *    filter has to be by recipient alone.
 *  - it derives ONE conversation key, from the solver it was built for. Bids
 *    arrive from many keys, each needing its own — derived per event, from the
 *    sender on the event.
 *  - it resolves ONE reply per `rfq_id` and closes. An auction wants every
 *    reply inside a window, not the first.
 *
 * The directed flow is untouched: once a winner is picked, the client builds an
 * ordinary `nostrRfqTransport` against that solver and runs § 4.1–4.5 as
 * before. This module only gets it to the point of knowing whom to ask.
 */
import {
    SimplePool,
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip44,
    type Event,
} from "nostr-tools";
import { RFQ_DIRECTED_KIND } from "./nostr";
import {
    RFQ_BROADCAST_KIND,
    openRfqPayload,
    parseBid,
    type OpenRfqSize,
    type SolverBid,
} from "./openRfq";

/** § 4.6 recommends 2–5s. Long enough for a round trip, short enough to feel live. */
const DEFAULT_BID_WINDOW_MS = 3_000;

export interface CollectBidsOptions {
    /** Relays to broadcast on and listen to. A shared RFQ bus, typically. */
    relays: string[];
    /** The directional § 2 pair string, e.g. `arkade:BTC->lightning:BTC`. */
    pair: string;
    /**
     * The canonical corridor-qualified market key for the `t` tag — corridors
     * resolved, canonical asset ids, deterministic leg order
     * (`arkade:btc/lightning:btc`). NEVER the card's display label: solvers
     * subscribe by this exact tag, and any other spelling is silently unheard.
     */
    marketKey: string;
    amountSide: "from" | "to";
    size: OpenRfqSize;
    /** 32 bytes hex, client-chosen; correlates bids. Not an `rfq_id`. */
    openId: string;
    bidWindowMs?: number;
    /**
     * Transport key. Defaults to a FRESH one per open RFQ, which § 4.6 asks for
     * by name: bids seal to this key, so reusing it links otherwise unrelated
     * trades together for every solver on the bus.
     */
    secretKey?: Uint8Array;
    pool?: SimplePool;
    /** Injectable clock, so `bids_until` is testable without waiting. */
    now?: () => number;
}

export interface CollectedBids {
    /** The key bids were sealed to — the directed close MAY use a different one. */
    clientPubkey: string;
    openId: string;
    bids: SolverBid[];
}

/**
 * Publish one `rfq_open` and gather bids for a window.
 *
 * Resolves with whatever arrived, including nothing: an auction no solver
 * answered is an ordinary outcome on a shared bus, not an error. A caller that
 * wants a directed fallback checks for an empty list.
 */
export const collectOpenRfqBids = async (options: CollectBidsOptions): Promise<CollectedBids> => {
    const secretKey = options.secretKey ?? generateSecretKey();
    const clientPubkey = getPublicKey(secretKey);
    const pool = options.pool ?? new SimplePool();
    const ownsPool = !options.pool;
    const windowMs = options.bidWindowMs ?? DEFAULT_BID_WINDOW_MS;
    const now = options.now ?? (() => Math.floor(Date.now() / 1000));

    const bids = new Map<string, SolverBid>();

    // Subscribe BEFORE publishing. A solver that answers instantly would
    // otherwise bid into a subscription that does not exist yet — the same
    // ordering `nostrRfqTransport` is careful about, for the same reason.
    //
    // No `authors` filter: that is the whole point of an open RFQ.
    const subscription = pool.subscribeMany(
        options.relays,
        { kinds: [RFQ_DIRECTED_KIND], "#p": [clientPubkey] },
        {
            onevent(event: Event) {
                let payload: unknown;
                try {
                    // Per-sender conversation key. `event.pubkey` is the sender,
                    // and the event's signature is what binds this price to it.
                    const conversationKey = nip44.v2.utils.getConversationKey(
                        secretKey,
                        event.pubkey,
                    );
                    payload = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
                } catch {
                    return; // not for us, or malformed: never throw on the socket
                }
                const bid = parseBid(payload, event.pubkey);
                if (!bid || bid.openId !== options.openId) return;
                // One bid per solver — the last one wins, so a solver that
                // improves its price is not made to compete with its own
                // earlier bid.
                bids.set(bid.solverPubkey, bid);
            },
        },
    );

    try {
        const bidsUntil = now() + Math.ceil(windowMs / 1000);
        const event = finalizeEvent(
            {
                kind: RFQ_BROADCAST_KIND,
                created_at: now(),
                // `t` is how solvers find this; there is no `p`, and the content
                // is plaintext because an open RFQ has nobody to encrypt to.
                tags: [["t", options.marketKey]],
                content: JSON.stringify(
                    openRfqPayload({
                        openId: options.openId,
                        pair: options.pair,
                        amountSide: options.amountSide,
                        size: options.size,
                        bidsUntil,
                    }),
                ),
            },
            secretKey,
        );

        const results = await Promise.allSettled(pool.publish(options.relays, event));
        if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("no relay accepted the open RFQ");
        }

        await new Promise((resolve) => setTimeout(resolve, windowMs));
    } finally {
        subscription.close();
        if (ownsPool) pool.destroy();
    }

    return { clientPubkey, openId: options.openId, bids: [...bids.values()] };
};
