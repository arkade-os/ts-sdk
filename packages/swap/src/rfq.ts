/**
 * RFQ v1 — the user side of quoted swaps.
 *
 * RFQ is the negotiation layer only. After the quote, **filling is
 * non-interactive** for every corridor this module serves: the user funds,
 * and the solver fills by observing that funding rather than by being told.
 * (Roles are *user* and *solver* throughout — see the README's Roles section
 * for why this package does not name the participants maker and taker.)
 *
 * - `arkade:BTC -> lightning:BTC` / `arkade:BTC -> onchain:BTC` (send) — the
 *   user funds its own locally derived VHTLC contract ({@link
 *   lightningSendVtxoScript}) and the onchain leg claims its L1 HTLC with `P`;
 *   the solver fills by observing the funding on-chain. A failed swap refunds
 *   to the user's address — by the user's own `sender` key on every
 *   interactive path, or, if the user's own key is ever lost, by the server
 *   and solver together via the `nonInteractiveRefund` leaf (no user
 *   signature, no timelock), which the emulator co-signs under a covenant
 *   provably paying only the user's pre-committed address.
 * - `lightning:BTC -> arkade:BTC` / `onchain:BTC -> arkade:BTC` (receive) —
 *   the user generates `P`, pays the solver's hold invoice or funds the L1
 *   HTLC, and may go offline; the solver funds the Arkade lockup pinned to
 *   the user's payout ({@link receiveVtxoScript}, roles inverted), and the
 *   claim — the user's own collaborative spend, or covclaimd's — reveals
 *   `P` publicly, which is what settles the user's side.
 * - `arkade:BTC|asset -> arkade:BTC|asset` — the user accepts the quote by
 *   creating and funding an Intents **offer** (`createOffer`) bound to the
 *   quoted terms; the offer covenant lets any filler deliver, so the solver
 *   fills without further interaction, or the user cancels cooperatively.
 *
 * There is deliberately NO accept message anywhere: acceptance is funding.
 * Every corridor then ends the same way — a fill, or the value back: a
 * timelocked refund on the HTLC corridors, a cooperative cancel on the
 * Arkade-only one.
 *
 * Trust model, identical to the offer side: from a quote the user uses only
 * the binding fields — `solver_pubkey`, `refund_locktime`, `valid_until`, the
 * amounts. Every other contract parameter is the user's own data (its
 * invoice, its Ark server connection, its refund address) or a trusted
 * constant — the emulator key defaults to the SDK's per-network pin (see
 * `resolveEmulatorPubkey`). Anything address-shaped the solver sends is
 * compare-only: a mismatch means refuse-to-fund, never "use theirs".
 *
 * Transport is symmetric-outbound: the reference framing below speaks the dev
 * broker (`{op:"sub"|"event"}` over WebSocket) or plain HTTP; the production
 * target is Nostr (directed kind + NIP-44), which changes only the transport
 * functions here, nothing above them.
 */
import { hex } from "@scure/base";
import {
    ArkAddress,
    RestArkProvider,
    VHTLC,
    asset,
    getNetwork,
    resolveEmulatorPubkey,
    toXOnly,
    type IWallet,
    type NetworkName,
} from "@arkade-os/sdk";

import { type OnchainHtlc, type OnchainHtlcParams, type OnchainNetwork } from "./onchainHtlc";

export {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
} from "./onchainHtlc";

import {
    provisionClaimSecret,
    provisionRefundKey,
    type ProvisionedClaimSecret,
    type ProvisionedKey,
} from "@arkade-os/sdk";
import { sealClaimPacket } from "./claimPacket";
import { registerLockupContract } from "./lockupContract";

// ── Re-exports from extracted modules ────────────────────────────────────────
// Error classes and closed sets
export {
    RFQ_TERMINAL_STATES,
    SwapRefusal,
    AddressMismatch,
    type RfqRefusalReason,
} from "./rfqErrors";

// VTXO script builders and timing helpers
export {
    SOLO_REFUND_HEADROOM_SECONDS,
    unilateralClaimDelay,
    unilateralRefundDelay,
    unilateralRefundWithoutReceiverDelay,
    lightningSendVtxoScript,
    receiveVtxoScript,
    type LightningSendTreeParams,
    type LightningReceiveTreeParams,
} from "./vhtlcScript";

// Verification / assertion helpers
export {
    MIN_HEADROOM_SECONDS,
    MIN_CLAIM_WINDOW_SECONDS,
    verifyLockupAddress,
    assertFundable,
    verifyReceiveInvoice,
    assertReceivable,
    type InvoiceFacts,
} from "./rfqVerify";

// Corridor derivation functions
export { deriveLightningReceive, deriveOnchainSend, deriveOnchainReceive } from "./rfqDerive";

// ── Internal imports for use in this file ────────────────────────────────────
import { SwapRefusal } from "./rfqErrors";
import { unilateralClaimDelay, lightningSendVtxoScript, receiveVtxoScript } from "./vhtlcScript";
import {
    verifyLockupAddress,
    assertFundable,
    verifyReceiveInvoice,
    assertReceivable,
    type InvoiceFacts,
} from "./rfqVerify";
import { deriveLightningReceive, deriveOnchainSend, deriveOnchainReceive } from "./rfqDerive";
import type { LightningSendTreeParams, LightningReceiveTreeParams } from "./vhtlcScript";

/** Decode a solver-supplied hex field, turning a malformed value (odd length,
 * non-hex chars) into a solver-blaming diagnostic instead of a bare
 * `@scure/base` internal error. */
