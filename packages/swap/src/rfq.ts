/**
 * RFQ v1 — the maker / intent-submitter side of quoted swaps.
 *
 * RFQ is the negotiation layer only. After the quote, **filling is
 * non-interactive maker-taker** for every corridor this module serves — the
 * MAKER is this side (the trader posting and funding the intent), the TAKER
 * is the solver that fills it:
 *
 * - `arkade:BTC -> lightning:BTC` / `arkade:BTC -> onchain:BTC` (send) — the
 *   trader funds its own locally derived VHTLC contract ({@link
 *   lightningSendVtxoScript}) and the onchain leg claims its L1 HTLC with `P`;
 *   the solver fills by observing the funding on-chain. A failed swap refunds
 *   to the trader's address — by the trader's own `sender` key on every
 *   interactive path, or, if the trader's own key is ever lost, by the server
 *   and solver together via the `nonInteractiveRefund` leaf (no trader
 *   signature, no timelock), which the emulator co-signs under a covenant
 *   provably paying only the trader's pre-committed address.
 * - `lightning:BTC -> arkade:BTC` / `onchain:BTC -> arkade:BTC` (receive) —
 *   the trader generates `P`, pays the solver's hold invoice or funds the L1
 *   HTLC, and may go offline; the solver funds the Arkade lockup pinned to
 *   the trader's payout ({@link receiveVtxoScript}, roles inverted), and the
 *   claim — the trader's own collaborative spend, or covclaimd's — reveals
 *   `P` publicly, which is what settles the trader's side.
 * - `arkade:BTC|asset -> arkade:BTC|asset` — the trader accepts the quote by
 *   creating and funding an Intents **offer** (`createOffer`) bound to the
 *   quoted terms; the offer covenant lets any filler deliver, so the solver
 *   fills without further interaction, or the trader cancels cooperatively.
 *
 * There is deliberately NO accept message anywhere: acceptance is funding.
 *
 * Trust model, identical to the offer side: from a quote the trader uses only
 * the binding fields — `solver_pubkey`, `refund_locktime`, `valid_until`, the
 * amounts. Every other contract parameter is the trader's own data (its
 * invoice, its Ark server connection, its refund address) or obtained
 * out-of-band from a source it independently trusts — the emulator's x-only
 * key, from the solver's signed registry/corridor card, since clients have no
 * network path to the emulator itself; only the solver and covclaimd do.
 * Anything address-shaped the solver sends is compare-only: a mismatch means
 * refuse-to-fund, never "use theirs".
 *
 * Transport is symmetric-outbound: the reference framing below speaks the dev
 * broker (`{op:"sub"|"event"}` over WebSocket) or plain HTTP; the production
 * target is Nostr (directed kind + NIP-44), which changes only the transport
 * functions here, nothing above them.
 */
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import {
    ArkAddress,
    RestArkProvider,
    VHTLC,
    asset,
    getNetwork,
    type IWallet,
    type NetworkName,
} from "@arkade-os/sdk";

import {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    ONCHAIN_SECONDS_PER_BLOCK,
    onchainHtlcScript,
    paymentHashOf,
    type OnchainHtlc,
    type OnchainNetwork,
} from "./onchainHtlc";

export {
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
} from "./onchainHtlc";

import {
    deriveSwapSecrets,
    preimageForRfqSecrets,
    randomSwapSecrets,
    senderPubkeyForRfqSecrets,
    type SwapSecrets,
} from "./secrets";
import { sealClaimPacket } from "./claimPacket";
import { registerLockupContract } from "./lockupContract";

/** Drop the prefix of a 33-byte compressed key; pass an x-only key through —
 * same rule as offer.ts, kept local so this module stays self-contained. */
const xOnly = (key: Uint8Array, label: string): Uint8Array => {
    if (key.length === 32) return key;
    if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) {
        throw new Error(`${label} is not a compressed or x-only public key`);
    }
    return key.slice(1);
};

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

/** Legs are `<corridor>:<asset>`; a pair is directional, `from->to`. Arkade
 * asset legs stay coarse (`arkade:ASSET`) — the exact asset ids ride the
 * request profile, mirroring how the offer TLV identifies assets. */
export const ARKADE_BTC = "arkade:BTC";
export const ARKADE_ASSET = "arkade:ASSET";
export const LIGHTNING_BTC = "lightning:BTC";

export const ONCHAIN_BTC = "onchain:BTC";

export const rfqPair = (from: string, to: string): string => `${from}->${to}`;

/** The implemented pair: pay a BOLT11 invoice out of an Arkade balance. */
export const LIGHTNING_SEND_PAIR = rfqPair(ARKADE_BTC, LIGHTNING_BTC);
/** On-board via Lightning: pay the solver's hold invoice, land on Arkade. */
export const LIGHTNING_RECEIVE_PAIR = rfqPair(LIGHTNING_BTC, ARKADE_BTC);
/** Off-board: Arkade sats out to a Bitcoin-L1 HTLC. */
export const ONCHAIN_SEND_PAIR = rfqPair(ARKADE_BTC, ONCHAIN_BTC);
/** On-board: a Bitcoin-L1 HTLC in, Arkade sats out. */
export const ONCHAIN_RECEIVE_PAIR = rfqPair(ONCHAIN_BTC, ARKADE_BTC);

