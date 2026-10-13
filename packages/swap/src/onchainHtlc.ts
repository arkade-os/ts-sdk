/**
 * The Bitcoin-L1 side of the onchain corridor: a taproot HTLC as pure local
 * derivation, spend builders, and the injected chain-access seam.
 *
 * One HTLC shape serves both directions — only the key roles swap:
 *
 * | direction                             | claimKey            | refundKey          |
 * |---------------------------------------|---------------------|--------------------|
 * | arkade->onchain (solver funds L1)     | user's payout key   | solver's htlc key  |
 * | onchain->arkade (user funds L1)       | solver's htlc key   | user's refund key  |
 *
 * The hash-lock is `ripemd160(sha256(P))`, as in the lightning-send program, so ONE preimage
 * unlocks both the Arkade leaf and the L1 leaf. Solver-supplied addresses are compare-only; the
 * package holds no keys (signing is a callback over the BIP-341 sighash) and no backend.
 */
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import * as btc from "@scure/btc-signer";

// ── Guardrail constants (rfq.ts re-exports these; defined here to keep the
//    claim path free of an rfq.ts import cycle) ───────────────────────────────

/** L1 confirmation-depth and reorg margin between dependent timelocks. */
export const ONCHAIN_ORDER_MARGIN_SECONDS = 2 * 60 * 60;
/** Don't broadcast a claim with less than this before the refund leaf opens:
 * MTP lag plus confirmation time. Past this point the safe move is to let the
 * swap die and take the covenant refund — claiming into the counterparty's
 * live refund window risks losing the race AND publishing P. */
export const ONCHAIN_CLAIM_MARGIN_SECONDS = 90 * 60;
/** Bounds on the confirmation depth a quote may demand. */
export const MAX_MIN_CONFIRMATIONS = 6;
/**
 * BIP65's boundary between the two things an absolute locktime can mean: below it a block height,
 * at or above it a unix timestamp (so the comparison is strict).
 */
export const LOCKTIME_THRESHOLD = 500_000_000;
/** Conservative block interval for converting depths into wall-clock time. */
export const ONCHAIN_SECONDS_PER_BLOCK = 600;
/**
 * Outputs below this are unspendable in practice; builders refuse them.
 *
 * 330, not 546: dust depends on output type, and both payouts here are taproot (546 is P2PKH).
 * The higher figure would refuse relayable refunds. A legacy `payoutPkScript` would need a
 * script-derived threshold. `BigInt(330)`, not `330n`: consumers read this source directly and
 * may target below ES2020.
 */
export const ONCHAIN_DUST_SATS = BigInt(330);

/**
 * vsize of the trader's claim transaction, for pricing it before it is built.
 *
 * One-in-one-out with a fixed witness, so only the payout script varies; this is the largest
 * standard one (P2TR). Rounded UP so a claim fee never under-charges out of the recipient's payout.
 * Pinned against a real sizing pass in `onchainHtlc.test.ts`; a leaf-shape change moves both.
 */
export const ONCHAIN_CLAIM_VSIZE = 152;

// ── Preimage utilities ───────────────────────────────────────────────────────

/** 32 random bytes. The user generates P for BOTH onchain directions. */
export const newPreimage = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/** `sha256(P)`, hex — the wire `payment_hash`, same convention as BOLT11. */
export const paymentHashOf = (preimage: Uint8Array): string => hex.encode(sha256(preimage));

/** The script-level commitment: `ripemd160(sha256(P))`, from the wire hash. */
const h160FromPaymentHash = (paymentHash: string): Uint8Array => ripemd160(hex.decode(paymentHash));

/** Refuse a `P` whose `ripemd160(sha256(P))` is not the covenant's `preimageHash`. */
export const assertPreimageMatches = (preimage: Uint8Array, preimageHash: Uint8Array): void => {
    if (hex.encode(ripemd160(sha256(preimage))) !== hex.encode(preimageHash)) {
        throw new Error("preimage does not match the covenant's payment hash");
    }
};

/** A gate refusal carrying a stable `reason` for callers to switch on. */
export const gateError = (reason: string, message: string): Error & { reason: string } => {
    const error = new Error(message) as Error & { reason: string };
    error.reason = reason;
    return error;
};

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** Probe every `pollMs` (default 5s) until it yields a value; past the unix-seconds
 * `deadline`, throw `gateError(reason, message)`. */