const solverHex = (value: string, field: string): Uint8Array => {
    try {
        return hex.decode(value);
    } catch {
        throw new Error(`solver sent malformed hex for ${field}`);
    }
};

// ── Pairs ────────────────────────────────────────────────────────────────────

/** Legs are `<corridor>:<asset>`; a pair is directional, `from->to`. */
export const ARKADE_BTC = "arkade:BTC";
export const LIGHTNING_BTC = "lightning:BTC";

export const ONCHAIN_BTC = "onchain:BTC";

/** The arkade leg for an asset: the asset id itself, 68 lowercase hex. The id
 * lives in the pair rather than the profile because the pair is the field both
 * sides route and subscribe on, and a coarse leg cannot say which asset a
 * market key is for.
 *
 * Taking an `AssetId` rather than a string is what enforces the case rule:
 * `hex.decode` accepts uppercase while `hex.encode` only emits lowercase, so a
 * value that reached us as `A1B2…` leaves here as `a1b2…`. Solvers compare pair
 * strings byte for byte — a sender that normalised only in its key derivation
 * would reach the right subscription and then be skipped as an unserved pair. */
export const arkadeAssetLeg = (id: asset.AssetId): string => `arkade:${id.toString()}`;

/** @deprecated The coarse asset leg. No solver serves it: `ASSET` is neither a
 * registered ticker nor a 68-hex asset id, so a solver's market-key derivation
 * throws on it. Use {@link arkadeAssetLeg}. Removed next major. */
export const ARKADE_ASSET = "arkade:ASSET";

export const rfqPair = (from: string, to: string): string => `${from}->${to}`;

/** The implemented pair: pay a BOLT11 invoice out of an Arkade balance. */
export const LIGHTNING_SEND_PAIR = rfqPair(ARKADE_BTC, LIGHTNING_BTC);
/** On-board via Lightning: pay the solver's hold invoice, land on Arkade. */
export const LIGHTNING_RECEIVE_PAIR = rfqPair(LIGHTNING_BTC, ARKADE_BTC);
/** Off-board: Arkade sats out to a Bitcoin-L1 HTLC. */
export const ONCHAIN_SEND_PAIR = rfqPair(ARKADE_BTC, ONCHAIN_BTC);
/** On-board: a Bitcoin-L1 HTLC in, Arkade sats out. */
export const ONCHAIN_RECEIVE_PAIR = rfqPair(ONCHAIN_BTC, ARKADE_BTC);

// ── Messages ─────────────────────────────────────────────────────────────────

/** A fresh client-chosen negotiation id: 32 random bytes, lowercase hex. */
export const newRfqId = (): string => hex.encode(crypto.getRandomValues(new Uint8Array(32)));

export interface RfqQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    from_amount: number;
    to_amount: number;
    solver_pubkey: string;
    valid_until: number;
    /** HTLC-class quotes only; absent for arkade↔arkade. */
    refund_locktime?: number;
    profile: { [key: string]: unknown; payment_hash?: string; lockup_address?: string };
    [key: string]: unknown;
}

export interface RfqStatus {
    v: 1;
    type: "rfq_status";
    rfq_id: string;
    state: string;
    updated_at: number;
    profile: Record<string, unknown>;
    [key: string]: unknown;
}

/** The wire's cap on a pair string, mirrored so an over-long pair fails here
 * with a reason instead of arriving as a bare `unsupported_payload`.
 *
 * 158 = ("lightning".length + 1 + 68) * 2 + "->".length — the longest corridor
 * name, a full 68-hex asset id on each leg, and the arrow. The longest pair
 * anyone can build is `arkade:<68>->arkade:<68>`, at 152 — and until the
 * exactly-one-asset guard in {@link arkadeSwapRequest} relaxes, this package
 * tops out at 87, so the guard is dormant on purpose.
 *
 * Restated rather than re-derived from this package's own corridor names: a
 * local cap BELOW the solver's would refuse a pair the solver would have
 * served, which is worse than the remote refusal this exists to pre-empt. The
 * test pins the number so a drift is a failure, not a surprise.
 *
 * Module-level, not in `index.ts`: it mirrors a number this repo does not own,
 * and publishing it would turn a remote edit into a semver event here. */
export const MAX_PAIR_LENGTH = 158;

/** Exported for the tests — a dormant guard still needs one, and no public
 * entry point can reach it. Not in `index.ts`. */
export const assertPairLength = (pair: string): void => {
    if (pair.length > MAX_PAIR_LENGTH) {
        throw new Error(
            `pair is ${pair.length} characters, over the wire's ${MAX_PAIR_LENGTH}-character limit`,
        );
    }
};

/** The rfq_request for the lightning send profile. A BOLT11 profile is always
 * exact-out: the invoice fixes the amount, so none is restated here.
 * `senderPubkey` is the trader's own key for the VHTLC's sender-side leaves
 * (see {@link lightningSendVtxoScript}) — required, never sent anywhere else,
 * never trusted by the solver as anything but a pubkey to bind into the
 * script. On the wire it's `client_refund_pubkey` (the payload schemas are
 * public at https://docs.arkadeos.com/intents/reference/rfq — the solver's schema
 * is `.strict()`, so both the wrong name AND the missing required field would
 * refuse every request). */
export const lightningSendRequest = (input: {
    rfqId: string;
    invoice: string;
    refundAddress: string;
    senderPubkey: Uint8Array;
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: LIGHTNING_SEND_PAIR,
    amount_side: "to",
    profile: {
        invoice: input.invoice,
        refund_address: input.refundAddress,
        client_refund_pubkey: hex.encode(input.senderPubkey),
    },
});

