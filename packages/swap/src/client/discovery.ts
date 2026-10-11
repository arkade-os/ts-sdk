/**
 * Discovery, separating the three states `discoverMarkets` collapses into one array:
 *
 * - **No data at all** (no registry, unindexed network, or unreachable with nothing
 *   cached) is {@link DiscoverySnapshotUnavailable}.
 * - **A stale cache** resolves and prices, but is `live: false` and cannot supply the
 *   key an addressed RFQ's responder is checked against.
 * - **Reachable and empty** is an ordinary snapshot; `quote()` turns an empty eligible
 *   set into `UnsupportedRoute`.
 *
 * Wraps `discover()` directly for its per-source outcomes; the cache entry and key are
 * shared with v1's `discoverMarkets`.
 *
 * The cache is a trust boundary: v1's `isMarketShaped` trusts `discovery_pubkey` and
 * `transports`, exactly what an addressed RFQ targets, so cached cards are revalidated
 * here in full and never pin a responder.
 */
import {
    MAX_RELAYS,
    discover,
    isRfqMarket,
    type DiscoveredMarket,
    type LocalCardInput,
    type Network as IndexedNetwork,
} from "@arkade-os/solver-discovery";
import type { NetworkName } from "@arkade-os/sdk";
import { MARKETS_CACHE_TTL_MS } from "../markets";
import type { AssetSwapRepository } from "../repository";
import { marketAssetId } from "../marketShape";
import { isIndexedNetwork } from "./aliases";
import { isAssetId } from "./assetId";
import { CORRIDORS } from "./corridor";
import { DiscoverySnapshotUnavailable } from "./errors";
import type { SnapshotRef } from "./quote";

/**
 * The default solver registry index per network (the registry's CI publishes one,
 * possibly empty, for each). An explicit `registryUrl` overrides it; `null` opts out.
 */
export const REGISTRY_URL: Record<IndexedNetwork, string> = {
    bitcoin: "https://arkade-os.github.io/solver-registry/bitcoin.json",
    signet: "https://arkade-os.github.io/solver-registry/signet.json",
    mutinynet: "https://arkade-os.github.io/solver-registry/mutinynet.json",
    regtest: "https://arkade-os.github.io/solver-registry/regtest.json",
};

/** Where the client's market data comes from. Every field is optional: absent
 * registry config falls back to {@link REGISTRY_URL} for the wallet's network,
 * and an injected snapshot needs no registry at all. */
export interface DiscoveryConfig {
    /**
     * The network's solver registry index URL. Absent means {@link REGISTRY_URL}; `null`
     * opts out, which without an injected snapshot is the unavailable case, not an empty
     * market set.
     */
    readonly registryUrl?: string | null;
    /** Locally pinned solver cards, merged with the registry's. */
    readonly localCards?: readonly LocalCardInput[];
    /**
     * Markets to resolve against without touching the network. Trusted like config: an
     * injected snapshot can pin an RFQ responder, a cached one cannot.
     */
    readonly snapshot?: readonly DiscoveredMarket[];
    /** Overrides the network the wallet reports. For tests and multi-network hosts. */
    readonly network?: IndexedNetwork;
    readonly fetchImpl?: typeof fetch;
    /** Receives discovery warnings (stale index, skipped cards, …). */
    readonly logger?: (...args: unknown[]) => void;
}

/** A market set, and where it came from. */
export interface DiscoverySnapshot {
    readonly markets: readonly DiscoveredMarket[];
    readonly ref: SnapshotRef;
}

