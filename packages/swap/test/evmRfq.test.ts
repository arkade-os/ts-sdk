/**
 * The EVM wire layer and its parity with `arkade-os/intent-solver`'s `evmPayloads.ts` and
 * `corridorPolicy.ts`, restated here because a drift is a swap that silently never matches.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

import {
    EVM_CHAIN,
    evmAmountFromWire,
    evmAmountToWire,
    evmDirectionOf,
    evmQuoteSats,
    evmQuoteTokenAmount,
    evmReceivePair,
    evmReceiveRequest,
    evmSendPair,
    evmSendRequest,
    evmTokenLeg,
    evmTokenOf,
    readEvmReceiveQuote,
    readEvmSendQuote,
    type EvmReceiveQuote,
    type EvmSendQuote,
} from "../src/evmRfq";
import { MIN_HEADROOM_SECONDS, assertFundable } from "../src/rfq";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const RFQ_ID = "a1".repeat(32);
const PAYMENT_HASH = "b2".repeat(32);
/** Lowercase, as a pair must carry it. */
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
/** The SAME token, EIP-55 checksummed — legal in a profile, refused in a pair. */
const USDC_CHECKSUMMED = "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48";
const ERC20_SWAP = "0x1111111111111111111111111111111111111111";
const CLAIM_ADDRESS = "0x2222222222222222222222222222222222222222";
const SOLVER_CLAIM_ADDRESS = "0x3333333333333333333333333333333333333333";
/** The solver's own EVM address, as the SEND quote carries it. */
const SOLVER_EVM_ADDRESS = "0x4444444444444444444444444444444444444444";

const NOW = 1_800_000_000;
const EXPECTED_QUOTE = {
    tokenAddress: USDC,
    rfqId: RFQ_ID,
    paymentHash: PAYMENT_HASH,
    chainId: 1,
    amountSats: 250_000,
    evmAmount: 249_750_000_000_000_000_000n,
};

// The solver's pair regexes (lowercase token only) and quote builders' keys.
const SOLVER_SEND_PAIR = /^arkade:BTC->ethereum:0x[0-9a-f]{40}$/;
const SOLVER_RECEIVE_PAIR = /^ethereum:0x[0-9a-f]{40}->arkade:BTC$/;

const SOLVER_SEND_QUOTE_KEYS = [
    "v",
    "type",
    "rfq_id",
    "pair",
    "from_amount",
    "to_amount",
    "solver_pubkey",
    "valid_until",
    "refund_locktime",
    "profile",
];
const SOLVER_SEND_QUOTE_PROFILE_KEYS = [
    "payment_hash",
    "lockup_address",
    "receiver_pk_script",
    "evm_refund_address",
    "evm_timeout_block",
    "evm_contract_address",
    "evm_chain_id",
    "min_confirmations",
    "min_age_seconds",
];
const SOLVER_RECEIVE_QUOTE_KEYS = SOLVER_SEND_QUOTE_KEYS;
const SOLVER_RECEIVE_QUOTE_PROFILE_KEYS = [
    "payment_hash",
    "lockup_address",
    "solver_refund_pk_script",
    "evm_contract_address",
    "evm_chain_id",
    "evm_claim_address",
    "min_confirmations",
    "min_age_seconds",
];

const withProfile = (quote: unknown, over: Record<string, unknown>): Record<string, unknown> => {
    const record = quote as Record<string, unknown>;
    return { ...record, profile: { ...(record.profile as Record<string, unknown>), ...over } };
};

const sendRequest = (): Record<string, unknown> =>
    evmSendRequest({
        rfqId: RFQ_ID,
        tokenAddress: USDC,
        paymentHash: PAYMENT_HASH,
        evmClaimAddress: CLAIM_ADDRESS,
        refundAddress: "ark1qrefund",
        senderPubkey: key(13),
        amountSats: 250_000,
    });

