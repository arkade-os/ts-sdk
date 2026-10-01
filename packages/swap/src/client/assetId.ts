/**
 * Asset identity for the v2 client: CAIP-19 with the rail as the CAIP-2
 * namespace — `<rail>:<network>/<asset-ns>:<reference>`.
 *
 * Rail, not settlement chain, as namespace: cross-rail sameness becomes a comparison on the asset
 * part (`arkade:bitcoin/slip44:0` vs `bitcoin:bitcoin/slip44:0`), and `bip122:…/arkade:…` would
 * assert a relationship Arkade does not have. These ids parse under CAIP-19 but `arkade`,
 * `bitcoin` and `bolt11` are in no CASA registry; meaning is the alias layer's job.
 */
import { asset, networks, type NetworkName } from "@arkade-os/sdk";

/**
 * A CAIP-2 namespace this client can spell. Closed, so an unimplemented rail fails at parse.
 *
 * `bolt11` is lightning: CAIP-2 namespaces are 3-8 chars, which `lightning` and `ln` miss. BOLT12
 * will be a separate corridor. `eip155` is grammar only: the EVM corridor is deferred, and refusal
 * belongs where a route is chosen (the alias layer), not where a string is read.
 */
export const RAILS = ["arkade", "bitcoin", "bolt11", "eip155"] as const;
export type Rail = (typeof RAILS)[number];

/** The rails whose CAIP-2 reference is a bitcoin network rather than a chain id. */
export const BITCOIN_RAILS = ["arkade", "bitcoin", "bolt11"] as const;
export type BitcoinRail = (typeof BITCOIN_RAILS)[number];

/**
 * The network half of a bitcoin-family chain part: core's own {@link NetworkName}, since the
 * wallet is the only source of the network.
 *
 * Wider than discovery's `NETWORKS` (which omits `testnet`): an asset on testnet exists whether or
 * not a market index covers it.
 */
export type NetworkRef = NetworkName;

type BitcoinAssetId<R extends BitcoinRail> = `${R}:${NetworkRef}/${string}:${string}`;

/**
 * A public asset id.
 *
 * A template literal type, so the package's other asset spellings (core's 68-hex id, discovery's
 * `AssetInfo.id`, the RFQ leg's `arkade:BTC`) are compile errors here, and `AssetId<"arkade">`
 * accepts no `bitcoin:` string (see `route.ts`).
 *
 * Deliberately not branded, so `client.quote({ give: "arkade:bitcoin/slip44:0" })` stays writable.
 * A value from a record or the wire is a `string`: parse it with {@link parseAssetId}, never cast.
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
 * Not in the §7 `SwapError` taxonomy on purpose: that is thrown by verbs before value moves; this
 * is a codec refusing input before a swap exists (as core's `AssetId.fromBytes` does).
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
 * The asset namespaces this client spells, and the reference form each takes. Closed like the
 * rail set, so `arkade:bitcoin/asset:notahex` is a parse failure, not an unserved RFQ pair.
 */
const REFERENCE_RULE = {
    slip44: /^(0|[1-9][0-9]{0,9})$/,
    /** The 68-lowercase-hex identity form; `asset.AssetId` then re-validates it. */
    asset: /^[0-9a-f]{68}$/,
    /**
     * Reserved for §9. Lowercase, never EIP-55: mixed case would be two spellings of one asset
     * comparing unequal in a pair string, a record and a cache key.
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
 * @throws {AssetIdError} with a stable {@link AssetIdRefusal} `reason`.
 */
export const parseAssetId = (value: string): ParsedAssetId => {
    // Identities are compared byte for byte everywhere (RFQ pair, cache key, store). Refusing
    // rather than folding keeps a checksum intact and stays loosenable later; the reverse is not.
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
        // CAIP-19's `/<token_id>`: nothing reads it, and accepting it would let two ids for one
        // asset both parse.
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
 * Only the rail is dropped; the CAIP-2 reference must still agree. Otherwise regtest BTC would
 * equal mainnet BTC, and an ERC-20 address copied across chains would equal its twin. Comparing
 * references across rail families is safe: a bitcoin network name is never a decimal chain id.
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
    // TS won't resolve the conditional against an unbound `R`; the cast stays in this expression.
    `${rail}:${network}/${BTC_ASSET_PART}` as AssetId<R>;

/**
 * An Arkade-issued asset.
 *
 * Takes `asset.AssetId`, not hex: `hex.decode` accepts uppercase but `toString()` emits lowercase,
 * so the type enforces the case rule. The reference is that 68-hex identity verbatim, pinned by
 * `asset.ASSET_ID_VECTORS` across repos; adding a `<genesis_txid>.<idx>` spelling would be one
 * more silently-disagreeing site.
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
