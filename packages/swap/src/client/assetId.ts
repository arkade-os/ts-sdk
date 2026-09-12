/**
 * Asset identity for the v2 client: CAIP-19 with the rail as the CAIP-2
 * namespace — `<rail>:<network>/<asset-ns>:<reference>`.
 *
 * The rail is the namespace rather than the settlement chain because sameness
 * across rails is then a comparison on the asset part instead of a shared
 * string: `arkade:bitcoin/slip44:0` and `bitcoin:bitcoin/slip44:0` are one BTC
 * on two rails, and nothing has to agree on a single id for them. Arkade has no
 * CAIP-2 namespace and no bitcoin-chain identity to nest under, so
 * `bip122:…/arkade:…` would assert a relationship it does not have.
 *
 * These ids parse under CAIP-19 and resolve under no published namespace spec:
 * `arkade`, `bitcoin` and `bolt11` are registered in no CASA registry. That is
 * the price of naming rails instead of chains, and it costs nothing here — this
 * module is the grammar, and what an id *means* is the alias layer's job.
 */
import { asset, networks, type NetworkName } from "@arkade-os/sdk";

/**
 * A CAIP-2 namespace this client can spell. Closed rather than open to the
 * CAIP-2 character class, so a rail nobody implements is a parse failure here
 * rather than a lookup miss three layers down.
 *
 * `bolt11` is lightning: CAIP-2 caps a namespace at eight characters, which
 * `lightning` overruns, and floors it at three, which `ln` misses. It names the
 * instrument the rail carries today; BOLT12 is a separate corridor when it
 * ships.
 *
 * `eip155` is grammar and nothing else. §9's EVM corridor is deferred, and §9
 * exists to prove the seams hold, so its own examples have to parse; the
 * refusal belongs where a route is chosen, not where a string is read, and the
 * alias layer is where it happens.
 */
export const RAILS = ["arkade", "bitcoin", "bolt11", "eip155"] as const;
export type Rail = (typeof RAILS)[number];

/** The rails whose CAIP-2 reference is a bitcoin network rather than a chain id. */
export const BITCOIN_RAILS = ["arkade", "bitcoin", "bolt11"] as const;
export type BitcoinRail = (typeof BITCOIN_RAILS)[number];

/**
 * The network half of a bitcoin-family chain part: core's own
 * {@link NetworkName}, because the wallet is the only source of the network —
 * v2 accepts no server URL anywhere — and this is the vocabulary a wallet
 * resolves to.
 *
 * It is one wider than discovery's `NETWORKS`, which omits `testnet`. That
 * difference belongs to the alias layer and not to the grammar: an asset on
 * testnet exists whether or not anyone publishes a market index for it, so
 * amputating the identity to match the index would make a network the SDK fully
 * supports unnameable.
 */
export type NetworkRef = NetworkName;

type BitcoinAssetId<R extends BitcoinRail> = `${R}:${NetworkRef}/${string}:${string}`;

/**
 * A public asset id.
 *
 * A template literal type and not `string`, which is what makes the other three
 * asset spellings in this package — core's 68-hex `asset.AssetId#toString()`,
 * discovery's `AssetInfo.id`, the RFQ leg's `arkade:BTC` — a compile error in a
 * slot that wants a public id, rather than a wrong pair string three layers
 * down. The rail parameter carries that further: `AssetId<"arkade">` accepts no
 * `bitcoin:` string, which is what makes an endpoint whose corridor and asset
 * disagree a compile error (see `route.ts`).
 *
 * Deliberately not branded — `client.quote({ give: "arkade:bitcoin/slip44:0" })`
 * must stay writable, and the spec's own examples are written that way — so the
 * shape is what the type checks and {@link parseAssetId} is the gate for
 * everything else. A value out of a record or off the wire is a `string`: parse
 * it, never cast it.
 */
export type AssetId<R extends Rail = Rail> = R extends BitcoinRail
    ? BitcoinAssetId<R>
    : `eip155:${number}/${string}:${string}`;

