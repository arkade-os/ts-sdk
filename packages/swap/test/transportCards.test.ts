import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimplePool } from "nostr-tools";
import { discover, type TransportCardFetcher } from "@arkade-os/solver-discovery";
import { discoveryIndex } from "../src/client/discovery";
import { discoverMarkets } from "../src/markets";

vi.mock("@arkade-os/solver-discovery", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@arkade-os/solver-discovery")>()),
    discover: vi.fn(async () => ({
        markets: [],
        sources: [
            {
                source: "https://registry.example/regtest.json",
                sourceType: "registry",
                ok: true,
                marketCount: 0,
                warnings: [],
            },
        ],
        warnings: [],
    })),
}));

const REGISTRY = "https://registry.example/regtest.json";
const PUBKEY = "ab".repeat(32);

const handed = () => vi.mocked(discover).mock.calls.at(-1)?.[0].transportCards;

beforeEach(() => {
    vi.mocked(discover).mockClear();
});
afterEach(() => {
    vi.restoreAllMocks();
});

type Option = { transportCards?: TransportCardFetcher | null };

describe.each([
    [
        "discoveryIndex",
        (option: Option) =>
            discoveryIndex({
                network: "regtest",
                config: { registryUrl: REGISTRY, ...option },
            }).load(),
    ],
    [
        "discoverMarkets",
        (option: Option) =>
            discoverMarkets({ network: "regtest", registryUrl: REGISTRY, ...option }),
    ],
])("%s", (_name, discoverWith) => {
    it("hands discovery the Nostr card fetcher when none is configured", async () => {
        await discoverWith({});
        const filters: unknown[] = [];
        vi.spyOn(SimplePool.prototype, "subscribeMany").mockImplementation(
            (_relays, filter, params) => {
                filters.push(filter);
                queueMicrotask(() => params.oneose?.());
                return { close: () => {} };
            },
        );
        vi.spyOn(SimplePool.prototype, "close").mockImplementation(() => {});

        const solver = {
            name: "solver",
            discovery_pubkey: PUBKEY,
            transports: { nostr: { relays: ["wss://relay.example"] } },
        };
        expect(await handed()?.fetch([solver], "regtest")).toEqual([]);
        expect(filters).toEqual([{ kinds: [38859], authors: [PUBKEY], "#d": ["regtest"] }]);
    });

    it("hands it no fetcher when transport cards are opted out", async () => {
        await discoverWith({ transportCards: null });
        expect(discover).toHaveBeenCalledTimes(1);
        expect(handed()).toBeUndefined();
    });

    it("hands it the caller's own fetcher", async () => {
        const own: TransportCardFetcher = { fetch: async () => [] };
        await discoverWith({ transportCards: own });
        expect(handed()).toBe(own);
    });
});
