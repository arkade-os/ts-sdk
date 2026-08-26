// Node-only live check of the discovery + quoting half of
// https://docs.arkadeos.com/intents/integrate/assets: fetch a real solver
// registry index, run it through `discoverMarkets` / `findMarket` /
// `quoteOffer` exactly as the docs page does, and assert a plan comes out.
//
// Run after `pnpm build`: `pnpm check:discovery [network] [registryUrl]`
// (defaults to mutinynet and the public Arkade registry).
//
// It also reproduces every way that flow legitimately hands back an empty
// market list, because "discover returns []" is the one symptom all of them
// share and only some of them log anything. Keeping the reproductions next to
// the happy path is the point: when a client reports no markets, this script
// says whether the registry is at fault, and if not, which client-side guard
// is the one swallowing them.
//
// Network-dependent by design (a live registry and a live price feed), so it
// is a script rather than a unit test — `test/markets.test.ts` covers the same
// wrapper against a stub fetch.
import {
    DEFAULT_MAX_AGE_SECONDS,
    bestMarket,
    discover,
    fetchIndex,
    isIndexStale,
    isNetwork,
    listMarkets,
    quoteOffer,
    sideLimits,
    validateIndex,
} from "@arkade-os/solver-discovery";
import {
    InMemoryAssetSwapRepository,
    QUOTE_OPTIONS,
    discoverMarkets,
    findMarket,
    makeCachedFeedFetch,
} from "@arkade-os/swap";

const NETWORK = process.argv[2] ?? "mutinynet";
const REGISTRY = process.argv[3] ?? `https://arkade-os.github.io/solver-registry/${NETWORK}.json`;
const GIVE_AMOUNT = "0.001";

let failures = 0;
const step = (n, title) => console.log(`\n── ${n}. ${title}\n`);
const ok = (message) => console.log(`   PASS  ${message}`);
const fail = (message) => {
    failures++;
    console.log(`   FAIL  ${message}`);
};
const info = (message) => console.log(`   ....  ${message}`);
const logger = (...args) => info(args.join(" "));

console.log(`network:  ${NETWORK}`);
console.log(`registry: ${REGISTRY}`);

// 1. The registry index itself — before any client code can be blamed.
step(1, "raw registry fetch");
const response = await fetch(REGISTRY);
info(`HTTP ${response.status} ${response.headers.get("content-type") ?? ""}`);
// a browser client dies here without it, and the failure surfaces as [] like
// every other one
info(`access-control-allow-origin: ${response.headers.get("access-control-allow-origin")}`);
const body = await response.text();
let index;
try {
    index = JSON.parse(body);
} catch {
    fail(`body is not JSON: ${body.slice(0, 120)}`);
}
if (index) {
    const ageSeconds = Math.floor(Date.now() / 1000) - index.generated_at;
    info(`version=${index.version} network=${index.network} commit=${index.commit?.slice(0, 8)}`);
    info(
        `generated_at=${index.generated_at} (${new Date(index.generated_at * 1000).toISOString()}), ` +
            `age ${(ageSeconds / 86400).toFixed(1)}d, stale past ${DEFAULT_MAX_AGE_SECONDS / 86400}d`,
    );
    const listed = index.markets ?? [];
    if (listed.length) {
        ok(
            `index lists ${listed.length} market(s): ${listed.map((m) => `${m.pair}@${m.solver}`).join(", ")}`,
        );
    } else {
        fail("the index itself lists zero markets — no client-side setting can conjure one");
    }
}

// 2. Validation, which rejects the whole index rather than the bad entry.
step(2, "index validation");
{
    const validated = validateIndex(index, NETWORK);
    validated.ok
        ? ok("validateIndex accepted the index")
        : fail(`validateIndex rejected it: ${validated.errors.join("; ")}`);

    const fetched = await fetchIndex(REGISTRY, { network: NETWORK });
    fetched.ok ? ok("fetchIndex ok") : fail(`fetchIndex failed: ${fetched.error}`);
    for (const warning of fetched.warnings) info(`warning: ${warning}`);
    if (fetched.index) {
        isIndexStale(fetched.index)
            ? fail("index is stale (>7d) — markets still load, with a warning")
            : ok("index is fresh");
    }
    // the network argument has to name the same network as the file: a
    // mismatch is a rejection, not a filter
    const mismatched = NETWORK === "signet" ? "regtest" : "signet";
    const wrongNetwork = await fetchIndex(REGISTRY, { network: mismatched });
    wrongNetwork.ok
        ? fail(`expected network "${mismatched}" to be rejected against this index`)
        : ok(`wrong expected network rejected: ${wrongNetwork.error}`);
}

// 3. discover(), the low-level call.
step(3, "discover({ registries: [url] })");
const { markets, sources, warnings } = await discover({ registries: [REGISTRY], network: NETWORK });
for (const source of sources) {
    info(
        `source ${source.source} ok=${source.ok} markets=${source.marketCount} ${source.error ?? ""}`,
    );
}
for (const warning of warnings) info(`warning: ${warning}`);
markets.length ? ok(`discover returned ${markets.length} market(s)`) : fail("discover returned []");
for (const pair of listMarkets(markets)) {
    info(
        `pair ${pair.pair}: ${pair.marketCount} market(s), ` +
            `solvable base=${pair.solvable.base} quote=${pair.solvable.quote}`,
    );
}