/** The `<asset-ns>:<reference>` half of an id — what sameness compares. */
export type AssetPart = `${string}:${string}`;

/** BTC's asset part on every rail that carries it (SLIP-44 coin type 0). */
export const BTC_ASSET_PART = "slip44:0" satisfies AssetPart;

/** The asset namespace an Arkade-issued asset takes. */
export const ARKADE_ASSET_NAMESPACE = "asset";

export interface ParsedAssetId {
    /** CAIP-2 namespace. */
    readonly rail: Rail;
    /**
     * CAIP-2 reference: the bitcoin network on a bitcoin-family rail, the
     * decimal chain id on `eip155`.
     */
    readonly reference: string;
    /** CAIP-19 asset namespace — `slip44`, `asset`, `erc20`. */
    readonly assetNamespace: AssetNamespace;
    /** CAIP-19 asset reference. */
    readonly assetReference: string;
}

/** Why an id was refused. Stable strings; callers switch on them. */
export type AssetIdRefusal =
    | "malformed"
    | "uppercase"
    | "unknown_rail"
    | "unknown_network"
    | "invalid_chain_id"
    | "unknown_asset_namespace"
    | "invalid_asset_reference"
    | "token_id_unsupported"
    | "unknown_alias"
    | "ambiguous_alias";

/**
 * A string that is not a public asset id.
 *
 * Not a member of the §7 `SwapError` taxonomy, and deliberately so: that
 * taxonomy is the client surface's, thrown by a verb before value moves, and
 * this is a codec refusing its input before a swap exists at all. Core's own
 * `AssetId.fromBytes` sets the same precedent.
 */
export class AssetIdError extends Error {
    readonly reason: AssetIdRefusal;
    readonly value: string;
    constructor(reason: AssetIdRefusal, value: string, detail: string, options?: ErrorOptions) {
        super(`invalid asset id ${JSON.stringify(value)}: ${detail}`, options);
        this.name = "AssetIdError";
        this.reason = reason;
        this.value = value;
    }
}

/**
 * The asset namespaces this client spells, and the reference form each takes.
 *
 * Closed for the same reason the rail set is: the parser *is* the vocabulary,
 * and an id nothing downstream can map is a lookup miss dressed as an id. The
 * per-namespace form is what makes `arkade:bitcoin/asset:notahex` a parse
 * failure rather than an unserved RFQ pair.
 */
const REFERENCE_RULE = {
    slip44: /^(0|[1-9][0-9]{0,9})$/,
    /** The 68-lowercase-hex identity form; `asset.AssetId` then re-validates it. */
    asset: /^[0-9a-f]{68}$/,
    /**
     * Reserved for §9. Lowercase, never EIP-55: a checksum belongs on an
     * address a human types, and an id here comes out of the alias table or a
     * market card. Mixed case would be two spellings of one asset comparing
     * unequal in a pair string, a record and a cache key.
     */
    erc20: /^0x[0-9a-f]{40}$/,
} as const satisfies Record<string, RegExp>;

export type AssetNamespace = keyof typeof REFERENCE_RULE;

/** A CAIP-2 reference, and so the outer bound on any network or chain id. */
const CHAIN_REFERENCE = /^[-_a-z0-9]{1,32}$/;
/** No leading zeros: `eip155:01` and `eip155:1` would otherwise be two ids for one chain. */
const CHAIN_ID = /^(0|[1-9][0-9]*)$/;
/** CAIP-19's own class, minus the uppercase this layer refuses. */
const ASSET_REFERENCE = /^[-.%a-z0-9]{1,128}$/;

const isRail = (value: string): value is Rail => (RAILS as readonly string[]).includes(value);

/** Whether `value` is a network core can resolve. Read off core's own table, so
 * a network added there needs no edit here. */
export const isNetworkRef = (value: string): value is NetworkRef => Object.hasOwn(networks, value);

