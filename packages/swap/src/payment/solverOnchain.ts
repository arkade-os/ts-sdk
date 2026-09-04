/**
 * `solver-onchain` — pay an L1 address out of an Arkade balance through a
 * solver, as a {@link PaymentRail}.
 *
 * ## Why this is a rail and not an app-level decision
 *
 * The wallet's version of this reimplemented three things `PaymentRouter`
 * already does: picking a route, matching an amount against bounds, and
 * falling back when the route says no. The router's own contract is the
 * fallback — a rail whose `available()` returns false or throws is dropped
 * from `options()` and never takes the router down — so every refusal this
 * corridor has (no card, a card that cannot take the size, an L1 endpoint the
 * wallet does not have, an address the claim cannot pay, a registry that did
 * not answer) is expressed by returning false, and `onchain` (the
 * collaborative exit) wins by ranking. There is no refusal enum here and no
 * bespoke error type: a rail that drops itself IS the fallback.
 *
 * What the app keeps is the user-facing half — the copy that explains why the
 * exit was collaborative. `options()` tells it which rails survived, which is
 * the fact that copy is about.
 *
 * ## What the caller must supply
 *
 * Registered by the app, not by a core factory: `@arkade-os/sdk` does not
 * depend on this package (the dependency runs the other way), so a rail that
 * needs RFQ has to be exported from here and `use()`d. Its dependencies are
 * taken at construction rather than read off `RouterContext.swaps`, which is
 * already occupied by boltz-swap's client.
 *
 * ## The order that matters
 *
 * `quote()` negotiates. An RFQ quote is a real quote with a `valid_until`, so
 * this is where it belongs — but it is not free: it provisions a claim secret,
 * registers the lockup as a contract, and tells a solver what the user is
 * about to do. `PaymentOption.quote()` is lazy for exactly this reason; listing
 * options costs nothing, asking for a price costs a negotiation.
 *
 * `send()` persists before it funds, and refuses to fund if the persist throws.
 * The Arkade lockup is spendable by the solver on production of the preimage;
 * funding one whose record was never written is how a swap becomes
 * unrecoverable, and it is the single ordering in this file that cannot be
 * relaxed.
 *
 * Driving the swap after that — watching for the L1 fill, claiming it,
 * refunding a stranded lockup — is `RfqSwapManager`'s job, not the send path's.
 * The rail hands the record to `persist` and reports the `rfqId` as the
 * quote's `swapId`; the manager takes it from there.
 */
import { marketCorridor, sideLimits, type DiscoveredMarket } from "@arkade-os/solver-discovery";
import { hex } from "@scure/base";
import type { PaymentRail, RouteQuote, RouterContext } from "@arkade-os/sdk";
import { btcTarget, makeHandle, resolveSendAmount, tryResolveSendAmount } from "@arkade-os/sdk";
import { requestOnchainSend, type RfqTransport } from "../rfq";
import { l1ScriptForAddress, type OnchainNetwork } from "../onchainHtlc";

/** This rail's id, and what `RouterPreferences.priority` ranks it by. */
export const SOLVER_ONCHAIN_RAIL = "solver-onchain";

/** 64 lowercase hex chars — the solver registry's own `emulator_pubkey` pattern. */
const XONLY_HEX = /^[0-9a-f]{64}$/;

/**
 * Where to reach a solver for an onchain send, and the bounds its card
 * advertises. Indicative only: the quote is what binds.
 */
export interface SolverOnchainRendezvous {
    solverPubkey: string;
    transports: { nostr: { relays: string[] } };
    /** The card's `emulator_pubkey`, x-only hex — the covenant cannot be
     *  derived without it. */
    emulatorPubkey: string;
    /** Card bounds on the onchain (payout) side, sats. */
    minSats: number;
    maxSats: number;
}

/** Everything `requestOnchainSend` handed back, plus the rendezvous it was
 *  negotiated at. This is what a record needs and what nothing later can give
 *  back — `onchainSendProfile()` maps it into an `RfqSwapOrigin`. */
export type SolverOnchainSend = Awaited<ReturnType<typeof requestOnchainSend>> & {
    rendezvous: SolverOnchainRendezvous;
    /** The RECIPIENT's output script — where the claim actually pays.
     *
     * Carried because the claim happens later, possibly in another process:
     * the claim transaction's output is the spender's own choice, and nothing
     * on the quote or the HTLC names it. */
    payoutPkScript: Uint8Array;
};

