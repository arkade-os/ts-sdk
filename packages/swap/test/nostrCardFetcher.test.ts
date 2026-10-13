import { afterEach, describe, expect, it, vi } from "vitest";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    SimplePool,
    type Event,
} from "nostr-tools";
import type { IndexSolver } from "@arkade-os/solver-discovery";
import { RFQ_AD_KIND, SOLVER_CARD_KIND, nostrCardFetcher } from "../src/nostr";

interface Params {
    onevent: (event: Event) => void;
    oneose?: () => void;
    onclose?: (reasons: unknown[]) => void;
}

/** A pool whose relays the test speaks for. It verifies nothing, as a lent pool may not. */
const relayStub = () => {
    const reqs: { relays: string[]; filter: unknown; params: Params }[] = [];
    const subscriptionClose = vi.fn();
    const pool = {
        subscribeMany(relays: string[], filter: unknown, params: Params) {
            reqs.push({ relays, filter, params });
            return { close: subscriptionClose };
        },
        close: vi.fn(),
    };
    return {
        pool: pool as never,
        reqs,
        subscriptionClose,
        poolClose: pool.close,
        deliver: (...events: Event[]) => events.forEach((e) => reqs[0].params.onevent(e)),
        eose: () => reqs[0].params.oneose?.(),
        dropEveryRelay: () => reqs[0].params.onclose?.([]),
    };
};

const solverKey = () => {
    const secret = generateSecretKey();
    return { secret, pubkey: getPublicKey(secret) };
};

/** Signed, then off the wire: the round trip drops `finalizeEvent`'s cached "verified" mark. */
const cardEvent = (
    secret: Uint8Array,
    createdAt: number,
    over: { d?: string | null; content?: string } = {},
): Event =>
    JSON.parse(
        JSON.stringify(
            finalizeEvent(
                {
                    kind: SOLVER_CARD_KIND,
                    created_at: createdAt,
                    tags: over.d === null ? [] : [["d", over.d ?? "mutinynet"]],
                    content: over.content ?? JSON.stringify({ name: "solver", at: createdAt }),
                },
                secret,
            ),
        ),
    );