/**
 * Parse an id, or refuse it.
 *
 * Total over strings and throwing rather than returning a result, because every
 * caller in the client either has an id or has nothing to do: an unparsed id
 * has no route, no market and no leg.
 */
export const parseAssetId = (value: string): ParsedAssetId => {
    // Every identity in this system is compared byte for byte and nothing folds
    // at the comparison — the RFQ pair, the markets cache key, the store's
    // asset fields. Refusing rather than lowercasing keeps a caller's checksum
    // intact and stays the loosenable direction: accepting-and-folding can be
    // added later without breaking anyone, the reverse cannot.
    if (/[A-Z]/.test(value)) {
        throw new AssetIdError(
            "uppercase",
            value,
            "ids are lowercase throughout — lowercase an EIP-55 reference before it becomes one",
        );
    }
    const slash = value.indexOf("/");
    if (slash < 0) {
        throw new AssetIdError("malformed", value, "expected <rail>:<network>/<asset-ns>:<ref>");
    }
    if (value.indexOf("/", slash + 1) >= 0) {
        // CAIP-19 allows a trailing `/<token_id>` for non-fungibles. Nothing in
        // v2 has one, and accepting a segment no layer reads would let two ids
        // for one asset both parse.
        throw new AssetIdError(
            "token_id_unsupported",
            value,
            "a CAIP-19 token id has no meaning here",
        );
    }
    const chain = value.slice(0, slash);
    const assetPart = value.slice(slash + 1);

    const chainColon = chain.indexOf(":");
    const assetColon = assetPart.indexOf(":");
    if (chainColon < 0 || assetColon < 0) {
        throw new AssetIdError("malformed", value, "expected <rail>:<network>/<asset-ns>:<ref>");
    }

    const rail = chain.slice(0, chainColon);
    const reference = chain.slice(chainColon + 1);
    const assetNamespace = assetPart.slice(0, assetColon);
    const assetReference = assetPart.slice(assetColon + 1);

    if (!isRail(rail)) {
        throw new AssetIdError("unknown_rail", value, `no rail named ${JSON.stringify(rail)}`);
    }
    if (!CHAIN_REFERENCE.test(reference)) {
        throw new AssetIdError("malformed", value, "the chain reference is not CAIP-2 shaped");
    }
    if (rail === "eip155") {
        if (!CHAIN_ID.test(reference)) {
            throw new AssetIdError("invalid_chain_id", value, "eip155 takes a decimal chain id");
        }
    } else if (!isNetworkRef(reference)) {
        throw new AssetIdError(
            "unknown_network",
            value,
            `no bitcoin network named ${JSON.stringify(reference)}`,
        );
    }
    if (!Object.hasOwn(REFERENCE_RULE, assetNamespace)) {
        throw new AssetIdError(
            "unknown_asset_namespace",
            value,
            `no asset namespace named ${JSON.stringify(assetNamespace)}`,
        );
    }
    const namespace = assetNamespace as AssetNamespace;
    if (!ASSET_REFERENCE.test(assetReference) || !REFERENCE_RULE[namespace].test(assetReference)) {
        throw new AssetIdError(
            "invalid_asset_reference",
            value,
            `${namespace} takes no reference ${JSON.stringify(assetReference)}`,
        );
    }
    if (namespace === ARKADE_ASSET_NAMESPACE) {
        // The shape rule cannot see an all-zero txid or an out-of-range group
        // index. Core's validator can, and it is the one that has to agree.
        try {
            asset.AssetId.fromString(assetReference);
        } catch (cause) {
            throw new AssetIdError(
                "invalid_asset_reference",
                value,
                "core refuses that issuance identity",
                { cause },
            );
        }
    }
    return { rail, reference, assetNamespace: namespace, assetReference };
};

/** Whether `value` parses as a public asset id. */
export const isAssetId = (value: string): value is AssetId => {
    try {
        parseAssetId(value);
        return true;
    } catch {
        return false;
    }
};