export async function pollUntil<T>(
    probe: () => Promise<T | undefined>,
    options: { pollMs?: number; deadline?: number },
    reason: string,
    message: string,
): Promise<T> {
    const pollMs = options.pollMs ?? 5_000;
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (options.deadline !== undefined && Date.now() / 1000 >= options.deadline) {
            throw gateError(reason, message);
        }
        await sleep(pollMs);
    }
}

// ── The taproot HTLC ─────────────────────────────────────────────────────────

export type OnchainNetwork = "bitcoin" | "testnet" | "regtest";

/**
 * The `@scure/btc-signer` parameters each L1 network is addressed under.
 *
 * Three members, not five: `signet` and `mutinynet` are indistinguishable from `testnet` at the
 * address level, which is why {@link l1NetworkFromArk} folds them together.
 */
export const L1_NETWORKS: Record<OnchainNetwork, typeof btc.NETWORK> = {
    bitcoin: btc.NETWORK,
    testnet: btc.TEST_NETWORK,
    regtest: { ...btc.TEST_NETWORK, bech32: "bcrt" },
};

/**
 * The `payoutPkScript` {@link buildHtlcClaim} pays the fill to. Resolve it EARLY: nothing else
 * names the spender's destination, and one that cannot be encoded must be refused before the swap
 * is negotiated, not at claim time.
 */
export const l1ScriptForAddress = (address: string, network: OnchainNetwork): Uint8Array =>
    btc.OutScript.encode(btc.Address(L1_NETWORKS[network]).decode(address));

export interface OnchainHtlcParams {
    /** `sha256(P)`, hex; the HASH160 commitment is derived internally. */
    paymentHash: string;
    /** x-only key that claims with the preimage. */
    claimKey: Uint8Array;
    /** x-only key that refunds after the locktime. */
    refundKey: Uint8Array;
    /** Absolute unix seconds (consensus matures it against median-time-past). */
    refundLocktime: number;
}

export interface OnchainHtlc {
    address: string;
    /** `0x5120…` — the P2TR output script. */
    pkScript: Uint8Array;
    leaves: { claim: Uint8Array; refund: Uint8Array };
    /** Serialized control blocks per leaf, ready for a script-path witness. */
    controlBlocks: { claim: Uint8Array; refund: Uint8Array };
    paymentHash: string;
    refundLocktime: number;
}

/**
 * Derive the two-leaf taproot HTLC. Internal key is the BIP-341 NUMS point, so
 * there is no key-path spend, ever:
 *
 *   claim:  `OP_SIZE 32 OP_EQUALVERIFY OP_HASH160 <h160> OP_EQUALVERIFY <claimKey> OP_CHECKSIG`
 *   refund: `<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundKey> OP_CHECKSIG`
 *
 * `OP_SIZE 32` pins the preimage to 32 bytes before hashing, as BOLT3 HTLCs do. Pinned
 * byte-for-byte by the golden test; any drift changes addresses on BOTH sides of a swap.
 */
