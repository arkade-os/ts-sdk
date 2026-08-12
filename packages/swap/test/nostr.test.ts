/**
 * The Nostr RFQ transport, and the two properties that fail silently if broken.
 *
 * Ported from the wallet, where this transport lived before it moved into the
 * package beside `httpTransport` and `relayTransport`.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, nip44, type Event } from "nostr-tools";
import { SwapRefusal } from "../src/rfq";
import { RFQ_AD_KIND, RFQ_DIRECTED_KIND, RelayUnavailable, nostrRfqTransport } from "../src/nostr";

/**
 * A stand-in for SimplePool that behaves like a relay the solver is also on:
 * it decrypts what the client publishes and lets the test answer as the solver.
 */
const fakePool = (solverSecret: Uint8Array) => {
    let onevent: ((e: Event) => void) | undefined;
    let onclose: ((reasons: unknown[]) => void) | undefined;
    const published: unknown[] = [];
    const seenFilters: unknown[] = [];
    const pool = {
        subscribeMany(
            _relays: string[],
            filter: unknown,
            params: { onevent: (e: Event) => void; onclose?: (reasons: unknown[]) => void },
        ) {
            seenFilters.push(filter);
            onevent = params.onevent;
            onclose = params.onclose;
            return { close: () => {} };
        },
        publish(_relays: string[], event: Event) {
            const key = nip44.v2.utils.getConversationKey(solverSecret, event.pubkey);
            published.push(JSON.parse(nip44.v2.decrypt(event.content, key)));
            return [Promise.resolve("ok")];
        },
        close() {},
    };
    /** Answer as the solver, encrypted to the client that published last. */
    const solverReplies = (clientPubkey: string, payload: unknown) => {
        const key = nip44.v2.utils.getConversationKey(solverSecret, clientPubkey);
        onevent?.({
            kind: RFQ_DIRECTED_KIND,
            pubkey: getPublicKey(solverSecret),
            content: nip44.v2.encrypt(JSON.stringify(payload), key),
            tags: [["p", clientPubkey]],
            created_at: Math.floor(Date.now() / 1000),
            id: "x",
            sig: "y",
        } as Event);
    };
    const dropEveryRelay = (reasons: unknown[]) => onclose?.(reasons);
    return { pool, published, seenFilters, solverReplies, dropEveryRelay };
};

describe("RFQ kinds", () => {
    /**
     * The RANGE, not the digits.
     *
     * The exact numbers are provisional in the spec and may still move by
     * agreement. The range may not: NIP-01 makes 20000-29999 ephemeral, and that
     * is what stops a relay retaining a negotiation. Drifting back into a stored
     * range breaks nothing an eye would catch — every other test here goes
     * through the constant and would follow it anywhere — while quietly
     * reinstating a permanent record of who negotiated what with whom.
     */
    it("keeps directed traffic inside the NIP-01 ephemeral range", () => {
        expect(RFQ_DIRECTED_KIND).toBeGreaterThanOrEqual(20_000);
        expect(RFQ_DIRECTED_KIND).toBeLessThan(30_000);
    });

    /**
     * The ad is standing state rather than a message, so it belongs in the
     * addressable range where a relay keeps the current version per solver.
     * Asserted beside the one above so the contrast is on the record: these two
     * kinds want OPPOSITE retention, and neither is a typo of the other.
     */
    it("keeps the solver ad addressable, not ephemeral", () => {
        expect(RFQ_AD_KIND).toBeGreaterThanOrEqual(30_000);
        expect(RFQ_AD_KIND).toBeLessThan(40_000);
    });

    it("subscribes on the directed kind, addressed to itself, from the solver", () => {
        const solverSecret = generateSecretKey();
        const { pool, seenFilters } = fakePool(solverSecret);
        const secretKey = generateSecretKey();
        nostrRfqTransport({
            relays: ["wss://x"],
            solverPubkey: getPublicKey(solverSecret),
            secretKey,
            pool: pool as never,
        });
        // All three matter: the kind is how a mismatch goes silent, `#p` is what
        // keeps another client's negotiation out, and `authors` is what stops a
        // stranger answering in the solver's place.
        expect(seenFilters[0]).toEqual({
            kinds: [RFQ_DIRECTED_KIND],
            "#p": [getPublicKey(secretKey)],
            authors: [getPublicKey(solverSecret)],
        });
    });
});

