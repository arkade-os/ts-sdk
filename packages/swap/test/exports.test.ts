/**
 * The root boundary, asserted in both directions — and, beside it, the
 * M8 disposition diff.
 *
 * Until the curation, `src/index.ts` was `export * from "./client"`, ~160
 * value exports on the root, and this file's last assertion PERMITTED all of
 * them: any name the client barrel carried counted as disposed. That made the
 * test a description of the barrel rather than a guard on the boundary — a
 * new internal landing in a client module silently became public API here.
 *
 * The rule now is exact membership. `CURATED_ROOT` is the whole public
 * surface — the client factory, the three verbs, the route/amount/asset
 * vocabulary, the sixteen-member error taxonomy, the durable record, the
 * storage backends and the payment rails — and the root inventory must equal
 * it: a name missing is a broken consumer, a name added is a support promise
 * nobody made. Everything else the client modules define lives at
 * `@arkade-os/swap/advanced`, and the last block diffs THAT boundary the same
 * way: internals must be present there and absent here.
 *
 * The disposition record half is unchanged: every name M8 ruled on is either
 * on the root (S, and the renamed R pair), on the `/protocol` floor (P), or
 * gone (I, D), and `scripts/dispositions.json` drifting from the barrels fails
 * here rather than at a consumer's first import.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    ADVANCED_ENTRY,
    CLIENT_ENTRY,
    PROTOCOL_ENTRY,
    ROOT_ENTRY,
    SWAP_ROOT,
    inventory,
} from "../scripts/export-inventory.mjs";

const dispositions = JSON.parse(
    readFileSync(resolve(SWAP_ROOT, "scripts/dispositions.json"), "utf8"),
);
const { S, P, I, D, R } = dispositions;

const namesOf = (entry: string) => new Set(inventory(entry).map((e) => e.name));
const moduleOf = (entry: string) =>
    // Posix separators: the module path is asserted against a `src/...` pattern,
    // which a Windows checkout would otherwise spell with backslashes.
    new Map(inventory(entry).map((e) => [e.name, e.module.replaceAll("\\", "/")] as const));

const root = namesOf(ROOT_ENTRY);
const client = namesOf(CLIENT_ENTRY);
const protocol = namesOf(PROTOCOL_ENTRY);
const advanced = namesOf(ADVANCED_ENTRY);

/**
 * The root, by exact membership. Grouped the way `src/index.ts` is, so a name
 * moving between groups reads as the curation changing, not as noise.
 */
