import {
    DEFAULT_PAGE_SIZE,
    OUTPOINT_QUERY_CHUNK_SIZE,
    SCRIPT_QUERY_CHUNK_SIZE,
} from "../contracts/constants";
import { isRetryableProviderError } from "../providers/availability";
import type { GetVtxosOptions, IndexerProvider, PageResponse, Vtxo } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { ExtendedVirtualCoin, VirtualCoin } from "./index";

/**
 * Canonical VTXO fact normalization and capability predicates.
 *
 * Incoming VTXOs may omit optional boolean facts, so SDK logic normalizes them
 * before applying spend/recovery predicates.
 */

/**
 * Below this, a millisecond value is too small to be a real batch expiry and is read as a block
 * height instead. The server returns one scalar for both units.
 *
 * A UTC constant rather than `getFullYear()`, which reads local time and would make the
 * classification depend on the runtime's timezone.
 */
export const EXPIRY_MIN_PLAUSIBLE_MS = Date.UTC(2025, 0, 1);

/**
 * The current moment, as the expiry predicates need it.
 *
 * `height` is optional: offline-first paths have no chain tip at hand. When it is absent,
 * height-based expiry cannot be evaluated and reads as not expired.
 */
export type TimeHeight = { timestamp: Date; height?: number };

/**
 * Resolve the {@link TimeHeight} for one expiry-driven pass.
 *
 * @remarks
 * Fetch the tip once per pass and reuse the result for every VTXO in it, so the pass judges them
 * all against the same height.
 *
 * A tip-fetch failure **degrades to timestamp-only rather than blocking**: height-encoded expiry
 * then reads as not expired, which is what the whole SDK did before heights were evaluated at all.
 * Recovery and deprecated-signer migration must not become unavailable because the onchain provider
 * is down.
 *
 * Pass no provider to opt out of height entirely — the offline-first paths (balance, coin
 * selection) do this deliberately.
 */
export async function resolveTimeHeight(
    provider?: Pick<OnchainProvider, "getChainTip">,
): Promise<TimeHeight> {
    const timestamp = new Date();
    if (!provider) return { timestamp };
    try {
        const tip = await provider.getChainTip();
        return { timestamp, height: tip.height };
    } catch (e) {
        console.warn("Failed to fetch chain tip; height-based expiry will not be evaluated", e);
        return { timestamp };
    }
}

/**
 * A {@link VirtualCoin} that has passed through {@link normalizeVtxo}: every fact the capability
 * predicates read is present.
 *
 * Internal signatures take this rather than `VirtualCoin` so the compiler rejects un-normalized
 * input — on the public shape these facts are optional, and `undefined` is falsy, so a legacy coin
 * would silently read as "not swept", "not spent", and drop out of the wrong bucket.
 *
 * It is deliberately a *subtype* of `VirtualCoin`, so normalized coins are returned to consumers
 * directly and no egress projection exists.
 */
export type NormalizedVirtualCoin = Omit<
    VirtualCoin,
    "isSwept" | "isPreconfirmed" | "isSpent" | "spentBy" | "commitmentTxIds"
> & {
    isSwept: boolean;
    isPreconfirmed: boolean;
    isSpent: boolean;
    spentBy: string;
    commitmentTxIds: string[];
};

export type NormalizedExtendedVirtualCoin = ExtendedVirtualCoin & NormalizedVirtualCoin;

// --- expiry ------------------------------------------------------------------------------------

/** The wire's single `expiresAt` scalar -> canonical, disambiguating seconds from height. */
export function parseWireExpiry(raw: string | null | undefined): {
    expiresAt?: Date;
    expiresAtHeight?: number;
} {
    if (raw === null || raw === undefined || raw === "") return {};
    const n = Number(raw);
    // `n <= 0` would otherwise yield `expiresAtHeight: 0`, which every chain tip is past — a VTXO
    // with no expiry would read as permanently expired.
    if (!Number.isFinite(n) || n <= 0) return {};
    const ms = n * 1000;
    if (ms >= EXPIRY_MIN_PLAUSIBLE_MS) return { expiresAt: new Date(ms) };
    return { expiresAtHeight: n };
}

// --- normalization -----------------------------------------------------------------------------

/**
 * Fill in every canonical fact. Idempotent.
 *
 * Facts are derived with `??` so a coin that already carries its own authoritative value keeps it.
 */
export function normalizeVtxo<T extends VirtualCoin>(v: T): T & NormalizedVirtualCoin {
    const expiry = {
        expiresAt: v.expiresAt === undefined ? undefined : new Date(v.expiresAt),
        expiresAtHeight: v.expiresAtHeight,
    };

    return {
        ...v,
        isSpent: v.isSpent ?? false,
        isSwept: v.isSwept ?? false,
        isPreconfirmed: v.isPreconfirmed ?? false,
        spentBy: v.spentBy ?? "",
        commitmentTxIds: v.commitmentTxIds ?? [],
        ...expiry,
    };
}

