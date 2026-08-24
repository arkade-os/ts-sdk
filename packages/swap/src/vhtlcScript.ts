/**
 * VHTLC script builders and timing helpers for the RFQ swap corridors.
 *
 * Extracted from rfq.ts — pure script construction, no transport or comms
 * logic. Consumed by rfqDerive.ts (derivation) and rfq.ts (requestLightningSend).
 */
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { VHTLC } from "@arkade-os/sdk";

/** BIP68 sequence granularity; the delay derivation rounds up to it. */
const SEQUENCE_GRANULARITY_SECONDS = 512;

/**
 * How long the sender's SOLO refund opens after the receiver's claim, seconds.
 *
 * This is the window in which a claimant holding the preimage must be able to
 * finish taking their money before the funder could take it back. On a live
 * Arkade server that is one collaborative spend; with the server gone it is a
 * full unilateral exit — an unroll broadcast per chain step, each waiting on a
 * confirmation, then the CSV spend.
 *
 * 4096s (eight 512s units, ~68 minutes) is sized for that worst case. It is
 * REASONED, not measured, and it mirrors `SOLO_REFUND_HEADROOM_SECONDS` in the
 * reference solver's `src/core/timelocks.ts` — the two must move together or a
 * trader derives an address the solver never quoted.
 *
 * A multiple of the granularity on purpose: BIP68 would round anything else,
 * making the encoded timelock differ from the number written here.
 */
export const SOLO_REFUND_HEADROOM_SECONDS = 8 * SEQUENCE_GRANULARITY_SECONDS;

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
    // the headroom below BIP68's ceiling, not at it: the solo refund stacks
    // SOLO_REFUND_HEADROOM_SECONDS on top of this value, and it must encode too
    if (
        serverExitDelaySeconds >
        0xffff * SEQUENCE_GRANULARITY_SECONDS - SOLO_REFUND_HEADROOM_SECONDS
    ) {
        throw new Error(
            `server exit delay ${serverExitDelaySeconds}s exceeds what BIP68 can encode ` +
                `once the solo refund's headroom is stacked above it`,
        );
    }
    return (
        Math.ceil(serverExitDelaySeconds / SEQUENCE_GRANULARITY_SECONDS) *
        SEQUENCE_GRANULARITY_SECONDS
    );
};

/** VHTLC's `unilateralRefund` tier: sender + receiver, no server — LEVEL with
 * `claimDelay`, not above it. Neither party can spend a two-signature leaf
 * alone, so separating it buys no safety, and every second spent separating it
 * is a second taken off the headroom that does matter. */
export const unilateralRefundDelay = (claimDelay: number): number => claimDelay;

/** VHTLC's `unilateralRefundWithoutReceiver` tier: sender alone, needing
 * nobody. The only leaf whose timing can steal — a funder able to refund
 * before the claimant can claim takes money from someone holding the preimage
 * — so it opens last, by {@link SOLO_REFUND_HEADROOM_SECONDS}. */
export const unilateralRefundWithoutReceiverDelay = (claimDelay: number): number =>
    claimDelay + SOLO_REFUND_HEADROOM_SECONDS;

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
    /** Emulator x-only key (32 bytes). */
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

/** Every input {@link lightningSendVtxoScript} builds from. Derived from the
 * builder rather than restated, so the two cannot drift. */
export type LightningSendTreeParams = Parameters<typeof lightningSendVtxoScript>[0];

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

/** Every input {@link receiveVtxoScript} builds from; see
 * {@link LightningSendTreeParams}. */
export type LightningReceiveTreeParams = Parameters<typeof receiveVtxoScript>[0];
