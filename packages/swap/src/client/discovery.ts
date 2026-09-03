/**
 * Discovery, and the three states one `DiscoveredMarket[]` used to collapse.
 *
 * `discoverMarkets` answers one array for three different situations: no
 * registry configured (or a network with no published index), a stale cache
 * served because every source failed, and a reachable registry that lists
 * nothing. They are not the same answer and they do not deserve the same
 * behaviour, so this module separates them and carries the difference on the
 * snapshot rather than in a comment:
 *
 * - **No data at all** — no registry, an unindexed network, or an unreachable
 *   one with nothing cached — is {@link DiscoverySnapshotUnavailable}. There is
 *   no route state for "resolved against nothing".
 * - **A stale cache** resolves and prices, and is marked stale. It is still a
 *   snapshot; what it cannot do is supply the key an addressed RFQ's responder
 *   is checked against (see `live` below).
 * - **Reachable and empty** is a snapshot like any other, with no markets in it.
 *   The route resolves; `quote()` is where an empty eligible set becomes
 *   `UnsupportedRoute`.
 *
 * It wraps discovery rather than `discoverMarkets`, and the reason is the same
 * separation: `discover()` reports per-source outcomes and `discoverMarkets`
 * spends them on the way out. `discoverMarkets` itself is untouched — the
 * wallet's own wrapper around it keeps working — and the cache is the same
 * entry under the same key, so a v1 read warms a v2 quote and back.
 *
 * The cache is also a trust boundary. `isMarketShaped` revalidates four fields
 * on read and trusts the rest, `discovery_pubkey` and `transports` included, and
 * those two are precisely what an addressed RFQ addresses itself to. So a cached
 * card is revalidated here against every field this client depends on, and a
 * snapshot that came out of the cache is marked `live: false` — the responder
 * check refuses to pin against cache content whatever its shape.
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
import { isIndexedNetwork } from "./aliases";
import { CORRIDORS } from "./corridor";
import { DiscoverySnapshotUnavailable } from "./errors";
import type { SnapshotRef } from "./quote";

/** Where the client's market data comes from. Every field is optional: a
 * client with none of it resolves against nothing and says so. */
export interface DiscoveryConfig {
    /**
     * The network's solver registry index URL.
     *
     * Config rather than an inference: nothing in the wallet, the operator info
     * or this package names a registry, so "inferred from the wallet" reaches
     * only as far as the network. Absent means no source at all, which is the
     * unavailable case and not an empty market set.
     */
    readonly registryUrl?: string;
    /** Locally pinned solver cards, merged with the registry's. */
    readonly localCards?: readonly LocalCardInput[];
    /**
     * Markets to resolve against without touching the network.
     *
     * Caller-supplied and therefore trusted the way config is: an injected
     * snapshot can pin an RFQ responder, where a cached one cannot.
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

const isRelayList = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_RELAYS &&
    value.every((relay) => typeof relay === "string" && relay.startsWith("wss://"));

const isCorridorField = (value: unknown): boolean =>
    value === undefined || (CORRIDORS as readonly string[]).includes(value as string);

/**
 * Whether a card read back out of the cache is one this client may act on.
 *
 * Wider than `isMarketShaped`, and deliberately so: that predicate guards the
 * v1 pricing path, which reads asset ids and decimals, where this one guards a
 * path that also addresses a solver over a rendezvous the card names. A stored
 * entry outlives the schema that wrote it AND the storage it sits in, so every
 * field the client depends on is re-checked rather than four of them.
 */
export const isUsableCard = (value: unknown): value is DiscoveredMarket => {
    const card = value as Partial<DiscoveredMarket> | null;
    if (
        typeof card?.pair !== "string" ||
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
    // A corridor market is addressed, not just priced: without a key to encrypt
    // to and a relay to reach, it is a card no quote can be requested from —
    // and both fields are exactly what the old read trusted.
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
        // Card by card rather than all-or-nothing: one card whose schema moved
        // should cost that card, not every market on the network.
        const markets = entry.markets.filter(isUsableCard);
        return { markets, fetchedAt: entry.fetchedAt };
    } catch {
        // A missing, malformed or unreadable cache reads as a miss, exactly as
        // the v1 read does — the refetch overwrites it.
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
 * Holds at most one snapshot and hands the same one back until it ages out or a
 * caller asks for a refresh, so a `resolve()` and the `quote()` after it agree
 * on what the market was — two loads a second apart returning different cards
 * would make the resolution the caller vetoed a different one from the quote
 * they got.
 */
export const discoveryIndex = (input: DiscoveryIndexInput): DiscoveryIndex => {
    const config = input.config ?? {};
    const network = config.network ?? input.network;
    const registry = config.registryUrl;

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
        if (!registry) return "no registry URL is configured, and no snapshot was injected";
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
                // The cards were read back out of local storage, whatever their
                // age: nothing here can attest that a registry ever served them.
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
            // Nothing to fetch from. The cache is keyed by registry, so there is
            // nothing to fall back to either.
            return unavailable(whyUnavailable());
        }

        const result = await discover({
            registries: [url],
            localCards: [...(config.localCards ?? [])],
            network: indexed,
            fetchImpl: config.fetchImpl,
        });
        if (result.warnings.length) config.logger?.("solver discovery:", ...result.warnings);

        // Reachable is per-source and not per-market: a registry that answers
        // with an empty index is authoritative about there being no market,
        // which is a different fact from not having answered.
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
                    // Best effort, as in v1: a lost cache write costs one refetch.
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
