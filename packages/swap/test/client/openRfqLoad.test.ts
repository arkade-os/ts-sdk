import { afterEach, expect, it, vi } from "vitest";
import { createSwapClient } from "../../src/client/client";
import { btcOn } from "../../src/client/assetId";
import { hdWallet, USD_ASSET_ID } from "./fixtures";
import type { OpenRfqRequest } from "../../src/openRfq";

const state = vi.hoisted(() => ({ collect: vi.fn(async (_request: OpenRfqRequest) => []) }));
vi.mock("../../src/openRfqTransport", async () => {
    vi.setSystemTime(Date.now() + 10_000);
    return { collectOpenRfqBids: state.collect };
});
afterEach(() => vi.useRealTimers());

it("starts the bid deadline after a cold transport module has loaded", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const client = createSwapClient({
        wallet: await hdWallet(),
        discovery: { snapshot: [] },
        policy: { drive: "manual" },
    });
    await client.openRfq(
        {
            give: btcOn("arkade", "regtest"),
            take: `arkade:regtest/asset:${USD_ASSET_ID}`,
            amount: 25_000n,
            amountOn: "give",
        },
        { secretKey: new Uint8Array(32).fill(5), windowMs: 500, relays: ["wss://relay.example"] },
    );
    expect(state.collect.mock.calls[0]?.[0]).toMatchObject({ bidsUntil: now + 11 });
    await client[Symbol.asyncDispose]();
});
