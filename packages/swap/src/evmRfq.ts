/**
 * The EVM corridors' RFQ wire: `arkade:BTC->ethereum:<token>` and its reverse. Negotiation only;
 * covenant derivation, deadline ordering and funding are not here.
 *
 * Restates `arkade-os/intent-solver`'s `solver-corridors-evm/src/wire/evmPayloads.ts`;
 * `test/evmRfq.test.ts` pins the parity. Token amounts are `bigint` here and canonical decimal
 * strings on the wire, since a JSON number loses an ERC20 amount past 2^53.
 */
import { hex } from "@scure/base";

import { ARKADE_BTC, assertPairLength, rfqPair } from "./rfq";

/** The EVM leg's namespace. Which chain is the quote's `evm_chain_id`, not the pair. */
export const EVM_CHAIN = "ethereum";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_AMOUNT = /^(0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT256_DECIMAL = MAX_UINT256.toString();
const SEND_PAIR = /^arkade:BTC->ethereum:0x[0-9a-f]{40}$/;
const RECEIVE_PAIR = /^ethereum:0x[0-9a-f]{40}->arkade:BTC$/;

/** `ethereum:<token>`, lowercased: the solver's pair regex is lowercase-only while its profile
 * address fields accept a checksum, so normalising only one of them yields `unsupported_pair`. */
export const evmTokenLeg = (tokenAddress: string): string =>
    `${EVM_CHAIN}:${assertEvmAddress(tokenAddress, "token address").toLowerCase()}`;

/** `arkade:BTC->ethereum:<token>`: the client locks sats, the solver pays tokens. */
export const evmSendPair = (tokenAddress: string): string => {
    const pair = rfqPair(ARKADE_BTC, evmTokenLeg(tokenAddress));
    assertPairLength(pair);
    return pair;
};

/** `ethereum:<token>->arkade:BTC`: the client locks tokens, the solver pays sats. */
export const evmReceivePair = (tokenAddress: string): string => {
    const pair = rfqPair(evmTokenLeg(tokenAddress), ARKADE_BTC);
    assertPairLength(pair);
    return pair;
};

export const evmDirectionOf = (pair: string): "send" | "receive" | null => {
    if (SEND_PAIR.test(pair)) return "send";
    if (RECEIVE_PAIR.test(pair)) return "receive";
    return null;
};

/** The lowercase ERC20 an EVM pair names, or `null`. */
export const evmTokenOf = (pair: string): string | null => {
    const direction = evmDirectionOf(pair);
    if (direction === null) return null;
    const [from, to] = pair.split("->");
    return (direction === "send" ? to : from).slice(EVM_CHAIN.length + 1);
};

export const evmAmountToWire = (units: bigint): string => {
    if (typeof units !== "bigint") throw new Error("token amount must be a bigint");
    if (units < 0n) throw new Error(`token amount may not be negative, got ${units}`);
    if (units > MAX_UINT256) throw new Error(`token amount must fit uint256, got ${units}`);
    return units.toString();
};

/** Refuses a JSON number outright: by the time it is here the parser may already have rounded it. */
export const evmAmountFromWire = (value: unknown, field: string): bigint => {
    if (typeof value !== "string") {
        throw new Error(
            `${field} must be a decimal string of atomic units, not a JSON ${typeof value}`,
        );
    }
    if (!TOKEN_AMOUNT.test(value)) {
        throw new Error(`${field} is not a canonical decimal amount: ${JSON.stringify(value)}`);
    }
    if (
        value.length > MAX_UINT256_DECIMAL.length ||
        (value.length === MAX_UINT256_DECIMAL.length && value > MAX_UINT256_DECIMAL)
    ) {
        throw new Error(`${field} exceeds uint256`);
    }
    return BigInt(value);
};

/** Exact-in only: `amount` is sats, and the solver's schema pins `amount_side: "from"`. */
export const evmSendRequest = (input: {
    rfqId: string;
    tokenAddress: string;
    /** `sha256(P)`, hex. */
    paymentHash: string;
    /** Where the client takes the tokens; sent as given, keeping any EIP-55 checksum. */
    evmClaimAddress: string;
    /** The client's Arkade address, where the covenant refund pays. */
    refundAddress: string;
    /** The client's x-only key for the covenant's refund leaves. */
    senderPubkey: Uint8Array;
    amountSats: number;
}): Record<string, unknown> => {
    assertPositiveInteger(input.amountSats, "amountSats");
    assertHash32(input.paymentHash, "paymentHash");
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair: evmSendPair(input.tokenAddress),
        amount_side: "from",
        amount: input.amountSats,
        profile: {
            payment_hash: input.paymentHash,
            evm_claim_address: assertEvmAddress(input.evmClaimAddress, "evmClaimAddress"),
            refund_address: input.refundAddress,
            client_refund_pubkey: hex.encode(input.senderPubkey),
        },
    };
};