describe("nostrRfqTransport", () => {
    const quote = (rfqId: string) => ({ v: 1, type: "rfq_quote", rfq_id: rfqId });

    it("returns the solver's quote for the negotiation it asked about", async () => {
        const solverSecret = generateSecretKey();
        const { pool, solverReplies } = fakePool(solverSecret);
        const secretKey = generateSecretKey();
        const transport = nostrRfqTransport({
            relays: ["wss://x"],
            solverPubkey: getPublicKey(solverSecret),
            secretKey,
            pool: pool as never,
        });

        const pending = transport.requestQuote({ v: 1, type: "rfq_request", rfq_id: "abc" });
        solverReplies(getPublicKey(secretKey), quote("abc"));
        await expect(pending).resolves.toMatchObject({ rfq_id: "abc" });
        await transport.close();
    });

    it("throws a SwapRefusal rather than a value when the solver refuses", async () => {
        const solverSecret = generateSecretKey();
        const { pool, solverReplies } = fakePool(solverSecret);
        const secretKey = generateSecretKey();
        const transport = nostrRfqTransport({
            relays: ["wss://x"],
            solverPubkey: getPublicKey(solverSecret),
            secretKey,
            pool: pool as never,
        });

        const pending = transport.requestQuote({ v: 1, type: "rfq_request", rfq_id: "abc" });
        solverReplies(getPublicKey(secretKey), {
            v: 1,
            type: "rfq_refusal",
            rfq_id: "abc",
            reason: "unsupported_pair",
        });
        await expect(pending).rejects.toBeInstanceOf(SwapRefusal);
        await transport.close();
    });

    it("ignores a reply for a different negotiation", async () => {
        const solverSecret = generateSecretKey();
        const { pool, solverReplies } = fakePool(solverSecret);
        const secretKey = generateSecretKey();
        const transport = nostrRfqTransport({
            relays: ["wss://x"],
            solverPubkey: getPublicKey(solverSecret),
            secretKey,
            pool: pool as never,
            timeoutMs: 60,
        });

        const pending = transport.requestQuote({ v: 1, type: "rfq_request", rfq_id: "abc" });
        // Answer for someone else's rfq_id: on a shared relay this arrives on the
        // same subscription, and accepting it would answer the wrong negotiation.
        solverReplies(getPublicKey(secretKey), quote("other"));
        await expect(pending).rejects.toThrow(/no solver reply/);
        await transport.close();
    });

    /**
     * A dropped subscription and a silent solver look identical from here, and
     * mean opposite things. Both shapes of `onclose` payload nostr-tools has
     * used across its 2.x line are exercised, because the package declares a
     * peer range spanning both and would otherwise only work against one.
     */
    it.each([
        ["legacy string[]", ["relay closed"]],
        ["current {url,reason}[]", [{ url: "wss://x", reason: "closed" }]],
    ])("fails as RelayUnavailable when every relay drops (%s)", async (_name, reasons) => {
        const solverSecret = generateSecretKey();
        const { pool, dropEveryRelay } = fakePool(solverSecret);
        const transport = nostrRfqTransport({
            relays: ["wss://x"],
            solverPubkey: getPublicKey(solverSecret),
            secretKey: generateSecretKey(),
            pool: pool as never,
        });

        const pending = transport.requestQuote({ v: 1, type: "rfq_request", rfq_id: "abc" });
        dropEveryRelay(reasons);
        await expect(pending).rejects.toBeInstanceOf(RelayUnavailable);
        await transport.close();
    });

    it("times out rather than hanging when the solver never answers", async () => {
        const solverSecret = generateSecretKey();
        const { pool } = fakePool(solverSecret);
        const transport = nostrRfqTransport({
            relays: ["wss://x"],
            solverPubkey: getPublicKey(solverSecret),
            secretKey: generateSecretKey(),
            pool: pool as never,
            timeoutMs: 40,
        });

        await expect(
            transport.requestQuote({ v: 1, type: "rfq_request", rfq_id: "abc" }),
        ).rejects.toThrow(/no solver reply within 40ms/);
        await transport.close();
    });
});