/** The rfq_request for an arkade↔arkade swap. Exactly one side may name an
 * asset id per direction (BTC has none), and the id is the leg itself — see
 * {@link arkadeAssetLeg}. Forward-looking: the wire shape is specified, the
 * reference solver does not serve it yet. */
export const arkadeSwapRequest = (input: {
    rfqId: string;
    /** Asset the trader deposits; omit when depositing BTC. */
    offerAsset?: asset.AssetId;
    /** Asset the trader wants; omit when wanting BTC. */
    wantAsset?: asset.AssetId;
    amountSide: "from" | "to";
    /** Integer base units of the side named by `amountSide`. */
    amount: number;
}): Record<string, unknown> => {
    // Both refusals say "exactly one", but the causes differ and so do the
    // remedies: neither side named is a degenerate request, both sides named is
    // a real corridor still waiting on a counterparty.
    if (!input.wantAsset && !input.offerAsset) {
        throw new Error(
            "set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC) — " +
                "with neither set both legs are BTC, which is not a swap",
        );
    }
    if (input.wantAsset && input.offerAsset) {
        throw new Error(
            "set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC) — " +
                "asset->asset is nameable on the wire but no solver quotes it yet",
        );
    }
    const pair = rfqPair(
        input.offerAsset ? arkadeAssetLeg(input.offerAsset) : ARKADE_BTC,
        input.wantAsset ? arkadeAssetLeg(input.wantAsset) : ARKADE_BTC,
    );
    assertPairLength(pair);
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair,
        amount_side: input.amountSide,
        amount: input.amount,
        // The pair is the only place the asset ids appear. Repeating them here
        // would be a key the solver's `.strict()` profile schema does not
        // declare, and an undeclared key is `unsupported_payload` — a refusal,
        // not an ignored extra. Empty, not absent: `profile` is required on
        // every other request shape this wire carries.
        profile: {},
    };
};

// ── Transports ───────────────────────────────────────────────────────────────

export interface RfqTransport {
    requestQuote(payload: Record<string, unknown>): Promise<RfqQuote>;
    status(rfqId: string): Promise<RfqStatus | null>;
    close(): Promise<void>;
}

/**
 * Discriminate a solver reply: a refusal carries a closed-set reason and is
 * thrown as {@link SwapRefusal}; anything that is not a quote for THIS
 * negotiation is an error rather than a value. The `rfq_id` check is what stops
 * a reply to one negotiation being accepted as the answer to another — on a
 * shared relay the solver's events all arrive on the same subscription.
 *
 * `pair` is compared for the same reason the solver compares it byte for byte:
 * a solver that normalises case, or quotes a market other than the one asked
 * for, is otherwise undetectable client-side. Note the quote's pair is a
 * constant the solver restates rather than the request's echoed back, so this
 * binds every solver to the exact spellings this module builds.
 *
 * `requestedPair` is optional by value, not by parameter: callers pass a
 * payload they built, and a payload with no `pair` is not one whose pair can be
 * wrong. Comparing `String(undefined)` would refuse every quote.
 *
 * Shared with the nostr transport (`nostr.ts`), which used to carry a
 * byte-identical copy — module-level only, never re-exported from `index.ts`.
 */
export const expectQuote = (payload: unknown, rfqId: string, requestedPair?: string): RfqQuote => {
    const p = payload as { type?: string; reason?: string; rfq_id?: string; pair?: unknown } | null;
    if (p?.type === "rfq_refusal") throw new SwapRefusal(p.reason ?? "unknown", p.rfq_id ?? rfqId);
    if (p?.type !== "rfq_quote" || p.rfq_id !== rfqId) {
        throw new Error(`unexpected reply: ${p?.type ?? "no payload"}`);
    }
    if (requestedPair !== undefined && p.pair !== requestedPair) {
        throw new Error(
            `solver quoted ${JSON.stringify(p.pair)}, not the requested ${requestedPair}`,
        );
    }
    return payload as RfqQuote;
};

/** The pair of a request we built, when it named one. */
export const pairOf = (payload: Record<string, unknown>): string | undefined =>
    typeof payload.pair === "string" ? payload.pair : undefined;

/** HTTP: POST /v1/swap for quotes, GET /v1/rfq/<rfq_id> for status.
 * `fetchImpl` is injectable for tests and non-global-fetch runtimes. */
export const httpTransport = (
    baseUrl: string,
    options: { fetchImpl?: typeof fetch } = {},
): RfqTransport => {
    const fetchImpl = options.fetchImpl ?? fetch;
    /**
     * A refusal is a 4xx carrying an `rfq_refusal` body, so the status code
     * alone cannot decide whether to read it — rejecting every non-2xx would
     * throw away the closed-set reason the solver sent. What must not happen
     * is a non-JSON body (an nginx 502 page, a proxy timeout) surfacing as a
     * bare `SyntaxError` from the parser, which says nothing about what went
     * wrong. So: parse defensively, and name the status when the body is not
     * ours to interpret.
     */
    const readJson = async (response: Response, what: string): Promise<unknown> => {
        const body = await response.text();
        try {
            return JSON.parse(body) as unknown;
        } catch {
            throw new Error(
                `${what} returned HTTP ${response.status} with a non-JSON body: ${body.slice(0, 200)}`,
            );
        }
    };
    return {
        async requestQuote(payload) {
            const response = await fetchImpl(`${baseUrl}/v1/swap`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            return expectQuote(
                await readJson(response, "quote request"),
                String(payload.rfq_id),
                pairOf(payload),
            );
        },
        async status(rfqId) {
            const response = await fetchImpl(`${baseUrl}/v1/rfq/${rfqId}`, { method: "GET" });
            if (response.status === 404) return null;
            const payload = (await readJson(response, "status request")) as {
                type?: string;
            } | null;
            return payload?.type === "rfq_status" ? (payload as RfqStatus) : null;
        },
        async close() {},
    };
};

/** Minimal WebSocket surface the relay transport needs — satisfied by the DOM
 * WebSocket and by `ws` alike, so neither becomes a dependency. */
export interface RelaySocket {
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "message" | "error", listener: (event: any) => void): void;
}

