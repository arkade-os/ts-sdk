/**
 * `solver-lightning` — pay a BOLT11 invoice out of an Arkade balance through a
 * solver, as a {@link PaymentRail}.
 *
 * The sibling of `solver-onchain` on the `arkade:BTC -> lightning:BTC`
 * corridor, and the same shape: `available()` picks a card that serves the
 * pair AND the size, a card that does neither drops the rail, and the router's
 * ranking hands the payment to whatever else matched — `@arkade-os/boltz-swap`'s
 * `lightning` rail, where one is registered. Both match a bolt11 invoice, both
 * stay registered, and `options()` surfaces both; the priority is a preference,
 * not a restriction.
 *
 * ## What this corridor fixes that the onchain one does not
 *
 * The invoice carries the amount, so there is no `amountSide` to name: the
 * BOLT11 profile is always exact-out. `requestLightningSend` checks `to_amount`
 * against the invoice's own amount and refuses a negative spread, so the
 * receiver-exactness `RouteQuote` promises is enforced inside the package
 * rather than by this rail.
 *
 * An explicit `req.amount` is therefore ignored for pricing and rejected when
 * it disagrees with the invoice: the payee is paid what the invoice says, and
 * a request naming a different number is asking for a payment nobody can make.
 *
 * ## Decoding
 *
 * `decodeInvoice` is injected because this package carries no bolt11
 * dependency and does not intend to — `requestLightningReceive` takes the same
 * parameter for the same reason. Pass `@arkade-os/boltz-swap`'s
 * `decodeInvoice`, or any decoder that yields {@link InvoiceFacts}.
 *
 * ## Order
 *
 * As on the onchain rail: `quote()` negotiates (an RFQ quote is a real quote,
 * and `PaymentOption.quote()` is lazy so that listing options costs nothing),
 * and `send()` writes the record before it funds and refuses to fund if the
 * write throws. A funded lockup with no record cannot be refunded.
 *
 * Watching the corridor after that — the solver's claim witness revealing the
 * preimage, or a refund when it does not — is `RfqSwapManager`'s job. Wire
 * `awaitSettlement` to it for a handle that reaches `"settled"` with the
 * preimage; without one the handle stops at `"sent"`.
 */
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { PaymentRail, RouteQuote, RouterContext } from "@arkade-os/sdk";
import { invoiceTarget, makeHandle } from "@arkade-os/sdk";
import { requestLightningSend, type InvoiceFacts, type RfqTransport } from "../rfq";
import { solverRendezvous, type SolverRendezvous } from "./rendezvous";

/** This rail's id, and what `RouterPreferences.priority` ranks it by. */
export const SOLVER_LIGHTNING_RAIL = "solver-lightning";

/** Everything `requestLightningSend` handed back, plus the invoice it was for
 *  and the rendezvous it was negotiated at — what a record needs and what
 *  nothing later can give back. */
export type SolverLightningSend = Awaited<ReturnType<typeof requestLightningSend>> & {
    invoice: InvoiceFacts;
    rendezvous: SolverRendezvous;
};

export interface SolverLightningRailDeps {
    /** Arkade Service REST URL — `requestLightningSend` reads `getInfo()` from it. */
    arkServerUrl: string;
    /**
     * BOLT11 → the facts the corridor binds into the covenant. Injected: this
     * package carries no bolt11 dependency. A decoder that throws on an
     * amountless or malformed invoice drops the rail rather than taking the
     * router down — which is correct, since neither can be paid.
     */
    decodeInvoice(bolt11: string): InvoiceFacts;
    /**
     * Solver cards to route over. Called on `available()` and again on
     * `quote()`; `discoverMarkets` already caches for an hour, so pass that
     * rather than a bare registry fetch.
     */
    discover(): Promise<DiscoveredMarket[]>;
    /** Open an RFQ transport to `rendezvous` for the duration of `fn`. */
    connect<T>(
        rendezvous: SolverRendezvous,
        fn: (transport: RfqTransport) => Promise<T>,
    ): Promise<T>;
    /**
     * Write the swap down. Runs BEFORE the lockup is funded and a rejection
     * cancels the send — a funded lockup with no record cannot be refunded.
     */
    persist(swap: SolverLightningSend): Promise<void>;
    /**
     * Resolve once the corridor settled, with the preimage the solver's claim
     * witness revealed. Optional, and the difference between a handle that
     * reaches `"settled"` and one that stops at `"sent"`; `RfqSwapManager`
     * drives the swap either way.
     */
    awaitSettlement?(swap: SolverLightningSend): Promise<{ preimage?: string }>;
    /** 33-byte compressed hex override for the covenant co-signer. */
    emulatorPubkey?: string;
    /** x-only fallback for a card that advertises no `emulator_pubkey`. */
    fallbackEmulatorPubkey?: Uint8Array;
}

/** The invoice's facts, or undefined for anything unpayable — an amountless
 *  invoice, an expired one, a string the decoder rejects. Never throws:
 *  `available()` reads undefined as "not this rail". */
