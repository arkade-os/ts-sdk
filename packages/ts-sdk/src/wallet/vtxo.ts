import type { GetVtxosOptions, IndexerProvider, PageResponse, Vtxo } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { ExtendedVirtualCoin, VirtualCoin, VirtualStatus } from "./index";

/**
 * Canonical VTXO facts, the conversions between them and the legacy `virtualStatus` projection,
 * and the capability predicates behavior is expected to read.
 *
 * Three directions are owned here:
 *
 * 1. wire `Vtxo` -> canonical ({@link convertVtxo})
 * 2. canonical -> legacy `virtualStatus` ({@link toVirtualStatus})
 * 3. legacy `virtualStatus` -> canonical ({@link normalizeVtxo})
 *
 * Direction 3 is not just for old persisted rows: `IndexerProvider` and `WalletRepository` are
 * public interfaces, so consumer implementations may hand back legacy-shaped coins through the
 * front door. Normalization therefore runs where the SDK *consumes* an interface, never inside an
 * implementation of one.
 */

/**
 * Below this, a millisecond value is too small to be a real batch expiry and is read as a block
 * height instead. The server returns one scalar for both units.
 *
 * Compared as a UTC constant rather than via `getFullYear()`, which reads local time and would move
 * the boundary with the runtime's offset — making the classification machine-dependent and letting
 * data written in one timezone re-read differently in another.
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
 * is down. Every path that needs a height goes through here so that guarantee has one
 * implementation rather than one per call site.
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
    /** `""` = not spent by anything — the public emission convention. Test truthiness. */
    spentBy: string;
    commitmentTxIds: string[];
};

export type NormalizedExtendedVirtualCoin = ExtendedVirtualCoin & NormalizedVirtualCoin;

// --- expiry ------------------------------------------------------------------------------------

/** D1: the wire's single `expiresAt` scalar -> canonical, disambiguating seconds from height. */
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

/** D2: canonical -> legacy `batchExpiry`. */
export function toBatchExpiry(c: {
    expiresAt?: Date;
    expiresAtHeight?: number;
}): number | undefined {
    if (c.expiresAt !== undefined) return c.expiresAt.getTime();
    // Multiplying a block height by 1000 is dimensionally meaningless, but it is what the legacy
    // converter did and what consumers already receive. Preserved deliberately.
    if (c.expiresAtHeight !== undefined) return c.expiresAtHeight * 1000;
    return undefined;
}

/** D3: legacy `batchExpiry` -> canonical, inverting D2 on its domain. */
export function parseLegacyExpiry(batchExpiry: number | undefined): {
    expiresAt?: Date;
    expiresAtHeight?: number;
} {
    // `<= 0` is guarded for the same reason as in `parseWireExpiry`: it would otherwise yield
    // `expiresAtHeight: 0`, which every chain tip is past — a VTXO with no expiry would read as
    // permanently expired.
    if (batchExpiry === undefined || batchExpiry <= 0) return {};
    if (batchExpiry >= EXPIRY_MIN_PLAUSIBLE_MS) return { expiresAt: new Date(batchExpiry) };
    return { expiresAtHeight: batchExpiry / 1000 };
}

// --- normalization -----------------------------------------------------------------------------

/** Direction 2: synthesize the legacy projection from canonical facts. */
export function toVirtualStatus(c: {
    isSpent?: boolean;
    isSwept?: boolean;
    isPreconfirmed?: boolean;
    commitmentTxIds?: string[];
    expiresAt?: Date;
    expiresAtHeight?: number;
}): VirtualStatus {
    return {
        // Precedence is load-bearing: consumers bucket on this label, so any other order silently
        // moves VTXOs between buckets.
        state: c.isSpent
            ? "spent"
            : c.isSwept
              ? "swept"
              : c.isPreconfirmed
                ? "preconfirmed"
                : "settled",
        commitmentTxIds: c.commitmentTxIds,
        batchExpiry: toBatchExpiry(c),
    };
}

/**
 * Direction 3: fill in every canonical fact, deriving from `virtualStatus` when a coin carries only
 * the legacy shape. Idempotent.
 *
 * Facts are derived with `??` so a coin that already carries its own authoritative value keeps it
 * rather than having it re-derived from the lossy projection.
 */
export function normalizeVtxo<T extends VirtualCoin>(v: T): T & NormalizedVirtualCoin {
    const state = v.virtualStatus?.state;
    const canonicalExpiry = v.expiresAt !== undefined || v.expiresAtHeight !== undefined;
    const expiry = canonicalExpiry
        ? // Coerce: a backend that persists through JSON hands back an ISO string, which typechecks
          // as `Date` but returns NaN from `.getTime()` — comparing false against everything.
          {
              expiresAt: v.expiresAt === undefined ? undefined : new Date(v.expiresAt),
              expiresAtHeight: v.expiresAtHeight,
          }
        : parseLegacyExpiry(v.virtualStatus?.batchExpiry);

    // `state === "spent"` cannot tell us whether the coin was *also* swept or preconfirmed — the
    // collapse destroyed that. Reading them as false matches today's behavior (a spent coin already
    // fails every spendability check), but it is a decision, not an accident.
    const isSpent = v.isSpent ?? state === "spent";
    const isSwept = v.isSwept ?? state === "swept";
    const isPreconfirmed = v.isPreconfirmed ?? state === "preconfirmed";
    const commitmentTxIds = v.commitmentTxIds ?? v.virtualStatus?.commitmentTxIds ?? [];

    return {
        ...v,
        isSpent,
        isSwept,
        isPreconfirmed,
        spentBy: v.spentBy ?? "",
        commitmentTxIds,
        ...expiry,
        virtualStatus:
            v.virtualStatus ??
            toVirtualStatus({ isSpent, isSwept, isPreconfirmed, commitmentTxIds, ...expiry }),
    };
}