export interface SolverOnchainRailDeps {
    /** Arkade Service REST URL — `requestOnchainSend` reads `getInfo()` from it. */
    arkServerUrl: string;
    /** Which Bitcoin network the L1 HTLC and the destination address live on. */
    l1Network: OnchainNetwork;
    /**
     * The user's x-only L1 key that AUTHORISES the claim. Never where it pays:
     * the HTLC's claim leaf binds a key this wallet must sign with, and the
     * recipient cannot.
     */
    payoutPubkey: Uint8Array;
    /**
     * Solver cards to route over. Called on `available()` and again on
     * `quote()`; `discoverMarkets` already caches for an hour, so pass that
     * rather than a bare registry fetch.
     */
    discover(): Promise<DiscoveredMarket[]>;
    /** Open an RFQ transport to `rendezvous` for the duration of `fn`. */
    connect<T>(
        rendezvous: SolverOnchainRendezvous,
        fn: (transport: RfqTransport) => Promise<T>,
    ): Promise<T>;
    /**
     * Write the swap down. Runs BEFORE the lockup is funded and a rejection
     * cancels the send — a funded lockup with no record cannot be refunded.
     */
    persist(swap: SolverOnchainSend): Promise<void>;
    /**
     * Resolve once the L1 fill has been claimed, with the claim's txid.
     *
     * Optional, and the difference between a handle that reaches `"settled"`
     * and one that stops at `"sent"`. Watching for the fill and claiming it is
     * `RfqSwapManager`'s job — an app that has one wires it here so the payment
     * handle reports the whole corridor; an app that does not still gets a
     * handle, and learns the lockup was funded and nothing more. Nothing about
     * the swap depends on this: the manager drives it either way.
     */
    awaitSettlement?(swap: SolverOnchainSend): Promise<{ txid: string }>;
    /** 33-byte compressed hex override for the covenant co-signer, when this
     *  deployment pins one. */
    emulatorPubkey?: string;
    /** x-only fallback for a card that advertises no `emulator_pubkey`. */
    fallbackEmulatorPubkey?: Uint8Array;
}

/**
 * What a card must carry before it can be a rendezvous: the card's own
 * `emulator_pubkey` wins, an absent one falls back to the pinned per-network
 * key, a malformed one fails closed even with a pin, and a disagreement
 * between the two is skipped rather than resolved.
 */
const rendezvousOf = (
    market: DiscoveredMarket,
    pinned?: string,
): SolverOnchainRendezvous | undefined => {
    const transports = { nostr: { relays: market.transports?.nostr?.relays ?? [] } };
    if (!market.discovery_pubkey || !transports.nostr.relays.length) return undefined;

    const advertised = (market as { emulator_pubkey?: unknown }).emulator_pubkey;
    const emulatorPubkey =
        advertised === undefined || advertised === null || advertised === ""
            ? pinned
            : typeof advertised === "string" && XONLY_HEX.test(advertised)
              ? advertised
              : undefined;
    if (!emulatorPubkey) return undefined;
    if (pinned && emulatorPubkey !== pinned) return undefined;

    // A side's bounds are what the SOLVER pays out on it, so the send leg —
    // arkade in, L1 out — is bounded by the quote (onchain) side. `sideLimits`
    // is the registry's own parser and reads a disabled side (max "0") or a
    // malformed bound as null, which is what keeps a disabled corridor from
    // reaching the user as "amount outside solver bounds".
    const bounds = sideLimits(market, "quote");
    if (!bounds) return undefined;

    return {
        solverPubkey: market.discovery_pubkey,
        transports,
        emulatorPubkey,
        minSats: Number(bounds.min),
        maxSats: Number(bounds.max),
    };
};

/**
 * Pick the rendezvous for THIS amount.
 *
 * The size check is not a courtesy. A card advertises the range its solver can
 * actually fill; quoting outside it burns a negotiation, tells a third party
 * what the user is about to do, and comes back as `amount_out_of_range`
 * anyway. A card that serves the pair but not the size is skipped rather than
 * fatal — another card may take it.
 *
 * Exported because it is the whole of `available()`'s judgement and worth
 * testing without a router around it.
 */
export const solverOnchainRendezvous = (
    markets: DiscoveredMarket[],
    amountSats: number,
    fallbackEmulatorPubkey?: Uint8Array,
): SolverOnchainRendezvous | undefined => {
    const pinned = fallbackEmulatorPubkey ? hex.encode(fallbackEmulatorPubkey) : undefined;

    for (const market of markets) {
        // The send leg goes arkade -> L1: anything else on the base side is a
        // corridor this wallet cannot fund from, and the receive direction
        // lives on the other side of the same market.
        if (marketCorridor(market, "base") !== "arkade") continue;
        if (marketCorridor(market, "quote") !== "onchain") continue;

        const rendezvous = rendezvousOf(market, pinned);
        if (!rendezvous) continue;
        if (amountSats >= rendezvous.minSats && amountSats <= rendezvous.maxSats) {
            return rendezvous;
        }
    }
    return undefined;
};

