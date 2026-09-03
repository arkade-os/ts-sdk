/**
 * The EVM corridors' wire layer, and its parity with the solver that already
 * speaks it.
 *
 * The `describe("solver parity")` block is the point of this file. Every other
 * test here checks that our own code does what our own docs say; that one
 * checks that what we emit is what the OTHER side accepts, which is the only
 * failure that cannot be found by reading this repo. An EVM offer encoded
 * differently from the solver is not a bug that surfaces as an error — it is a
 * swap that quietly never matches.
 *
 * The solver's schemas are restated below as data rather than imported: they
 * live in another repo, behind a `zod` this package does not depend on. Source
 * of truth, `arkade-os/intent-solver` at `9751a1c`:
 *
 *   packages/solver-corridors-evm/src/wire/evmPayloads.ts
 *   packages/solver-core/src/core/corridorPolicy.ts
 *
 * A restatement can drift, which is exactly why it is pinned here: a drift
 * fails a test, instead of being discovered by a client that quotes and is
 * never filled.
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

const NOW = 1_800_000_000;

// ── The solver's schemas, restated ──────────────────────────────────────────

/**
 * `zod`'s primitives, as much of them as these two schemas use.
 *
 * A `rule` answers `null` when the value is acceptable and a reason when it is
 * not, so a failure names the field AND what was wrong with it — a bare
 * boolean would make every mutation below report the same thing.
 */
type Rule = (value: unknown) => string | null;

const literal =
    (want: unknown): Rule =>
    (value) =>
        value === want
            ? null
            : `expected literal ${JSON.stringify(want)}, got ${JSON.stringify(value)}`;

const matching =
    (pattern: RegExp): Rule =>
    (value) =>
        typeof value === "string" && pattern.test(value)
            ? null
            : `expected a string matching ${pattern}, got ${JSON.stringify(value)}`;

const boundedString =
    (min: number, max: number): Rule =>
    (value) =>
        typeof value === "string" && value.length >= min && value.length <= max
            ? null
            : `expected a string of ${min}..${max} chars, got ${JSON.stringify(value)}`;

const positiveInt: Rule = (value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0
        ? null
        : `expected a positive integer, got ${JSON.stringify(value)}`;

/** `z.object({…}).strict()` — every declared key required, every undeclared
 * key a refusal. Strictness is the half that catches an extra field, and an
 * extra field is `unsupported_payload` on this wire, not an ignored key. */
const strictObject = (fields: Record<string, Rule>): Rule => {
    return (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return `expected an object, got ${JSON.stringify(value)}`;
        }
        const record = value as Record<string, unknown>;
        const extra = Object.keys(record).filter((name) => !(name in fields));
        if (extra.length > 0) return `unrecognized key(s): ${extra.join(", ")}`;
        for (const [name, rule] of Object.entries(fields)) {
            if (!(name in record)) return `missing key: ${name}`;
            const failure = rule(record[name]);
            if (failure) return `${name}: ${failure}`;
        }
        return null;
    };
};

// `packages/solver-corridors-evm/src/wire/evmPayloads.ts`, verbatim.
const RFQ_ID_RULE = matching(/^[0-9a-f]{64}$/);
const HEX32 = matching(/^[0-9a-f]{64}$/);
const XONLY_HEX = matching(/^[0-9a-f]{64}$/);
const EVM_ADDRESS = matching(/^0x[0-9a-fA-F]{40}$/);
const TOKEN_AMOUNT = matching(/^(0|[1-9][0-9]*)$/);
// `packages/solver-core/src/core/marketKey.ts`: (LONGEST_CORRIDOR + 1 + 68) * 2 + 2,
// with LONGEST_CORRIDOR = "arkade:BTC->lightning:BTC".length.
const SOLVER_MAX_PAIR_LENGTH = (25 + 1 + 68) * 2 + 2;
const PAIR = boundedString(1, SOLVER_MAX_PAIR_LENGTH);