/** Wire `Vtxo` -> canonical `VirtualCoin`. Shared by every indexer provider. */
export function convertVtxo(vtxo: Vtxo): NormalizedVirtualCoin {
    const expiry = parseWireExpiry(vtxo.expiresAt);
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !vtxo.isSwept && !vtxo.isPreconfirmed,
            isLeaf: !vtxo.isPreconfirmed,
        },
        isSpent: vtxo.isSpent,
        isSwept: vtxo.isSwept,
        isPreconfirmed: vtxo.isPreconfirmed,
        commitmentTxIds: vtxo.commitmentTxids,
        ...expiry,
        spentBy: vtxo.spentBy ?? "",
        settledBy: vtxo.settledBy,
        arkTxId: vtxo.arkTxid,
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
        isUnrolled: vtxo.isUnrolled,
        script: vtxo.script,
        assets: vtxo.assets?.map((a) => ({
            assetId: a.assetId,
            amount: BigInt(a.amount),
        })),
    };
}

// --- provider boundary -------------------------------------------------------------------------

/** What a normalized VTXO read answers with. @see getNormalizedVtxos */
export type NormalizedVtxoPage = { vtxos: NormalizedVirtualCoin[]; page?: PageResponse };

/**
 * The only sanctioned way for SDK logic to read VTXOs from an `IndexerProvider`: a drop-in for
 * `provider.getVtxos()` that normalizes whatever came back. A cheap pass-through for the built-in
 * providers, which already populate the facts.
 */
export async function getNormalizedVtxos(
    provider: Pick<IndexerProvider, "getVtxos">,
    opts?: GetVtxosOptions,
): Promise<NormalizedVtxoPage> {
    const { vtxos, page } = await provider.getVtxos(opts);
    return { vtxos: vtxos.map(normalizeVtxo), page };
}

/** Everything a script query can filter on, minus the cursor this reader owns. */
export type VtxoScriptQuery = Omit<GetVtxosOptions, "scripts" | "outpoints" | "pageIndex">;

/**
 * Read every virtual output for an arbitrary number of scripts.
 *
 * @remarks
 * Scripts travel in the query string, so a wallet-derived list must be chunked
 * at {@link SCRIPT_QUERY_CHUNK_SIZE} or the request `414`s. Chunks run
 * sequentially — that pacing is the point, since this path can now run wide —
 * and each is paged to exhaustion, so callers cannot silently receive page one.
 */
export async function getAllNormalizedVtxos(
    provider: Pick<IndexerProvider, "getVtxos">,
    scripts: string[],
    opts: VtxoScriptQuery = {},
): Promise<NormalizedVirtualCoin[]> {
    const { pageSize = DEFAULT_PAGE_SIZE, ...filters } = opts;
    const all: NormalizedVirtualCoin[] = [];

    for (let i = 0; i < scripts.length; i += SCRIPT_QUERY_CHUNK_SIZE) {
        const chunk = scripts.slice(i, i + SCRIPT_QUERY_CHUNK_SIZE);
        let pageIndex = 0;
        let hasMore = true;

        while (hasMore) {
            const { vtxos, page } = await getNormalizedVtxos(provider, {
                ...filters,
                scripts: chunk,
                pageIndex,
                pageSize,
            });
            all.push(...vtxos);

            // A short page means the last one: providers that omit `page`
            // entirely are treated as unpaged.
            hasMore = page ? vtxos.length === pageSize : false;
            pageIndex++;
            if (hasMore) await new Promise((r) => setTimeout(r, 500));
        }
    }

    return all;
}

/**
 * Resolve `createdAt` (epoch ms) for txids by querying each txid's output 0 as a virtual
 * outpoint, chunked at {@link OUTPOINT_QUERY_CHUNK_SIZE}. `pageSize` is explicit because the
 * provider omits `page.size` when unset and a server default below the chunk size would
 * silently short-page. Best-effort: a retryable failure drops its chunk and leaves the map
 * partial; terminal errors propagate.
 */
export async function fetchVtxoCreatedAtByTxid(
    provider: Pick<IndexerProvider, "getVtxos">,
    txids: string[],
): Promise<Map<string, number>> {
    const unique = [...new Set(txids)].filter((txid) => txid !== "");
    const createdAt = new Map<string, number>();

    for (let i = 0; i < unique.length; i += OUTPOINT_QUERY_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + OUTPOINT_QUERY_CHUNK_SIZE);
        try {
            const { vtxos } = await getNormalizedVtxos(provider, {
                outpoints: chunk.map((txid) => ({ txid, vout: 0 })),
                pageSize: DEFAULT_PAGE_SIZE,
            });
            for (const v of vtxos) {
                createdAt.set(v.txid, v.createdAt.getTime());
            }
        } catch (err) {
            if (!isRetryableProviderError(err)) throw err;
        }
    }

    return createdAt;
}