const CURATED_ROOT: readonly string[] = [
    // The client: factory, object, config, and the config's field types.
    "createSwapClient",
    "SwapClient",
    "SwapClientConfig",
    "SwapFilter",
    "DiscoveryConfig",
    "DiscoverySnapshot",
    "REGISTRY_URL",
    "CorridorOverrides",
    "DriveMode",
    "RfqAuctionPolicy",
    "SwapPolicy",
    "RfqTransportFactory",
    // The verbs and their option/return vocabulary.
    "pay",
    "receive",
    "exchange",
    "PayOptions",
    "PayResult",
    "ReceiveOptions",
    "ReceiveRequest",
    "ReceiveArtifact",
    "ExchangeOptions",
    "FeeCeiling",
    "VerbDeps",
    // The route vocabulary: the closed union and the quoted terms.
    "Route",
    "AssetOn",
    "Endpoint",
    "Ep",
    "Instrument",
    "Artifact",
    "DepositArtifact",
    "CorridorId",
    "Quote",
    "QuoteInput",
    "QuoteId",
    "QuoteLeg",
    "AssetRef",
    "PinnedAmount",
    "MarketRef",
    "CardMarketRef",
    "AuctionMarketRef",
    "AuctionProvenance",
    "MarketBackend",
    "Market",
    "RankedBid",
    "ResolvedEndpoint",
    "RouteResolution",
    "SnapshotRef",
    // Asset ids and the alias layer.
    "AssetId",
    "ParsedAssetId",
    "AssetPart",
    "AssetNamespace",
    "Rail",
    "BitcoinRail",
    "NetworkRef",
    "AssetIdError",
    "AssetIdRefusal",
    "RAILS",
    "BITCOIN_RAILS",
    "BTC_ASSET_PART",
    "ARKADE_ASSET_NAMESPACE",
    "btcOn",
    "arkadeAsset",
    "canonicalAssetId",
    "parseAssetId",
    "formatAssetId",
    "isAssetId",
    "isNetworkRef",
    "sameAsset",
    "assetPartOf",
    "railOf",
    "issuanceOf",
    "bitcoinNetworkOf",
    "AssetAliasTable",
    "RegisteredAsset",
    // Amounts.
    "Amount",
    "AmountFormatError",
    "AtomicDecimal",
    "DisplayDecimal",
    "AssetScale",
    "AmountRefusal",
    "isAtomicDecimal",
    "toAtomicDecimal",
    "fromAtomicDecimal",
    // The sixteen-member error taxonomy, its base, list and guard — and the
    // one drive error the public client throws off the taxonomy.
    "AcceptConflict",
    "AmbiguousDestination",
    "AmountEncodingUnsupported",
    "AmountMismatch",
    "ClientDisposed",
    "DiscoverySnapshotUnavailable",
    "InconsistentRoute",
    "InsufficientFunds",
    "MaxFeeExceeded",
    "MissingCorridorDep",
    "NotCancellable",
    "OperatorUnreachable",
    "QuoteExpired",
    "QuoteVerificationFailed",
    "SwapRefusal",
    "UnsupportedRoute",
    "isSwapError",
    "SWAP_ERROR_NAMES",
    "SwapError",
    "SwapErrorName",
    "QuoteCheck",
    "SwapDriveRefusedError",
    "RFQ_REFUSAL_ERROR_CODES",
    "isRfqRefusalErrorCode",
    "RfqRefusalDetail",
    "RfqRefusalErrorCode",
    "RfqRefusalUnit",
    // The durable record, its ids, and the outcome vocabulary.
    "Swap",
    "SwapRecord",
    "SwapRecordCommon",
    "OfferSwapRecord",
    "CorridorSwapRecord",
    "SwapFamily",
    "AssetSwapId",
    "RecordedLeg",
    "RecordedEndpoint",
    "RecordedInstrument",
    "RecordedArtifact",
    "assetSwapIdOf",
    "quoteIdOfSwapId",
    "familyOfSwapId",
    "Outcome",
    "CorridorKind",
    "RawState",
    "SwapUpdate",
    "Unsubscribe",
    "CancelOutcome",
    "RecoveryResult",
    // Storage: the interface and the two root backends.
    "AssetSwapRepository",
    "MarketsCacheEntry",
    "InMemoryAssetSwapRepository",
    "IndexedDbAssetSwapRepository",
    "restoreAssetSwapRepository",
    "RestoreAssetSwapRepositoryOptions",
    "RestoreAssetSwapRepositoryResult",
    "AssetSwapRestoreChange",
    "registerAssetSwapRestore",
    "RegisterAssetSwapRestoreOptions",
    // The operator slice for `SwapClientConfig.operator`.
    "SwapOperator",
    // Names v1 declared that the v2 surface references — in something the
    // caller authors, implements, reads, or catches — so v2 names whatever
    // their origin. Same order as `src/index.ts`.
    "AssetSwap",
    "InvoiceFacts",
    "ChainSource",
    "LockupRegistrationFailed",
    "LockupSpendIndexer",
    "SwapContractRegistry",
    "RfqSwapState",
    "isRfqSwapTerminal",
    // The payment rails.
    "LIGHTNING_RAIL",
    "lightningRail",
    "ONCHAIN_SWAP_RAIL",
    "onchainSwapRail",
    "claimFeeSats",
    "OnchainSwapRailDeps",
    "SWAP_ROUTER_PRIORITY",
    "createSwapPaymentRouter",
    "SwapPaymentRouterConfig",
    "PAYMENT_STATUS",
    "isTerminalStatus",
    "paymentStatusOf",
    "SwapPaymentFailedError",
    "railAvailable",
    "receiverExact",
    "swapHandle",
    "SwapRailClient",
];

/**
 * Orchestration below the verbs, spot-checked rather than enumerated: this is
 * the list the curation review named, plus the seams `V2_API.md` calls
 * source-level API. Each must be off the root and on `./advanced`. The exact
 * membership assertion above is what catches anything NOT named here leaking
 * back; this list exists so the boundary's intent is greppable.
 */
