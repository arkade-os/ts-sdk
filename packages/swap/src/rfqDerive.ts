/**
 * Corridor derivation functions for the RFQ corridors.
 *
 * These are the pure cores of the top-level `request*` flows: derive BOTH
 * contracts locally from the quote's binding fields plus the trader's own data,
 * and refuse on any mismatch. No transport I/O, no wallet I/O.
 */
import { hex } from "@scure/base";
import { ArkAddress, VHTLC, toXOnly } from "@arkade-os/sdk";
import {
    onchainHtlcScript,
    type OnchainHtlc,
    type OnchainHtlcParams,
    type OnchainNetwork,
} from "./onchainHtlc";
import {
    lightningSendVtxoScript,
    receiveVtxoScript,
    type LightningReceiveTreeParams,
} from "./vhtlcScript";
import { verifyLockupAddress, AddressMismatch } from "./rfqVerify";
import type { RfqQuote } from "./rfq";

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

/**
 * The pure core of `requestOnchainSend`: derive BOTH contracts locally
 * from the quote's binding fields plus the user's own data, and refuse on any
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
    /** The user's own key for the VHTLC's sender-side leaves — same role as
     * in `requestLightningSend`. */
    senderPubkey: Uint8Array;
}): {
    address: string;
    swapPkScript: Uint8Array;
    /** The lockup covenant itself — what the contract row is registered from,
     * so the row can never key on a script other than the derived one. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    htlc: OnchainHtlc;
    /** The inputs {@link htlc} was built from. Returned because nothing else
     * can give them back: `OnchainHtlc` exposes only derived values, and this
     * contract is Bitcoin L1 — there is no Arkade contract row for it, so a
     * consumer persisting the swap has no other route to rebuilding it. */
    htlcParams: OnchainHtlcParams;
    /** Echoed from the input, so a result is a complete description of the L1
     * half rather than one a caller has to re-assemble from what it passed in.
     * `onchainSendProfile` reads it from here. */
    l1Network: OnchainNetwork;
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
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
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

    // Named so the inputs can be handed back: `OnchainHtlc` carries only
    // derived values, and unlike the Arkade lockup this HTLC has no contract
    // row, so these are the only route to rebuilding it after a restart.
    const htlcParams = {
        paymentHash: input.paymentHash,
        claimKey: input.payoutPubkey,
        refundKey: toXOnly(hex.decode(htlcPubkey), "solver L1 htlc key"),
        refundLocktime: htlcLocktime,
    };
    const htlc = onchainHtlcScript(htlcParams, input.l1Network);
    if (htlc.address !== htlcAddress) throw new AddressMismatch(htlc.address, htlcAddress);

    return {
        address,
        swapPkScript: script.pkScript,
        script,
        htlc,
        htlcParams,
        l1Network: input.l1Network,
        refundLocktime,
        htlcLocktime,
        minConfirmations,
    };
}

/**
 * The pure core of `requestLightningReceive`: derive the solver-funded
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
    /** Every input the covenant was built from — see the same field on
     * `requestLightningSend`'s result for why a consumer needs them. */
    treeParams: LightningReceiveTreeParams;
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

    // Named rather than inlined so the exact inputs can be handed back — see
    // `treeParams` on the return type.
    const treeParams = {
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
        refundLocktime,
        serverPubkey: input.serverPubkey,
        paymentHash: input.paymentHash,
        claimDelay: input.claimDelay,
        emulatorPubkey: input.emulatorPubkey,
        solverRefundPkScript: solverHex(solverRefundPkScriptHex, "profile.solver_refund_pk_script"),
        payoutPubkey: input.payoutPubkey,
        payoutPkScript: ArkAddress.decode(input.payoutAddress).pkScript,
    };
    const script = receiveVtxoScript(treeParams);
    const address = script.address(input.hrp, input.serverPubkey).encode();
    verifyLockupAddress(quote, address);
    return { address, swapPkScript: script.pkScript, script, invoice, refundLocktime, treeParams };
}

/**
 * The pure core of `requestOnchainReceive`: derive BOTH contracts
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
        solverPubkey: toXOnly(hex.decode(quote.solver_pubkey), "solver key"),
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
            claimKey: toXOnly(hex.decode(claimPubkey), "solver L1 claim key"),
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