const factsOf = (
    raw: string,
    decode: (bolt11: string) => InvoiceFacts,
    now: number,
): InvoiceFacts | undefined => {
    const invoice = invoiceTarget(raw);
    if (!invoice) return undefined;
    let facts: InvoiceFacts;
    try {
        facts = decode(invoice);
    } catch {
        return undefined;
    }
    // An amountless invoice has no size to bound and no amount to quote; a
    // solver cannot price one and neither can this rail.
    if (!Number.isInteger(facts.amountSats) || facts.amountSats <= 0) return undefined;
    // Expiry is checked here as well as in `assertFundable` so an expired
    // invoice drops the rail before a negotiation is spent on it.
    if (facts.expiresAt <= now) return undefined;
    return facts;
};

/**
 * Pick the lightning-send rendezvous for THIS amount — {@link solverRendezvous}
 * on the `lightning` payout corridor.
 */
export const solverLightningRendezvous = (
    markets: DiscoveredMarket[],
    amountSats: number,
    fallbackEmulatorPubkey?: Uint8Array,
): SolverRendezvous | undefined =>
    solverRendezvous(markets, "lightning", amountSats, fallbackEmulatorPubkey);

/**
 * The rail. Register it and rank it:
 *
 * ```ts
 * router.use(solverLightningRail(deps));
 * router.options(req, { priority: ["ark", "solver-lightning", "lightning"] });
 * ```
 */
export function solverLightningRail(deps: SolverLightningRailDeps): PaymentRail {
    const rendezvousFor = async (amountSats: number): Promise<SolverRendezvous | undefined> =>
        solverLightningRendezvous(await deps.discover(), amountSats, deps.fallbackEmulatorPubkey);

    return {
        id: SOLVER_LIGHTNING_RAIL,
        match: (req) => invoiceTarget(req.raw) !== undefined,

        available: async (req) => {
            const facts = factsOf(req.raw, deps.decodeInvoice, Math.floor(Date.now() / 1000));
            if (!facts) return false;
            // An explicit amount that contradicts the invoice is not a payment
            // this corridor — or any corridor — can make.
            if (req.amount !== undefined && req.amount !== facts.amountSats) return false;
            // A discovery failure propagates: the router catches it, warns, and
            // drops this rail, which is the intended fallback and louder than
            // swallowing it here would be.
            return (await rendezvousFor(facts.amountSats)) !== undefined;
        },

        quote: async (req, ctx: RouterContext): Promise<RouteQuote> => {
            const facts = factsOf(req.raw, deps.decodeInvoice, Math.floor(Date.now() / 1000));
            if (!facts) {
                throw new Error(
                    `${SOLVER_LIGHTNING_RAIL}: the request carries no payable BOLT11 invoice ` +
                        `(amountless, expired, or undecodable)`,
                );
            }
            if (req.amount !== undefined && req.amount !== facts.amountSats) {
                throw new Error(
                    `${SOLVER_LIGHTNING_RAIL}: the request names ${req.amount} sats but the ` +
                        `invoice is for ${facts.amountSats} — the payee is paid the invoice`,
                );
            }
            const rendezvous = await rendezvousFor(facts.amountSats);
            if (!rendezvous) {
                throw new Error(
                    `${SOLVER_LIGHTNING_RAIL}: no solver serves arkade:BTC -> lightning:BTC ` +
                        `at ${facts.amountSats} sats`,
                );
            }

            const negotiated = await deps.connect(rendezvous, (transport) =>
                requestLightningSend(ctx.wallet, deps.arkServerUrl, transport, {
                    invoice: facts,
                    ...(deps.emulatorPubkey ? { emulatorPubkey: deps.emulatorPubkey } : {}),
                }),
            );
            const swap: SolverLightningSend = { ...negotiated, invoice: facts, rendezvous };

            return {
                railId: SOLVER_LIGHTNING_RAIL,
                // The payee always receives the invoice amount — `requestLightningSend`
                // refuses a quote that reprices it — so the corridor's spread is a
                // fee on top and `fundAmount` is what leaves the wallet.
                amount: facts.amountSats,
                fee: swap.fundAmount - facts.amountSats,
                total: swap.fundAmount,
                meta: {
                    rfqId: swap.rfqId,
                    validUntil: swap.quote.valid_until,
                    paymentHash: facts.paymentHash,
                    invoiceExpiresAt: facts.expiresAt,
                    solverPubkey: rendezvous.solverPubkey,
                },
                send: async () =>
                    makeHandle(SOLVER_LIGHTNING_RAIL, async (emit) => {
                        // Persist FIRST: a funded lockup with no record cannot
                        // be refunded, so a write that throws takes the payment
                        // with it.
                        await deps.persist(swap);
                        await ctx.wallet.send({
                            address: swap.address,
                            amount: swap.fundAmount,
                        });
                        // "sent", not "settled": funding is acceptance, and the
                        // invoice is not paid until the solver's claim witness
                        // reveals the preimage.
                        emit({ status: "sent" });
                        const result = { railId: SOLVER_LIGHTNING_RAIL, swapId: swap.rfqId };
                        if (!deps.awaitSettlement) return result;
                        const { preimage } = await deps.awaitSettlement(swap);
                        const settled = { ...result, ...(preimage !== undefined && { preimage }) };
                        emit({ status: "settled", result: settled });
                        return settled;
                    }),
            };
        },
    };
}