/** Build an id from its parts, validating the result. */
export const formatAssetId = <R extends Rail>(parts: ParsedAssetId & { rail: R }): AssetId<R> => {
    const id = `${parts.rail}:${parts.reference}/${parts.assetNamespace}:${parts.assetReference}`;
    parseAssetId(id);
    return id as AssetId<R>;
};

/** The rail an id names. */
export const railOf = (id: AssetId): Rail => parseAssetId(id).rail;

/**
 * The bitcoin network an id settles on, or `undefined` on a rail whose CAIP-2
 * reference is a chain id rather than a network.
 */
export const bitcoinNetworkOf = (id: AssetId): NetworkRef | undefined => {
    const { rail, reference } = parseAssetId(id);
    return rail === "eip155" ? undefined : (reference as NetworkRef);
};

/** The `<asset-ns>:<reference>` half. */
export const assetPartOf = (id: AssetId): AssetPart => {
    const { assetNamespace, assetReference } = parseAssetId(id);
    return `${assetNamespace}:${assetReference}`;
};

/**
 * Whether two ids name the same asset on (possibly) different rails.
 *
 * This is the whole reason the rail is the namespace: BTC's sameness is the
 * shared `slip44:0`, a comparison, where a single cross-rail id would have made
 * it a string both sides had to already agree on.
 *
 * The rail is the *only* half sameness drops. The CAIP-2 reference still has to
 * agree: `arkade:regtest/slip44:0` and `bitcoin:bitcoin/slip44:0` share a coin
 * type and nothing else — regtest BTC settles nothing on mainnet — and an ERC-20
 * contract address repeats verbatim across every chain that copied the token, so
 * the asset part alone would make USDT-on-mainnet the same asset as its address
 * twin on another chain. Comparing references across rail families is safe on a
 * plain string: a bitcoin network name is never a decimal chain id.
 */
export const sameAsset = (a: AssetId, b: AssetId): boolean => {
    const left = parseAssetId(a);
    const right = parseAssetId(b);
    return (
        left.reference === right.reference &&
        left.assetNamespace === right.assetNamespace &&
        left.assetReference === right.assetReference
    );
};

/** BTC on a bitcoin-family rail: the same coin, named once per rail. */
export const btcOn = <R extends BitcoinRail>(rail: R, network: NetworkRef): AssetId<R> =>
    // The checker will not resolve the conditional against an unbound `R`; the
    // assertion is confined to this expression and never reaches a call site.
    `${rail}:${network}/${BTC_ASSET_PART}` as AssetId<R>;

/**
 * An Arkade-issued asset.
 *
 * Takes `asset.AssetId` rather than a hex string for the reason `arkadeAssetLeg`
 * does (`rfq.ts:111`): `hex.decode` accepts uppercase where `hex.encode` emits
 * only lowercase, so the parameter type is what enforces the case rule, and a
 * value that reached us as `A1B2…` leaves here as `a1b2…`.
 *
 * The reference is that identity verbatim — 68 lowercase hex, `toString()`'s
 * own output. The spec's prose spells it `<genesis_txid>.<idx>`, which is what
 * those bytes mean, not a second encoding: the identity is implemented in seven
 * places across three repos and pinned by `asset.ASSET_ID_VECTORS` precisely
 * because every disagreement between sites fails silently, so this layer adds
 * no eighth spelling.
 */
export const arkadeAsset = (network: NetworkRef, id: asset.AssetId): AssetId<"arkade"> =>
    `arkade:${network}/${ARKADE_ASSET_NAMESPACE}:${id.toString()}`;

/**
 * The issuance identity nested inside an arkade id; `undefined` for BTC.
 *
 * The inverse of {@link arkadeAsset}, and the round trip the shared vectors
 * pin: the 34 bytes in equal the 34 bytes out.
 */
export const issuanceOf = (id: AssetId<"arkade">): asset.AssetId | undefined => {
    const { assetNamespace, assetReference } = parseAssetId(id);
    return assetNamespace === ARKADE_ASSET_NAMESPACE
        ? asset.AssetId.fromString(assetReference)
        : undefined;
};