export function onchainHtlcScript(params: OnchainHtlcParams, network: OnchainNetwork): OnchainHtlc {
    if (params.claimKey.length !== 32 || params.refundKey.length !== 32) {
        throw new Error("claimKey and refundKey must be 32-byte x-only keys");
    }
    if (!Number.isInteger(params.refundLocktime) || params.refundLocktime <= 0) {
        throw new Error(
            `refundLocktime must be a positive unix timestamp, got ${params.refundLocktime}`,
        );
    }
    // A height-shaped value (a dropped `/ 1000`, a solver quoting a height) would build a refund
    // leaf dead for millennia, undetectably: the address is well-formed and funding confirms.
    if (params.refundLocktime < LOCKTIME_THRESHOLD) {
        throw new Error(
            `refundLocktime ${params.refundLocktime} is below LOCKTIME_THRESHOLD ` +
                `(${LOCKTIME_THRESHOLD}) and would be interpreted as a block height`,
        );
    }
    // `btc.p2tr` reads an `undefined` network as mainnet, so a garbled record would rebuild with
    // right leaves and pkScript but a lying `bc1p…` address.
    if (!Object.hasOwn(L1_NETWORKS, network)) {
        throw new Error(
            `unknown L1 network '${String(network)}' — expected one of ` +
                `${Object.keys(L1_NETWORKS).join(", ")}`,
        );
    }
    const h160 = h160FromPaymentHash(params.paymentHash);
    const claim = btc.Script.encode([
        "SIZE",
        32,
        "EQUALVERIFY",
        "HASH160",
        h160,
        "EQUALVERIFY",
        params.claimKey,
        "CHECKSIG",
    ]);
    const refund = btc.Script.encode([
        btc.ScriptNum().encode(BigInt(params.refundLocktime)),
        "CHECKLOCKTIMEVERIFY",
        "DROP",
        params.refundKey,
        "CHECKSIG",
    ]);
    const payment = btc.p2tr(
        btc.taprootNumsKey(),
        btc.taprootListToTree([{ script: claim }, { script: refund }]),
        L1_NETWORKS[network],
        true,
    );

    const controlBlockFor = (leaf: Uint8Array): Uint8Array => {
        for (const [block, script] of payment.tapLeafScript ?? []) {
            if (
                script.length - 1 === leaf.length &&
                hex.encode(script.subarray(0, leaf.length)) === hex.encode(leaf)
            ) {
                return btc.TaprootControlBlock.encode(block);
            }
        }
        throw new Error("leaf missing from compiled taproot tree"); // unreachable: we just built it
    };

    return {
        address: payment.address!,
        pkScript: payment.script,
        leaves: { claim, refund },
        controlBlocks: { claim: controlBlockFor(claim), refund: controlBlockFor(refund) },
        paymentHash: params.paymentHash,
        refundLocktime: params.refundLocktime,
    };
}

// ── Transaction builders ─────────────────────────────────────────────────────

export interface HtlcUtxo {
    txid: string;
    vout: number;
    amount: bigint;
}

interface SpendResult {
    txHex: string;
    txid: string;
    /** `utxo.amount − fee` — what actually lands at the payout script. */
    payoutAmount: bigint;
}

/** Assemble a one-in-one-out script-path spend; witness decides which leaf. */
const buildLeafSpend = async (input: {
    htlc: OnchainHtlc;
    utxo: HtlcUtxo;
    leaf: Uint8Array;
    controlBlock: Uint8Array;
    /** Witness items ABOVE the signature (e.g. the preimage), bottom-up. */
    stackAboveSig: Uint8Array[];
    payoutPkScript: Uint8Array;
    feeRateSatVb: number;
    sign: (sighash: Uint8Array) => Promise<Uint8Array>;
    lockTime?: number;
    sequence: number;
}): Promise<SpendResult> => {
    if (!Number.isFinite(input.feeRateSatVb) || input.feeRateSatVb <= 0) {
        throw new Error(`feeRateSatVb must be positive, got ${input.feeRateSatVb}`);
    }
    const assemble = (payout: bigint): btc.Transaction => {
        const tx = new btc.Transaction({ lockTime: input.lockTime ?? 0 });
        tx.addInput({
            txid: input.utxo.txid,
            index: input.utxo.vout,
            witnessUtxo: { script: input.htlc.pkScript, amount: input.utxo.amount },
            sequence: input.sequence,
        });
        tx.addOutput({ script: input.payoutPkScript, amount: payout });
        return tx;
    };
    const witness = (sig: Uint8Array): Uint8Array[] => [
        sig,
        ...input.stackAboveSig,
        input.leaf,
        input.controlBlock,
    ];

    // Sizing pass: a DEFAULT-sighash schnorr signature is always 64 bytes and
    // amounts are fixed-width, so a dummy-signed build measures the exact vsize.
    const sizing = assemble(input.utxo.amount);
    sizing.updateInput(0, { finalScriptWitness: witness(new Uint8Array(64)) }, true);
    const fee = BigInt(Math.ceil(sizing.vsize * input.feeRateSatVb));
    const payout = input.utxo.amount - fee;
    if (payout < ONCHAIN_DUST_SATS) {
        throw new Error(
            `fee ${fee} leaves ${payout} sats from a ${input.utxo.amount} sat HTLC — below the ${ONCHAIN_DUST_SATS} sat dust limit`,
        );
    }

    const tx = assemble(payout);
    const sighash = tx.preimageWitnessV1(
        0,
        [input.htlc.pkScript],
        btc.SigHash.DEFAULT,
        [input.utxo.amount],
        undefined,
        input.leaf,
        0xc0,
    );
    const sig = await input.sign(sighash);
    if (sig.length !== 64)
        throw new Error(`sign() must return a 64-byte BIP340 signature, got ${sig.length}`);
    tx.updateInput(0, { finalScriptWitness: witness(sig) }, true);
    return { txHex: tx.hex, txid: tx.id, payoutAmount: payout };
};