// ── Errors and closed sets ───────────────────────────────────────────────────

/** The closed refusal set. Treat any unknown reason as a generic decline. */
export type RfqRefusalReason =
    | "unsupported_pair"
    | "unsupported_payload"
    | "amount_out_of_range"
    | "exposure_cap"
    | "invoice_expired"
    | "quote_conflict"
    | "pricing_unavailable";

/** Lifecycle vocabulary; states after which nothing more will happen. */
export const RFQ_TERMINAL_STATES = ["settled", "refused", "expired", "refunded", "stuck"] as const;

/** A refusal from the solver, carrying its closed-set reason. */
export class SwapRefusal extends Error {
    readonly reason: string;
    readonly rfqId: string | undefined;
    constructor(reason: string, rfqId?: string) {
        super(`solver refused: ${reason}`);
        this.name = "SwapRefusal";
        this.reason = reason;
        this.rfqId = rfqId;
    }
}

/** The solver's address does not match the local derivation. NEVER fund past this. */
export class AddressMismatch extends Error {
    readonly derived: string;
    readonly quoted: string | undefined;
    constructor(derived: string, quoted?: string) {
        super("solver lockup address does not match local derivation — refusing to fund");
        this.name = "AddressMismatch";
        this.derived = derived;
        this.quoted = quoted;
    }
}

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

/** The rfq_request for the lightning send profile. A BOLT11 profile is always
 * exact-out: the invoice fixes the amount, so none is restated here.
 * `senderPubkey` is the trader's own key for the VHTLC's sender-side leaves
 * (see {@link lightningSendVtxoScript}) — required, never sent anywhere else,
 * never trusted by the solver as anything but a pubkey to bind into the
 * script. On the wire it's `client_refund_pubkey` (docs/rfq-protocol.md —
 * the solver's schema is `.strict()`, so both the wrong name AND the missing
 * required field would refuse every request). */
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
 * asset id per direction (BTC has none); the pair string stays coarse and the
 * ids ride the profile, like the offer TLV. Forward-looking: the wire shape is
 * specified, the reference solver does not serve it yet. */
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
    if (Boolean(input.wantAsset) === Boolean(input.offerAsset)) {
        throw new Error("set exactly one of wantAsset (BTC->asset) or offerAsset (asset->BTC)");
    }
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair: rfqPair(
            input.offerAsset ? ARKADE_ASSET : ARKADE_BTC,
            input.wantAsset ? ARKADE_ASSET : ARKADE_BTC,
        ),
        amount_side: input.amountSide,
        amount: input.amount,
        profile: {
            ...(input.offerAsset && { offer_asset: hex.encode(input.offerAsset.serialize()) }),
            ...(input.wantAsset && { want_asset: hex.encode(input.wantAsset.serialize()) }),
        },
    };
};

// ── Guardrails ───────────────────────────────────────────────────────────────

/** Funding gate: refuse unless ≥90 min remain before the refund path opens.
 * 90 because the refund CLTV matures against median-time-past (BIP-113),
 * which lags wall clock by ~1h — a smaller wall-clock margin is no margin. */
export const MIN_HEADROOM_SECONDS = 90 * 60;

/** Compare-only check of the solver's address against YOUR derivation.
 * Throws {@link AddressMismatch}; returns the address so calls chain. */
export const verifyLockupAddress = (quote: RfqQuote, derivedAddress: string): string => {
    const quoted = quote.profile?.lockup_address;
    if (derivedAddress !== quoted) throw new AddressMismatch(derivedAddress, quoted);
    return derivedAddress;
};

/** The maker's gates, checked immediately before funding — never at quote
 * time. Throws with a stable `reason` property. `invoiceExpiresAt` applies to
 * BOLT11 profiles only; `onchain` adds the L1-HTLC gates (§ guardrails of the
 * onchain spec) and is required for the onchain pairs. */