// --- capabilities ------------------------------------------------------------------------------

/**
 * Whether a virtual output has been consumed and can never be spent again.
 *
 * @remarks
 * Unions all three spend facts rather than trusting any one of them. The wire contract permits
 * `isSpent: true` with an empty `spentBy` (settlement inputs needing no forfeit are written that
 * way), so a `spentBy || settledBy` definition would classify a spent VTXO as spendable — inflating
 * balance and selecting it for a send that must fail.
 *
 * `isUnrolled` is deliberately **not** part of this union: it says where the output lives, not that
 * it was consumed. Mirrors NArk's `ArkVtxo.IsSpent()`. The location axis is {@link canSweepOnchain},
 * which the two capability predicates below subtract instead.
 */
export function hasTerminalSpend(vtxo: VirtualCoin): boolean {
    const n = normalizeVtxo(vtxo);
    return !!n.isSpent || !!n.spentBy || !!n.settledBy;
}

/**
 * Whether a virtual output's batch expiry has passed. Pure expiry — swept is a separate fact, ORed
 * in explicitly by {@link canSpendOffchain} / {@link canRecoverOnchain}.
 *
 * @remarks
 * Not named `isExpired`: the deprecated {@link isExpired} also returns `true` for a swept VTXO, and
 * two same-named predicates with different truth conditions is how a call site gets silently
 * rewired.
 *
 * Height-based expiry is only evaluated when `now.height` is supplied.
 */
export function isPastExpiry(vtxo: VirtualCoin, now: TimeHeight): boolean {
    const n = normalizeVtxo(vtxo);
    if (n.expiresAt !== undefined && now.timestamp.getTime() >= n.expiresAt.getTime()) return true;
    return (
        n.expiresAtHeight !== undefined &&
        now.height !== undefined &&
        now.height >= n.expiresAtHeight
    );
}

/** Whether a virtual output can be spent in an offchain transaction. The send/coin-selection test. */
export function canSpendOffchain(vtxo: VirtualCoin, now: TimeHeight): boolean {
    const n = normalizeVtxo(vtxo);
    return !hasTerminalSpend(n) && !n.isUnrolled && !(n.isSwept || isPastExpiry(n, now));
}

/**
 * Whether a virtual output must be recovered into a fresh batch rather than spent offchain. The
 * recovery/renewal test and the `recoverable` balance bucket.
 */
export function canRecoverOnchain(vtxo: VirtualCoin, now: TimeHeight): boolean {
    const n = normalizeVtxo(vtxo);
    return !hasTerminalSpend(n) && !n.isUnrolled && (n.isSwept || isPastExpiry(n, now));
}

/**
 * Whether a virtual output's exit already happened: the output lives onchain and `completeUnroll`
 * is the only remedy. The third and last capability, on the location axis rather than the spend
 * one — together the three partition the live set, since this claims every unrolled coin and the
 * other two refuse them.
 *
 * @remarks
 * The ts-sdk analogue of NArk's `OnchainSweepService` filter, minus the expiry clause: the relevant
 * maturity here is the exit tx's CSV timelock, which `prepareUnrollTransaction` checks against the
 * chain tip, not the batch expiry.
 */
export function canSweepOnchain(vtxo: VirtualCoin): boolean {
    const n = normalizeVtxo(vtxo);
    return !hasTerminalSpend(n) && !!n.isUnrolled;
}

// --- fee estimation ----------------------------------------------------------------------------

/** The `OffchainInput` fields that come from the VTXO itself. */
export function toOffchainInputFeeParams(vtxo: NormalizedVirtualCoin): {
    amount: bigint;
    type: "recoverable" | "vtxo";
    weight: number;
    birth: Date;
    expiry: Date | undefined;
} {
    return {
        amount: BigInt(vtxo.value),
        type: vtxo.isSwept ? "recoverable" : "vtxo",
        weight: 0,
        birth: vtxo.createdAt,
        expiry: vtxo.expiresAt,
    };
}

// --- discrimination ----------------------------------------------------------------------------

/**
 * Narrow a settle input to a virtual output.
 *
 * @remarks
 * Keyed on `script`: it is required on `VirtualCoin` (so legacy and canonical shapes both have it)
 * and absent from `ExtendedCoin`, which the optional canonical facts cannot claim.
 *
 * The `typeof` guard is load-bearing — `settle` accepts arknote strings, and `in` throws a
 * `TypeError` on a primitive rather than returning false.
 */
export function isVirtualCoin<T>(input: T): input is T & VirtualCoin {
    return (
        typeof input === "object" &&
        input !== null &&
        typeof (input as { script?: unknown }).script === "string"
    );
}