/** Relay: both parties outbound, addressed by x-only pubkey, speaking the dev
 * broker framing. Nostr (directed kind + NIP-44) replaces only this function.
 * One socket; replies correlated by rfq_id. */
export const relayTransport = (
    relayUrl: string,
    options: {
        solverPubkey: string;
        clientPubkey: string;
        WebSocketCtor?: new (url: string) => RelaySocket;
        timeoutMs?: number;
    },
): RfqTransport => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const Ctor =
        options.WebSocketCtor ?? (WebSocket as unknown as new (url: string) => RelaySocket);
    const pending = new Map<string, (payload: unknown) => void>();
    let sequence = 0;

    const socketReady = new Promise<RelaySocket>((resolve, reject) => {
        const ws = new Ctor(relayUrl);
        ws.addEventListener("open", () => {
            ws.send(
                JSON.stringify({
                    op: "sub",
                    id: "s1",
                    filter: { recipient: options.clientPubkey },
                }),
            );
            resolve(ws);
        });
        ws.addEventListener("error", () => reject(new Error("relay connection failed")));
        ws.addEventListener("message", (event: { data: unknown }) => {
            let frame: { op?: string; event?: { payload?: { rfq_id?: string } } };
            try {
                frame = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (frame.op !== "event") return;
            const payload = frame.event?.payload;
            const rfqId = payload?.rfq_id;
            const settle = rfqId !== undefined ? pending.get(rfqId) : undefined;
            if (settle && rfqId !== undefined) {
                pending.delete(rfqId);
                settle(payload);
            }
        });
    });

    const roundTrip = async (payload: Record<string, unknown>, rfqId: string): Promise<unknown> => {
        const ws = await socketReady;
        const reply = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(rfqId);
                reject(new Error(`no reply within ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(rfqId, (p) => {
                clearTimeout(timer);
                resolve(p);
            });
        });
        ws.send(
            JSON.stringify({
                op: "event",
                event: {
                    id: `${options.clientPubkey}:${(sequence += 1)}`,
                    author: options.clientPubkey,
                    recipient: options.solverPubkey,
                    createdAtMs: Date.now(),
                    payload,
                },
            }),
        );
        return reply;
    };

    return {
        async requestQuote(payload) {
            return expectQuote(
                await roundTrip(payload, String(payload.rfq_id)),
                String(payload.rfq_id),
                pairOf(payload),
            );
        },
        async status(rfqId) {
            const payload = (await roundTrip(
                { v: 1, type: "rfq_status_request", rfq_id: rfqId },
                rfqId,
            )) as { type?: string } | null;
            return payload?.type === "rfq_status" ? (payload as RfqStatus) : null;
        },
        async close() {
            try {
                (await socketReady).close();
            } catch {
                // socket never opened; nothing to close
            }
        },
    };
};

// ── Request builders ─────────────────────────────────────────────────────────

/** The rfq_request for `arkade:BTC->onchain:BTC`. Exact-out means "this much
 * lands in the L1 HTLC". `senderPubkey` is the user's own key for the
 * VHTLC's sender-side leaves — same role as in {@link lightningSendRequest}.
 * On the wire it's `client_refund_pubkey`, same as there. */
export const onchainSendRequest = (input: {
    rfqId: string;
    /** `sha256(P)`, hex — user-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** User's x-only L1 key for the HTLC's claim leaf. */
    payoutPubkey: Uint8Array;
    /** User's arkade address — where the covenant refund must pay. */
    refundAddress: string;
    senderPubkey: Uint8Array;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: ONCHAIN_SEND_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        payout_pubkey: hex.encode(input.payoutPubkey),
        refund_address: input.refundAddress,
        client_refund_pubkey: hex.encode(input.senderPubkey),
    },
});

/** The rfq_request for `lightning:BTC->arkade:BTC`: pay the solver's hold
 * invoice, land on Arkade. The trader generates `P`, keeps it, and sends only
 * `H` plus `P` sealed to covclaimd — the solver never sees `P` until it
 * appears in a claim witness. `payoutPubkey` is the trader's own x-only
 * Arkade key — the covenant's `receiver` role on this leg, so the trader can
 * claim the lockup itself without covclaimd. */
export const lightningReceiveRequest = (input: {
    rfqId: string;
    /** `H = sha256(P)`, hex — trader-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** Trader's arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** Trader's x-only arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
    /** `P` sealed to covclaimd, base64 — `sealClaimPacket(...).ciphertext`. */
    claimPacket: string;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: LIGHTNING_RECEIVE_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        payout_address: input.payoutAddress,
        payout_pubkey: hex.encode(input.payoutPubkey),
        claim_packet: input.claimPacket,
    },
});

/** The rfq_request for `onchain:BTC->arkade:BTC`. The user funds the L1 HTLC
 * (holding its refund role) and receives Arkade; P travels sealed to
 * covclaimd (see `sealClaimPacket`) so the user can go offline after
 * funding. `payoutPubkey` is the trader's own x-only Arkade key — the
 * covenant's `receiver` role, same as the Lightning receive leg's. */
export const onchainReceiveRequest = (input: {
    rfqId: string;
    paymentHash: string;
    /** Trader's arkade address — where the swapped sats land. */
    payoutAddress: string;
    /** Trader's x-only arkade key — the covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
    /** Trader's x-only L1 key for the HTLC's refund leaf. */
    refundPubkey: Uint8Array;
    /** `P` sealed to covclaimd, base64 — `sealClaimPacket(...).ciphertext`. */
    claimPacket: string;
    amount: number;
    amountSide: "from" | "to";
}): Record<string, unknown> => ({
    v: 1,
    type: "rfq_request",
    rfq_id: input.rfqId,
    pair: ONCHAIN_RECEIVE_PAIR,
    amount_side: input.amountSide,
    amount: input.amount,
    profile: {
        payment_hash: input.paymentHash,
        claim_packet: input.claimPacket,
        refund_pubkey: hex.encode(input.refundPubkey),
        payout_address: input.payoutAddress,
        payout_pubkey: hex.encode(input.payoutPubkey),
    },
});

// ── Arkade ↔ arkade: quote, then take by funding an offer ───────────────────

/**
 * Map an arkade↔arkade quote onto `createOffer` terms. The trader takes the
 * quote by creating and funding the offer covenant before `valid_until` —
 * the non-interactive fill: the covenant only releases the deposit to a
 * transaction that delivers the quoted want-amount to the trader, so the
 * solver fills or nothing moves. There is no rfq_fill message and no refund
 * timelock; an unfilled offer is cancelled cooperatively (`cancelOffer`).
 */
export const offerTermsFromQuote = (
    quote: RfqQuote,
    assets: { wantAsset?: asset.AssetId; offerAsset?: asset.AssetId },
): { wantAmount: bigint; wantAsset?: asset.AssetId; offerAsset?: asset.AssetId } => {
    if (Boolean(assets.wantAsset) === Boolean(assets.offerAsset)) {
        throw new Error("set exactly one of wantAsset or offerAsset");
    }
    return { wantAmount: BigInt(quote.to_amount), ...assets };
};

// ── Internal helpers ──────────────────────────────────────────────────────────

const l1NetworkFromArk = (network: string): OnchainNetwork =>
    network === "bitcoin" ? "bitcoin" : network === "regtest" ? "regtest" : "testnet";

/** The exact-out/exact-in consistency check every receive flow applies: the
 * fixed side of the quote must equal the amount the request named. Anything
 * else is a quote for a different trade. */
const assertQuotedAmount = (quote: RfqQuote, amountSide: "from" | "to", amount: number): void => {
    const quoted = amountSide === "from" ? quote.from_amount : quote.to_amount;
    if (quoted !== amount) {
        throw new Error(
            `quote ${amountSide === "from" ? "from_amount" : "to_amount"} ${quoted} ` +
                `does not match the requested ${amount} — not this trade's quote`,
        );
    }
    if (quote.to_amount > quote.from_amount) {
        throw new Error("quote pays out more than it takes in — not a quote to fund");
    }
};

// ── Top-level user flows ──────────────────────────────────────────────────────

/**
 * The lightning-send user flow, mirroring `createOffer`'s shape: quote →
 * derive locally → verify → gate. Pure of funding on purpose — it returns the
 * address and amount, and the caller funds with its own wallet
 * (`wallet.send({ address, amount })`) before `quote.valid_until`, after
 * which the user may go OFFLINE: filling is non-interactive. Success reveals
 * the preimage in the solver's claim witness (also served via status as
 * `settled`); failure refunds to `refundAddress`.
 *
 * Throws {@link SwapRefusal} (closed reason), {@link AddressMismatch} (never
 * fund), a gate error with a stable `reason`, or
 * {@link LockupRegistrationFailed} — the last one alone means the quote is
 * still good and the same call can be retried once local storage is.
 *
 * Broadcasts nothing, but does write locally: the lockup is registered with the
 * wallet's contract manager before the address is returned, exactly as
 * `createOffer` registers its covenant — so the lockup is watched from the
 * moment it lands and out of generic coin selection, and a persistence failure
 * throws while nothing is funded. `RfqSwapManager` re-registers as a backstop
 * for older records; a repeat write is a no-op.
 *
 * The `sender` key comes from the wallet — a fresh HD descriptor per call, or
 * the wallet's static key — and is returned as `senderPubkey` plus `secrets`.
 * `secrets` holds only a public descriptor; the signer re-derives from the
 * wallet, so nothing secret is at rest. Persist `secrets` with the record
 * anyway: it is how the refund signer is found again. `nonInteractiveRefund`
 * recovers the funds even without it — but it needs the SOLVER's active
 * cooperation, not just infrastructure uptime.
 */
export async function requestLightningSend(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        invoice: InvoiceFacts;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The trader's OWN derivation — the only address to fund. */
    address: string;
    /** What the lockup must carry: the quote's `from_amount` (the invoice
     * amount plus the corridor's fee), in sats. */
    fundAmount: number;
    /** The covenant's scriptPubKey, for watching the lockup and its spend. */
    swapPkScript: Uint8Array;
    /** The covenant itself. Hand it to `RfqSwapManager` as the record's
     * `lockup` (with `address`): without it the manager can only poll, and
     * cannot retire the row this call just wrote. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** Where a failed swap refunds. */
    refundAddress: string;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the `sender` key is recovered later. Persist it with the record;
     * it holds nothing secret. */
    secrets: ProvisionedKey;
    /**
     * Every input the covenant was built from, as it was AT REQUEST TIME.
     *
     * Returned so a consumer can persist the swap without re-deriving any of
     * it. Half of these are not on the quote: `serverPubkey` and `claimDelay`
     * come from this wallet's own `getInfo()`, `emulatorPubkey` from a
     * per-network pin, `refundPkScript` from decoding an address.
     *
     * All public. Persisting them is optional: this call also registers the
     * lockup as a contract, and that row is where `rebuildRfqSwap` takes its
     * covenant from — see `rfqRecord.ts`. Keep a copy only to hold a record
     * that rebuilds without the wallet's contract store, and keep it as
     * `VHTLCV2ContractHandler.serializeParams(script.options)`, the shape the
     * rebuild accepts.
     */
    treeParams: LightningSendTreeParams;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // This leg is one we fund, so all it needs is the key that refunds it.
    // No preimage: a lightning send's P belongs to the payee.
    const secrets = await provisionRefundKey(wallet);
    const senderPubkey = secrets.pubkey;
    const [info, refundAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);

    const quote = await transport.requestQuote(
        lightningSendRequest({ rfqId, invoice: params.invoice.raw, refundAddress, senderPubkey }),
    );
    if (quote.refund_locktime === undefined) {
        throw new Error("lightning-send quote is missing refund_locktime");
    }
    const receiverPkScriptHex = quote.profile?.receiver_pk_script as string | undefined;
    if (receiverPkScriptHex === undefined) {
        throw new Error("lightning-send quote is missing profile.receiver_pk_script");
    }
    // The BOLT11 profile is exact-out: `to_amount` is the invoice, verbatim,
    // and `from_amount` adds the corridor's fee on top. Funding anything but
    // `from_amount` underfunds by exactly the fee and is refused — and a quote
    // repricing the invoice itself is not a quote for this invoice at all.
    if (quote.to_amount !== params.invoice.amountSats) {
        throw new Error(
            `quote to_amount ${quote.to_amount} does not match the invoice's ${params.invoice.amountSats}`,
        );
    }
    if (quote.from_amount < quote.to_amount) {
        throw new Error(
            `quote from_amount ${quote.from_amount} is below the invoice amount — a negative spread is not a quote`,
        );
    }

    const serverPubkey = toXOnly(hex.decode(info.signerPubkey), "ark signer key");
    const network = getNetwork(info.network as NetworkName);
    // Named rather than inlined so the exact inputs the covenant was built from
    // can be returned to the caller — see `treeParams` on the return type.
    const treeParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime: quote.refund_locktime,
        serverPubkey,
        paymentHash: params.invoice.paymentHash,
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: ArkAddress.decode(refundAddress).pkScript,
    };
    const script = lightningSendVtxoScript(treeParams);
    const address = script.address(network.hrp, serverPubkey).encode();
    verifyLockupAddress(quote, address);
    assertFundable({
        quote,
        invoiceExpiresAt: params.invoice.expiresAt,
        now: Math.floor(Date.now() / 1000),
    });

    // Last, so a refused quote leaves no row behind, but still before the
    // caller holds an address to fund: registration throws here, where nothing
    // is at stake, rather than stranding a funded lockup unwatched.
    await registerLockupContract(await wallet.getContractManager(), script, address);

    return {
        rfqId,
        quote,
        address,
        // What the lockup must carry: the quote's `from_amount` — the invoice
        // PLUS the corridor's fee, never the bare invoice amount.
        fundAmount: quote.from_amount,
        swapPkScript: script.pkScript,
        script,
        refundAddress,
        senderPubkey,
        secrets,
        treeParams,
    };
}

