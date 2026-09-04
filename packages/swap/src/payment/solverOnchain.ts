/**
 * `solver-onchain` — pay an L1 address out of an Arkade balance through a
 * solver. Registered by the app: the SDK does not depend on this package, and
 * `RouterContext.swaps` is boltz-swap's. Every refusal is `available()`
 * returning false, so the router drops the rail and the collaborative exit
 * `onchain` wins by ranking.
 */
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { PaymentRail, RouteQuote, RouterContext } from "@arkade-os/sdk";
import { btcTarget, makeHandle, resolveSendAmount, tryResolveSendAmount } from "@arkade-os/sdk";
import { assertFundable, requestOnchainSend, type RfqTransport } from "../rfq";
import { l1ScriptForAddress, type OnchainNetwork } from "../onchainHtlc";
import { solverRendezvous, type SolverRendezvous } from "./rendezvous";

export const SOLVER_ONCHAIN_RAIL = "solver-onchain";

/** What a record needs. Pass the whole object to `onchainSendProfile()`: only
 *  this carries `payoutPkScript`. */
export type SolverOnchainSend = Awaited<ReturnType<typeof requestOnchainSend>> & {
    rendezvous: SolverRendezvous;
    /** Where the claim pays. Named nowhere else — the claim's output is the
     *  spender's choice. `onchainSendProfile()` hex-encodes it; a store fed
     *  these bytes raw returns an object with no `.length`. */
    payoutPkScript: Uint8Array;
};

export interface SolverOnchainRailDeps {
    arkServerUrl: string;
    l1Network: OnchainNetwork;
    /** x-only L1 key that AUTHORISES the claim — not where it pays. */
    payoutPubkey: Uint8Array;
    /** Called by `available()` and again by `quote()` — pass the caching
     *  `discoverMarkets`, not a bare registry fetch. */
    discover(): Promise<DiscoveredMarket[]>;
    connect<T>(
        rendezvous: SolverRendezvous,
        fn: (transport: RfqTransport) => Promise<T>,
    ): Promise<T>;
    /** Runs BEFORE funding, and a rejection cancels the send: a funded lockup
     *  with no record cannot be refunded. */
    persist(swap: SolverOnchainSend): Promise<void>;
    /** Resolve once the L1 fill is claimed. Optional: without it the handle
     *  stops at `"sent"`. `RfqSwapManager` drives the swap either way. */
    awaitSettlement?(swap: SolverOnchainSend): Promise<{ txid: string }>;
    emulatorPubkey?: string;
    fallbackEmulatorPubkey?: Uint8Array;
}

export const solverOnchainRendezvous = (
    markets: DiscoveredMarket[],
    amountSats: number,
    fallbackEmulatorPubkey?: Uint8Array,
): SolverRendezvous | undefined =>
    solverRendezvous(markets, "onchain", amountSats, fallbackEmulatorPubkey);

/** Register alongside the core `onchain` rail, ranked first:
 *  `priority: ["ark", "solver-onchain", "onchain"]`. Both stay registered. */
export function solverOnchainRail(deps: SolverOnchainRailDeps): PaymentRail {
    const rendezvousFor = async (
        amount: number | undefined,
    ): Promise<SolverRendezvous | undefined> => {
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
            // makes the route pointless, and it fails closed.
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

            // `"to"` keeps the quote receiver-exact: the user's number is the
            // L1 payout and the fee sits on top.
            const negotiated = await deps.connect(rendezvous, (transport) =>
                requestOnchainSend(ctx.wallet, deps.arkServerUrl, transport, {
                    amount,
                    amountSide: "to",
                    payoutPubkey: deps.payoutPubkey,
                    ...(deps.emulatorPubkey ? { emulatorPubkey: deps.emulatorPubkey } : {}),
                }),
            );
            // `payoutPkScript` above used `deps.l1Network`. Where HRPs coincide
            // this does not fail, it persists a payout for another network.
            if (negotiated.l1Network !== deps.l1Network) {
                throw new Error(
                    `${SOLVER_ONCHAIN_RAIL}: rail built for ${deps.l1Network} but the swap was ` +
                        `negotiated on ${negotiated.l1Network}`,
                );
            }
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
                    // The claim tx's fee comes out of the HTLC output at a rate
                    // not knowable now, so `amount` is the payout, not the net.
                    claimFeeDeductedFromPayout: true,
                },
                send: async () =>
                    makeHandle(SOLVER_ONCHAIN_RAIL, async (emit) => {
                        // `send()` can run minutes after `quote()` gated —
                        // long enough for the quote or the claim window to lapse.
                        assertFundable({
                            quote: swap.quote,
                            now: Math.floor(Date.now() / 1000),
                            onchain: {
                                htlcLocktime: swap.htlcParams.refundLocktime,
                                minConfirmations: swap.minConfirmations,
                                direction: "send",
                            },
                        });
                        // Persist FIRST: a funded lockup with no record cannot
                        // be refunded.
                        await deps.persist(swap);
                        await ctx.wallet.send({
                            address: swap.address,
                            amount: swap.fundAmount,
                        });
                        // Not "settled": the recipient has nothing until the
                        // solver fills the HTLC and this wallet claims it.
                        emit({ status: "sent" });
                        const result = { railId: SOLVER_ONCHAIN_RAIL, swapId: swap.rfqId };
                        if (!deps.awaitSettlement) return result;
                        // The lockup is funded; `handle.ts` reads a rejection
                        // as `failed`, inviting a retry that funds a SECOND.
                        let txid: string;
                        try {
                            ({ txid } = await deps.awaitSettlement(swap));
                        } catch (e) {
                            console.warn(
                                `${SOLVER_ONCHAIN_RAIL}: settlement watch failed; the payment is sent`,
                                e,
                            );
                            return result;
                        }
                        const settled = { ...result, txid };
                        emit({ status: "settled", result: settled });
                        return settled;
                    }),
            };
        },
    };
}
