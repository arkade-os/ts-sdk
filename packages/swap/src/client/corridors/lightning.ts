/**
 * The lightning corridor: a BOLT11 invoice, on this wallet's network.
 *
 * Core's `isLightningInvoice` checks shape only (no checksum, no decode), so the network
 * match and decode happen here. `lntbs` is both signet and mutinynet, so a
 * signet-versus-mutinynet mismatch is not detectable; `lnsb` (simnet) passes core's regex
 * but names no `NetworkName`, so it is refused rather than mapped to a neighbour.
 *
 * Gates owned here: HRP, invoice expiry, amountless refusal. Gates that need the quote
 * (e.g. headroom vs `quote.refund_locktime`) belong to the quote path.
 */
import { invoiceTarget, type NetworkName } from "@arkade-os/sdk";
import type { InvoiceFacts } from "../../rfq";
import type { CorridorClaim, CorridorDrive, CorridorFactory, CorridorModule } from "./contract";
import type { LightningCorridorDeps } from "./deps";

/**
 * Which networks an invoice HRP can belong to. Ordered, not a record: `lnbcrt` must be
 * tested before `lnbc` and `lntbs` before `lntb`.
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
export const PAYMENT_HASH = /^[0-9a-f]{64}$/;

/**
 * Both directions, with ownership inverted. `arkade -> lightning`: the trader funds the
 * lockup, so `refundLocktime` is a moment to refund AFTER (the solver claims with the
 * preimage it learns by paying). `lightning -> arkade`: the solver funds it, the trader
 * has no refund, and the deadline is a moment to have claimed BEFORE.
 */
export const LIGHTNING_DRIVE = {
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
} as const satisfies CorridorDrive;

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
                // Inside the `try`: the decoder is a replaceable seam and `matches` must not
                // throw. `Hex` is a bare alias, so a malformed hash would typecheck and then
                // be compared byte-for-byte against a real one.
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

            if (!Number.isSafeInteger(facts.expiresAt)) {
                return { refused: "the decoded invoice carries no usable expiry" };
            }
            const now = Math.floor(Date.now() / 1000);
            if (facts.expiresAt <= now) {
                return { refused: `the invoice expired ${now - facts.expiresAt}s ago` };
            }

            if (!Number.isSafeInteger(facts.amountSats) || facts.amountSats < 0) {
                return { refused: "the decoded invoice carries no usable amount" };
            }
            // Amountless arrives as `0`. A destination string is the TAKE leg of a send, where
            // the invoice is the amount pin and `amountOn` cannot rescue it. (The instrument's
            // `amount` stays optional for future reusable instruments such as BOLT12.)
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