const EvmSendRfqRequest = strictObject({
    v: literal(1),
    type: literal("rfq_request"),
    rfq_id: RFQ_ID_RULE,
    pair: PAIR,
    amount_side: literal("from"),
    amount: positiveInt,
    profile: strictObject({
        payment_hash: HEX32,
        evm_claim_address: EVM_ADDRESS,
        refund_address: boundedString(1, 200),
        client_refund_pubkey: XONLY_HEX,
    }),
});

const EvmReceiveRfqRequest = strictObject({
    v: literal(1),
    type: literal("rfq_request"),
    rfq_id: RFQ_ID_RULE,
    pair: PAIR,
    amount_side: literal("from"),
    // No `amount`, and `.strict()` is what turns that from an omission into a
    // rule: the client's amount is a token quantity, so it rides the profile
    // as a string. An `amount` added for symmetry refuses the whole request.
    profile: strictObject({
        payment_hash: HEX32,
        evm_amount: TOKEN_AMOUNT,
        evm_timeout_block: positiveInt,
        evm_refund_address: EVM_ADDRESS,
        payout_address: boundedString(1, 200),
        payout_pubkey: XONLY_HEX,
    }),
});

// `packages/solver-core/src/core/corridorPolicy.ts` — LOWERCASE token only.
const SOLVER_SEND_PAIR = /^arkade:BTC->ethereum:0x[0-9a-f]{40}$/;
const SOLVER_RECEIVE_PAIR = /^ethereum:0x[0-9a-f]{40}->arkade:BTC$/;

/**
 * Exactly what `evmSendRfqQuotePayload` and `evmReceiveRfqQuotePayload` emit.
 *
 * The quote direction needs its own pin, and for a different reason than the
 * request direction. A request is validated by the solver, so getting it wrong
 * produces a refusal; a QUOTE is validated by nobody but us, so a reader that
 * looks for `receiver_pkscript` simply never finds it and reports a broken
 * quote against a solver that sent a correct one. Without this, the only thing
 * checking those names is the fixture below — which this file also wrote, so
 * it would agree with any typo.
 */
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

