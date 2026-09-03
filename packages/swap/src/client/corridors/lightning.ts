/**
 * The lightning corridor: a BOLT11 invoice, on this wallet's network.
 *
 * Core settles the shape and stops there — `isLightningInvoice` matches the HRP
 * and a bech32 tail, strips a `lightning:` prefix, and by its own comment
 * carries no bolt11 dependency and so no checksum and no decode. The two gaps
 * are this module's, and §6 puts both at the parse boundary.
 *
 * The HRP-to-network table exists in neither package, so it is authored here.
 * Two of its facts are worth stating because a test could otherwise claim more
 * than the vocabulary can express: `lntbs` is signet AND mutinynet, which share
 * an HRP exactly as they share `tark`, so a signet-versus-mutinynet rejection is
 * not expressible; and `lnsb` (simnet) is admitted by core's regex — five
 * prefixes, where §6 names four — and named by no `NetworkName`, so it is
 * refused rather than mapped to a neighbour.
 *
 * Of §6's parse-boundary gates, this module owns three: the HRP check, the
 * invoice expiry, and the amountless refusal. The rest read the quote — the
 * headroom check needs `quote.refund_locktime` and no parse has a quote — and
 * belong to the quote path.
 */
import { invoiceTarget, type NetworkName } from "@arkade-os/sdk";
import type { InvoiceFacts } from "../../rfq";
import type { CorridorClaim, CorridorDrive, CorridorFactory, CorridorModule } from "./contract";
import type { LightningCorridorDeps } from "./deps";

/**
 * Which networks an invoice HRP can belong to.
 *
 * An ordered list rather than a record, because the order is load-bearing:
 * `lnbcrt` has to be tested before `lnbc` and `lntbs` before `lntb`, and a
 * record would leave that to key-iteration order.
 */
export const INVOICE_HRPS = [
    ["lnbcrt", ["regtest"]],
    ["lntbs", ["signet", "mutinynet"]],
    ["lnbc", ["bitcoin"]],
    ["lntb", ["testnet"]],
] as const satisfies readonly (readonly [string, readonly NetworkName[]])[];

/** The networks `raw`'s HRP names, or `undefined` for one no network claims. */
export const networksOfInvoiceHrp = (raw: string): readonly NetworkName[] | undefined => {
    const lower = raw.toLowerCase();
    return INVOICE_HRPS.find(([hrp]) => lower.startsWith(hrp))?.[1];
};

/** `sha256(P)` as the invoice instrument carries it: 64 lowercase hex chars. */
const PAYMENT_HASH = /^[0-9a-f]{64}$/;

/**
 * Both directions, and the ownership inverts between them.
 *
 * On `arkade -> lightning` the trader funds the lockup, so `refundLocktime` is
 * the trader's and is a moment to act AFTER — the only action is the Arkade
 * refund, since the solver claims the lockup with the preimage it learns by
 * paying. On `lightning -> arkade` the solver funds it: every non-claim leaf is
 * the solver's, the trader has no refund at all, and the deadline is a moment to
 * have claimed BEFORE.
 */
const LIGHTNING_DRIVE: CorridorDrive = {
    give: {
        lockups: [{ covenant: "arkade_lockup", owner: "solver", deadline: "refund_locktime" }],
        actions: ["claimLockup"],
        seams: ["indexer"],
    },
    take: {
        lockups: [{ covenant: "arkade_lockup", owner: "trader", deadline: "refund_locktime" }],
        actions: ["refundArkade"],
        seams: ["indexer"],
    },
};

export const lightningCorridor: CorridorFactory<LightningCorridorDeps> = Object.assign(
    (deps: LightningCorridorDeps): CorridorModule<LightningCorridorDeps> => ({
        corridor: "lightning",
        deps,
        drive: LIGHTNING_DRIVE,
        matches(raw: string): CorridorClaim {
            const invoice = invoiceTarget(raw);
            if (invoice === undefined) return undefined;

            const networks = networksOfInvoiceHrp(invoice);
            if (networks === undefined) {
                return { refused: "this invoice's network prefix names no network this SDK knows" };
            }
            if (!networks.includes(deps.networkName)) {
                return {
                    refused:
                        `this is a ${networks.join(" or ")} invoice and the wallet is on ` +
                        `${deps.networkName}`,
                };
            }

            let facts: InvoiceFacts;
            try {
                facts = deps.decode(invoice);
                // Read under the same guard as the call. The decoder is a
                // replaceable seam, so nothing its answer contains is
                // guaranteed by the type, and `matches` must not throw — one
                // dereference inside the `try` settles that the object is
                // readable at all, and the checks after it are total.
                //
                // An empty or malformed hash is the case that matters: `Hex` is
                // a bare alias, so it would typecheck onto the instrument and
                // then be compared byte-for-byte against a real one.
                if (!PAYMENT_HASH.test(facts.paymentHash)) {
                    return { refused: "the decoded invoice carries no usable payment hash" };
                }
            } catch (error) {
                return {
                    refused: `the invoice did not decode: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                };
            }

            if (!Number.isFinite(facts.expiresAt)) {
                return { refused: "the decoded invoice carries no usable expiry" };
            }
            const now = Math.floor(Date.now() / 1000);
            if (facts.expiresAt <= now) {
                return { refused: `the invoice expired ${now - facts.expiresAt}s ago` };
            }

            if (!Number.isSafeInteger(facts.amountSats) || facts.amountSats < 0) {
                return { refused: "the decoded invoice carries no usable amount" };
            }
            // Amountless is refused rather than carried, and `0` is how it
            // arrives. A destination string is by construction the TAKE leg of a
            // send, which is exactly where §6 puts this refusal: the invoice is
            // the amount pin there, and `amountOn` does not rescue it. The
            // instrument keeps `amount` optional for the reusable-instrument
            // corridors (BOLT12) that will arrive by another door with amount
            // rules of their own.
            if (facts.amountSats === 0) {
                return { refused: "the invoice names no amount, and a send route needs one" };
            }

            return {
                claimed: {
                    kind: "invoice",
                    bolt11: invoice,
                    paymentHash: facts.paymentHash,
                    amount: BigInt(facts.amountSats),
                    expiresAt: facts.expiresAt,
                },
            };
        },
    }),
    { target: invoiceTarget },
);