/** The token amount rides the profile as `evm_amount`; the envelope has no `amount`, and the
 * solver's strict schema refuses one. No `claim_packet`: the client must be online to claim. */
export const evmReceiveRequest = (input: {
    rfqId: string;
    tokenAddress: string;
    paymentHash: string;
    evmAmount: bigint;
    /** The client's own lock deadline, as a block height. */
    evmTimeoutBlock: number;
    evmRefundAddress: string;
    payoutAddress: string;
    /** The covenant's `receiver` role. */
    payoutPubkey: Uint8Array;
}): Record<string, unknown> => {
    assertPositiveInteger(input.evmTimeoutBlock, "evmTimeoutBlock");
    assertHash32(input.paymentHash, "paymentHash");
    if (input.evmAmount <= 0n) {
        throw new Error(
            `evmAmount must be a positive number of atomic units, got ${input.evmAmount}`,
        );
    }
    return {
        v: 1,
        type: "rfq_request",
        rfq_id: input.rfqId,
        pair: evmReceivePair(input.tokenAddress),
        amount_side: "from",
        profile: {
            payment_hash: input.paymentHash,
            evm_amount: evmAmountToWire(input.evmAmount),
            evm_timeout_block: input.evmTimeoutBlock,
            evm_refund_address: assertEvmAddress(input.evmRefundAddress, "evmRefundAddress"),
            payout_address: input.payoutAddress,
            payout_pubkey: hex.encode(input.payoutPubkey),
        },
    };
};

interface EvmQuoteProfileCommon {
    payment_hash: string;
    /** Compare-only: never fund it without deriving the covenant locally. */
    lockup_address: string;
    evm_contract_address: string;
    evm_chain_id: number;
    /** Wait for both: a rollup can bury a lock in seconds before its L1 batch finalizes. */
    min_confirmations: number;
    min_age_seconds: number;
    [key: string]: unknown;
}

export interface EvmSendQuoteProfile extends EvmQuoteProfileCommon {
    /** The solver's claim pkScript, needed to rebuild the covenant's merkle root. */
    receiver_pk_script: string;
    /** The solver's address, the refund role of its lock: the sixth swap-key field, and an
     * explicit argument to `claim`. */
    evm_refund_address: string;
    /** A block height, unlike the unix-seconds `refund_locktime` beside it. */
    evm_timeout_block: number;
}

export interface EvmReceiveQuoteProfile extends EvmQuoteProfileCommon {
    /** The solver's refund pkScript, needed to rebuild the covenant's merkle root. */
    solver_refund_pk_script: string;
    /** The `claimAddress` the client must lock to. */
    evm_claim_address: string;
}

export interface EvmSendQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    from_amount: number;
    to_amount: string;
    solver_pubkey: string;
    valid_until: number;
    refund_locktime: number;
    profile: EvmSendQuoteProfile;
    [key: string]: unknown;
}