// ── Fixtures ────────────────────────────────────────────────────────────────

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
    it("the send request satisfies the solver's strict schema", () => {
        expect(EvmSendRfqRequest(sendRequest())).toBeNull();
    });

    it("the receive request satisfies the solver's strict schema", () => {
        expect(EvmReceiveRfqRequest(receiveRequest())).toBeNull();
    });

    it("the receive request carries NO envelope amount", () => {
        // Not a style point: the schema is `.strict()`, so an `amount` here is
        // an unrecognized key and the whole request is `unsupported_payload`.
        expect(receiveRequest()).not.toHaveProperty("amount");
        expect(EvmReceiveRfqRequest({ ...receiveRequest(), amount: 1 })).toMatch(
            /unrecognized key\(s\): amount/,
        );
    });

    it("the send request DOES carry one — the schema requires it", () => {
        const { amount, ...withoutAmount } = sendRequest();
        expect(amount).toBe(250_000);
        expect(EvmSendRfqRequest(withoutAmount)).toBe("missing key: amount");
    });

    it("both pairs match the solver's LOWERCASE-only corridor regexes", () => {
        expect(evmSendPair(USDC)).toMatch(SOLVER_SEND_PAIR);
        expect(evmReceivePair(USDC)).toMatch(SOLVER_RECEIVE_PAIR);
        // The checksummed spelling of the SAME token, which the solver's pair
        // regex refuses — so normalising is what makes it quotable at all.
        expect(evmSendPair(USDC_CHECKSUMMED)).toMatch(SOLVER_SEND_PAIR);
        expect(evmReceivePair(USDC_CHECKSUMMED)).toMatch(SOLVER_RECEIVE_PAIR);
        expect(USDC_CHECKSUMMED).not.toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("the quote fixtures carry exactly what the solver's builders emit", () => {
        // Both directions, and BOTH WAYS round: a key the solver sends and we
        // do not is a field the reader will never check, and a key we invented
        // is a field no solver will ever send — the second reads as a broken
        // solver, which is the harder one to diagnose.
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
        // The fixture above is what the solver emits; dropping any one of its
        // profile keys must be noticed. Anything the reader tolerates missing
        // is a field the funding path would later read as `undefined`.
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
                    {
                        tokenAddress: USDC,
                    },
                ),
            ).toThrow(new RegExp(`profile\\.${key}`));
        }
        for (const key of SOLVER_RECEIVE_QUOTE_PROFILE_KEYS) {
            expect(() =>
                readEvmReceiveQuote(
                    withoutKey(receiveQuote() as unknown as Record<string, unknown>, key),
                    { tokenAddress: USDC },
                ),
            ).toThrow(new RegExp(`profile\\.${key}`));
        }
    });

    it("the strict validator itself refuses what the solver would", () => {
        // A parity check is only worth what its validator catches, so pin that
        // the validator is not vacuous.
        expect(EvmSendRfqRequest({ ...sendRequest(), extra: 1 })).toMatch(/unrecognized key/);
        expect(EvmSendRfqRequest({ ...sendRequest(), amount_side: "to" })).toMatch(
            /amount_side: expected literal "from"/,
        );
        expect(EvmSendRfqRequest({ ...sendRequest(), v: 2 })).toMatch(/v: expected literal 1/);
        const request = receiveRequest();
        const profile = request.profile as Record<string, unknown>;
        expect(
            EvmReceiveRfqRequest({ ...request, profile: { ...profile, evm_amount: "1e18" } }),
        ).toMatch(/evm_amount: expected a string/);
        expect(
            EvmReceiveRfqRequest({ ...request, profile: { ...profile, evm_amount: 1e18 } }),
        ).toMatch(/evm_amount: expected a string/);
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
            // The checksummed token — a spelling no solver serves, and the
            // exact value a client that skipped normalising would produce.
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
        // 2^256 - 1 — the widest an ERC20 balance can be, and 60 orders of
        // magnitude past what a double holds exactly.
        expect(evmAmountToWire(2n ** 256n - 1n)).toBe(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        );
    });

    it("refuses a negative amount rather than emitting a sign the schema anchors out", () => {
        expect(() => evmAmountToWire(-1n)).toThrow(/may not be negative/);
    });

    it("round-trips past 2^53 without losing a unit", () => {
        // One atomic unit above 2^53, and the value a double rounds to. The
        // point of the string encoding is that these stay distinguishable.
        const exact = 9_007_199_254_740_993n;
        expect(evmAmountFromWire(evmAmountToWire(exact), "x")).toBe(exact);
        expect(Number(exact)).toBe(9_007_199_254_740_992);
    });

    it("refuses a JSON number outright, at every magnitude", () => {
        // Including one that IS exactly representable: accepting it would make
        // the check depend on the value rather than on the encoding, and the
        // rounding has already happened by the time we look.
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
        // The pair must be lowercased and the profile must not be: the solver
        // accepts either case here, and flattening it throws away the typo
        // protection the checksum exists for.
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
        expect(EvmSendRfqRequest(request)).toBeNull();
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
        // Survives an actual JSON round trip, which a number would not.
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
        expect(() => evmReceiveRequest({ ...receive, evmAmount: -1n })).toThrow(
            /may not be negative/,
        );
        expect(() => evmReceiveRequest({ ...receive, evmRefundAddress: "nope" })).toThrow(
            /evmRefundAddress/,
        );
    });
});

// ── Quotes ──────────────────────────────────────────────────────────────────

