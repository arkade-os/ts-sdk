import { afterEach, describe, expect, it, vi } from "vitest";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip44,
    type Event,
    type SimplePool,
} from "nostr-tools";
import { collectOpenRfqBids } from "../src/openRfqTransport";
import type { OpenRfqRequest } from "../src/openRfq";

const request = (): OpenRfqRequest => ({
    openId: "a".repeat(64),
    pair: "arkade:bitcoin/slip44:0->arkade:bitcoin/asset:abcd",
    amountSide: "from",
    amount: 10_000n,
    bidsUntil: Math.floor(Date.now() / 1000) + 10,
});

const fixture = (outcome: () => Promise<string> = () => Promise.resolve("ok")) => {
    const clientKey = generateSecretKey();
    const solverKey = generateSecretKey();
    const close = vi.fn();
    const destroy = vi.fn();
    let receive: ((event: Event) => void) | undefined;
    let lost: ((reasons: string[]) => void) | undefined;
    let published: Event | undefined;
    const pool = {
        subscribeMany: vi.fn(
            (
                _relays: string[],
                _filter: unknown,
                handlers: {
                    onevent: (event: Event) => void;
                    onclose?: (reasons: string[]) => void;
                },
            ) => {
                receive = handlers.onevent;
                lost = handlers.onclose;
                return { close };
            },
        ),
        publish: vi.fn((_relays: string[], event: Event) => {
            published = event;
            return [outcome()];
        }),
        destroy,
        close: vi.fn(),
    };
    const makeBid = (
        changes: Record<string, unknown> = {},
        eventChanges: Record<string, unknown> = {},
        signer = solverKey,
    ) => {
        const open = JSON.parse(published!.content);
        const key = nip44.v2.utils.getConversationKey(signer, getPublicKey(clientKey));
        const event = finalizeEvent(
            {
                kind: 24859,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["p", getPublicKey(clientKey)],
                    ["e", published!.id],
                ],
                content: nip44.v2.encrypt(
                    JSON.stringify({
                        v: 1,
                        type: "rfq_bid",
                        open_id: open.open_id,
                        pair: open.pair,
                        amount_side: open.amount_side,
                        from_amount: open.amount,
                        to_amount: "123000000000000000001",
                        valid_until: open.bids_until + 20,
                        card: { signed: true },
                        ...changes,
                    }),
                    key,
                ),
                ...eventChanges,
            },
            signer,
        );
        return event;
    };
    const bid = (...args: Parameters<typeof makeBid>) => {
        const event = JSON.parse(JSON.stringify(makeBid(...args))) as Event;
        receive?.(event);
        return event;
    };
    return {
        clientKey,
        solverKey,
        pool,
        close,
        destroy,
        bid,
        makeBid,
        get published() {
            return published;
        },
        drop: () => lost?.(["disconnected"]),
        inject: (event: Event) => receive?.(event),
        options: {
            relays: ["wss://relay.test"],
            secretKey: clientKey,
            pool: pool as unknown as SimplePool,
            windowMs: 1_000,
        },
    };
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("open RFQ collection", () => {
    it("publishes a public size only and collects sealed prices without owning the pool", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const onBids = vi.fn();
        const result = collectOpenRfqBids(request(), { ...f.options, onBids });
        expect(f.pool.subscribeMany.mock.invocationCallOrder[0]).toBeLessThan(
            f.pool.publish.mock.invocationCallOrder[0]!,
        );
        expect(f.published?.kind).toBe(24860);
        expect(JSON.parse(f.published!.content).v).toBe(1);
        expect(f.published?.tags).toEqual([["t", request().pair]]);
        expect(Object.keys(JSON.parse(f.published!.content))).toEqual([
            "v",
            "type",
            "open_id",
            "pair",
            "amount_side",
            "amount",
            "bids_until",
        ]);
        f.bid();
        await vi.advanceTimersByTimeAsync(1_000);
        const bids = await result;
        expect(bids).toHaveLength(1);
        expect(bids[0]?.toAmount).toBe(123000000000000000001n);
        expect(onBids).toHaveBeenCalledTimes(1);
        expect(f.close).toHaveBeenCalledOnce();
        expect(f.destroy).not.toHaveBeenCalled();
        expect(f.pool.close).not.toHaveBeenCalled();
    });

    it("drops invalid signatures, foreign references, stale prices and amount changes", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const result = collectOpenRfqBids(request(), f.options);
        f.bid({ open_id: "foreign" });
        f.bid(
            {},
            {
                tags: [
                    ["p", "a".repeat(64)],
                    ["e", f.published!.id],
                ],
            },
        );
        f.bid(
            {},
            {
                tags: [
                    ["p", getPublicKey(f.clientKey)],
                    ["e", "a".repeat(64)],
                ],
            },
        );
        f.bid({}, { kind: 24860 });
        f.bid({}, { created_at: Math.floor(Date.now() / 1000) - 60 });
        f.bid({ pair: "arkade:bitcoin/slip44:0->bolt11:bitcoin/slip44:0" });
        f.bid({ valid_until: Math.floor(Date.now() / 1000) });
        f.bid({ from_amount: "9999" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toEqual([]);
    });

    it("drops an otherwise valid reply with an invalid signature", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const result = collectOpenRfqBids(request(), f.options);
        const reply = JSON.parse(JSON.stringify(f.makeBid())) as Event;
        f.inject({ ...reply, sig: "0".repeat(128) });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toEqual([]);
    });

    it.each(["from", "to"] as const)(
        "retains a better late bid at capacity for an exact-%s request",
        async (amountSide) => {
            vi.useFakeTimers();
            const f = fixture();
            const result = collectOpenRfqBids({ ...request(), amountSide }, f.options);
            for (let i = 0; i < 64; i++) {
                const counter = String(100 + i);
                f.bid(
                    amountSide === "from"
                        ? { to_amount: counter }
                        : { from_amount: counter, to_amount: "10000" },
                    {},
                    generateSecretKey(),
                );
            }
            const better = f.bid(
                amountSide === "from"
                    ? { to_amount: "999" }
                    : { from_amount: "1", to_amount: "10000" },
                {},
                generateSecretKey(),
            );
            const worse = f.bid(
                amountSide === "from"
                    ? { to_amount: "1" }
                    : { from_amount: "999", to_amount: "10000" },
                {},
                generateSecretKey(),
            );
            await vi.advanceTimersByTimeAsync(1_000);
            const bids = await result;
            expect(bids).toHaveLength(64);
            expect(bids[0]?.id).toBe(better.id);
            expect(bids.some((bid) => bid.id === worse.id)).toBe(false);
        },
    );

    it("bounds authenticated reply decryptions while preserving an admitted bid", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const decrypt = vi.spyOn(nip44.v2, "decrypt");
        const result = collectOpenRfqBids(request(), f.options);
        const admitted = f.bid();
        const malformed = f.makeBid({ open_id: "foreign" });
        for (let i = 0; i < 255; i++) {
            f.inject(
                finalizeEvent(
                    {
                        kind: malformed.kind,
                        created_at: malformed.created_at,
                        tags: [...malformed.tags, ["nonce", String(i)]],
                        content: malformed.content,
                    },
                    f.solverKey,
                ),
            );
        }
        f.inject(f.makeBid({ to_amount: "123000000000000000002" }));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(decrypt).toHaveBeenCalledTimes(256);
        expect((await result).map((bid) => bid.id)).toEqual([admitted.id]);
    });

    it("ignores sealed replies using another open RFQ wire version", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const result = collectOpenRfqBids(request(), f.options);
        f.bid({ v: 2 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toEqual([]);
    });

    it("keeps an improved bid when a worse revision or replay follows", async () => {
        vi.useFakeTimers();
        const f = fixture();
        const result = collectOpenRfqBids(request(), f.options);
        const first = f.bid();
        f.bid({ to_amount: "123000000000000000003" });
        f.inject(first);
        f.bid({ to_amount: "123000000000000000002" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await result)[0]?.toAmount).toBe(123000000000000000003n);
    });

    it("ends at its original deadline even if every relay publish stalls", async () => {
        vi.useFakeTimers();
        const f = fixture(() => new Promise(() => {}));
        const result = collectOpenRfqBids(request(), f.options);
        const rejection = expect(result).rejects.toThrow("no relay accepted");
        await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
        expect(f.close).toHaveBeenCalledOnce();
    });

    it("keeps an admitted bid while every relay acknowledgement stalls", async () => {
        vi.useFakeTimers();
        const f = fixture(() => new Promise(() => {}));
        const result = collectOpenRfqBids(request(), f.options);
        f.bid();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toHaveLength(1);
    });

    it("keeps an admitted bid when the relay acknowledgement later fails", async () => {
        vi.useFakeTimers();
        let fail!: () => void;
        const f = fixture(
            () =>
                new Promise((_, reject) => {
                    fail = () => reject(new Error("blocked"));
                }),
        );
        const result = collectOpenRfqBids(request(), f.options);
        f.bid();
        fail();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toHaveLength(1);
    });

    it("treats a resolved connection failure as a rejected publication", async () => {
        const f = fixture(() => Promise.resolve("connection failure: offline"));
        await expect(collectOpenRfqBids(request(), f.options)).rejects.toThrow("no relay accepted");
        expect(f.close).toHaveBeenCalledOnce();
    });

    it("aborts immediately and closes only its subscription", async () => {
        const f = fixture();
        const controller = new AbortController();
        const result = collectOpenRfqBids(request(), { ...f.options, signal: controller.signal });
        controller.abort(new Error("cancelled"));
        await expect(result).rejects.toThrow("cancelled");
        expect(f.close).toHaveBeenCalledOnce();
        expect(f.destroy).not.toHaveBeenCalled();
    });

    it("reports all relays lost before the bid window ends", async () => {
        const f = fixture();
        const result = collectOpenRfqBids(request(), f.options);
        f.drop();
        await expect(result).rejects.toThrow("disconnected");
        expect(f.close).toHaveBeenCalledOnce();
    });
});
