/**
 * Absolute (CLTV) refund-locktime arithmetic.
 *
 * Boltz emits a VHTLC `refund` locktime in either BIP65 form depending on its
 * `useLocktimeSeconds` setting, so every comparison here dispatches on the
 * threshold rather than assuming a timestamp. Kept free of any class or provider
 * dependency so the branch logic is testable on its own; the decision about
 * *warning* when a block-height locktime meets an absent `OnchainProvider` lives
 * on `ArkadeSwaps`, which is what knows whether a provider was configured.
 */

/**
 * BIP65 threshold: a locktime below this is a block height, at or above it a
 * Unix timestamp in seconds.
 */
export const LOCKTIME_HEIGHT_THRESHOLD = 500_000_000;

/**
 * How long to wait before re-attempting a spend the server rejected as
 * CLTV-immature. It matures the locktime against the chain tip block's
 * timestamp rather than its wall clock, so the rejection clears once a later
 * block lands — on the order of one block interval, not of the locktime itself.
 */
export const CLTV_IMMATURE_RETRY_SEC = 60;

/** Whether `locktime` is denominated in block heights rather than Unix seconds. */
export const isBlockHeightLocktime = (locktime: number): boolean =>
    locktime < LOCKTIME_HEIGHT_THRESHOLD;

/**
 * Whether an absolute (CLTV) refund locktime has been reached.
 *
 * A block-height locktime with no known chain tip counts as not reached: that
 * defers to the cooperative refund path instead of attempting a spend the
 * server would reject as immature.
 */
export const isRefundLocktimeReached = (locktime: number, chainTipHeight?: number): boolean =>
    isBlockHeightLocktime(locktime)
        ? chainTipHeight !== undefined && chainTipHeight >= locktime
        : Math.floor(Date.now() / 1000) >= locktime;

/**
 * When to retry a locktime that has not been reached. A block height carries no
 * wall-clock deadline, so re-poll on the block-interval cadence instead.
 */
export const refundRetryAt = (locktime: number): number =>
    isBlockHeightLocktime(locktime)
        ? Math.floor(Date.now() / 1000) + CLTV_IMMATURE_RETRY_SEC
        : locktime;

/**
 * The value a refund locktime was actually compared against, for logging: the
 * chain tip height for a block-height locktime, wall-clock seconds otherwise.
 * Reporting the wrong one makes a block height read as catastrophically overdue
 * against a ~1.7e9 timestamp.
 */
export const refundLocktimeBasis = (locktime: number, chainTipHeight?: number): string =>
    isBlockHeightLocktime(locktime)
        ? `chainTipHeight=${chainTipHeight ?? "unknown"}`
        : `currentTimestamp=${Math.floor(Date.now() / 1000)}`;

/**
 * A chain tip that has already been resolved. `height` is `undefined` when the
 * lookup was attempted and came back empty — deliberately distinct from "not
 * looked up yet", which a bare `tip?: number` could not express. That
 * distinction is what lets a batch hoist one fetch for many swaps: with a plain
 * optional, a hoisted fetch that failed would look identical to no fetch and
 * every swap would retry it, each paying its own failure latency and log line.
 */
export type ChainTipSnapshot = { resolved: true; height?: number };
