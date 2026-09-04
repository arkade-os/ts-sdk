/**
 * `solver-lightning` — the sibling of `solver-onchain` on the BOLT11 corridor.
 * Boltz's `lightning` rail matches the same invoices and both stay registered.
 * The invoice fixes the amount, so a `req.amount` that disagrees is refused
 * rather than ignored; `decodeInvoice` is injected because this package
 * carries no bolt11 dependency.
 */
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { PaymentRail, RouteQuote, RouterContext } from "@arkade-os/sdk";
import { invoiceTarget, makeHandle } from "@arkade-os/sdk";
import { assertFundable, requestLightningSend, type InvoiceFacts, type RfqTransport } from "../rfq";
import { solverRendezvous, type SolverRendezvous } from "./rendezvous";

export const SOLVER_LIGHTNING_RAIL = "solver-lightning";

export type SolverLightningSend = Awaited<ReturnType<typeof requestLightningSend>> & {
    invoice: InvoiceFacts;
    rendezvous: SolverRendezvous;
};

/** Mirrors {@link SolverOnchainRailDeps}; see there for the shared seams. */
export interface SolverLightningRailDeps {
    /** A decoder that throws drops the rail rather than taking the router
     *  down — correct, since an undecodable invoice cannot be paid. */
    decodeInvoice(bolt11: string): InvoiceFacts;
    discover(): Promise<DiscoveredMarket[]>;
    connect<T>(
        rendezvous: SolverRendezvous,
        fn: (transport: RfqTransport) => Promise<T>,
    ): Promise<T>;
    persist(swap: SolverLightningSend): Promise<void>;
    /** Optional; without it the handle stops at `"sent"`. */
    awaitSettlement?(swap: SolverLightningSend): Promise<{ preimage?: string }>;
    emulatorPubkey?: string;
    fallbackEmulatorPubkey?: Uint8Array;
}

/** Undefined for anything unpayable — amountless, expired, undecodable. */
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
    if (!Number.isInteger(facts.amountSats) || facts.amountSats <= 0) return undefined;
    // Also gated in `assertFundable`; here so an expired invoice drops the rail
    // before a negotiation is spent on it.
    if (facts.expiresAt <= now) return undefined;
    return facts;
};

export const solverLightningRendezvous = (
    markets: DiscoveredMarket[],
    amountSats: number,
    fallbackEmulatorPubkey?: Uint8Array,
): SolverRendezvous | undefined =>
    solverRendezvous(markets, "lightning", amountSats, fallbackEmulatorPubkey);

export function solverLightningRail(deps: SolverLightningRailDeps): PaymentRail {
    const rendezvousFor = async (amountSats: number): Promise<SolverRendezvous | undefined> =>
        solverLightningRendezvous(await deps.discover(), amountSats, deps.fallbackEmulatorPubkey);

    return {
        id: SOLVER_LIGHTNING_RAIL,
        match: (req) => invoiceTarget(req.raw) !== undefined,

        available: async (req) => {
            const facts = factsOf(req.raw, deps.decodeInvoice, Math.floor(Date.now() / 1000));
            if (!facts) return false;
            // A request amount contradicting the invoice is unpayable.
            if (req.amount !== undefined && req.amount !== facts.amountSats) return false;
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
                requestLightningSend(ctx.wallet, transport, {
                    invoice: facts,
                    ...(deps.emulatorPubkey ? { emulatorPubkey: deps.emulatorPubkey } : {}),
                }),
            );
            const swap: SolverLightningSend = { ...negotiated, invoice: facts, rendezvous };

            return {
                railId: SOLVER_LIGHTNING_RAIL,
                // `requestLightningSend` refuses a quote that reprices the
                // invoice, so the spread is a fee on top.
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
                        // Funding an expired invoice buys nothing: the solver
                        // can no longer get the preimage.
                        assertFundable({
                            quote: swap.quote,
                            invoiceExpiresAt: facts.expiresAt,
                            now: Math.floor(Date.now() / 1000),
                        });
                        // Persist FIRST — see `solverOnchain`.
                        await deps.persist(swap);
                        await ctx.wallet.send({
                            address: swap.address,
                            amount: swap.fundAmount,
                        });
                        // Not "settled": the invoice is unpaid until the solver\'s claim
                        // witness reveals the preimage.
                        emit({ status: "sent" });
                        const result = { railId: SOLVER_LIGHTNING_RAIL, swapId: swap.rfqId };
                        if (!deps.awaitSettlement) return result;
                        // Not a payment failure — see `solverOnchain`.
                        let preimage: string | undefined;
                        try {
                            ({ preimage } = await deps.awaitSettlement(swap));
                        } catch (e) {
                            console.warn(
                                `${SOLVER_LIGHTNING_RAIL}: settlement watch failed; the payment is sent`,
                                e,
                            );
                            return result;
                        }
                        const settled = { ...result, ...(preimage !== undefined && { preimage }) };
                        emit({ status: "settled", result: settled });
                        return settled;
                    }),
            };
        },
    };
}