export const assertFundable = (input: {
    quote: RfqQuote;
    invoiceExpiresAt?: number;
    now: number;
    onchain?: {
        htlcLocktime: number;
        minConfirmations: number;
        /** "send" = arkade->onchain (the L1 timelock-order gate applies). */
        direction: "send" | "receive";
    };
}): void => {
    const fail = (reason: string, message: string): never => {
        const error = new Error(message) as Error & { reason: string };
        error.reason = reason;
        throw error;
    };
    if (input.invoiceExpiresAt !== undefined && input.now >= input.invoiceExpiresAt) {
        fail("invoice_expired", "invoice expired");
    }
    if (input.now >= input.quote.valid_until)
        fail("quote_expired", "quote expired — request a fresh one");
    if (
        input.quote.refund_locktime !== undefined &&
        input.quote.refund_locktime - input.now < MIN_HEADROOM_SECONDS
    ) {
        fail("insufficient_headroom", "refund deadline headroom below 90 minutes");
    }
    if (input.onchain) {
        const { htlcLocktime, minConfirmations, direction } = input.onchain;
        if (
            !Number.isInteger(minConfirmations) ||
            minConfirmations < 1 ||
            minConfirmations > MAX_MIN_CONFIRMATIONS
        ) {
            fail(
                "confirmations_out_of_range",
                `min_confirmations must be 1..${MAX_MIN_CONFIRMATIONS}, got ${minConfirmations}`,
            );
        }
        // Enough room to confirm the fill AND claim well before the refund
        // leaf opens (MTP lag + confirmation time).
        const needed = minConfirmations * ONCHAIN_SECONDS_PER_BLOCK + ONCHAIN_CLAIM_MARGIN_SECONDS;
        if (htlcLocktime - input.now <= needed) {
            fail("claim_window_too_short", "L1 HTLC locktime leaves no safe claim window");
        }
        if (direction === "send") {
            // The solver claims Arkade with P AFTER the maker's L1 claim; the
            // maker's Arkade refund must therefore open LAST, with reorg margin.
            if (
                input.quote.refund_locktime === undefined ||
                htlcLocktime + ONCHAIN_ORDER_MARGIN_SECONDS > input.quote.refund_locktime
            ) {
                fail(
                    "timelock_order",
                    "L1 HTLC locktime + margin must fall before the Arkade refund locktime",
                );
            }
        }
    }
};

// ── Transports ───────────────────────────────────────────────────────────────

export interface RfqTransport {
    requestQuote(payload: Record<string, unknown>): Promise<RfqQuote>;
    status(rfqId: string): Promise<RfqStatus | null>;
    close(): Promise<void>;
}

const expectQuote = (payload: unknown, rfqId: string): RfqQuote => {
    const p = payload as { type?: string; reason?: string; rfq_id?: string } | null;
    if (p?.type === "rfq_refusal") throw new SwapRefusal(p.reason ?? "unknown", p.rfq_id ?? rfqId);
    if (p?.type !== "rfq_quote" || p.rfq_id !== rfqId) {
        throw new Error(`unexpected reply: ${p?.type ?? "no payload"}`);
    }
    return payload as RfqQuote;
};

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
            return expectQuote(await readJson(response, "quote request"), String(payload.rfq_id));
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

// ── Lightning send: derivation + the maker flow ──────────────────────────────

/** BIP68 sequence granularity; the delay derivation rounds up to it. */
const SEQUENCE_GRANULARITY_SECONDS = 512;

/** The solver's unilateral-claim delay, derived from the Ark server's reported
 * exit delay exactly as the reference solver derives it — both sides read the
 * SAME server, so the derivation (not a quote field) is what keeps the two
 * scripts identical. */
export const unilateralClaimDelay = (serverExitDelaySeconds: number): number => {
    if (
        !Number.isFinite(serverExitDelaySeconds) ||
        serverExitDelaySeconds < SEQUENCE_GRANULARITY_SECONDS
    ) {
        throw new Error(
            `server exit delay must be at least ${SEQUENCE_GRANULARITY_SECONDS}s of seconds, got ${serverExitDelaySeconds}`,
        );
    }
    // two granularity steps below BIP68's ceiling, not at it: the refund tiers
    // add one and two steps on top of this value, and every tier must encode
    if (serverExitDelaySeconds > (0xffff - 2) * SEQUENCE_GRANULARITY_SECONDS) {
        throw new Error(
            `server exit delay ${serverExitDelaySeconds}s exceeds what BIP68 can encode ` +
                `once the two refund tiers are stacked above it`,
        );
    }
    return (
        Math.ceil(serverExitDelaySeconds / SEQUENCE_GRANULARITY_SECONDS) *
        SEQUENCE_GRANULARITY_SECONDS
    );
};

/** VHTLC's `unilateralRefund` tier: sender + solver, no server, one 512s step
 * past `claimDelay` — the middle rung between the fully-collaborative paths
 * and the sender's last-resort `unilateralRefundWithoutReceiver`. Same
 * already-rounded `claimDelay` input as {@link unilateralClaimDelay}
 * produces — one rounding, shared across all three tiers. */
export const unilateralRefundDelay = (claimDelay: number): number =>
    claimDelay + SEQUENCE_GRANULARITY_SECONDS;

/** VHTLC's `unilateralRefundWithoutReceiver` tier: sender alone, needs
 * nobody — two 512s steps past `claimDelay`, past {@link
 * unilateralRefundDelay}. */
export const unilateralRefundWithoutReceiverDelay = (claimDelay: number): number =>
    claimDelay + 2 * SEQUENCE_GRANULARITY_SECONDS;