export interface DiscoveryIndex {
    /**
     * The snapshot in hand, without touching the network — an injected one, one
     * this client already loaded, or the repository's cache.
     *
     * @throws {DiscoverySnapshotUnavailable} when there is none.
     */
    peek(): Promise<DiscoverySnapshot>;
    /**
     * A snapshot, fetching when there is none in hand or when asked to refresh.
     *
     * @throws {DiscoverySnapshotUnavailable} when the fetch leaves it with
     *   nothing either.
     */
    load(opts?: { refresh?: boolean }): Promise<DiscoverySnapshot>;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const LEGACY_ASSET_ID = /^(?:btc|[0-9a-f]{68})$/;

const isRelayList = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_RELAYS &&
    value.every((relay) => typeof relay === "string" && relay.startsWith("wss://"));

const isCorridorField = (value: unknown): boolean =>
    value === undefined || (CORRIDORS as readonly string[]).includes(value as string);

/**
 * Whether a card read back out of the cache is one this client may act on. Stricter
 * than v1's `isMarketShaped` because this path also addresses a solver over the
 * rendezvous the card names, so every field the client depends on is re-checked.
 */
export const isUsableCard = (value: unknown): value is DiscoveredMarket => {
    const card = value as Partial<DiscoveredMarket> | null;
    if (!card) return false;
    if (
        (card.pair !== undefined && typeof card.pair !== "string") ||
        typeof card.solver !== "string" ||
        typeof card.source !== "string" ||
        (card.sourceType !== "registry" && card.sourceType !== "local") ||
        typeof card.base_asset?.id !== "string" ||
        typeof card.quote_asset?.id !== "string" ||
        typeof card.base_asset.decimals !== "number" ||
        typeof card.quote_asset.decimals !== "number" ||
        !isCorridorField(card.base_corridor) ||
        !isCorridorField(card.quote_corridor)
    ) {
        return false;
    }
    for (const side of ["base", "quote"] as const) {
        const id = marketAssetId(card, side);
        if (id === undefined || (!isAssetId(id) && !LEGACY_ASSET_ID.test(id))) return false;
    }
    // An RFQ market needs a key to encrypt to and a relay to reach.
    if (isRfqMarket(card)) {
        if (typeof card.discovery_pubkey !== "string" || !HEX_64.test(card.discovery_pubkey)) {
            return false;
        }
        if (!isRelayList(card.transports?.nostr?.relays)) return false;
    }
    return true;
};

/** The cached entry for this network and registry, revalidated card by card. */
const readCache = async (
    repository: AssetSwapRepository,
    network: IndexedNetwork,
    registry: string,
): Promise<{ markets: DiscoveredMarket[]; fetchedAt: number } | undefined> => {
    try {
        const entry = await repository.getCachedMarkets(network, registry);
        if (!Array.isArray(entry?.markets) || typeof entry?.fetchedAt !== "number") return;
        // Card by card: one card whose schema moved costs only that card.
        const markets = entry.markets.filter(isUsableCard);
        return { markets, fetchedAt: entry.fetchedAt };
    } catch {
        return undefined;
    }
};

export interface DiscoveryIndexInput {
    /** The network the wallet reported. */
    readonly network: NetworkName;
    readonly config?: DiscoveryConfig;
    /** Backs the shared markets cache. Without one, every load hits the registry. */
    readonly repository?: AssetSwapRepository;
}

/**
 * One client's view of the market index.
 *
 * Holds one snapshot until it ages out or a refresh is asked for, so a `resolve()` and
 * the `quote()` after it agree on what the market was.
 */
export const discoveryIndex = (input: DiscoveryIndexInput): DiscoveryIndex => {
    const config = input.config ?? {};
    const network = config.network ?? input.network;
    const registry =
        config.registryUrl === undefined
            ? isIndexedNetwork(network)
                ? REGISTRY_URL[network]
                : undefined
            : (config.registryUrl ?? undefined);

    const injected: DiscoverySnapshot | undefined = config.snapshot && {
        markets: config.snapshot,
        ref: { fetchedAt: Date.now(), live: true, source: "injected" },
    };

    let held: DiscoverySnapshot | undefined;

    const unavailable = (detail: string): never => {
        throw new DiscoverySnapshotUnavailable(input.network, detail);
    };

    /** Everything a snapshot needs before a registry can be asked at all. */
    const sources = ():
        | { network: IndexedNetwork; registry: string }
        | { network?: undefined; registry?: undefined } => {
        if (!isIndexedNetwork(network)) return {};
        if (!registry) return {};
        return { network, registry };
    };

    const whyUnavailable = (): string => {
        if (!isIndexedNetwork(network)) return `no market index is published for ${network}`;
        if (!registry)
            return "the registry was disabled and no snapshot was injected (registryUrl: null)";
        return `the registry ${registry} could not be reached and nothing is cached`;
    };

    const fromCache = async (): Promise<DiscoverySnapshot | undefined> => {
        const { network: indexed, registry: url } = sources();
        if (!indexed || !url || !input.repository) return undefined;
        const cached = await readCache(input.repository, indexed, url);
        if (!cached) return undefined;
        return {
            markets: cached.markets,
            ref: {
                fetchedAt: cached.fetchedAt,
                // Whatever its age: nothing attests a registry ever served these cards.
                live: false,
                source: "cache",
                registry: url,
            },
        };
    };

    const peek = async (): Promise<DiscoverySnapshot> => {
        if (injected) return injected;
        if (held) return held;
        const cached = await fromCache();
        if (cached) {
            held = cached;
            return cached;
        }
        return unavailable(whyUnavailable());
    };

    const load = async (opts: { refresh?: boolean } = {}): Promise<DiscoverySnapshot> => {
        if (injected) return injected;
        const fresh =
            held?.ref.live === true && Date.now() - held.ref.fetchedAt < MARKETS_CACHE_TTL_MS;
        if (fresh && !opts.refresh) return held as DiscoverySnapshot;

        const { network: indexed, registry: url } = sources();
        if (!indexed || !url) {
            // The cache is keyed by registry, so there is no fallback either.
            return unavailable(whyUnavailable());
        }

        const result = await discover({
            registries: [url],
            localCards: [...(config.localCards ?? [])],
            network: indexed,
            fetchImpl: config.fetchImpl,
        });
        if (result.warnings.length) config.logger?.("solver discovery:", ...result.warnings);

        // A registry answering with an empty index is authoritative about there being no
        // market, unlike one that did not answer.
        if (result.sources.some((source) => source.ok)) {
            const fetchedAt = Date.now();
            held = {
                markets: result.markets,
                ref: { fetchedAt, live: true, source: "live", registry: url },
            };
            if (input.repository) {
                try {
                    await input.repository.saveCachedMarkets(indexed, url, {
                        markets: result.markets,
                        fetchedAt,
                    });
                } catch {
                    // Best effort: a lost cache write costs one refetch.
                }
            }
            return held;
        }

        const cached = await fromCache();
        if (cached) {
            held = cached;
            return cached;
        }
        return unavailable(whyUnavailable());
    };

    return { peek, load };
};