/** Script-path spend of the claim leaf; the witness reveals P — that is how
 * the counterparty learns it, so never build this unless the claim will win
 * (see {@link claimOnchainFill}). `sign` is BIP340 over the claim key. */
export const buildHtlcClaim = async (input: {
    htlc: OnchainHtlc;
    utxo: HtlcUtxo;
    preimage: Uint8Array;
    payoutPkScript: Uint8Array;
    feeRateSatVb: number;
    sign: (sighash: Uint8Array) => Promise<Uint8Array>;
}): Promise<SpendResult> => {
    if (paymentHashOf(input.preimage) !== input.htlc.paymentHash) {
        throw new Error("preimage does not hash to the HTLC's payment hash");
    }
    return buildLeafSpend({
        htlc: input.htlc,
        utxo: input.utxo,
        leaf: input.htlc.leaves.claim,
        controlBlock: input.htlc.controlBlocks.claim,
        stackAboveSig: [input.preimage],
        payoutPkScript: input.payoutPkScript,
        feeRateSatVb: input.feeRateSatVb,
        sign: input.sign,
        sequence: 0xfffffffd,
    });
};

/** Script-path spend of the refund leaf; consensus-valid only once nLockTime
 * has matured against median-time-past — gate on {@link ChainSource.getMtp},
 * not wall clock. `sign` is BIP340 over the refund key. */
export const buildHtlcRefund = (input: {
    htlc: OnchainHtlc;
    utxo: HtlcUtxo;
    payoutPkScript: Uint8Array;
    feeRateSatVb: number;
    sign: (sighash: Uint8Array) => Promise<Uint8Array>;
}): Promise<SpendResult> =>
    buildLeafSpend({
        htlc: input.htlc,
        utxo: input.utxo,
        leaf: input.htlc.leaves.refund,
        controlBlock: input.htlc.controlBlocks.refund,
        stackAboveSig: [],
        payoutPkScript: input.payoutPkScript,
        feeRateSatVb: input.feeRateSatVb,
        sign: input.sign,
        lockTime: input.htlc.refundLocktime,
        // any value below 0xffffffff enables nLockTime enforcement
        sequence: 0xfffffffe,
    });

// ── ChainSource: the injected L1 backend ─────────────────────────────────────

export interface ChainUtxo extends HtlcUtxo {
    confirmations: number;
}

/** The package's whole view of Bitcoin L1, injected so the package stays backend-free
 * (`CorridorOverrides.onchain.chain` takes it). */
export interface ChainSource {
    /** Confirmed+mempool outputs paying a script; used to detect the fill. */
    getScriptUtxos(pkScript: Uint8Array): Promise<ChainUtxo[]>;
    /** The spend of an outpoint, if any — where P is extracted from. A
     * provider omitting the spender txid still lists it in `pkScript`'s history. */
    getSpendingTx(
        txid: string,
        vout: number,
        pkScript: Uint8Array,
    ): Promise<{ txHex: string } | null>;
    broadcast(txHex: string): Promise<string>;
    /** Current median-time-past, unix seconds — gates refund broadcasting. */
    getMtp(): Promise<number>;
}

/** Read P out of a claim spend's witness: the 32-byte item whose sha256 is the
 * payment hash. Null when the tx reveals no matching preimage (e.g. a refund
 * spend, or an unrelated tx). */
export function extractPreimage(txHex: string, paymentHash: string): Uint8Array | null {
    let raw;
    try {
        raw = btc.RawTx.decode(hex.decode(txHex));
    } catch {
        return null;
    }
    for (const stack of raw.witnesses ?? []) {
        for (const item of stack) {
            if (item.length === 32 && hex.encode(sha256(item)) === paymentHash) return item;
        }
    }
    return null;
}

// ── Fill watching, claiming, and crash-recovery classification ──────────────