/** Compile the lightning-send VHTLC from the quote's binding fields plus the
 * trader's own data. `paymentHash` is the BOLT11 payment hash (`sha256(P)`,
 * hex); the script's HASH160 commitment is derived from it here, which is why
 * the trader never needs to see `P`.
 *
 * Every quote gets the full eight-leaf contract: VHTLC's own six
 * (`claim`/`refund`/`refundWithoutReceiver`/`unilateralClaim`/
 * `unilateralRefund`/`unilateralRefundWithoutReceiver`), plus two more the
 * emulator co-signs under a covenant pinning the payout to a pre-committed
 * destination — `nonInteractiveClaim` (server + emulator, pays the solver's
 * own `receiverPkScript`, no solver signature needed) and
 * `nonInteractiveRefund` (server + solver + emulator, pays the trader's own
 * `refundPkScript`, no timelock and no trader signature needed — see {@link
 * VHTLC.Options.nonInteractiveRefund}'s doc comment for why that matters).
 */
export function lightningSendVtxoScript(params: {
    /** Binding field #1: the solver's x-only key, from the quote. */
    solverPubkey: Uint8Array;
    /** Binding field #2: when the trader's refund path opens, from the quote. */
    refundLocktime: number;
    /** The Ark server's x-only key — the trader's OWN connection. */
    serverPubkey: Uint8Array;
    /** BOLT11 payment hash, hex — from the trader's OWN invoice decode. */
    paymentHash: string;
    /** From {@link unilateralClaimDelay} over the trader's OWN server info.
     * {@link unilateralRefundDelay} and {@link unilateralRefundWithoutReceiverDelay}
     * derive from this same value — one rounding, shared across all three tiers. */
    claimDelay: number;
    /** Emulator x-only key — the SOLVER's deployment, not the trader's own.
     * Not fetched here or anywhere in this package; see {@link
     * requestLightningSend}'s `emulatorPubkey` parameter for where it comes
     * from and why. */
    emulatorPubkey: Uint8Array;
    /** Where a refund must pay: the trader's P2TR pkScript (34 bytes). Also
     * `nonInteractiveRefund`'s covenant destination. */
    refundPkScript: Uint8Array;
    /** The trader's own key — VHTLC's `sender` role. Required on every
     * interactive refund-side leaf; the trader generates and persists it
     * (see {@link requestLightningSend}'s own obligations). */
    senderPubkey: Uint8Array;
    /** The solver's own claim destination, from the quote
     * (`profile.receiver_pk_script`) — needed only so `nonInteractiveClaim`'s
     * covenant key can be derived; the trader does not otherwise use or trust
     * this value. P2TR pkScript, 34 bytes. */
    receiverPkScript: Uint8Array;
}): InstanceType<typeof VHTLC.ScriptV2> {
    const seconds = (value: number): { type: "seconds"; value: bigint } => ({
        type: "seconds",
        value: BigInt(value),
    });
    return new VHTLC.ScriptV2({
        sender: params.senderPubkey,
        receiver: params.solverPubkey,
        server: params.serverPubkey,
        preimageHash: ripemd160(hex.decode(params.paymentHash)),
        refundLocktime: BigInt(params.refundLocktime),
        unilateralClaimDelay: seconds(params.claimDelay),
        unilateralRefundDelay: seconds(unilateralRefundDelay(params.claimDelay)),
        unilateralRefundWithoutReceiverDelay: seconds(
            unilateralRefundWithoutReceiverDelay(params.claimDelay),
        ),
        nonInteractiveClaim: {
            receiverPkScript: params.receiverPkScript,
            emulatorPubkey: params.emulatorPubkey,
        },
        nonInteractiveRefund: {
            senderPkScript: params.refundPkScript,
            emulatorPubkey: params.emulatorPubkey,
        },
    });
}

/** The BOLT11 facts the trader read from its OWN decode — this module takes
 * the facts, not the decoder, so any wallet's existing decoder serves. */
export interface InvoiceFacts {
    /** The raw BOLT11 — what travels in the request profile. */
    raw: string;
    /** `sha256(P)`, hex (64 chars). */
    paymentHash: string;
    amountSats: number;
    /** Absolute expiry, unix seconds. */
    expiresAt: number;
}

/**
 * The lightning-send maker flow, mirroring `createOffer`'s shape: quote →
 * derive locally → verify → gate. Pure of funding on purpose — it returns the
 * address and amount, and the caller funds with its own wallet
 * (`wallet.send({ address, amount })`) before `quote.valid_until`, after
 * which the maker may go OFFLINE: filling is non-interactive. Success reveals
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
 * Allocates a fresh `sender` key per call and returns it as `senderPubkey`
 * plus `secrets`. On an HD wallet `secrets` holds only a public descriptor and
 * nothing needs protecting; otherwise it holds the raw key and the caller MUST
 * persist it, or every interactive refund path is gone. `nonInteractiveRefund`
 * still recovers the funds without it — but it needs the SOLVER's active
 * cooperation, not just infrastructure uptime, so losing the key with an
 * unwilling solver is a total loss.
 */