export interface EvmReceiveQuote {
    v: 1;
    type: "rfq_quote";
    rfq_id: string;
    pair: string;
    from_amount: string;
    to_amount: number;
    solver_pubkey: string;
    valid_until: number;
    refund_locktime: number;
    profile: EvmReceiveQuoteProfile;
    [key: string]: unknown;
}

export type EvmRfqQuote = EvmSendQuote | EvmReceiveQuote;

/**
 * Checks a reply's shape and binds it to the request (rfq id, token, payment hash, chain, exact
 * input). It does not make `lockup_address` safe to fund. Unknown fields are tolerated.
 */
export const readEvmSendQuote = (
    payload: unknown,
    expected: {
        tokenAddress: string;
        rfqId: string;
        paymentHash: string;
        chainId: number;
        amountSats: number;
    },
): EvmSendQuote => {
    assertHash32(expected.paymentHash, "expected.paymentHash");
    assertPositiveInteger(expected.chainId, "expected.chainId");
    assertPositiveInteger(expected.amountSats, "expected.amountSats");
    const { quote, profile } = readEvmQuoteEnvelope(
        payload,
        evmSendPair(expected.tokenAddress),
        expected.rfqId,
    );
    readCommonProfile(profile, expected.paymentHash, expected.chainId);
    assertHex(profile.receiver_pk_script, "profile.receiver_pk_script");
    assertEvmAddress(
        asString(profile.evm_refund_address, "profile.evm_refund_address"),
        "profile.evm_refund_address",
    );
    assertPositiveInteger(profile.evm_timeout_block, "profile.evm_timeout_block");
    assertPositiveTokenAmount(quote.to_amount, "to_amount");
    assertPositiveInteger(quote.from_amount, "from_amount");
    if (quote.from_amount !== expected.amountSats) {
        throw new Error("quote from_amount does not match the requested sats amount");
    }
    return quote as unknown as EvmSendQuote;
};

/** The receive-direction counterpart of {@link readEvmSendQuote}. */
export const readEvmReceiveQuote = (
    payload: unknown,
    expected: {
        tokenAddress: string;
        rfqId: string;
        paymentHash: string;
        chainId: number;
        evmAmount: bigint;
    },
): EvmReceiveQuote => {
    assertHash32(expected.paymentHash, "expected.paymentHash");
    assertPositiveInteger(expected.chainId, "expected.chainId");
    if (expected.evmAmount <= 0n) throw new Error("expected.evmAmount must be positive");
    evmAmountToWire(expected.evmAmount);
    const { quote, profile } = readEvmQuoteEnvelope(
        payload,
        evmReceivePair(expected.tokenAddress),
        expected.rfqId,
    );
    readCommonProfile(profile, expected.paymentHash, expected.chainId);
    assertHex(profile.solver_refund_pk_script, "profile.solver_refund_pk_script");
    assertEvmAddress(
        asString(profile.evm_claim_address, "profile.evm_claim_address"),
        "profile.evm_claim_address",
    );
    if (assertPositiveTokenAmount(quote.from_amount, "from_amount") !== expected.evmAmount) {
        throw new Error("quote from_amount does not match the requested token amount");
    }
    assertPositiveInteger(quote.to_amount, "to_amount");
    return quote as unknown as EvmReceiveQuote;
};

/** The token leg of a quote, picked by its pair so the sats leg can never be read as tokens. */
export const evmQuoteTokenAmount = (quote: EvmRfqQuote): bigint => {
    const direction = evmDirectionOf(quote.pair);
    if (direction === null) throw new Error(`not an EVM pair: ${JSON.stringify(quote.pair)}`);
    return direction === "send"
        ? evmAmountFromWire(quote.to_amount, "to_amount")
        : evmAmountFromWire(quote.from_amount, "from_amount");
};