const listed = (pubkey: string, relays = ["wss://relay.example"]): IndexSolver => ({
    name: "solver",
    discovery_pubkey: pubkey,
    transports: { nostr: { relays } },
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("SOLVER_CARD_KIND", () => {
    it("is the kind the RFQ ad used, still exported under the old name", () => {
        expect(SOLVER_CARD_KIND).toBe(38859);
        expect(RFQ_AD_KIND).toBe(SOLVER_CARD_KIND);
    });
});

describe("nostrCardFetcher", () => {
    it("asks once, over every listed relay, for the listed keys' cards on this network", async () => {
        const a = solverKey();
        const b = solverKey();
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [
                listed(a.pubkey, ["wss://one", "wss://two"]),
                listed(b.pubkey, ["wss://two", "wss://three"]),
                listed(a.pubkey, ["wss://one"]),
            ],
            "mutinynet",
        );
        relay.eose();
        await pending;

        expect(relay.reqs).toHaveLength(1);
        expect(relay.reqs[0].relays).toEqual(["wss://one", "wss://two", "wss://three"]);
        expect(relay.reqs[0].filter).toEqual({
            kinds: [38859],
            authors: [a.pubkey, b.pubkey],
            "#d": ["mutinynet"],
        });
    });

    it("keeps each key's latest card, whatever order the relays deliver in", async () => {
        const a = solverKey();
        const b = solverKey();
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(a.pubkey), listed(b.pubkey)],
            "mutinynet",
        );
        relay.deliver(
            cardEvent(a.secret, 100),
            cardEvent(a.secret, 300),
            cardEvent(b.secret, 50),
            cardEvent(a.secret, 200),
        );
        relay.eose();
        const cards = await pending;

        expect(cards).toHaveLength(2);
        expect(cards).toContainEqual({
            pubkey: a.pubkey,
            createdAt: 300,
            card: { name: "solver", at: 300 },
        });
        expect(cards).toContainEqual({
            pubkey: b.pubkey,
            createdAt: 50,
            card: { name: "solver", at: 50 },
        });
    });

    it("breaks a same-second tie by the lower event id, as NIP-01 does", async () => {
        const a = solverKey();
        const [low, high] = [
            cardEvent(a.secret, 100, { content: '{"v":1}' }),
            cardEvent(a.secret, 100, { content: '{"v":2}' }),
        ].sort((x, y) => (x.id < y.id ? -1 : 1));
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(a.pubkey)],
            "mutinynet",
        );
        relay.deliver(high, low, high);
        relay.eose();

        expect((await pending).map((c) => c.card)).toEqual([JSON.parse(low.content)]);
    });

    it("drops a card from a key it did not ask for, or for another network", async () => {
        const a = solverKey();
        const stranger = solverKey();
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(a.pubkey)],
            "mutinynet",
        );
        relay.deliver(
            cardEvent(a.secret, 100),
            cardEvent(stranger.secret, 500),
            cardEvent(a.secret, 400, { d: "bitcoin" }),
            cardEvent(a.secret, 450, { d: null }),
        );
        relay.eose();

        expect(await pending).toEqual([
            { pubkey: a.pubkey, createdAt: 100, card: { name: "solver", at: 100 } },
        ]);
    });

    it("drops an event whose signature does not verify, before it can shadow the real card", async () => {
        const a = solverKey();
        const forged = { ...cardEvent(a.secret, 900), content: '{"name":"forged"}' };
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(a.pubkey)],
            "mutinynet",
        );
        relay.deliver(cardEvent(a.secret, 100), forged);
        relay.eose();

        expect((await pending).map((c) => c.createdAt)).toEqual([100]);
    });

    it("skips a card it cannot parse, and the older card that one replaced", async () => {
        const a = solverKey();
        const b = solverKey();
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(a.pubkey), listed(b.pubkey)],
            "mutinynet",
        );
        relay.deliver(
            cardEvent(a.secret, 100),
            cardEvent(a.secret, 200, { content: "{not json" }),
            cardEvent(b.secret, 100),
        );
        relay.eose();

        expect((await pending).map((c) => c.pubkey)).toEqual([b.pubkey]);
    });

    it("answers on EOSE, closing its subscription but never a pool it was lent", async () => {
        const a = solverKey();
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(a.pubkey)],
            "mutinynet",
        );
        relay.deliver(cardEvent(a.secret, 100));
        relay.eose();

        expect(await pending).toHaveLength(1);
        expect(relay.subscriptionClose).toHaveBeenCalledTimes(1);
        expect(relay.poolClose).not.toHaveBeenCalled();
    });

    it("answers with what arrived when the relays never finish", async () => {
        const a = solverKey();
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool, timeoutMs: 20 }).fetch(
            [listed(a.pubkey)],
            "mutinynet",
        );
        relay.deliver(cardEvent(a.secret, 100));

        expect(await pending).toHaveLength(1);
        expect(relay.subscriptionClose).toHaveBeenCalledTimes(1);
    });

    it("answers with nothing when every relay drops", async () => {
        const relay = relayStub();
        const pending = nostrCardFetcher({ pool: relay.pool }).fetch(
            [listed(solverKey().pubkey)],
            "mutinynet",
        );
        relay.dropEveryRelay();

        expect(await pending).toEqual([]);
    });

    it("opens nothing when there is no one, or nowhere, to ask", async () => {
        const subscribeMany = vi
            .spyOn(SimplePool.prototype, "subscribeMany")
            .mockImplementation(() => {
                throw new Error("opened a subscription");
            });
        const unreachable = { name: "solver", discovery_pubkey: solverKey().pubkey };

        expect(await nostrCardFetcher().fetch([], "mutinynet")).toEqual([]);
        expect(await nostrCardFetcher().fetch([unreachable], "mutinynet")).toEqual([]);
        expect(subscribeMany).not.toHaveBeenCalled();
    });

    it("tears an owned pool down through pool.close() alone", async () => {
        const subscriptionClose = vi.fn();
        vi.spyOn(SimplePool.prototype, "subscribeMany").mockImplementation(
            (_relays, _filter, params) => {
                queueMicrotask(() => params.oneose?.());
                return { close: subscriptionClose };
            },
        );
        const poolClose = vi.spyOn(SimplePool.prototype, "close").mockImplementation(() => {});

        await nostrCardFetcher().fetch(
            [listed(solverKey().pubkey, ["wss://x", "wss://y"])],
            "mutinynet",
        );
        expect(poolClose).toHaveBeenCalledWith(["wss://x", "wss://y"]);
        expect(subscriptionClose).not.toHaveBeenCalled();
    });
});