export async function requestLightningSend(
    wallet: IWallet,
    arkServerUrl: string,
    /** Covenant co-signer (emulator) x-only key — the SOLVER's deployment,
     * not the trader's. This library does NOT fetch or verify it: clients
     * have no network path to the emulator, only the solver and covclaimd
     * do. The caller must obtain this out-of-band, before calling this
     * function, from the solver's signed registry/corridor card (its
     * `emulator_pubkey`, added in arkade-os/solver-registry#18) or an
     * equivalent source it
     * independently trusts, and is responsible for having checked it against
     * that trusted value itself — the same never-trust-only-compare rule as
     * {@link verifyLockupAddress}, just applied by the caller instead of
     * here, because there is nothing in this module to derive it against. */
    emulatorPubkey: Uint8Array,
    transport: RfqTransport,
    params: { invoice: InvoiceFacts; rfqId?: string },
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
    /** How the `sender` key is recovered later. Persist it with the record —
     * on the derivable arm it holds nothing secret. */
    secrets: SwapSecrets;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    const secrets = (await deriveSwapSecrets(wallet)) ?? randomSwapSecrets();
    if (!secrets.derivable) {
        console.warn(
            "[swap] wallet cannot allocate an HD descriptor: the sender key is random and MUST be persisted before funding",
        );
    }
    const senderPubkey = await senderPubkeyForRfqSecrets(wallet, secrets);
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

    const serverPubkey = xOnly(hex.decode(info.signerPubkey), "ark signer key");
    const script = lightningSendVtxoScript({
        solverPubkey: xOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime: quote.refund_locktime,
        serverPubkey,
        paymentHash: params.invoice.paymentHash,
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        emulatorPubkey: xOnly(emulatorPubkey, "emulator pubkey"),
        senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: ArkAddress.decode(refundAddress).pkScript,
    });
    const address = script
        .address(getNetwork(info.network as NetworkName).hrp, serverPubkey)
        .encode();
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
    };
}

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

// ── Onchain corridor: off-board (arkade->onchain) and on-board wire ─────────

/** The Arkade lockup for an onchain send uses the SAME {@link
 * lightningSendVtxoScript} the Lightning leg does — only the SOURCE of the
 * payment hash differs (maker-generated P instead of a BOLT11). One function,
 * one golden test. */

const l1NetworkFromArk = (network: string): OnchainNetwork =>
    network === "bitcoin" ? "bitcoin" : network === "regtest" ? "regtest" : "testnet";

/** The rfq_request for `arkade:BTC->onchain:BTC`. Exact-out means "this much
 * lands in the L1 HTLC". `senderPubkey` is the maker's own key for the
 * VHTLC's sender-side leaves — same role as in {@link lightningSendRequest}.
 * On the wire it's `client_refund_pubkey`, same as there. */