const receiveRequest = (): Record<string, unknown> =>
    evmReceiveRequest({
        rfqId: RFQ_ID,
        tokenAddress: USDC,
        paymentHash: PAYMENT_HASH,
        evmAmount: 123_456_789n,
        evmTimeoutBlock: 21_000_000,
        evmRefundAddress: CLAIM_ADDRESS,
        payoutAddress: "ark1qpayout",
        payoutPubkey: key(9),
    });

const sendQuote = (over: Record<string, unknown> = {}): EvmSendQuote =>
    ({
        v: 1,
        type: "rfq_quote",
        rfq_id: RFQ_ID,
        pair: evmSendPair(USDC),
        from_amount: 250_000,
        to_amount: "249750000000000000000",
        solver_pubkey: "cc".repeat(32),
        valid_until: NOW + 60,
        refund_locktime: NOW + 200 * 3600,
        profile: {
            payment_hash: PAYMENT_HASH,
            lockup_address: "ark1qlockup",
            receiver_pk_script: "51201234",
            evm_refund_address: SOLVER_EVM_ADDRESS,
            evm_timeout_block: 21_000_000,
            evm_contract_address: ERC20_SWAP,
            evm_chain_id: 1,
            min_confirmations: 12,
            min_age_seconds: 180,
        },
        ...over,
    }) as unknown as EvmSendQuote;

const receiveQuote = (over: Record<string, unknown> = {}): EvmReceiveQuote =>
    ({
        v: 1,
        type: "rfq_quote",
        rfq_id: RFQ_ID,
        pair: evmReceivePair(USDC),
        from_amount: "249750000000000000000",
        to_amount: 250_000,
        solver_pubkey: "cc".repeat(32),
        valid_until: NOW + 60,
        refund_locktime: NOW + 200 * 3600,
        profile: {
            payment_hash: PAYMENT_HASH,
            lockup_address: "ark1qlockup",
            solver_refund_pk_script: "51205678",
            evm_contract_address: ERC20_SWAP,
            evm_chain_id: 1,
            evm_claim_address: SOLVER_CLAIM_ADDRESS,
            min_confirmations: 12,
            min_age_seconds: 180,
        },
        ...over,
    }) as unknown as EvmReceiveQuote;

// ── Parity ──────────────────────────────────────────────────────────────────