const ADVANCED_ONLY: readonly string[] = [
    // accept / preparation
    "acceptQuote",
    "QuotePreparation",
    "AcceptInput",
    "conflictingFields",
    "swapRecordOf",
    // the drive, for an app that drives swaps manually
    "createSwapDrive",
    "SwapDrive",
    "SwapDriveConfig",
    "DriveRefusal",
    "readableRecord",
    "corridorRecordStore",
    "CorridorRecordStore",
    "RecordSink",
    "walletLockupIndexer",
    "offerFactsOf",
    "offerRecordSource",
    "rfqRecordOf",
    "splitRecords",
    "applyOfferSpend",
    "withOfferStatus",
    "withRfqState",
    // cancel plumbing
    "cancelSwap",
    "CancelInput",
    // corridors and destination claiming
    "corridorSet",
    "CorridorSet",
    "ClaimedDestination",
    "CORRIDOR_FACTORIES",
    "resolveCorridorBase",
    "resolveCorridorDeps",
    "liveArkadeInfo",
    "CorridorBase",
    "CorridorDeps",
    "CorridorDepsByCorridor",
    "ArkadeCorridorDeps",
    "LightningCorridorDeps",
    "OnchainCorridorDeps",
    "OnchainClaim",
    "arkadeCorridor",
    "lightningCorridor",
    "onchainCorridor",
    "decodeBolt11",
    "DEFAULT_INVOICE_EXPIRY_SECONDS",
    "INVOICE_HRPS",
    "networksOfInvoiceHrp",
    "esploraChainSource",
    "esploraTip",
    "chainSourceOver",
    "CORRIDORS",
    "corridorOfRail",
    "railOfCorridor",
    "Corridor",
    "RailOf",
    // market picking
    "chooseMarket",
    "eligibleMarkets",
    "usableMarkets",
    "marketKeyOf",
    "marketRefOf",
    "cardMarketOf",
    "marketBackendOf",
    "isAddressable",
    "isCardMarket",
    "MarketCandidate",
    // quoting below the client
    "quoteViaRfq",
    "RfqPreparation",
    "RfqQuoteInput",
    "quoteFromFeed",
    "feedFetch",
    "FeedFetch",
    "FeedQuoteInput",
    "OfferPreparation",
    "FEED_TTL_MS",
    "resolveRoute",
    "assembleRoute",
    "ResolvedRoute",
    "ResolveDeps",
    // the RFQ wire
    "rfqLeg",
    "rfqPairFor",
    "parseRfqQuote",
    "ParsedRfqQuote",
    "withCanonicalAmount",
    "encodeRfqAmount",
    "decodeRfqAmount",
    "toRfqAmountSide",
    "fromRfqAmountSide",
    "toSafeNumber",
    "RfqAmountSide",
    "AmountOn",
    "attesting",
    "nostrTransportFactory",
    "AttestingRfqTransport",
    "RfqRendezvous",
    // verification
    "verifyPair",
    "verifyQuotedAmount",
    "verifyQuoteTtl",
    "verifyReceiveInvoiceFacts",
    "verifyReceiveWindow",
    "verifyResponder",
    "verifySendInvoice",
    "verifySendWindow",
    "verifyingDerivation",
    // the verbs' own plumbing
    "enforceFeeCeiling",
    // record and outcome derivations
    "swapOf",
    "legOf",
    "instrumentOf",
    "artifactOf",
    "recordLeg",
    "recordEndpoint",
    "recordInstrument",
    "recordArtifact",
    "fundsFromWallet",
    "OFFER_SWAP_ID_PREFIX",
    "RFQ_SWAP_ID_PREFIX",
    "corridorOutcome",
    "offerOutcome",
    "recordOutcome",
    "readsChain",
    "ACTIVITY_TOKEN",
    "CORRIDOR_PASS",
    "LOCKUP_OWNER",
    // discovery, aliases and the rest of the vocabulary internals
    "discoveryIndex",
    "DiscoveryIndex",
    "DiscoveryIndexInput",
    "isUsableCard",
    "aliasTableFrom",
    "publicAssetId",
    "scopedToRail",
    "toDiscoveryLeg",
    "DiscoveryLeg",
    "INDEXED_NETWORKS",
    "isIndexedNetwork",
    "satsOf",
    "Hex",
    "Pubkey",
    // the corridor contract vocabulary
    "CorridorModule",
    "CorridorFactory",
    "CorridorClaim",
    "CorridorCovenant",
    "CorridorDeadline",
    "CorridorDrive",
    "CorridorLockup",
    "CorridorPass",
    "LockupOwner",
    "ObservationSeam",
    "RouteSide",
    "ChainSourceBackend",
    "AddressParams",
    "L1Tip",
];