export const onchainSendRequest = (input: {
    rfqId: string;
    /** `sha256(P)`, hex — maker-chosen; see {@link paymentHashOf}. */
    paymentHash: string;
    /** Maker's x-only L1 key for the HTLC's claim leaf. */
    payoutPubkey: Uint8Array;
    /** Maker's arkade address — where the covenant refund must pay. */
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

/** The rfq_request for `onchain:BTC->arkade:BTC`. The maker funds the L1 HTLC
 * (holding its refund role) and receives Arkade; P travels sealed to
 * covclaimd (see `sealClaimPacket`) so the maker can go offline after
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

/**
 * The pure core of {@link requestOnchainSend}: derive BOTH contracts locally
 * from the quote's binding fields plus the maker's own data, and refuse on any
 * mismatch. Binding: `solver_pubkey`, `refund_locktime`, `htlc_pubkey`,
 * `htlc_locktime`, `min_confirmations`; `lockup_address` and `htlc_address`
 * are compare-only.
 */
export function deriveOnchainSend(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    l1Network: OnchainNetwork;
    refundAddress: string;
    /** The maker's own key for the VHTLC's sender-side leaves — same role as
     * in {@link requestLightningSend}. */
    senderPubkey: Uint8Array;
}): {
    address: string;
    swapPkScript: Uint8Array;
    /** The lockup covenant itself — what the contract row is registered from,
     * so the row can never key on a script other than the derived one. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    htlc: OnchainHtlc;
    refundLocktime: number;
    htlcLocktime: number;
    minConfirmations: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime ?? (profile.refund_locktime as number | undefined);
    const htlcPubkey = profile.htlc_pubkey as string | undefined;
    const htlcLocktime = profile.htlc_locktime as number | undefined;
    const htlcAddress = profile.htlc_address as string | undefined;
    const minConfirmations = profile.min_confirmations as number | undefined;
    const receiverPkScriptHex = profile.receiver_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        htlcPubkey === undefined ||
        htlcLocktime === undefined ||
        minConfirmations === undefined ||
        receiverPkScriptHex === undefined
    ) {
        throw new Error("onchain-send quote is missing a binding field");
    }

    const script = lightningSendVtxoScript({
        solverPubkey: xOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        senderPubkey: input.senderPubkey,
        receiverPkScript: solverHex(receiverPkScriptHex, "profile.receiver_pk_script"),
        refundPkScript: ArkAddress.decode(input.refundAddress).pkScript,
    });
    const address = script.address(input.hrp, input.serverPubkey).encode();
    verifyLockupAddress(quote, address);

    const htlc = onchainHtlcScript(
        {
            paymentHash: input.paymentHash,
            claimKey: input.payoutPubkey,
            refundKey: xOnly(hex.decode(htlcPubkey), "solver L1 htlc key"),
            refundLocktime: htlcLocktime,
        },
        input.l1Network,
    );
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
    };
}

/**
 * The `arkade:BTC->onchain:BTC` maker flow, mirroring `requestLightningSend`:
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
 * - **Stay claim-capable.** Unlike lightning-send the maker cannot go fully
 *   offline: it must claim the L1 HTLC (`awaitOnchainFill` →
 *   `claimOnchainFill`) before `htlc.refundLocktime`. Missing that window
 *   forfeits the fill and falls back to the Arkade covenant refund.
 */
export async function requestOnchainSend(
    wallet: IWallet,
    arkServerUrl: string,
    /** Covenant co-signer (emulator) x-only key — same parameter, same
     * caller obligation, as {@link requestLightningSend}'s. */
    emulatorPubkey: Uint8Array,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** Maker's x-only L1 key that will claim the HTLC. */
        payoutPubkey: Uint8Array;
        /** Optional caller-owned P. Persist it with the returned secrets before funding. */
        preimage?: Uint8Array;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The maker's OWN arkade lockup derivation — the only address to fund. */
    address: string;
    fundAmount: number;
    swapPkScript: Uint8Array;
    /** The arkade covenant itself — the record's `lockup` for
     * `RfqSwapManager`, same role as {@link requestLightningSend}'s. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    refundAddress: string;
    /** The EXPECTED L1 fill, derived locally — watch and claim against this. */
    htlc: OnchainHtlc;
    /** The VHTLC `sender` x-only key, bound into the covenant. Public. */
    senderPubkey: Uint8Array;
    /** How the preimage and the `sender` key are recovered later. Persist it
     * with the record BEFORE funding. */
    secrets: SwapSecrets;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    // Before anything irreversible (HD allocation, quote, funding): the L1
    // claim leaf pins OP_SIZE 32, so any other length funds an unclaimable
    // HTLC, and restore rejects the record outright (`decodeHex32`).
    if (params.preimage && params.preimage.length !== 32) {
        throw new Error(`preimage must be 32 bytes, got ${params.preimage.length}`);
    }
    const derivedSecrets = await deriveSwapSecrets(wallet);
    const secrets = derivedSecrets
        ? params.preimage
            ? { ...derivedSecrets, preimage: params.preimage }
            : derivedSecrets
        : randomSwapSecrets({ preimage: params.preimage ?? true });
    if (!secrets.derivable) {
        console.warn(
            params.preimage
                ? "[swap] this swap's sender key is random; the supplied preimage and sender key MUST be persisted before funding"
                : "[swap] this swap's preimage and sender key are random and MUST be persisted before funding",
        );
    } else if (params.preimage) {
        console.warn(
            "[swap] this swap's preimage was supplied by the caller and MUST be persisted with the signing descriptor before funding",
        );
    }
    const preimage = await preimageForRfqSecrets(wallet, secrets);
    const paymentHash = paymentHashOf(preimage);
    const senderPubkey = await senderPubkeyForRfqSecrets(wallet, secrets);
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

    const derived = deriveOnchainSend({
        quote,
        paymentHash,
        payoutPubkey: params.payoutPubkey,
        serverPubkey: xOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: xOnly(emulatorPubkey, "emulator pubkey"),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: getNetwork(info.network as NetworkName).hrp,
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
        senderPubkey,
        secrets,
    };
}

// ── Receive corridors: the solver funds Arkade, the trader pays outside ─────

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

/** Compile the RECEIVE-direction VHTLC: the same eight-leaf tree as {@link
 * lightningSendVtxoScript} with the roles inverted — the trader is the
 * `receiver` (it generated `P` and claims the lockup with it), the solver is
 * the `sender` (it funds the lockup and holds the refund recourse). One
 * function shared by both receive corridors, mirroring the send legs' sharing
 * of `lightningSendVtxoScript`. */
export function receiveVtxoScript(params: {
    /** Binding field #1: the solver's x-only key, from the quote — VHTLC's
     * `sender` role on the receive corridors. */
    solverPubkey: Uint8Array;
    /** Binding field #2: the SOLVER's own refund deadline on these legs, from
     * the quote — after it the solver may reclaim an unclaimed lockup. */
    refundLocktime: number;
    /** The Ark server's x-only key — the trader's OWN connection. */
    serverPubkey: Uint8Array;
    /** `sha256(P)`, hex — the trader's OWN preimage hash. */
    paymentHash: string;
    /** From {@link unilateralClaimDelay} over the trader's OWN server info. */
    claimDelay: number;
    /** Emulator x-only key — see {@link requestLightningSend}'s parameter. */
    emulatorPubkey: Uint8Array;
    /** The solver's covenant refund destination, from the quote
     * (`profile.solver_refund_pk_script`) — the one tree parameter nothing
     * else on the wire determines. */
    solverRefundPkScript: Uint8Array;
    /** The trader's own x-only Arkade key — VHTLC's `receiver` role on these
     * legs, so the trader can claim without covclaimd. */
    payoutPubkey: Uint8Array;
    /** The trader's own Arkade payout pkScript (decoded from its payout
     * address) — `nonInteractiveClaim`'s pinned destination. */
    payoutPkScript: Uint8Array;
}): InstanceType<typeof VHTLC.ScriptV2> {
    const seconds = (value: number): { type: "seconds"; value: bigint } => ({
        type: "seconds",
        value: BigInt(value),
    });
    return new VHTLC.ScriptV2({
        sender: params.solverPubkey,
        receiver: params.payoutPubkey,
        server: params.serverPubkey,
        preimageHash: ripemd160(hex.decode(params.paymentHash)),
        refundLocktime: BigInt(params.refundLocktime),
        unilateralClaimDelay: seconds(params.claimDelay),
        unilateralRefundDelay: seconds(unilateralRefundDelay(params.claimDelay)),
        unilateralRefundWithoutReceiverDelay: seconds(
            unilateralRefundWithoutReceiverDelay(params.claimDelay),
        ),
        nonInteractiveClaim: {
            receiverPkScript: params.payoutPkScript,
            emulatorPubkey: params.emulatorPubkey,
        },
        nonInteractiveRefund: {
            senderPkScript: params.solverRefundPkScript,
            emulatorPubkey: params.emulatorPubkey,
        },
    });
}

/**
 * The pure core of {@link requestLightningReceive}: derive the solver-funded
 * covenant locally from the quote's binding fields plus the trader's own data
 * and refuse on any address mismatch. The trader funds nothing on Arkade on
 * this leg — verification is still what makes paying the hold invoice safe:
 * the lockup the solver will fund must be the tree whose claim paths pay the
 * trader.
 */
export function deriveLightningReceive(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    payoutAddress: string;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
}): {
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The solver's hold invoice on `H` — what the trader pays to arm the swap. */
    invoice: string;
    refundLocktime: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime;
    const invoice = profile.invoice as string | undefined;
    const solverRefundPkScriptHex = profile.solver_refund_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        invoice === undefined ||
        solverRefundPkScriptHex === undefined
    ) {
        throw new Error("lightning-receive quote is missing a binding field");
    }

    const script = receiveVtxoScript({
        solverPubkey: xOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        solverRefundPkScript: solverHex(solverRefundPkScriptHex, "profile.solver_refund_pk_script"),
        payoutPubkey: input.payoutPubkey,
        payoutPkScript: ArkAddress.decode(input.payoutAddress).pkScript,
    });
    const address = script.address(input.hrp, input.serverPubkey).encode();
    verifyLockupAddress(quote, address);
    return { address, swapPkScript: script.pkScript, script, invoice, refundLocktime };
}

/**
 * The `lightning:BTC->arkade:BTC` maker flow: quote → derive the covenant
 * locally → verify → gate. Returns the solver's hold invoice to PAY — the
 * payment itself is the trader's own Lightning wallet's job, exactly as
 * funding is the caller's job on the send corridors. Once the paid HTLC is
 * held, the solver funds the lockup; the trader claims it with `P` (its own,
 * generated here) — itself via the collaborative claim leaf
 * ({@link claimReceiveLockup} in `claim.ts`), or via covclaimd if it is
 * offline.
 *
 * The same obligations as {@link requestOnchainSend}: persist `secrets`
 * BEFORE paying — the preimage and the payout key re-derive from it (or, on a
 * non-HD wallet, are carried by it).
 */
export async function requestLightningReceive(
    wallet: IWallet,
    arkServerUrl: string,
    /** Covenant co-signer (emulator) x-only key — same parameter, same
     * caller obligation, as {@link requestLightningSend}'s. */
    emulatorPubkey: Uint8Array,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
        /** covclaimd's 33-byte compressed pubkey (from its own info endpoint)
         * — the claim packet seals to it and only it can ever read `P` early. */
        covclaimdPubkey: Uint8Array;
        rfqId?: string;
    },
): Promise<{
    rfqId: string;
    quote: RfqQuote;
    /** The solver's hold invoice — what the trader pays, for `payAmount`. */
    invoice: string;
    /** What the trader pays: the quote's `from_amount`. */
    payAmount: number;
    /** The trader's OWN derivation of the lockup the solver must fund. */
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    payoutAddress: string;
    /** The trader's covenant `receiver` key, bound into the tree. Public. */
    payoutPubkey: Uint8Array;
    /** How the preimage and the payout key are recovered later. Persist it
     * with the record BEFORE paying the invoice. */
    secrets: SwapSecrets;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    const secrets = (await deriveSwapSecrets(wallet)) ?? randomSwapSecrets({ preimage: true });
    if (!secrets.derivable) {
        console.warn(
            "[swap] this swap's preimage and payout key are random and MUST be persisted before paying",
        );
    }
    const preimage = await preimageForRfqSecrets(wallet, secrets);
    const paymentHash = paymentHashOf(preimage);
    const payoutPubkey = await senderPubkeyForRfqSecrets(wallet, secrets);
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

    const derived = deriveLightningReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        serverPubkey: xOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: xOnly(emulatorPubkey, "emulator pubkey"),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: getNetwork(info.network as NetworkName).hrp,
    });
    assertFundable({ quote, now: Math.floor(Date.now() / 1000) });

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
        address: derived.address,
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        payoutAddress,
        payoutPubkey,
        secrets,
    };
}