/** The sats leg of a quote; see {@link evmQuoteTokenAmount}. */
export const evmQuoteSats = (quote: EvmRfqQuote): number => {
    const direction = evmDirectionOf(quote.pair);
    if (direction === null) throw new Error(`not an EVM pair: ${JSON.stringify(quote.pair)}`);
    const field = direction === "send" ? "from_amount" : "to_amount";
    const sats = quote[field];
    assertPositiveInteger(sats, field);
    return sats as number;
};

const assertEvmAddress = (value: string, field: string): string => {
    if (!EVM_ADDRESS.test(value)) {
        throw new Error(`${field} must be 0x then 40 hex, got ${JSON.stringify(value)}`);
    }
    return value;
};

const assertPositiveInteger = (value: unknown, field: string): void => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer, got ${String(value)}`);
    }
};

const assertNonNegativeInteger = (value: unknown, field: string): void => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative integer, got ${String(value)}`);
    }
};

/** Even length too: these pkScripts are decoded later, and odd hex would fail there instead. */
const assertHex = (value: unknown, field: string): void => {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length % 2 !== 0 ||
        !/^[0-9a-f]+$/.test(value)
    ) {
        throw new Error(`${field} must be lowercase hex of whole bytes, got ${String(value)}`);
    }
};

const assertHash32 = (value: unknown, field: string): void => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${field} must be 64 lowercase hex characters, got ${String(value)}`);
    }
};

const assertPositiveTokenAmount = (value: unknown, field: string): bigint => {
    const amount = evmAmountFromWire(value, field);
    if (amount === 0n) throw new Error(`${field} must be positive`);
    return amount;
};

const asString = (value: unknown, field: string): string => {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a string, got ${String(value)}`);
    }
    return value;
};

const readEvmQuoteEnvelope = (
    payload: unknown,
    expectedPair: string,
    expectedRfqId: string,
): { quote: Record<string, unknown>; profile: Record<string, unknown> } => {
    if (!payload || typeof payload !== "object") throw new Error("EVM quote is not an object");
    const quote = payload as Record<string, unknown>;
    if (quote.v !== 1) throw new Error(`expected EVM quote version 1, got ${String(quote.v)}`);
    if (quote.type !== "rfq_quote") {
        throw new Error(`expected an rfq_quote, got ${String(quote.type)}`);
    }
    // Before the pair: a reply to another negotiation may be for the same market.
    if (quote.rfq_id !== expectedRfqId) {
        throw new Error(
            `quote is for rfq_id ${JSON.stringify(quote.rfq_id)}, not this negotiation's ` +
                `${expectedRfqId}`,
        );
    }
    if (quote.pair !== expectedPair) {
        throw new Error(`solver quoted ${JSON.stringify(quote.pair)}, not ${expectedPair}`);
    }
    asString(quote.solver_pubkey, "solver_pubkey");
    assertPositiveInteger(quote.valid_until, "valid_until");
    assertPositiveInteger(quote.refund_locktime, "refund_locktime");
    if (!quote.profile || typeof quote.profile !== "object") {
        throw new Error("EVM quote carries no profile");
    }
    return { quote, profile: quote.profile as Record<string, unknown> };
};

const readCommonProfile = (
    profile: Record<string, unknown>,
    paymentHash: string,
    chainId: number,
): void => {
    assertHash32(profile.payment_hash, "profile.payment_hash");
    asString(profile.lockup_address, "profile.lockup_address");
    assertEvmAddress(
        asString(profile.evm_contract_address, "profile.evm_contract_address"),
        "profile.evm_contract_address",
    );
    assertPositiveInteger(profile.evm_chain_id, "profile.evm_chain_id");
    assertPositiveInteger(profile.min_confirmations, "profile.min_confirmations");
    // Zero is legal: the solver gates on depth alone.
    assertNonNegativeInteger(profile.min_age_seconds, "profile.min_age_seconds");
    if (profile.payment_hash !== paymentHash) {
        throw new Error("quote payment_hash does not match the request");
    }
    if (profile.evm_chain_id !== chainId) {
        throw new Error("quote evm_chain_id does not match the expected chain");
    }
};