// 4. discoverMarkets(), the wrapper the docs page and the wallet call.
step(4, "discoverMarkets({ network, registryUrl })");
{
    const found = await discoverMarkets({ network: NETWORK, registryUrl: REGISTRY, logger });
    found.length
        ? ok(`discoverMarkets returned ${found.length} market(s)`)
        : fail("discoverMarkets returned [] against a healthy registry");
}

// 5. The empty-result reproductions, in the order worth checking a client for.
step(5, "ways this returns []");
{
    const expect = async (label, promise, empty = true) => {
        const got = await promise;
        (got.length === 0) === empty
            ? ok(`${label} ⇒ ${got.length} market(s)`)
            : fail(`${label} ⇒ ${got.length} market(s), expected ${empty ? "none" : "some"}`);
    };

    // (a) no registry URL for this network. Returns before the fetch and
    //     before the logger, so nothing is written anywhere — the quietest
    //     failure of the set, and the first thing to rule out.
    await expect(
        "registryUrl: undefined",
        discoverMarkets({ network: NETWORK, registryUrl: undefined, logger }),
    );

    // (b) a network string the client does not recognize — same silent return.
    for (const network of ["Mutinynet", "mutinynet ", "mutiny"]) {
        info(`isNetwork(${JSON.stringify(network)}) = ${isNetwork(network)}`);
        await expect(
            `network: ${JSON.stringify(network)}`,
            discoverMarkets({ network, registryUrl: REGISTRY }),
        );
    }

    // (c) calling discover() with `registryUrl` rather than `registries`: the
    //     option is ignored, zero registries are followed, and the result is []
    //     with no source and no warning to show for it.
    const misnamed = await discover({ registryUrl: REGISTRY, network: NETWORK });
    misnamed.markets.length === 0 && misnamed.sources.length === 0
        ? ok("discover({ registryUrl }) ⇒ [] with no sources and no warnings")
        : fail(`discover({ registryUrl }) ⇒ ${misnamed.markets.length} market(s)`);

    // (d) a cached [] wins for the full hour, however healthy the registry is.
    const cached = new InMemoryAssetSwapRepository();
    await cached.saveCachedMarkets(NETWORK, REGISTRY, { markets: [], fetchedAt: Date.now() });
    await expect(
        "cache holding [] (<1h old)",
        discoverMarkets({ network: NETWORK, registryUrl: REGISTRY, repository: cached }),
    );
    await expect(
        "same cache, useCache: false",
        discoverMarkets({
            network: NETWORK,
            registryUrl: REGISTRY,
            repository: cached,
            useCache: false,
        }),
        false,
    );
    const repaired = await cached.getCachedMarkets(NETWORK, REGISTRY);
    repaired?.markets.length
        ? ok(`the forced refetch rewrote the cache with ${repaired.markets.length} market(s)`)
        : fail("the forced refetch left the cache empty");

    // (e) unreachable registry and nothing cached — logged, at least.
    const unreachable = () => Promise.reject(new Error("network down"));
    await expect(
        "unreachable registry, no cache",
        discoverMarkets({
            network: NETWORK,
            registryUrl: REGISTRY,
            fetchImpl: unreachable,
            logger,
        }),
    );

    // (f) …and with a cache, however old, the last known markets stand in.
    const warm = new InMemoryAssetSwapRepository();
    await warm.saveCachedMarkets(NETWORK, REGISTRY, { markets, fetchedAt: 0 });
    await expect(
        "unreachable registry, stale cache",
        discoverMarkets({
            network: NETWORK,
            registryUrl: REGISTRY,
            repository: warm,
            fetchImpl: unreachable,
            logger,
        }),
        false,
    );
}

// 6. findMarket + quoteOffer against the live feed, as the docs page has it.
step(6, "findMarket + quoteOffer");
if (!markets.length) {
    info("skipped: nothing discovered");
} else {
    const anyBtcMarket = markets.find((market) => market.base_asset.id === "btc") ?? markets[0];
    const fromId = anyBtcMarket.base_asset.id;
    const toId = anyBtcMarket.quote_asset.id;
    info(`quoting ${anyBtcMarket.base_asset.ticker} → ${anyBtcMarket.quote_asset.ticker}`);

    const selected = findMarket(markets, fromId, toId);
    if (!selected?.market) {
        fail("findMarket found nothing for a pair the registry advertises");
    } else {
        const { market, give } = selected;
        ok(`findMarket picked ${market.pair} from ${market.solver} (give=${give})`);
        // bestMarket is what findMarket ranks with; a cursor past the last
        // match is null, which is how a UI walks to the next-best solver
        info(
            `second-best solver: ${bestMarket(markets, { baseId: fromId, quoteId: toId, cursor: 1 })?.solver ?? "none"}`,
        );
        for (const side of ["base", "quote"]) {
            const limits = sideLimits(market, side);
            info(`limits.${side}: ${limits ? `${limits.min}..${limits.max}` : "disabled"}`);
        }
        try {
            const plan = await quoteOffer(market, {
                give,
                giveAmount: GIVE_AMOUNT,
                ...QUOTE_OPTIONS,
                fetchImpl: makeCachedFeedFetch(),
            });
            ok(
                `plan: ${plan.deposit.display} ${plan.deposit.asset.ticker} → ` +
                    `${plan.receive.display} ${plan.receive.asset.ticker} @ ${plan.priceDisplay} ` +
                    `(fee ${market.fee_bps}bps, withinLimits=${plan.limits.withinLimits})`,
            );
        } catch (error) {
            fail(`quoteOffer failed: ${error.message} (price_feed: ${market.price_feed})`);
        }
    }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