/**
 * The rail. Register it alongside the core `onchain` rail and rank it first:
 *
 * ```ts
 * router.use(solverOnchainRail(deps));
 * router.options(req, { priority: ["ark", "solver-onchain", "onchain"] });
 * ```
 *
 * Both rails match a BTC address, and both stay registered — the ranking is a
 * preference, not a restriction. When no solver serves the pair or the size,
 * `available()` returns false and the collaborative exit wins on its own.
 */
export function solverOnchainRail(deps: SolverOnchainRailDeps): PaymentRail {
    /** The rendezvous for this request, or undefined for every reason there is
     *  not one. Never throws: `available()` reads it as "not this rail". */
    const rendezvousFor = async (
        amount: number | undefined,
    ): Promise<SolverOnchainRendezvous | undefined> => {
        if (amount === undefined) return undefined;
        const markets = await deps.discover();
        return solverOnchainRendezvous(markets, amount, deps.fallbackEmulatorPubkey);
    };

    return {
        id: SOLVER_ONCHAIN_RAIL,
        match: (req) => btcTarget(req.raw) !== undefined,

        available: async (req) => {
            const address = btcTarget(req.raw);
            if (!address) return false;
            // Before any network call: a destination the claim cannot pay to
            // makes the whole route pointless, and the record must carry the
            // script. Cheaper than discovery and it fails closed.
            try {
                l1ScriptForAddress(address, deps.l1Network);
            } catch {
                return false;
            }
            // An amountless request defers to quote(), which is where the
            // "an amount is required" rejection belongs. Nothing can be
            // bounds-checked without one, so the rail cannot claim to fit.
            const amount = tryResolveSendAmount(req.raw, req.amount);
            if (amount === undefined) return false;
            // A discovery failure propagates: the router catches it, warns, and
            // drops this rail — which is the intended fallback, and louder than
            // swallowing it here would be.
            return (await rendezvousFor(amount)) !== undefined;
        },

        quote: async (req, ctx: RouterContext): Promise<RouteQuote> => {
            const address = btcTarget(req.raw)!;
            const amount = resolveSendAmount(SOLVER_ONCHAIN_RAIL, req.raw, req.amount);
            const payoutPkScript = l1ScriptForAddress(address, deps.l1Network);
            const rendezvous = await rendezvousFor(amount);
            if (!rendezvous) {
                throw new Error(
                    `${SOLVER_ONCHAIN_RAIL}: no solver serves arkade:BTC -> onchain:BTC at ${amount} sats`,
                );
            }

            // `amountSide: "to"` — the router's amounts are receiver-exact, so
            // the number the user named is the L1 payout and the corridor's fee
            // sits on top. `requestOnchainSend` pins `to_amount` to it.
            const negotiated = await deps.connect(rendezvous, (transport) =>
                requestOnchainSend(ctx.wallet, deps.arkServerUrl, transport, {
                    amount,
                    amountSide: "to",
                    payoutPubkey: deps.payoutPubkey,
                    ...(deps.emulatorPubkey ? { emulatorPubkey: deps.emulatorPubkey } : {}),
                }),
            );
            const swap: SolverOnchainSend = { ...negotiated, rendezvous, payoutPkScript };

            return {
                railId: SOLVER_ONCHAIN_RAIL,
                amount,
                fee: swap.fundAmount - amount,
                total: swap.fundAmount,
                meta: {
                    rfqId: swap.rfqId,
                    validUntil: swap.quote.valid_until,
                    htlcAddress: swap.htlc.address,
                    minConfirmations: swap.minConfirmations,
                    solverPubkey: rendezvous.solverPubkey,
                    // `amount` is what the solver puts INTO the L1 HTLC, which
                    // is as receiver-exact as this corridor gets: the claim
                    // transaction's own fee comes out of that output, and the
                    // rate at claim time — possibly hours away — is not knowable
                    // now. Displaying `amount` is honest; calling it the net
                    // received would not be.
                    claimFeeDeductedFromPayout: true,
                },
                send: async () =>
                    makeHandle(SOLVER_ONCHAIN_RAIL, async (emit) => {
                        // Persist FIRST. A funded lockup with no record cannot
                        // be refunded, so a persist that throws must take the
                        // payment with it.
                        await deps.persist(swap);
                        await ctx.wallet.send({
                            address: swap.address,
                            amount: swap.fundAmount,
                        });
                        // "sent", not "settled": the Arkade leg is funded, and
                        // the recipient has nothing until the solver fills the
                        // L1 HTLC and this wallet claims it. A rejection from
                        // here on is outside the record's reach only if the
                        // send broadcast and the response was lost — the row is
                        // already written, so the manager reconciles it.
                        emit({ status: "sent" });
                        const result = { railId: SOLVER_ONCHAIN_RAIL, swapId: swap.rfqId };
                        if (!deps.awaitSettlement) return result;
                        const { txid } = await deps.awaitSettlement(swap);
                        const settled = { ...result, txid };
                        emit({ status: "settled", result: settled });
                        return settled;
                    }),
            };
        },
    };
}