describe("quote readers", () => {
    it("narrows a well-formed send quote", () => {
        const quote = readEvmSendQuote(sendQuote(), { tokenAddress: USDC });
        expect(quote.profile.evm_timeout_block).toBe(21_000_000);
        expect(evmQuoteTokenAmount(quote)).toBe(249_750_000_000_000_000_000n);
        expect(evmQuoteSats(quote)).toBe(250_000);
    });

    it("narrows a well-formed receive quote", () => {
        const quote = readEvmReceiveQuote(receiveQuote(), { tokenAddress: USDC });
        expect(quote.profile.evm_claim_address).toBe(SOLVER_CLAIM_ADDRESS);
        expect(evmQuoteTokenAmount(quote)).toBe(249_750_000_000_000_000_000n);
        expect(evmQuoteSats(quote)).toBe(250_000);
    });

    it("takes the token and sats legs off OPPOSITE sides per direction", () => {
        // The one thing that silently swaps: both quotes carry the same two
        // numbers, and reading the wrong side yields a plausible value.
        const send = readEvmSendQuote(sendQuote(), { tokenAddress: USDC });
        const receive = readEvmReceiveQuote(receiveQuote(), { tokenAddress: USDC });
        expect(BigInt(send.to_amount)).toBe(evmQuoteTokenAmount(send));
        expect(send.from_amount).toBe(evmQuoteSats(send));
        expect(BigInt(receive.from_amount)).toBe(evmQuoteTokenAmount(receive));
        expect(receive.to_amount).toBe(evmQuoteSats(receive));
    });

    it("refuses a quote for another token, or another pair entirely", () => {
        expect(() => readEvmSendQuote(sendQuote(), { tokenAddress: ERC20_SWAP })).toThrow(
            /solver quoted .* not arkade:BTC->ethereum/,
        );
        // The receive quote's own pair, handed to the send reader.
        expect(() => readEvmSendQuote(receiveQuote(), { tokenAddress: USDC })).toThrow(
            /solver quoted/,
        );
        expect(() => readEvmReceiveQuote(sendQuote(), { tokenAddress: USDC })).toThrow(
            /solver quoted/,
        );
    });

    it("refuses a token amount that arrived as a JSON number", () => {
        expect(() =>
            readEvmSendQuote(sendQuote({ to_amount: 249.75e18 }), { tokenAddress: USDC }),
        ).toThrow(/to_amount must be a decimal string/);
        expect(() =>
            readEvmReceiveQuote(receiveQuote({ from_amount: 249.75e18 }), { tokenAddress: USDC }),
        ).toThrow(/from_amount must be a decimal string/);
    });

    it("refuses an address field that is PRESENT but not an address", () => {
        // Distinct from the missing-field case below, and it has to be tested
        // separately: a check that only fires on absence would pass that one
        // and let `evm_contract_address: "0x0"` straight through. These are the
        // two values a client later has to talk to a chain with.
        const withProfile = (
            quote: Record<string, unknown>,
            over: Record<string, unknown>,
        ): Record<string, unknown> => ({
            ...quote,
            profile: { ...(quote.profile as Record<string, unknown>), ...over },
        });
        for (const bad of ["0x0", "", "not-an-address", `${ERC20_SWAP}00`, ERC20_SWAP.slice(2)]) {
            expect(() =>
                readEvmSendQuote(
                    withProfile(sendQuote() as unknown as Record<string, unknown>, {
                        evm_contract_address: bad,
                    }),
                    { tokenAddress: USDC },
                ),
            ).toThrow(/profile\.evm_contract_address must be 0x then 40 hex/);
            expect(() =>
                readEvmReceiveQuote(
                    withProfile(receiveQuote() as unknown as Record<string, unknown>, {
                        evm_claim_address: bad,
                    }),
                    { tokenAddress: USDC },
                ),
            ).toThrow(/profile\.evm_claim_address must be 0x then 40 hex/);
        }
    });

    it("refuses a pkScript that is present but not hex", () => {
        const withProfile = (
            quote: Record<string, unknown>,
            over: Record<string, unknown>,
        ): Record<string, unknown> => ({
            ...quote,
            profile: { ...(quote.profile as Record<string, unknown>), ...over },
        });
        for (const bad of ["", "zz", "5120AB", 5120]) {
            expect(() =>
                readEvmSendQuote(
                    withProfile(sendQuote() as unknown as Record<string, unknown>, {
                        receiver_pk_script: bad,
                    }),
                    { tokenAddress: USDC },
                ),
            ).toThrow(/profile\.receiver_pk_script must be lowercase hex/);
            expect(() =>
                readEvmReceiveQuote(
                    withProfile(receiveQuote() as unknown as Record<string, unknown>, {
                        solver_refund_pk_script: bad,
                    }),
                    { tokenAddress: USDC },
                ),
            ).toThrow(/profile\.solver_refund_pk_script must be lowercase hex/);
        }
    });

    it("refuses a quote missing a field the funding path will read", () => {
        const drop = (key: string): Record<string, unknown> => {
            const quote = sendQuote() as unknown as Record<string, unknown>;
            const profile = { ...(quote.profile as Record<string, unknown>) };
            delete profile[key];
            return { ...quote, profile };
        };
        for (const key of [
            "payment_hash",
            "lockup_address",
            "receiver_pk_script",
            "evm_timeout_block",
            "evm_contract_address",
            "evm_chain_id",
            "min_confirmations",
            "min_age_seconds",
        ]) {
            expect(() => readEvmSendQuote(drop(key), { tokenAddress: USDC })).toThrow(
                new RegExp(`profile\\.${key}`),
            );
        }
    });

    it("refuses a quote missing an ENVELOPE field, including the two deadlines", () => {
        // `valid_until` and `refund_locktime` matter more than the rest, and
        // they fail in a way that reads as success. `assertFundable` compares
        // `now >= quote.valid_until` and `refund_locktime - now`; against
        // `undefined` both are false and NaN, so a missing deadline does not
        // fail its gate — it deletes it, and the swap funds with no window
        // check at all.
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
                    { tokenAddress: USDC },
                ),
            ).toThrow(new RegExp(key));
            expect(() =>
                readEvmReceiveQuote(
                    dropEnvelope(receiveQuote() as unknown as Record<string, unknown>, key),
                    { tokenAddress: USDC },
                ),
            ).toThrow(new RegExp(key));
        }
        // …and a profile that is missing outright, not merely short a key.
        expect(() =>
            readEvmSendQuote(
                dropEnvelope(sendQuote() as unknown as Record<string, unknown>, "profile"),
                { tokenAddress: USDC },
            ),
        ).toThrow(/carries no profile/);
    });

    it("accepts min_age_seconds of zero — depth-only is a solver's choice", () => {
        const quote = sendQuote() as unknown as Record<string, unknown>;
        const profile = { ...(quote.profile as Record<string, unknown>), min_age_seconds: 0 };
        expect(() => readEvmSendQuote({ ...quote, profile }, { tokenAddress: USDC })).not.toThrow();
    });

    it("ignores unknown fields — responses are tolerant, requests are not", () => {
        const quote = sendQuote() as unknown as Record<string, unknown>;
        const profile = { ...(quote.profile as Record<string, unknown>), future_field: "x" };
        expect(() =>
            readEvmSendQuote({ ...quote, profile, another: 1 }, { tokenAddress: USDC }),
        ).not.toThrow();
    });

    it("refuses a refusal, and anything that is not a quote at all", () => {
        expect(() =>
            readEvmSendQuote(
                { v: 1, type: "rfq_refusal", reason: "unsupported_pair" },
                {
                    tokenAddress: USDC,
                },
            ),
        ).toThrow(/expected an rfq_quote, got rfq_refusal/);
        expect(() => readEvmSendQuote(null, { tokenAddress: USDC })).toThrow(/not an object/);
        expect(() => readEvmSendQuote("{}", { tokenAddress: USDC })).toThrow(/not an object/);
    });
});

// ── The funding gate ────────────────────────────────────────────────────────

describe("assertFundable accepts an EVM quote", () => {
    it("passes a live quote with headroom", () => {
        assertFundable({ quote: sendQuote(), now: NOW });
        assertFundable({ quote: receiveQuote(), now: NOW });
    });

    it("still gates the quote window and the refund headroom", () => {
        expect(() => assertFundable({ quote: sendQuote(), now: NOW + 60 })).toThrow(
            /quote expired/,
        );
        const tight = sendQuote({ refund_locktime: NOW + MIN_HEADROOM_SECONDS - 1 });
        expect(() => assertFundable({ quote: tight, now: NOW })).toThrow(/headroom/);
        const receiveTight = receiveQuote({ refund_locktime: NOW + MIN_HEADROOM_SECONDS - 1 });
        expect(() => assertFundable({ quote: receiveTight, now: NOW })).toThrow(/headroom/);
    });
});