describe("the curated root boundary", () => {
    it("holds exactly the curated surface — no more, no less", () => {
        // Exact membership, both directions at once: a name on the root that
        // is not curated is a support promise nobody made (the review's hole:
        // `export * from "./client"` advertised ~160 such names), and a curated
        // name missing is a consumer's first broken import.
        expect([...root].sort()).toEqual([...CURATED_ROOT].sort());
    });

    it("keeps the orchestration internals OFF the root", () => {
        // The review's named offenders and their kin. Caught by membership
        // above as well; listed here so a regression names its victim.
        expect(ADVANCED_ONLY.filter((n) => root.has(n))).toEqual([]);
    });

    it("puts the orchestration internals on ./advanced", () => {
        expect(ADVANCED_ONLY.filter((n) => !advanced.has(n))).toEqual([]);
    });

    it("keeps ./advanced a superset of the root's client vocabulary", () => {
        // One specifier per flow: an advanced consumer imports the drive and
        // the verbs from the same subpath.
        const missing = [...root].filter(
            (n) => !advanced.has(n) && moduleOf(ROOT_ENTRY).get(n)?.startsWith("src/client/"),
        );
        expect(missing).toEqual([]);
    });

    it("gives every name in the boundary lists exactly one entry", () => {
        expect(CURATED_ROOT.length).toBe(new Set(CURATED_ROOT).size);
        expect(ADVANCED_ONLY.length).toBe(new Set(ADVANCED_ONLY).size);
        const overlap = CURATED_ROOT.filter((n) => ADVANCED_ONLY.includes(n));
        expect(overlap).toEqual([]);
    });
});

describe("the M8 disposition record", () => {
    it("gives every name exactly one disposition", () => {
        const all = [...S, ...P, ...I, ...D, ...R];
        expect(all.length).toBe(new Set(all).size);
    });

    it("puts every S name on the root", () => {
        expect([...S].filter((n: string) => !root.has(n))).toEqual([]);
    });

    it("puts every P name on /protocol, and nothing else", () => {
        expect([...protocol].sort()).toEqual([...P].sort());
    });

    it("keeps every P name OFF the root", () => {
        // The window was collapsed deliberately: `0.1.0` breaks against
        // `0.1.0-rc.1` whatever this barrel does, so re-exporting the v1 names
        // from the root for a version would have split one migration into two
        // and left 200 of them on a root whose claim is to be the v2 surface.
        // A P name reappearing here is that decision being undone by accident.
        expect([...P].filter((n: string) => root.has(n))).toEqual([]);
    });

    it("keeps every I and D name off both barrels", () => {
        const gone = [...I, ...D];
        expect(
            gone.filter((n: string) => root.has(n) || protocol.has(n) || advanced.has(n)),
        ).toEqual([]);
    });

    it("binds each R name to the v2 declaration, not the facade it replaced", () => {
        // The whole of B in one assertion: the name survived, the declaration
        // behind it did not. `src/swapClient.ts` is deleted, so what this
        // guards is a re-import — the facade coming back under the name that
        // replaced it.
        const declaredIn = moduleOf(ROOT_ENTRY);
        for (const name of R) {
            expect(root.has(name)).toBe(true);
            expect(declaredIn.get(name)).toMatch(/^src\/client\//);
        }
    });
});

describe("the @deprecated pointers", () => {
    // Every tag sits on the declaration, because a block tag above an
    // `export { … } from` does not reach the consumer's editor — the alias
    // resolves to the target and reads ITS JSDoc. So they are counted in the
    // source files, not in the barrel.
    const sources = new Map<string, string>();
    const sourceOf = (module: string) => {
        if (!sources.has(module)) {
            sources.set(module, readFileSync(resolve(SWAP_ROOT, module), "utf8"));
        }
        return sources.get(module)!;
    };
    const declaredIn = moduleOf(PROTOCOL_ENTRY);

    it("tags every P declaration", () => {
        const untagged = [...P].filter((name: string) => {
            const module = declaredIn.get(name);
            if (!module) return true;
            const source = sourceOf(module);
            // The tag is in the JSDoc immediately above the declaration, so it
            // is the nearest `@deprecated` before the name.
            const at = source.search(
                new RegExp(
                    `^(export )?(async )?(const|function|class|interface|type|enum) ${name}\\b`,
                    "m",
                ),
            );
            if (at < 0) return true;
            const window = source.slice(Math.max(0, at - 1400), at);
            return !window.includes("@deprecated");
        });
        expect(untagged).toEqual([]);
    });

    it("names a replacement or says so", () => {
        // Greppable rather than reviewed: a pointer either names a v2 spelling
        // in backticks or admits there is none.
        const tags = [...new Set(P.map((n: string) => declaredIn.get(n)))]
            .flatMap((module) => sourceOf(module as string).match(/@deprecated[^\n]*/g) ?? [])
            // The shared tail names the subpath, so it carries backticks of its
            // own; strip it before asking whether the POINTER says anything.
            .map((t) => t.replace(/Moved off the package root to `[^`]+`\./, ""));
        expect(tags.length).toBeGreaterThanOrEqual(P.length);
        const empty = tags.filter((t) => !/`[^`]+`/.test(t) && !t.includes("no replacement"));
        expect(empty).toEqual([]);
    });
});