/**
 * The `arkade:BTC->onchain:BTC` user flow, mirroring `requestLightningSend`:
 * quote → derive BOTH contracts locally → verify → gate. Pure of funding —
 * the caller funds `address` with its own wallet before `quote.valid_until`.
 *
 * Registers the arkade lockup before returning the address, on the same terms
 * as {@link requestLightningSend} — including {@link LockupRegistrationFailed},
 * the one throw here that does not mean "walk away from this quote". The L1
 * HTLC is not a contract row: it lives on bitcoin, not on Ark, and the wallet's
 * contract manager knows nothing of it.
 *
 * Two obligations, both LOUD:
 * - **Persist `secrets` (with the record) BEFORE funding.** On an HD wallet it
 *   is a public descriptor and both the preimage and the `sender` key
 *   re-derive from the seed; otherwise it carries the raw secrets, and losing
 *   them forfeits the L1 claim and every interactive refund path — leaving
 *   recovery dependent on the solver via `nonInteractiveRefund`.
 * - **Stay claim-capable.** Unlike lightning-send the user cannot go fully
 *   offline: it must claim the L1 HTLC (`awaitOnchainFill` →
 *   `claimOnchainFill`) before `htlc.refundLocktime`. Missing that window
 *   forfeits the fill and falls back to the Arkade covenant refund.
 */