/**
 * The pure core of {@link requestOnchainReceive}: derive BOTH contracts
 * locally — the solver-funded Arkade covenant and the L1 HTLC the trader
 * funds — and refuse on any mismatch. Binding: `solver_pubkey`,
 * `refund_locktime`, `claim_pubkey`, `htlc_locktime`, `min_confirmations`;
 * `lockup_address` and `htlc_address` are compare-only.
 */
export function deriveOnchainReceive(input: {
    quote: RfqQuote;
    paymentHash: string;
    payoutPubkey: Uint8Array;
    payoutAddress: string;
    /** The trader's own x-only L1 key — the HTLC's refund role. */
    refundPubkey: Uint8Array;
    serverPubkey: Uint8Array;
    emulatorPubkey: Uint8Array;
    claimDelay: number;
    hrp: string;
    l1Network: OnchainNetwork;
}): {
    address: string;
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The L1 HTLC the trader funds, derived locally — fund only this. */
    htlc: OnchainHtlc;
    refundLocktime: number;
    htlcLocktime: number;
    minConfirmations: number;
} {
    const { quote } = input;
    const profile = quote.profile ?? {};
    const refundLocktime = quote.refund_locktime;
    const claimPubkey = profile.claim_pubkey as string | undefined;
    const htlcLocktime = profile.htlc_locktime as number | undefined;
    const htlcAddress = profile.htlc_address as string | undefined;
    const minConfirmations = profile.min_confirmations as number | undefined;
    const solverRefundPkScriptHex = profile.solver_refund_pk_script as string | undefined;
    if (
        refundLocktime === undefined ||
        claimPubkey === undefined ||
        htlcLocktime === undefined ||
        minConfirmations === undefined ||
        solverRefundPkScriptHex === undefined
    ) {
        throw new Error("onchain-receive quote is missing a binding field");
    }

    const script = receiveVtxoScript({
        solverPubkey: xOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        solverRefundPkScript: solverHex(solverRefundPkScriptHex, "profile.solver_refund_pk_script"),
        payoutPubkey: input.payoutPubkey,
        payoutPkScript: ArkAddress.decode(input.payoutAddress).pkScript,
    });
    const address = script.address(input.hrp, input.serverPubkey).encode();
    verifyLockupAddress(quote, address);

    const htlc = onchainHtlcScript(
        {
            paymentHash: input.paymentHash,
            claimKey: xOnly(hex.decode(claimPubkey), "solver L1 claim key"),
            refundKey: input.refundPubkey,
            refundLocktime: htlcLocktime,
        },
        input.l1Network,
    );
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
    };
}

