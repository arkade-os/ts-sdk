import { finalizeEvent, getPublicKey, nip44, verifyEvent, type Event } from "nostr-tools";
import { RFQ_DIRECTED_KIND, RelayUnavailable } from "./nostr";
import { sharedNostrPool, type NostrPool } from "./nostrPool";
import {
    openRfqPayload,
    parseOpenRfqBid,
    rankOpenRfqBids,
    RFQ_BROADCAST_KIND,
    type OpenRfqBid,
    type OpenRfqRequest,
} from "./openRfq";
import { SolverUnavailable } from "./transportErrors";

export interface CollectOpenRfqOptions {
    readonly secretKey: Uint8Array;
    readonly relays: readonly string[];
    readonly windowMs?: number;
    readonly signal?: AbortSignal;
    readonly onBids?: (bids: readonly OpenRfqBid[]) => void;
    readonly pool?: NostrPool;
}

const MAX_BIDS = 64;
const MAX_SEEN_EVENTS = 256;
const MAX_EVENT_CONTENT = 100_000;
const MAX_WINDOW_MS = 30_000;

export const collectOpenRfqBids = (
    request: OpenRfqRequest,
    options: CollectOpenRfqOptions,
): Promise<readonly OpenRfqBid[]> => {
    const payload = openRfqPayload(request);
    const windowMs = options.windowMs ?? 3_000;
    if (!Number.isSafeInteger(windowMs) || windowMs < 0 || windowMs > MAX_WINDOW_MS)
        throw new Error("windowMs must be an integer between 0 and 30000");
    const started = Date.now();
    const now = Math.floor(started / 1000);
    const duration = Math.min(windowMs, request.bidsUntil * 1000 - started);
    if (duration < 0 || request.bidsUntil > now + 31) throw new Error("invalid open RFQ deadline");
    const relays = [...new Set(options.relays)];
    if (!relays.length || relays.length > 16)
        throw new Error("open RFQ requires between 1 and 16 relays");
    for (const relay of relays) {
        const url = new URL(relay);
        if (!/^wss?:$/.test(url.protocol) || url.username || url.password || url.hash)
            throw new Error("invalid open RFQ relay");
    }
    options.signal?.throwIfAborted();
    const secretKey = new Uint8Array(options.secretKey);
    const clientPubkey = getPublicKey(secretKey);
    const event = finalizeEvent(
        {
            kind: RFQ_BROADCAST_KIND,
            created_at: now,
            tags: [["t", request.pair]],
            content: JSON.stringify(payload),
        },
        secretKey,
    );
    const pool = options.pool ?? sharedNostrPool();
    return new Promise((resolve, reject) => {
        const bids = new Map<string, OpenRfqBid>();
        const seen = new Set<string>();
        let closed = false;
        let accepted = false;
        let subscription: { close(): void } | undefined;
        const noRelay = () => new SolverUnavailable("no relay accepted the open RFQ");
        const finish = (error?: unknown) => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            try {
                subscription?.close();
            } catch {
                // Relay teardown does not change the completed auction result.
            }
            secretKey.fill(0);
            if (error !== undefined) reject(error);
            else resolve(rankOpenRfqBids([...bids.values()], request.amountSide));
        };
        const abort = () => finish(options.signal?.reason ?? new Error("open RFQ aborted"));
        const timer = setTimeout(() => finish(accepted ? undefined : noRelay()), duration);
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
            subscription = pool.subscribeMany(
                relays,
                { kinds: [RFQ_DIRECTED_KIND], "#p": [clientPubkey], "#e": [event.id], since: now },
                {
                    onevent(reply: Event) {
                        const current = Math.floor(Date.now() / 1000);
                        if (
                            closed ||
                            !reply ||
                            typeof reply.content !== "string" ||
                            typeof reply.id !== "string" ||
                            !/^[a-f0-9]{64}$/.test(reply.id) ||
                            typeof reply.pubkey !== "string" ||
                            !/^[a-f0-9]{64}$/.test(reply.pubkey) ||
                            typeof reply.sig !== "string" ||
                            !/^[a-f0-9]{128}$/.test(reply.sig) ||
                            !Array.isArray(reply.tags) ||
                            reply.tags.length > 32 ||
                            !reply.tags.every(
                                (tag) =>
                                    Array.isArray(tag) &&
                                    tag.length <= 8 &&
                                    tag.every(
                                        (value) =>
                                            typeof value === "string" && value.length <= 1_024,
                                    ),
                            ) ||
                            Date.now() >= started + duration ||
                            reply.kind !== RFQ_DIRECTED_KIND ||
                            reply.content.length > MAX_EVENT_CONTENT ||
                            !Number.isSafeInteger(reply.created_at) ||
                            reply.created_at < event.created_at ||
                            reply.created_at > current + 5 ||
                            reply.created_at >= request.bidsUntil ||
                            seen.has(reply.id) ||
                            seen.size >= MAX_SEEN_EVENTS
                        )
                            return;
                        const recipients = reply.tags.filter((tag) => tag[0] === "p");
                        const references = reply.tags.filter((tag) => tag[0] === "e");
                        if (
                            recipients.length !== 1 ||
                            recipients[0]?.[1] !== clientPubkey ||
                            references.length !== 1 ||
                            references[0]?.[1] !== event.id
                        )
                            return;
                        try {
                            if (!verifyEvent(reply)) return;
                            seen.add(reply.id);
                            const key = nip44.v2.utils.getConversationKey(secretKey, reply.pubkey);
                            const bid = parseOpenRfqBid(
                                JSON.parse(nip44.v2.decrypt(reply.content, key)),
                                reply.pubkey,
                                reply.id,
                            );
                            if (
                                !bid ||
                                bid.openId !== request.openId ||
                                bid.pair !== request.pair ||
                                bid.amountSide !== request.amountSide ||
                                bid.validUntil <= current ||
                                bid.validUntil <= request.bidsUntil ||
                                (request.amountSide === "from" ? bid.fromAmount : bid.toAmount) !==
                                    request.amount
                            )
                                return;
                            const previous = bids.get(bid.solverPubkey);
                            if (previous) {
                                const improved =
                                    request.amountSide === "from"
                                        ? bid.toAmount > previous.toAmount
                                        : bid.fromAmount < previous.fromAmount;
                                if (!improved) return;
                            } else if (bids.size >= MAX_BIDS) return;
                            bids.set(bid.solverPubkey, bid);
                            options.onBids?.(
                                rankOpenRfqBids([...bids.values()], request.amountSide),
                            );
                        } catch {
                            // A malformed participant or a failed progress callback cannot end collection.
                        }
                    },
                    onclose(reasons: readonly unknown[]) {
                        finish(new RelayUnavailable(reasons.map(String)));
                    },
                },
            );
            if (closed) subscription.close();
            else {
                const publications = pool.publish(relays, event);
                if (!publications.length) finish(noRelay());
                void Promise.allSettled(publications).then((results) => {
                    accepted = results.some(
                        (result) =>
                            result.status === "fulfilled" &&
                            !String(result.value).startsWith("connection failure"),
                    );
                    if (!accepted) finish(noRelay());
                });
                for (const publication of publications)
                    void publication.then(
                        (result) => {
                            if (!String(result).startsWith("connection failure")) accepted = true;
                        },
                        () => {},
                    );
            }
        } catch (error) {
            finish(error);
        }
    });
};