export async function requestOnchainSend(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** User's x-only L1 key that will claim the HTLC. */
        payoutPubkey: Uint8Array;
        /** Optional caller-owned P. Persist it with the returned secrets before funding. */
        preimage?: Uint8Array;
        rfqId?: string;
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The user's OWN arkade lockup derivation — the only address to fund. */
    address: string;
    fundAmount: number;
    swapPkScript: Uint8Array;
    /** The arkade covenant itself — the record's `lockup` for
     * `RfqSwapManager`, same role as {@link requestLightningSend}'s. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    refundAddress: string;
    /** The EXPECTED L1 fill, derived locally — watch and claim against this. */
    htlc: OnchainHtlc;
    /** The inputs {@link htlc} was built from — persist these to rebuild it
     * after a restart. Nothing else gives them back: `OnchainHtlc` exposes only
     * derived values, and this contract is Bitcoin L1, so unlike the arkade
     * lockup there is no contract row holding its parameters. Persist
     * `htlc.address` alongside them (`OnchainSendProfile.htlcAddress`): the
     * rebuild checks the two against each other, which is the only check
     * available on a leg with no second copy of its covenant.
     *
     * `onchainSendProfile(result)` does all of that mapping for you; prefer it
     * to reading these fields across by hand. */
    htlcParams: OnchainHtlcParams;
    /**
     * Which bitcoin network the L1 HTLC was derived for.
     *
     * Returned because it is NOT the ark network name and cannot be recovered
     * from one by inspection: this call maps `info.network` through a private
     * narrowing where signet, mutinynet and testnet4 all become `"testnet"`.
     * A caller reconstructing it from context would be re-deriving a mapping
     * it cannot see, and a value the profile needs verbatim.
     */
    l1Network: OnchainNetwork;
    /** `profile.min_confirmations`; gates when the L1 fill becomes claimable,
     * and part of what a restored swap needs to drive its own claim. */
    minConfirmations: number;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the preimage and the `sender` key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE funding. Public unless
     * `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // We fund the arkade leg and claim the L1 one, so this needs both halves:
    // the key that refunds the lockup and the P that claims the HTLC. A
    // supplied P is length-checked before an index is consumed — the L1 claim
    // leaf pins OP_SIZE 32, and any other length funds an unclaimable HTLC.
    const secrets = await provisionClaimSecret(wallet, { preimage: params.preimage });
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before funding",
        );
    }
    const paymentHash = hex.encode(secrets.paymentHash);
    const senderPubkey = secrets.pubkey;
    const [info, refundAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);

    const quote = await transport.requestQuote(
        onchainSendRequest({
            rfqId,
            paymentHash,
            payoutPubkey: params.payoutPubkey,
            refundAddress,
            senderPubkey,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );

    const network = getNetwork(info.network as NetworkName);
    const derived = deriveOnchainSend({
        quote,
        paymentHash,
        payoutPubkey: params.payoutPubkey,
        serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
        l1Network: l1NetworkFromArk(info.network),
        refundAddress,
        senderPubkey,
    });
    assertFundable({
        quote,
        now: Math.floor(Date.now() / 1000),
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "send",
        },
    });

    // Before the caller can fund, and loud on failure — see the same call in
    // `requestLightningSend`.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        address: derived.address,
        fundAmount: quote.from_amount,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        refundAddress,
        htlc: derived.htlc,
        htlcParams: derived.htlcParams,
        l1Network: derived.l1Network,
        minConfirmations: derived.minConfirmations,
        senderPubkey,
        secrets,
    };
}

/**
 * The `lightning:BTC->arkade:BTC` user flow: quote → derive the covenant
 * locally → verify → gate. Returns the solver's hold invoice to PAY — the
 * payment itself is the trader's own Lightning wallet's job, exactly as
 * funding is the caller's job on the send corridors. Once the paid HTLC is
 * held, the solver funds the lockup; the trader claims it with `P` (its own,
 * generated here) — itself via the collaborative claim leaf
 * ({@link claimReceiveLockup} in `claim.ts`), or via covclaimd if it is
 * offline.
 *
 * Three obligations, all of them before the invoice is handed to a payer:
 *
 * 1. Persist `secrets` and `expectedAmount`. The preimage and the payout key
 *    re-derive from `secrets` (or, on a non-HD wallet, are carried by it), and
 *    without `expectedAmount` the claim has nothing to compare the funded
 *    value against.
 * 2. Stay online. covclaimd cannot claim this covenant today, so the offline
 *    path the claim packet exists for does not run yet: an unclaimed lockup is
 *    reclaimed by the solver at `refund_locktime` and the payer refunded.
 * 3. On {@link LockupRegistrationFailed}, call this function again once the
 *    store is working. The failed attempt is inert — it returned no invoice,
 *    so nothing can be paid into the lockup nobody is watching — and the new
 *    call derives its own preimage and `rfq_id`. Re-registering `error.script`
 *    does NOT resume it: the invoice and `secrets` were never handed back.
 *
 * The invoice is the solver's, so it is verified here against the trader's own
 * `H` and the quote ({@link verifyReceiveInvoice}) before it is returned —
 * nothing publishable comes back from a failed check, registration included.
 * Pay before `invoiceExpiresAt`: the hold-invoice window is minutes, not the
 * quote's `valid_until`.
 */
export async function requestLightningReceive(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** covclaimd's 33-byte compressed pubkey (from its own info endpoint)
         * — the claim packet seals to it and only it can ever read `P` early. */
        covclaimdPubkey: Uint8Array;
        /** The caller's own BOLT11 decoder, applied to the SOLVER's invoice.
         * Required: an optional verifier is one integrators skip, and this is
         * the check whose absence loses the whole payment. */
        decodeInvoice: (bolt11: string) => InvoiceFacts;
        /** Opt-in ceiling, in sats, on what the payer will be asked for. */
        maxPayAmount?: number;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The solver's hold invoice — what the trader pays, for `payAmount`.
     * Verified against this swap's `H` and the quote's `from_amount`. */
    invoice: string;
    /** What the trader pays: the quote's `from_amount`. */
    payAmount: number;
    /** What the solver's lockup must carry: the quote's `to_amount`. Persist
     * it with the record — `pushClaim` refuses to publish `P` for less, and
     * captured at claim time instead it would be whatever the solver funded. */
    expectedAmount: number;
    /** Last moment the invoice can be paid, unix seconds: `min(invoice
     * expiry, valid_until)`. Absolute on purpose — a countdown returned from
     * here is stale before the caller reads it; derive one at display time. */
    invoiceExpiresAt: number;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    payoutAddress: string;
    /** The trader's covenant `receiver` key, bound into the tree. Public. */
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE paying the invoice.
     * Public unless `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
    /** Every input the covenant was built from; see the same field on
     * `requestLightningSend`'s result. */
    treeParams: LightningReceiveTreeParams;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // A leg we claim: the key that receives it, and the P that unlocks it.
    const secrets = await provisionClaimSecret(wallet);
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before paying",
        );
    }
    const preimage = secrets.preimage;
    const paymentHash = hex.encode(secrets.paymentHash);
    const payoutPubkey = secrets.pubkey;
    const [info, payoutAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);
    const claimPacket = await sealClaimPacket({
        preimage,
        covclaimdPubkey: params.covclaimdPubkey,
    });

    const quote = await transport.requestQuote(
        lightningReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress,
            payoutPubkey,
            claimPacket: claimPacket.ciphertext,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const network = getNetwork(info.network as NetworkName);
    const derived = deriveLightningReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
    });
    const now = Math.floor(Date.now() / 1000);
    const { payDeadline } = verifyReceiveInvoice({
        invoice: derived.invoice,
        decode: params.decodeInvoice,
        paymentHash,
        quote,
    });
    assertReceivable({ quote, payDeadline, now, maxPayAmount: params.maxPayAmount });

    // Watch the solver-funded lockup from the moment its address exists.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        invoice: derived.invoice,
        payAmount: quote.from_amount,
        expectedAmount: quote.to_amount,
        invoiceExpiresAt: payDeadline,
        address: derived.address,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        payoutAddress,
        payoutPubkey,
        secrets,
        treeParams: derived.treeParams,
    };
}

