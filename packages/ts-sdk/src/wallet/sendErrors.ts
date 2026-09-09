/**
 * Refusals from `Wallet.send` when asset change has nowhere to land.
 *
 * An asset rides a BTC carrier: the sats are the output, the asset is an
 * annotation on it. `send` consolidates every asset the inputs carried but the
 * recipients did not take onto its **one** change output, so that output has to
 * hold at least the dust floor — an asset change output below dust is a change
 * output the server will not accept.
 *
 * That makes "send all the sats" and "keep the assets" incompatible past a
 * point, and the point is one dust below the spendable balance. Before these
 * errors existed the refusal surfaced as `Insufficient funds` from coin
 * selection, against a balance that plainly covered the amount, which is the
 * least useful thing it could have said.
 *
 * Two ways to arrive, two remedies, so two errors — narrow to
 * {@link AssetChangeCarrierError} for "the assets had no carrier" regardless of
 * which:
 *
 * - {@link SendAboveMaxSendableError} — generic selection, and the wallet has
 *   no spare coin left to fund the carrier. Recoverable by the caller: send
 *   `maxSendable` instead, or include the assets in the send and free the
 *   reserve entirely.
 * - {@link SelectedVtxosCannotCarryAssetChangeError} — the caller pinned the
 *   inputs with `selectedVtxos`, so `send` may not reach for a coin it was not
 *   given. There is no ceiling to report; the remedy is to name more inputs.
 */

/** What both refusals carry: the change that would be left, and the floor it
 * failed to reach. */
export interface AssetChangeCarrierFacts {
    /** Sats of BTC change the send would leave for the assets to ride. */
    changeAmount: number;
    /** Distinct assets needing that one change output. */
    assetChangeCount: number;
    /** The floor a change output must reach to carry them. */
    dustAmount: bigint;
}

/**
 * A send whose asset change could not be given a carrier at or above dust.
 *
 * Abstract on purpose: every instance is one of the two subclasses, which
 * differ in whether a ceiling can be named. Catch this to handle both.
 */
export abstract class AssetChangeCarrierError extends Error {
    /** Sats of BTC change the send would leave for the assets to ride. */
    readonly changeAmount: number;
    /** Distinct assets needing that one change output. */
    readonly assetChangeCount: number;
    /** The floor a change output must reach to carry them. */
    readonly dustAmount: bigint;

    protected constructor(
        message: string,
        facts: AssetChangeCarrierFacts,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.changeAmount = facts.changeAmount;
        this.assetChangeCount = facts.assetChangeCount;
        this.dustAmount = facts.dustAmount;
    }
}

/**
 * Thrown when generic selection has no spare sat left to fund the carrier the
 * asset change needs — the "send all" of a wallet that holds an asset.
 *
 * {@link maxSendable} is the same figure `WalletBalance.maxSendable` reports,
 * computed from the same spendable set, so a caller that prefilled a "send max"
 * control from the balance and raced a receive can re-read it from the refusal
 * rather than parsing the message.
 */
export class SendAboveMaxSendableError extends AssetChangeCarrierError {
    override readonly name = "SendAboveMaxSendableError";

    /**
     * The largest send that still leaves the assets a carrier — equal to
     * `WalletBalance.maxSendable`, and zero when less than dust could leave.
     */
    readonly maxSendable: number;

    constructor(
        facts: AssetChangeCarrierFacts & { maxSendable: number },
        options?: { cause?: unknown },
    ) {
        super(
            `send: ${facts.changeAmount} sats of change cannot carry ${facts.assetChangeCount} asset ` +
                `change(s), needs ${facts.dustAmount} — send at most ${facts.maxSendable} sats ` +
                `(WalletBalance.maxSendable) to keep the assets, or send them too`,
            facts,
            options,
        );
        this.maxSendable = facts.maxSendable;
    }
}

/**
 * Thrown when the caller pinned the inputs with `selectedVtxos` and those
 * inputs leave too little change to carry the asset change.
 *
 * No ceiling is reported: the wallet may hold coins that would fund the
 * carrier, but this path may not reach for one the caller did not name. The
 * remedy is to name more inputs, not to lower the amount.
 */
export class SelectedVtxosCannotCarryAssetChangeError extends AssetChangeCarrierError {
    override readonly name = "SelectedVtxosCannotCarryAssetChangeError";

    constructor(facts: AssetChangeCarrierFacts, options?: { cause?: unknown }) {
        super(
            `send({ selectedVtxos }): ${facts.changeAmount} sats of change cannot carry ` +
                `${facts.assetChangeCount} asset change(s), needs ${facts.dustAmount}`,
            facts,
            options,
        );
    }
}