/** Direction 1: wire `Vtxo` -> canonical `VirtualCoin`. Shared by every indexer provider. */
export function convertVtxo(vtxo: Vtxo): NormalizedVirtualCoin {
    const expiry = parseWireExpiry(vtxo.expiresAt);
    const facts = {
        isSpent: vtxo.isSpent,
        isSwept: vtxo.isSwept,
        isPreconfirmed: vtxo.isPreconfirmed,
        commitmentTxIds: vtxo.commitmentTxids,
        ...expiry,
    };
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !vtxo.isSwept && !vtxo.isPreconfirmed,
            isLeaf: !vtxo.isPreconfirmed,
        },
        ...facts,
        virtualStatus: toVirtualStatus(facts),
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

/**
 * Boundary #1: the only sanctioned way for SDK logic to read VTXOs from an `IndexerProvider`.
 *
 * A drop-in for `provider.getVtxos()` that normalizes whatever came back. For the built-in
 * providers the facts are already present and this is a cheap pass-through; for a consumer-supplied
 * provider it is what makes the contract true.
 */
export async function getNormalizedVtxos(
    provider: Pick<IndexerProvider, "getVtxos">,
    opts?: GetVtxosOptions,
): Promise<{ vtxos: NormalizedVirtualCoin[]; page?: PageResponse }> {
    const { vtxos, page } = await provider.getVtxos(opts);
    return { vtxos: vtxos.map(normalizeVtxo), page };
}

// --- capabilities ------------------------------------------------------------------------------

/**
 * Whether a virtual output has been consumed and can never be spent again.
 *
 * @remarks
 * Unions all three spend facts rather than trusting any one of them. The wire contract permits
 * `isSpent: true` with an empty `spentBy` (settlement inputs needing no forfeit are written that
 * way), so a `spentBy || settledBy` definition would classify a spent VTXO as spendable — inflating
 * balance and selecting it for a send that must fail. The union can only ever classify *more*
 * VTXOs as spent, which is the safe direction to err.
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
 * Deliberately not named `isExpired`: the deprecated {@link isExpired} also returns `true` for a
 * swept VTXO, and two same-named predicates with different truth conditions is how a call site gets
 * silently rewired.
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
    return !hasTerminalSpend(n) && !(n.isSwept || isPastExpiry(n, now));
}

/**
 * Whether a virtual output must be recovered into a fresh batch rather than spent offchain. The
 * recovery/renewal test and the `recoverable` balance bucket.
 */
export function canRecoverOnchain(vtxo: VirtualCoin, now: TimeHeight): boolean {
    const n = normalizeVtxo(vtxo);
    return !hasTerminalSpend(n) && (n.isSwept || isPastExpiry(n, now));
}

// --- fee estimation ----------------------------------------------------------------------------

/**
 * The `OffchainInput` fields that come from the VTXO itself, shared by every offchain fee estimate.
 *
 * @remarks
 * `expiry` goes through {@link toBatchExpiry} rather than reading `expiresAt` directly, so a
 * height-encoded expiry keeps producing the same (dimensionally meaningless, near-1970) date the
 * legacy `batchExpiry` path always fed the estimator. Fee estimation is a no-height path: changing
 * what the estimator sees here would move fees, which is out of scope.
 */
export function toOffchainInputFeeParams(vtxo: NormalizedVirtualCoin): {
    amount: bigint;
    type: "recoverable" | "vtxo";
    weight: number;
    birth: Date;
    expiry: Date | undefined;
} {
    const batchExpiry = toBatchExpiry(vtxo);
    return {
        amount: BigInt(vtxo.value),
        type: vtxo.isSwept ? "recoverable" : "vtxo",
        weight: 0,
        birth: vtxo.createdAt,
        expiry: batchExpiry ? new Date(batchExpiry) : undefined,
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

// --- deprecated compatibility wrappers ---------------------------------------------------------

/**
 * Return whether a virtual output is still spendable.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output has not been consumed
 *
 * @deprecated Ambiguous: `true` for swept or expired virtual outputs, which cannot in fact be spent
 * offchain. Use {@link canSpendOffchain}.
 */
export function isSpendable(vtxo: VirtualCoin): boolean {
    return !hasTerminalSpend(vtxo);
}

/**
 * Return whether a virtual output is recoverable.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output is swept but not yet consumed
 *
 * @deprecated Swept-only: ignores virtual outputs that are past expiry but not yet swept, which are
 * equally recoverable. Use {@link canRecoverOnchain}.
 */
export function isRecoverable(vtxo: VirtualCoin): boolean {
    const n = normalizeVtxo(vtxo);
    return n.isSwept && !hasTerminalSpend(n);
}

/**
 * Return whether a virtual output should be treated as expired.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output is swept or its wall-clock batch expiry has passed
 *
 * @deprecated Conflates swept with expired, and cannot evaluate height-based expiry — being
 * synchronous, it has no source for the current chain tip, so it ignores `expiresAtHeight` exactly
 * as it always has. For the recovery decision use {@link canRecoverOnchain}; to reproduce this
 * truth condition use `v.isSwept || isPastExpiry(v, now)`.
 */
export function isExpired(vtxo: VirtualCoin): boolean {
    const n = normalizeVtxo(vtxo);
    return n.isSwept || (n.expiresAt !== undefined && n.expiresAt.getTime() <= Date.now());
}