/**
 * The `onchain:BTC->arkade:BTC` maker flow: quote → derive BOTH contracts
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
    /** Covenant co-signer (emulator) x-only key — same parameter, same
     * caller obligation, as {@link requestLightningSend}'s. */
    emulatorPubkey: Uint8Array,
    transport: RfqTransport,
    params: {
        amount: number;
        amountSide: "from" | "to";
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
    swapPkScript: Uint8Array;
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The EXPECTED L1 contract, derived locally — fund only this address. */
    htlc: OnchainHtlc;
    payoutAddress: string;
    payoutPubkey: Uint8Array;
    secrets: SwapSecrets;
}> {
    const rfqId = params.rfqId ?? newRfqId();
    const secrets = (await deriveSwapSecrets(wallet)) ?? randomSwapSecrets({ preimage: true });
    if (!secrets.derivable) {
        console.warn(
            "[swap] this swap's preimage and payout key are random and MUST be persisted before funding",
        );
    }
    const preimage = await preimageForRfqSecrets(wallet, secrets);
    const paymentHash = paymentHashOf(preimage);
    const payoutPubkey = await senderPubkeyForRfqSecrets(wallet, secrets);
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

    const derived = deriveOnchainReceive({
        quote,
        paymentHash,
        payoutPubkey,
        payoutAddress,
        refundPubkey: params.refundPubkey,
        serverPubkey: xOnly(hex.decode(info.signerPubkey), "ark signer key"),
        emulatorPubkey: xOnly(emulatorPubkey, "emulator pubkey"),
        claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
        hrp: getNetwork(info.network as NetworkName).hrp,
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
        swapPkScript: derived.swapPkScript,
        script: derived.script,
        htlc: derived.htlc,
        payoutAddress,
        payoutPubkey,
        secrets,
    };
}