describe("solver parity", () => {
    it("both pairs match the solver's LOWERCASE-only corridor regexes", () => {
        expect(evmSendPair(USDC)).toMatch(SOLVER_SEND_PAIR);
        expect(evmReceivePair(USDC)).toMatch(SOLVER_RECEIVE_PAIR);
        expect(evmSendPair(USDC_CHECKSUMMED)).toMatch(SOLVER_SEND_PAIR);
        expect(evmReceivePair(USDC_CHECKSUMMED)).toMatch(SOLVER_RECEIVE_PAIR);
        expect(USDC_CHECKSUMMED).not.toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("the quote fixtures carry exactly what the solver's builders emit", () => {
        const send = sendQuote() as unknown as Record<string, unknown>;
        expect(Object.keys(send).sort()).toEqual([...SOLVER_SEND_QUOTE_KEYS].sort());
        expect(Object.keys(send.profile as object).sort()).toEqual(
            [...SOLVER_SEND_QUOTE_PROFILE_KEYS].sort(),
        );
        const receive = receiveQuote() as unknown as Record<string, unknown>;
        expect(Object.keys(receive).sort()).toEqual([...SOLVER_RECEIVE_QUOTE_KEYS].sort());
        expect(Object.keys(receive.profile as object).sort()).toEqual(
            [...SOLVER_RECEIVE_QUOTE_PROFILE_KEYS].sort(),
        );
    });

    it("the readers require every profile key the solver actually sends", () => {
        const withoutKey = (
            quote: Record<string, unknown>,
            key: string,
        ): Record<string, unknown> => {
            const profile = { ...(quote.profile as Record<string, unknown>) };
            delete profile[key];
            return { ...quote, profile };
        };
        for (const key of SOLVER_SEND_QUOTE_PROFILE_KEYS) {
            expect(() =>
                readEvmSendQuote(
                    withoutKey(sendQuote() as unknown as Record<string, unknown>, key),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(new RegExp(`profile\\.${key}`));
        }
        for (const key of SOLVER_RECEIVE_QUOTE_PROFILE_KEYS) {
            expect(() =>
                readEvmReceiveQuote(
                    withoutKey(receiveQuote() as unknown as Record<string, unknown>, key),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(new RegExp(`profile\\.${key}`));
        }
    });
});

// ── Pairs ───────────────────────────────────────────────────────────────────

describe("pairs and token identity", () => {
    it("names the EVM legs", () => {
        expect(EVM_CHAIN).toBe("ethereum");
        expect(evmTokenLeg(USDC)).toBe(`ethereum:${USDC}`);
        expect(evmSendPair(USDC)).toBe(`arkade:BTC->ethereum:${USDC}`);
        expect(evmReceivePair(USDC)).toBe(`ethereum:${USDC}->arkade:BTC`);
    });

    it("lowercases a checksummed token so the pair still matches byte for byte", () => {
        expect(evmTokenLeg(USDC_CHECKSUMMED)).toBe(`ethereum:${USDC}`);
        expect(evmSendPair(USDC_CHECKSUMMED)).toBe(evmSendPair(USDC));
        expect(evmReceivePair(USDC_CHECKSUMMED)).toBe(evmReceivePair(USDC));
    });

    it("refuses anything that is not an EVM address", () => {
        expect(() => evmSendPair("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toThrow(
            /token address must be 0x then 40 hex/,
        );
        expect(() => evmSendPair(`${USDC}00`)).toThrow(/token address/);
        expect(() => evmReceivePair("0xnothex")).toThrow(/token address/);
    });

    it("reads a direction and a token back off a pair", () => {
        expect(evmDirectionOf(evmSendPair(USDC))).toBe("send");
        expect(evmDirectionOf(evmReceivePair(USDC))).toBe("receive");
        expect(evmTokenOf(evmSendPair(USDC))).toBe(USDC);
        expect(evmTokenOf(evmReceivePair(USDC))).toBe(USDC);
    });

    it("answers null for every pair that is not an EVM one", () => {
        for (const pair of [
            "arkade:BTC->lightning:BTC",
            "onchain:BTC->arkade:BTC",
            `arkade:BTC->ethereum:${USDC_CHECKSUMMED}`,
            `ethereum:${USDC}->ethereum:${USDC}`,
            "",
        ]) {
            expect(evmDirectionOf(pair)).toBeNull();
            expect(evmTokenOf(pair)).toBeNull();
        }
    });
});

// ── Amounts ─────────────────────────────────────────────────────────────────

describe("amounts", () => {
    it("encodes a bigint as the canonical decimal form", () => {
        expect(evmAmountToWire(0n)).toBe("0");
        expect(evmAmountToWire(1n)).toBe("1");
        expect(evmAmountToWire(2n ** 256n - 1n)).toBe(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        );
    });

    it("refuses a negative amount rather than emitting a sign the schema anchors out", () => {
        expect(() => evmAmountToWire(-1n)).toThrow(/may not be negative/);
    });

    it("bounds values to uint256 and refuses non-bigint runtime inputs", () => {
        const max = 2n ** 256n - 1n;
        expect(evmAmountToWire(max)).toBe(max.toString());
        expect(evmAmountFromWire(max.toString(), "x")).toBe(max);
        expect(() => evmAmountToWire(max + 1n)).toThrow(/fit uint256/);
        expect(() => evmAmountToWire(1 as unknown as bigint)).toThrow(/must be a bigint/);
        expect(() => evmAmountFromWire((max + 1n).toString(), "x")).toThrow(/exceeds uint256/);
        expect(() => evmAmountFromWire("9".repeat(1_000), "x")).toThrow(/exceeds uint256/);
    });

    it("round-trips past 2^53 without losing a unit", () => {
        const exact = 9_007_199_254_740_993n;
        expect(evmAmountFromWire(evmAmountToWire(exact), "x")).toBe(exact);
        expect(Number(exact)).toBe(9_007_199_254_740_992);
    });

    it("refuses a JSON number outright, at every magnitude", () => {
        for (const value of [1, 0, 1e18, Number.MAX_SAFE_INTEGER]) {
            expect(() => evmAmountFromWire(value, "evm_amount")).toThrow(
                /evm_amount must be a decimal string of atomic units, not a JSON number/,
            );
        }
    });

    it("refuses every non-canonical spelling", () => {
        for (const value of ["", "01", "1e18", "0x10", " 1", "1 ", "-1", "1.0", "+1", "١٢٣"]) {
            expect(() => evmAmountFromWire(value, "evm_amount")).toThrow(/not a canonical decimal/);
        }
    });

    it("accepts the two edge spellings that ARE canonical", () => {
        expect(evmAmountFromWire("0", "x")).toBe(0n);
        expect(evmAmountFromWire("10", "x")).toBe(10n);
    });
});

// ── Requests ────────────────────────────────────────────────────────────────

describe("request builders", () => {
    it("builds the send request", () => {
        expect(sendRequest()).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: `arkade:BTC->ethereum:${USDC}`,
            amount_side: "from",
            amount: 250_000,
            profile: {
                payment_hash: PAYMENT_HASH,
                evm_claim_address: CLAIM_ADDRESS,
                refund_address: "ark1qrefund",
                client_refund_pubkey: hex.encode(key(13)),
            },
        });
    });

    it("builds the receive request, with the amount in the profile", () => {
        expect(receiveRequest()).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: `ethereum:${USDC}->arkade:BTC`,
            amount_side: "from",
            profile: {
                payment_hash: PAYMENT_HASH,
                evm_amount: "123456789",
                evm_timeout_block: 21_000_000,
                evm_refund_address: CLAIM_ADDRESS,
                payout_address: "ark1qpayout",
                payout_pubkey: hex.encode(key(9)),
            },
        });
    });

    it("keeps an EIP-55 checksummed profile address as given", () => {
        const request = evmSendRequest({
            rfqId: RFQ_ID,
            tokenAddress: USDC,
            paymentHash: PAYMENT_HASH,
            evmClaimAddress: USDC_CHECKSUMMED,
            refundAddress: "ark1qrefund",
            senderPubkey: key(13),
            amountSats: 1,
        });
        expect((request.profile as Record<string, unknown>).evm_claim_address).toBe(
            USDC_CHECKSUMMED,
        );
    });

    it("carries a 256-bit amount through to the wire intact", () => {
        const huge = 2n ** 200n + 7n;
        const request = evmReceiveRequest({
            rfqId: RFQ_ID,
            tokenAddress: USDC,
            paymentHash: PAYMENT_HASH,
            evmAmount: huge,
            evmTimeoutBlock: 1,
            evmRefundAddress: CLAIM_ADDRESS,
            payoutAddress: "ark1qpayout",
            payoutPubkey: key(9),
        });
        const encoded = (request.profile as Record<string, unknown>).evm_amount;
        expect(encoded).toBe(huge.toString());
        const reparsed = JSON.parse(JSON.stringify(request)) as {
            profile: { evm_amount: unknown };
        };
        expect(evmAmountFromWire(reparsed.profile.evm_amount, "evm_amount")).toBe(huge);
    });

    it("refuses the inputs the solver's schema would refuse anyway", () => {
        const send = {
            rfqId: RFQ_ID,
            tokenAddress: USDC,
            paymentHash: PAYMENT_HASH,
            evmClaimAddress: CLAIM_ADDRESS,
            refundAddress: "ark1qrefund",
            senderPubkey: key(13),
            amountSats: 250_000,
        };
        expect(() => evmSendRequest({ ...send, amountSats: 0 })).toThrow(/amountSats/);
        expect(() => evmSendRequest({ ...send, amountSats: 1.5 })).toThrow(/amountSats/);
        expect(() => evmSendRequest({ ...send, evmClaimAddress: "0x00" })).toThrow(
            /evmClaimAddress/,
        );
        expect(() => evmSendRequest({ ...send, paymentHash: "not-a-hash" })).toThrow(/paymentHash/);
        const receive = {
            rfqId: RFQ_ID,
            tokenAddress: USDC,
            paymentHash: PAYMENT_HASH,
            evmAmount: 1n,
            evmTimeoutBlock: 21_000_000,
            evmRefundAddress: CLAIM_ADDRESS,
            payoutAddress: "ark1qpayout",
            payoutPubkey: key(9),
        };
        expect(() => evmReceiveRequest({ ...receive, evmTimeoutBlock: 0 })).toThrow(
            /evmTimeoutBlock/,
        );
        expect(() => evmReceiveRequest({ ...receive, paymentHash: "not-a-hash" })).toThrow(
            /paymentHash/,
        );
        for (const bad of [0n, -1n]) {
            expect(() => evmReceiveRequest({ ...receive, evmAmount: bad })).toThrow(
                /evmAmount must be a positive number of atomic units/,
            );
        }
        expect(evmAmountToWire(0n)).toBe("0");
        expect(() => evmReceiveRequest({ ...receive, evmRefundAddress: "nope" })).toThrow(
            /evmRefundAddress/,
        );
        expect(() => evmReceiveRequest({ ...receive, evmAmount: 2n ** 256n })).toThrow(
            /fit uint256/,
        );
    });
});

// ── Quotes ──────────────────────────────────────────────────────────────────

describe("quote readers", () => {
    it("narrows a well-formed send quote", () => {
        const quote = readEvmSendQuote(sendQuote(), EXPECTED_QUOTE);
        expect(quote.profile.evm_timeout_block).toBe(21_000_000);
        expect(evmQuoteTokenAmount(quote)).toBe(249_750_000_000_000_000_000n);
        expect(evmQuoteSats(quote)).toBe(250_000);
    });

    it("narrows a well-formed receive quote", () => {
        const quote = readEvmReceiveQuote(receiveQuote(), EXPECTED_QUOTE);
        expect(quote.profile.evm_claim_address).toBe(SOLVER_CLAIM_ADDRESS);
        expect(evmQuoteTokenAmount(quote)).toBe(249_750_000_000_000_000_000n);
        expect(evmQuoteSats(quote)).toBe(250_000);
    });

    it("takes the token and sats legs off OPPOSITE sides per direction", () => {
        const send = readEvmSendQuote(sendQuote(), EXPECTED_QUOTE);
        const receive = readEvmReceiveQuote(receiveQuote(), EXPECTED_QUOTE);
        expect(BigInt(send.to_amount)).toBe(evmQuoteTokenAmount(send));
        expect(send.from_amount).toBe(evmQuoteSats(send));
        expect(BigInt(receive.from_amount)).toBe(evmQuoteTokenAmount(receive));
        expect(receive.to_amount).toBe(evmQuoteSats(receive));
    });

    it("refuses a quote for another negotiation, even on the same market", () => {
        const other = "c3".repeat(32);
        expect(() => readEvmSendQuote(sendQuote({ rfq_id: other }), EXPECTED_QUOTE)).toThrow(
            /quote is for rfq_id "c3c3.*not this negotiation's a1a1/,
        );
        expect(() => readEvmReceiveQuote(receiveQuote({ rfq_id: other }), EXPECTED_QUOTE)).toThrow(
            /not this negotiation's/,
        );
        const anonymous = sendQuote() as unknown as Record<string, unknown>;
        delete anonymous.rfq_id;
        expect(() => readEvmSendQuote(anonymous, EXPECTED_QUOTE)).toThrow(/quote is for rfq_id/);
    });

    it("refuses a quote for another token, or another pair entirely", () => {
        expect(() =>
            readEvmSendQuote(sendQuote(), { ...EXPECTED_QUOTE, tokenAddress: ERC20_SWAP }),
        ).toThrow(/solver quoted .* not arkade:BTC->ethereum/);
        expect(() => readEvmSendQuote(receiveQuote(), EXPECTED_QUOTE)).toThrow(/solver quoted/);
        expect(() => readEvmReceiveQuote(sendQuote(), EXPECTED_QUOTE)).toThrow(/solver quoted/);
    });

    it("refuses a token amount that arrived as a JSON number", () => {
        expect(() => readEvmSendQuote(sendQuote({ to_amount: 249.75e18 }), EXPECTED_QUOTE)).toThrow(
            /to_amount must be a decimal string/,
        );
        expect(() =>
            readEvmReceiveQuote(receiveQuote({ from_amount: 249.75e18 }), EXPECTED_QUOTE),
        ).toThrow(/from_amount must be a decimal string/);
    });

    it("binds both exact-in quote amounts, payment hashes, and chains to the request", () => {
        const otherHash = "d4".repeat(32);
        expect(() =>
            readEvmSendQuote(
                { ...sendQuote(), profile: { ...sendQuote().profile, payment_hash: otherHash } },
                EXPECTED_QUOTE,
            ),
        ).toThrow(/payment_hash does not match/);
        expect(() =>
            readEvmReceiveQuote(
                {
                    ...receiveQuote(),
                    profile: { ...receiveQuote().profile, payment_hash: otherHash },
                },
                EXPECTED_QUOTE,
            ),
        ).toThrow(/payment_hash does not match/);
        expect(() => readEvmSendQuote(sendQuote({ from_amount: 250_001 }), EXPECTED_QUOTE)).toThrow(
            /from_amount does not match the requested sats/,
        );
        expect(() =>
            readEvmReceiveQuote(
                receiveQuote({ from_amount: "249750000000000000001" }),
                EXPECTED_QUOTE,
            ),
        ).toThrow(/from_amount does not match the requested token/);
        expect(() =>
            readEvmSendQuote(
                { ...sendQuote(), profile: { ...sendQuote().profile, evm_chain_id: 10 } },
                EXPECTED_QUOTE,
            ),
        ).toThrow(/evm_chain_id does not match/);
        expect(() =>
            readEvmReceiveQuote(
                { ...receiveQuote(), profile: { ...receiveQuote().profile, evm_chain_id: 10 } },
                EXPECTED_QUOTE,
            ),
        ).toThrow(/evm_chain_id does not match/);
    });

    it("requires version 1 and positive uint256 token quote amounts", () => {
        expect(() => readEvmSendQuote(sendQuote({ v: 2 }), EXPECTED_QUOTE)).toThrow(
            /expected EVM quote version 1/,
        );
        expect(() => readEvmReceiveQuote(receiveQuote({ v: 2 }), EXPECTED_QUOTE)).toThrow(
            /expected EVM quote version 1/,
        );
        expect(() => readEvmSendQuote(sendQuote({ to_amount: "0" }), EXPECTED_QUOTE)).toThrow(
            /to_amount must be positive/,
        );
        expect(() =>
            readEvmReceiveQuote(receiveQuote({ from_amount: "0" }), EXPECTED_QUOTE),
        ).toThrow(/from_amount must be positive/);
        expect(() =>
            readEvmSendQuote(sendQuote({ to_amount: (2n ** 256n).toString() }), EXPECTED_QUOTE),
        ).toThrow(/exceeds uint256/);
        expect(() =>
            readEvmReceiveQuote(
                receiveQuote({ from_amount: (2n ** 256n).toString() }),
                EXPECTED_QUOTE,
            ),
        ).toThrow(/exceeds uint256/);
    });

    it("rejects unsafe integer fields and expected values", () => {
        const unsafe = Number.MAX_SAFE_INTEGER + 1;
        expect(() => readEvmSendQuote(sendQuote({ valid_until: unsafe }), EXPECTED_QUOTE)).toThrow(
            /valid_until must be a positive integer/,
        );
        expect(() =>
            readEvmReceiveQuote(
                {
                    ...receiveQuote(),
                    profile: { ...receiveQuote().profile, min_age_seconds: unsafe },
                },
                EXPECTED_QUOTE,
            ),
        ).toThrow(/min_age_seconds must be a non-negative integer/);
        expect(() => readEvmSendQuote(sendQuote(), { ...EXPECTED_QUOTE, chainId: unsafe })).toThrow(
            /expected.chainId must be a positive integer/,
        );
    });

    it("refuses an address field that is PRESENT but not an address", () => {
        for (const bad of ["0x0", "", "not-an-address", `${ERC20_SWAP}00`, ERC20_SWAP.slice(2)]) {
            expect(() =>
                readEvmSendQuote(
                    withProfile(sendQuote(), {
                        evm_contract_address: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.evm_contract_address must be 0x then 40 hex/);
            expect(() =>
                readEvmReceiveQuote(
                    withProfile(receiveQuote(), {
                        evm_claim_address: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.evm_claim_address must be 0x then 40 hex/);
            expect(() =>
                readEvmSendQuote(
                    withProfile(sendQuote(), {
                        evm_refund_address: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.evm_refund_address must be 0x then 40 hex/);
        }
    });

    it("gives a send client all six fields of the swap key", () => {
        const quote = readEvmSendQuote(sendQuote(), EXPECTED_QUOTE);
        const key = {
            preimageHash: quote.profile.payment_hash,
            amount: evmQuoteTokenAmount(quote),
            tokenAddress: evmTokenOf(quote.pair),
            claimAddress: CLAIM_ADDRESS,
            refundAddress: quote.profile.evm_refund_address,
            timelock: quote.profile.evm_timeout_block,
        };
        for (const [field, value] of Object.entries(key)) {
            expect(value, `${field} is not derivable from the quote`).toBeDefined();
        }
        expect(key.refundAddress).toBe(SOLVER_EVM_ADDRESS);
        expect(key.tokenAddress).toBe(USDC);
        expect(key.amount).toBe(249_750_000_000_000_000_000n);
    });

    it("refuses a payment_hash that is not a 32-byte hash", () => {
        for (const bad of ["", "not-hex", "b2".repeat(31), "b2".repeat(33), "B2".repeat(32), 7]) {
            expect(() =>
                readEvmSendQuote(
                    withProfile(sendQuote(), {
                        payment_hash: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.payment_hash must be 64 lowercase hex/);
            expect(() =>
                readEvmReceiveQuote(
                    withProfile(receiveQuote(), {
                        payment_hash: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.payment_hash must be 64 lowercase hex/);
        }
    });

    it("refuses a pkScript that is present but not hex", () => {
        for (const bad of ["", "zz", "5120AB", 5120, "abc", "5120" + "aa".repeat(31) + "a"]) {
            expect(() =>
                readEvmSendQuote(
                    withProfile(sendQuote(), {
                        receiver_pk_script: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.receiver_pk_script must be lowercase hex of whole bytes/);
            expect(() =>
                readEvmReceiveQuote(
                    withProfile(receiveQuote(), {
                        solver_refund_pk_script: bad,
                    }),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(/profile\.solver_refund_pk_script must be lowercase hex of whole bytes/);
        }
    });

    it("refuses a quote missing an ENVELOPE field, including the two deadlines", () => {
        // A missing deadline would not fail `assertFundable`'s gates, it would delete them.
        const dropEnvelope = (
            quote: Record<string, unknown>,
            key: string,
        ): Record<string, unknown> => {
            const copy = { ...quote };
            delete copy[key];
            return copy;
        };
        for (const key of ["solver_pubkey", "valid_until", "refund_locktime"]) {
            expect(() =>
                readEvmSendQuote(
                    dropEnvelope(sendQuote() as unknown as Record<string, unknown>, key),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(new RegExp(key));
            expect(() =>
                readEvmReceiveQuote(
                    dropEnvelope(receiveQuote() as unknown as Record<string, unknown>, key),
                    EXPECTED_QUOTE,
                ),
            ).toThrow(new RegExp(key));
        }
        expect(() =>
            readEvmSendQuote(
                dropEnvelope(sendQuote() as unknown as Record<string, unknown>, "profile"),
                EXPECTED_QUOTE,
            ),
        ).toThrow(/carries no profile/);
        expect(() =>
            readEvmReceiveQuote(
                dropEnvelope(receiveQuote() as unknown as Record<string, unknown>, "profile"),
                EXPECTED_QUOTE,
            ),
        ).toThrow(/carries no profile/);
    });

    it("accepts min_age_seconds of zero — depth-only is a solver's choice", () => {
        const quote = sendQuote() as unknown as Record<string, unknown>;
        const profile = { ...(quote.profile as Record<string, unknown>), min_age_seconds: 0 };
        expect(() => readEvmSendQuote({ ...quote, profile }, EXPECTED_QUOTE)).not.toThrow();
    });

    it("ignores unknown fields — responses are tolerant, requests are not", () => {
        const quote = sendQuote() as unknown as Record<string, unknown>;
        const profile = { ...(quote.profile as Record<string, unknown>), future_field: "x" };
        expect(() =>
            readEvmSendQuote({ ...quote, profile, another: 1 }, EXPECTED_QUOTE),
        ).not.toThrow();
    });

    it("refuses a refusal, and anything that is not a quote at all", () => {
        expect(() =>
            readEvmSendQuote(
                { v: 1, type: "rfq_refusal", reason: "unsupported_pair" },
                EXPECTED_QUOTE,
            ),
        ).toThrow(/expected an rfq_quote, got rfq_refusal/);
        expect(() => readEvmSendQuote(null, EXPECTED_QUOTE)).toThrow(/not an object/);
        expect(() => readEvmSendQuote("{}", EXPECTED_QUOTE)).toThrow(/not an object/);
    });
});

// ── The funding gate ────────────────────────────────────────────────────────

describe("assertFundable refuses EVM quotes until local funding is implemented", () => {
    it.each([
        ["send", () => sendQuote()],
        ["receive", () => receiveQuote()],
    ])("refuses every EVM %s quote before applying unrelated gates", (_direction, quote) => {
        for (const maxFee of [
            { sats: 0 },
            { bps: 100 },
            { bps: 100, referenceRate: 0.5 },
            { sats: 1_000_000_000, bps: 10_000 },
        ]) {
            let thrown: unknown;
            try {
                assertFundable({
                    quote: quote(),
                    now: NOW + 60,
                    maxFee,
                    onchain: { htlcLocktime: 1, minConfirmations: 1, direction: "send" },
                });
            } catch (error) {
                thrown = error;
            }
            expect((thrown as { reason?: string } | undefined)?.reason).toBe(
                "evm_funding_unavailable",
            );
            expect(String(thrown)).toMatch(/EVM funding is unavailable/);
        }
    });

    it("refuses numeric-token EVM quotes before maxFee or onchain policy", () => {
        const send = sendQuote({ to_amount: 249_750_000_000_000_000_000 as unknown as string });
        const receive = receiveQuote({
            from_amount: 249_750_000_000_000_000_000 as unknown as string,
        });
        for (const quote of [send, receive]) {
            expect(() =>
                assertFundable({
                    quote,
                    now: NOW,
                    maxFee: { bps: 1 },
                    onchain: { htlcLocktime: 1, minConfirmations: 1, direction: "send" },
                }),
            ).toThrow(expect.objectContaining({ reason: "evm_funding_unavailable" }));
        }
    });

    it("leaves the sats-only gate on a BTC quote working", () => {
        const btc = {
            rfq_id: RFQ_ID,
            pair: "arkade:BTC->lightning:BTC",
            from_amount: 100_000,
            to_amount: 99_500,
            valid_until: NOW + 60,
            refund_locktime: NOW + MIN_HEADROOM_SECONDS + 60,
        };
        expect(() => assertFundable({ quote: btc, now: NOW, maxFee: { sats: 500 } })).not.toThrow();
        expect(() => assertFundable({ quote: btc, now: NOW, maxFee: { sats: 499 } })).toThrow(
            /fee 500 exceeds/,
        );
    });
});