/**
 * The `onchain:BTC->arkade:BTC` user flow: quote → derive BOTH contracts
 * locally → verify → gate. Returns the L1 HTLC to fund (`htlc.address`, for
 * `fundAmount`) — the funding transaction itself is the trader's own L1
 * wallet's job, exactly as on the send corridors. After `min_confirmations`
 * the solver funds the Arkade lockup; the trader claims it with `P` (its
 * own), itself or via covclaimd.
 *
 * Persist `secrets` BEFORE funding, and note the direction's own deadline:
 * if the swap never settles, the L1 HTLC's refund leaf (the trader's
 * `refundPubkey`) opens at `htlc.refundLocktime` — `buildHtlcRefund` takes it
 * back from there.
 */
export async function requestOnchainReceive(
    wallet: IWallet,
    arkServerUrl: string,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Co-signer key override (33-byte compressed hex); see
         * {@link resolveEmulatorPubkey}. */
        emulatorPubkey?: string;
        /** Trader's x-only L1 key for the HTLC's refund leaf. */
        refundPubkey: Uint8Array;
        /** covclaimd's 33-byte compressed pubkey — see {@link requestLightningReceive}. */
        covclaimdPubkey: Uint8Array;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    /** What the trader's L1 funding must carry: the quote's `from_amount`. */
    fundAmount: number;
    /** What the solver's lockup must carry: the quote's `to_amount`. Persist
     * it with the record — see {@link requestLightningReceive}. */
    expectedAmount: number;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The EXPECTED L1 contract, derived locally — fund only this address. */
    htlc: OnchainHtlc;
    payoutAddress: string;
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later — map it
     * through `swapSecretsToRecord` and persist BEFORE funding. Public unless
     * `mustPersistPreimage` says the wallet could not derive P. */
    secrets: ProvisionedClaimSecret;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // A leg we claim: the key that receives it, and the P that unlocks it.
    const secrets = await provisionClaimSecret(wallet);
    if (secrets.mustPersistPreimage) {
        console.warn(
            "[swap] this swap's preimage cannot be re-derived from the seed and MUST be persisted with the record before funding",
        );
    }
    const preimage = secrets.preimage;
    const paymentHash = hex.encode(secrets.paymentHash);
    const payoutPubkey = secrets.pubkey;
    const [info, payoutAddress] = await Promise.all([
        new RestArkProvider(arkServerUrl).getInfo(),
        wallet.getAddress(),
    ]);
    const claimPacket = await sealClaimPacket({
        preimage,
        covclaimdPubkey: params.covclaimdPubkey,
    });

    const quote = await transport.requestQuote(
        onchainReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress,
            payoutPubkey,
            refundPubkey: params.refundPubkey,
            claimPacket: claimPacket.ciphertext,
            amount: params.amount,
            amountSide: params.amountSide,
        }),
    );
    assertQuotedAmount(quote, params.amountSide, params.amount);

    const network = getNetwork(info.network as NetworkName);
    const derived = deriveOnchainReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        refundPubkey: params.refundPubkey,
        serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: toXOnly(
            hex.decode(resolveEmulatorPubkey(network, params.emulatorPubkey)),
            "emulator signer key",
        ),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: network.hrp,
        l1Network: l1NetworkFromArk(info.network),
    });
    assertFundable({
        quote,
        now: Math.floor(Date.now() / 1000),
        onchain: {
            htlcLocktime: derived.htlcLocktime,
            minConfirmations: derived.minConfirmations,
            direction: "receive",
        },
    });

    // Watch the solver-funded lockup from the moment its address exists.
    await registerLockupContract(
        await wallet.getContractManager(),
        derived.script,
        derived.address,
    );

    return {
        rfqId,
        quote,
        address: derived.address,
        fundAmount: quote.from_amount,
        expectedAmount: quote.to_amount,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        htlc: derived.htlc,
        payoutAddress,
        payoutPubkey,
        secrets,
    };
}