/** Poll {@link ChainSource} until the HTLC is funded to the required depth.
 * Picks the largest qualifying output when several exist. Throws (reason
 * `fill_timeout`) once `deadline` (unix seconds) passes without one. */
export async function awaitOnchainFill(
    chain: ChainSource,
    htlc: OnchainHtlc,
    minConfirmations: number,
    options: { pollMs?: number; deadline?: number } = {},
): Promise<ChainUtxo> {
    return pollUntil(
        async () => {
            const utxos = await chain.getScriptUtxos(htlc.pkScript);
            return utxos
                .filter((u) => u.confirmations >= minConfirmations)
                .sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
        },
        options,
        "fill_timeout",
        "HTLC was not filled before the deadline",
    );
}

/**
 * Claim the fill: build the claim spend and broadcast it, publishing P (that is how the solver
 * gets paid). Refuses (`claim_window_closed`) with less than {@link ONCHAIN_CLAIM_MARGIN_SECONDS}
 * before the refund leaf opens.
 */
export async function claimOnchainFill(
    chain: ChainSource,
    input: {
        htlc: OnchainHtlc;
        utxo: HtlcUtxo;
        preimage: Uint8Array;
        payoutPkScript: Uint8Array;
        feeRateSatVb: number;
        sign: (sighash: Uint8Array) => Promise<Uint8Array>;
        /** Injected for tests; defaults to wall clock. */
        now?: number;
    },
): Promise<{ txid: string; payoutAmount: bigint }> {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (input.htlc.refundLocktime - now < ONCHAIN_CLAIM_MARGIN_SECONDS) {
        throw gateError(
            "claim_window_closed",
            "refund leaf opens too soon to claim safely — take the covenant refund instead",
        );
    }
    const spend = await buildHtlcClaim(input);
    const txid = await chain.broadcast(spend.txHex);
    return { txid, payoutAmount: spend.payoutAmount };
}

/** Where an onchain HTLC stands, for crash recovery. Persisting the record BEFORE funding is what
 * makes this classification (and the claim) possible after a restart. */
export type OnchainHtlcPhase =
    | { phase: "unfunded" }
    | { phase: "awaiting_confirmations"; utxo: ChainUtxo }
    | { phase: "claimable"; utxo: ChainUtxo }
    /**
     * The refund leaf has matured, so the CLAIM WINDOW IS CLOSED and `claimOnchainFill` throws.
     * Do not claim: let the counterparty's L1 refund settle and take the Arkade-side covenant
     * refund. On a swap you expected to claim, this means the claim was missed.
     */
    | { phase: "refundable"; utxo: ChainUtxo }
    | { phase: "claimed"; txid: string; preimage: Uint8Array }
    | { phase: "swept"; txid: string };

/**
 * Classify an HTLC from chain state alone. `funding` (the known outpoint from
 * the stored record) is what distinguishes "never funded" from "funded and
 * already spent": without it a spent HTLC looks unfunded.
 *
 * `claimed` carries the preimage read from the spend's witness — the receipt;
 * `swept` is a spend that reveals no preimage (the counterparty's refund).
 */
export async function classifyOnchainHtlc(
    chain: ChainSource,
    input: {
        htlc: OnchainHtlc;
        minConfirmations: number;
        funding?: { txid: string; vout: number };
    },
): Promise<OnchainHtlcPhase> {
    const utxos = await chain.getScriptUtxos(input.htlc.pkScript);
    const best = utxos.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
    if (!best) {
        if (!input.funding) return { phase: "unfunded" };
        const spend = await chain.getSpendingTx(
            input.funding.txid,
            input.funding.vout,
            input.htlc.pkScript,
        );
        if (!spend) return { phase: "unfunded" };
        const preimage = extractPreimage(spend.txHex, input.htlc.paymentHash);
        const txid = btc.Transaction.fromRaw(hex.decode(spend.txHex), {
            allowUnknownInputs: true,
            allowUnknownOutputs: true,
        }).id;
        return preimage ? { phase: "claimed", txid, preimage } : { phase: "swept", txid };
    }
    if (best.confirmations < input.minConfirmations)
        return { phase: "awaiting_confirmations", utxo: best };
    const mtp = await chain.getMtp();
    if (mtp >= input.htlc.refundLocktime) return { phase: "refundable", utxo: best };
    return { phase: "claimable", utxo: best };
}
