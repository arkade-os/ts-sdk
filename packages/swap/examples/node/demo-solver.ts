/**
 * A stand-in for the reference solver, in-process, so the example runs with
 * nothing but the regtest stack in front of it.
 *
 * It quotes `arkade:BTC->lightning:BTC` the way a real solver does: it reads
 * the payment hash out of the invoice, picks its own `refund_locktime`, and
 * derives the lockup covenant — the SAME derivation the trader runs on its
 * side, which is why the two addresses agree.
 *
 * What it is NOT: a solver. It holds no Lightning node, never pays the
 * invoice, and cannot claim the covenant — so a swap quoted here can only be
 * funded and then refunded by covenant once `refund_locktime` passes. The
 * example refuses to fund against it for that reason.
 *
 * Note that the trader does not need this side to be honest: it compares the
 * quoted `lockup_address` against its own derivation and funds only its own
 * (see `verifyLockupAddress`). Pass `SOLVER_URL` to talk to a real solver over
 * `httpTransport` instead.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";

import {
    LIGHTNING_SEND_PAIR,
    lightningSendVtxoScript,
    type RfqQuote,
    type RfqStatus,
    type RfqTransport,
} from "../../src/index.js";
import { invoiceFacts } from "./bolt11.js";

/** How long a quote stays fundable, and how far out the trader's refund path
 * sits. Both are the solver's call; the trader only gates on them. */
const QUOTE_TTL_SECONDS = 120;
const REFUND_LOCKTIME_SECONDS = 24 * 60 * 60;

export interface DemoSolverOptions {
    /** The Ark server's x-only key — the demo solver reads the same server. */
    serverPubkey: Uint8Array;
    /** The emulator's x-only key, likewise. */
    emulatorPubkey: Uint8Array;
    /** From `unilateralClaimDelay` over the same server info. */
    claimDelay: number;
    /** Address prefix for the network the Ark server reports. */
    hrp: string;
}

export const demoSolverTransport = (options: DemoSolverOptions): RfqTransport => {
    // an example key: this side never signs, it only needs a public key to
    // name in the covenant's claim leaf
    const solverPubkey = schnorr.getPublicKey(new Uint8Array(32).fill(0x11));
    const quoted = new Map<string, RfqQuote>();

    return {
        async requestQuote(payload) {
            const profile = payload.profile as { invoice: string; refund_address: string };
            const invoice = invoiceFacts(profile.invoice);
            const now = Math.floor(Date.now() / 1000);
            const refundLocktime = now + REFUND_LOCKTIME_SECONDS;

            const script = lightningSendVtxoScript({
                solverPubkey,
                refundLocktime,
                serverPubkey: options.serverPubkey,
                paymentHash: invoice.paymentHash,
                claimDelay: options.claimDelay,
                emulatorPubkey: options.emulatorPubkey,
                refundPkScript: ArkAddress.decode(profile.refund_address).pkScript,
            });

            const quote: RfqQuote = {
                v: 1,
                type: "rfq_quote",
                rfq_id: String(payload.rfq_id),
                pair: LIGHTNING_SEND_PAIR,
                from_amount: invoice.amountSats,
                to_amount: invoice.amountSats,
                solver_pubkey: hex.encode(solverPubkey),
                valid_until: now + QUOTE_TTL_SECONDS,
                refund_locktime: refundLocktime,
                profile: {
                    payment_hash: invoice.paymentHash,
                    lockup_address: script.address(options.hrp, options.serverPubkey).encode(),
                },
            };
            quoted.set(quote.rfq_id, quote);
            return quote;
        },

        async status(rfqId): Promise<RfqStatus | null> {
            const quote = quoted.get(rfqId);
            if (!quote) return null;
            // nothing funds here, so the negotiation never leaves `quoted` — a
            // real solver walks this to `settled` and publishes the preimage
            return {
                v: 1,
                type: "rfq_status",
                rfq_id: rfqId,
                state: "quoted",
                updated_at: Math.floor(Date.now() / 1000),
                profile: { payment_hash: quote.profile.payment_hash },
            };
        },

        async close() {},
    };
};
