/**
 * The receive-direction RFQ surface: `lightning:BTC->arkade:BTC` and
 * `onchain:BTC->arkade:BTC`.
 *
 * The test that matters most is the golden one, same as the send leg's: the
 * role-inverted covenant compiled here must be byte-identical to the
 * reference solver's, or the trader would verify against a tree the solver
 * never builds and refuse every swap. The pinned bytes were produced by the
 * reference implementation's `CovenantSwapScript` with the roles mapped
 * exactly as its receive corridors build them (`receiver` = the trader's
 * payout key, `client` = the solver).
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

const state = vi.hoisted(() => ({
    arkInfo: { signerPubkey: "", unilateralExitDelay: 4096, network: "regtest" },
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return state.arkInfo;
            }
        },
    };
});

import {
    ArkAddress,
    DescriptorIdentity,
    HDDescriptorProvider,
    InMemoryWalletRepository,
    MnemonicIdentity,
    type IWallet,
} from "@arkade-os/sdk";
import {
    AddressMismatch,
    LIGHTNING_RECEIVE_PAIR,
    ONCHAIN_RECEIVE_PAIR,
    assertReceivable,
    deriveLightningReceive,
    deriveOnchainReceive,
    lightningReceiveRequest,
    onchainReceiveRequest,
    receiveVtxoScript,
    requestLightningReceive,
    requestOnchainReceive,
    verifyReceiveInvoice,
    type InvoiceFacts,
    type RfqQuote,
    type RfqTransport,
} from "../src/rfq";
import { LockupRegistrationFailed } from "../src/lockupContract";
import { createRfqSwapRecord, rebuildRfqSwap } from "../src/rfqRecord";
import type { LightningReceiveSwap } from "../src/swapManager";
import { onchainHtlcScript, paymentHashOf } from "../src/onchainHtlc";
import { contractPreimage } from "@arkade-os/sdk";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);
const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));

const SERVER = key(3);
const SOLVER = key(1);
const EMULATOR_PUBKEY = key(9);
const EMULATOR_PUBKEY_HEX = "02" + hex.encode(EMULATOR_PUBKEY);
const TRADER_PAYOUT_PUBKEY = key(13);
const SOLVER_REFUND_PK_SCRIPT = p2tr(key(8));
const L1_REFUND_PUBKEY = key(7);
const HTLC_CLAIM_PUBKEY = key(11);
const COVCLAIMD_PK = secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), true);
const PAYOUT_ADDRESS = new ArkAddress(SERVER, key(21), "tark").encode();

state.arkInfo.signerPubkey = hex.encode(SERVER);

const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 3600;
const REFUND_LOCKTIME = NOW + 2 * 3600;
const HTLC_LOCKTIME = NOW + 30 * 600 + 6 * 3600;

describe("receiveVtxoScript", () => {
    // The reference solver's fixture, roles inverted: sender (VHTLC) = key(1)
    // (the solver), receiver = key(13) (the trader's payout key), server =
    // key(3), emulator = key(9), covenant refund destination = p2tr(key(8))
    // (the solver's own on these legs), claim payout = p2tr(key(5)) (the
    // trader's), preimage hash = ripemd160(sha256(0x07 * 32)), locktime
    // 1_800_000_000, CSV 4096s / 4608s / 5120s.
    const script = () =>
        receiveVtxoScript({
            solverPubkey: SOLVER,
            refundLocktime: 1_800_000_000,
            serverPubkey: SERVER,
            paymentHash: PAYMENT_HASH,
            claimDelay: 4096,
            emulatorPubkey: EMULATOR_PUBKEY,
            solverRefundPkScript: SOLVER_REFUND_PK_SCRIPT,
            payoutPubkey: TRADER_PAYOUT_PUBKEY,
            payoutPkScript: p2tr(key(5)),
        });

    it("is byte-identical to the reference solver's role-inverted script — golden scriptPubKey", () => {
        expect(hex.encode(script().pkScript)).toBe(
            "5120f683cdac21b1a88963f03078567e58188d24340c0f0e5d5c17a2790b3478c908",
        );
    });

    it("puts the trader in the receiver role and the solver in the sender role, leaf for leaf", () => {
        const compiled = script();
        const hash160 = hex.encode(ripemd160(sha256(PREIMAGE)));

        // claim: preimage (length-checked) + the TRADER (receiver) + server
        expect(compiled.claimScript).toBe(
            `82012088a914${hash160}876920${hex.encode(TRADER_PAYOUT_PUBKEY)}ad20${hex.encode(SERVER)}ac`,
        );
        // collaborative refund: solver(sender) + trader + server
        expect(compiled.refundScript).toBe(
            `20${hex.encode(SOLVER)}ad20${hex.encode(TRADER_PAYOUT_PUBKEY)}ad20${hex.encode(SERVER)}ac`,
        );
        // refundWithoutReceiver: solver + server, CLTV(refundLocktime) — the
        // solver's own recourse on these legs
        expect(compiled.refundWithoutReceiverScript.includes("b175")).toBe(true);
        expect(
            compiled.refundWithoutReceiverScript.endsWith(
                `20${hex.encode(SOLVER)}ad20${hex.encode(SERVER)}ac`,
            ),
        ).toBe(true);
        // unilateralClaim: preimage + the trader alone, CSV(4096s)
        expect(compiled.unilateralClaimScript).toBe(
            `82012088a914${hash160}876903080040b27520${hex.encode(TRADER_PAYOUT_PUBKEY)}ac`,
        );
        // the two non-interactive leaves pin to the right destinations:
        // nonInteractiveRefund = server + trader(receiver) + emulator-tweaked
        // key, pinned to the solver's refund destination; nonInteractiveClaim
        // carries the server + the trader's payout pin.
        expect(compiled.nonInteractiveClaimScript).toContain(hex.encode(SERVER));
        expect(compiled.nonInteractiveRefundScript).toContain(hex.encode(SERVER));
        expect(compiled.nonInteractiveRefundScript).toContain(hex.encode(TRADER_PAYOUT_PUBKEY));
    });
});

describe("receive request builders", () => {
    it("builds the lightning receive request", () => {
        expect(
            lightningReceiveRequest({
                rfqId: RFQ_ID,
                paymentHash: PAYMENT_HASH,
                payoutAddress: "tark1q...",
                payoutPubkey: TRADER_PAYOUT_PUBKEY,
                claimPacket: "abc=",
                amount: 5_000,
                amountSide: "to",
            }),
        ).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: LIGHTNING_RECEIVE_PAIR,
            amount_side: "to",
            amount: 5_000,
            profile: {
                payment_hash: PAYMENT_HASH,
                payout_address: "tark1q...",
                payout_pubkey: hex.encode(TRADER_PAYOUT_PUBKEY),
                claim_packet: "abc=",
            },
        });
    });

    it("builds the onchain receive request", () => {
        expect(
            onchainReceiveRequest({
                rfqId: RFQ_ID,
                paymentHash: PAYMENT_HASH,
                payoutAddress: "tark1q...",
                payoutPubkey: TRADER_PAYOUT_PUBKEY,
                refundPubkey: L1_REFUND_PUBKEY,
                claimPacket: "abc=",
                amount: 100_000,
                amountSide: "from",
            }),
        ).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: ONCHAIN_RECEIVE_PAIR,
            amount_side: "from",
            amount: 100_000,
            profile: {
                payment_hash: PAYMENT_HASH,
                claim_packet: "abc=",
                refund_pubkey: hex.encode(L1_REFUND_PUBKEY),
                payout_address: "tark1q...",
                payout_pubkey: hex.encode(TRADER_PAYOUT_PUBKEY),
            },
        });
    });
});

/** A quote whose covenant fields derive the lockup the maker will derive. */
const receiveQuote = (
    payload: Record<string, unknown>,
    over: { from?: number; to?: number; profile?: Record<string, unknown> } = {},
): RfqQuote => {
    const profile = (payload as { profile: Record<string, unknown> }).profile;
    const script = receiveVtxoScript({
        solverPubkey: SOLVER,
        refundLocktime: REFUND_LOCKTIME,
        serverPubkey: SERVER,
        paymentHash: profile.payment_hash as string,
        claimDelay: 4096,
        emulatorPubkey: EMULATOR_PUBKEY,
        solverRefundPkScript: SOLVER_REFUND_PK_SCRIPT,
        payoutPubkey: hex.decode(profile.payout_pubkey as string),
        payoutPkScript: ArkAddress.decode(PAYOUT_ADDRESS).pkScript,
    });
    return {
        v: 1,
        type: "rfq_quote",
        rfq_id: payload.rfq_id as string,
        pair: (payload as { pair?: string }).pair ?? LIGHTNING_RECEIVE_PAIR,
        from_amount: over.from ?? 5_000,
        to_amount: over.to ?? 4_950,
        solver_pubkey: hex.encode(SOLVER),
        valid_until: VALID_UNTIL,
        refund_locktime: REFUND_LOCKTIME,
        profile: {
            payment_hash: profile.payment_hash,
            invoice: "lnbcrt49u1p...",
            lockup_address: script.address("tark", SERVER).encode(),
            solver_refund_pk_script: hex.encode(SOLVER_REFUND_PK_SCRIPT),
            ...over.profile,
        },
    };
};

describe("deriveLightningReceive", () => {
    const request = () =>
        lightningReceiveRequest({
            rfqId: RFQ_ID,
            paymentHash: PAYMENT_HASH,
            payoutAddress: PAYOUT_ADDRESS,
            payoutPubkey: TRADER_PAYOUT_PUBKEY,
            claimPacket: "abc=",
            amount: 5_000,
            amountSide: "to",
        });

    it("verifies the solver's lockup against the local derivation", () => {
        const quote = receiveQuote(request());
        const derived = deriveLightningReceive({
            quote,
            paymentHash: PAYMENT_HASH,
            payoutPubkey: TRADER_PAYOUT_PUBKEY,
            payoutAddress: PAYOUT_ADDRESS,
            serverPubkey: SERVER,
            emulatorPubkey: EMULATOR_PUBKEY,
            claimDelay: 4096,
            hrp: "tark",
        });
        expect(derived.address).toBe(quote.profile.lockup_address);
        expect(derived.invoice).toBe("lnbcrt49u1p...");
        expect(derived.refundLocktime).toBe(REFUND_LOCKTIME);
    });

    it("refuses to fund a mismatched lockup address", () => {
        const quote = receiveQuote(request(), { profile: { lockup_address: "tark1qwrong" } });
        expect(() =>
            deriveLightningReceive({
                quote,
                paymentHash: PAYMENT_HASH,
                payoutPubkey: TRADER_PAYOUT_PUBKEY,
                payoutAddress: PAYOUT_ADDRESS,
                serverPubkey: SERVER,
                emulatorPubkey: EMULATOR_PUBKEY,
                claimDelay: 4096,
                hrp: "tark",
            }),
        ).toThrow(AddressMismatch);
    });

    it("refuses a quote missing a binding field", () => {
        const quote = receiveQuote(request(), { profile: { solver_refund_pk_script: undefined } });
        expect(() =>
            deriveLightningReceive({
                quote,
                paymentHash: PAYMENT_HASH,
                payoutPubkey: TRADER_PAYOUT_PUBKEY,
                payoutAddress: PAYOUT_ADDRESS,
                serverPubkey: SERVER,
                emulatorPubkey: EMULATOR_PUBKEY,
                claimDelay: 4096,
                hrp: "tark",
            }),
        ).toThrow(/missing a binding field/);
    });
});

describe("deriveOnchainReceive", () => {
    const request = () =>
        onchainReceiveRequest({
            rfqId: RFQ_ID,
            paymentHash: PAYMENT_HASH,
            payoutAddress: PAYOUT_ADDRESS,
            payoutPubkey: TRADER_PAYOUT_PUBKEY,
            refundPubkey: L1_REFUND_PUBKEY,
            claimPacket: "abc=",
            amount: 100_000,
            amountSide: "from",
        });

    const onchainQuote = (over: Record<string, unknown> = {}): RfqQuote => {
        const req = request();
        const base = receiveQuote(req, { from: 100_000, to: 99_000 });
        const htlc = onchainHtlcScript(
            {
                paymentHash: PAYMENT_HASH,
                claimKey: HTLC_CLAIM_PUBKEY,
                refundKey: L1_REFUND_PUBKEY,
                refundLocktime: HTLC_LOCKTIME,
            },
            "regtest",
        );
        return {
            ...base,
            pair: ONCHAIN_RECEIVE_PAIR,
            profile: {
                ...base.profile,
                claim_pubkey: hex.encode(HTLC_CLAIM_PUBKEY),
                htlc_locktime: HTLC_LOCKTIME,
                htlc_address: htlc.address,
                min_confirmations: 2,
            },
            ...over,
        };
    };

    const derive = (quote: RfqQuote) =>
        deriveOnchainReceive({
            quote,
            paymentHash: PAYMENT_HASH,
            payoutPubkey: TRADER_PAYOUT_PUBKEY,
            payoutAddress: PAYOUT_ADDRESS,
            refundPubkey: L1_REFUND_PUBKEY,
            serverPubkey: SERVER,
            emulatorPubkey: EMULATOR_PUBKEY,
            claimDelay: 4096,
            hrp: "tark",
            l1Network: "regtest",
        });

    it("verifies BOTH contracts against the local derivation", () => {
        const derived = derive(onchainQuote());
        expect(derived.address).toBe(onchainQuote().profile.lockup_address);
        expect(derived.htlc.address).toBe(onchainQuote().profile.htlc_address);
        expect(derived.minConfirmations).toBe(2);
    });

    it("refuses a mismatched htlc address — that is the contract the trader funds", () => {
        const quote = onchainQuote();
        (quote.profile as Record<string, unknown>).htlc_address = "bcrt1qwrong";
        expect(() => derive(quote)).toThrow(AddressMismatch);
    });
});

const INVOICE_EXPIRES_AT = NOW + 600;

describe("verifyReceiveInvoice", () => {
    const quote = receiveQuote(
        lightningReceiveRequest({
            rfqId: RFQ_ID,
            paymentHash: PAYMENT_HASH,
            payoutAddress: PAYOUT_ADDRESS,
            payoutPubkey: TRADER_PAYOUT_PUBKEY,
            claimPacket: "abc=",
            amount: 5_000,
            amountSide: "from",
        }),
        { from: 5_000, to: 4_950 },
    );
    const verify = (facts: Partial<InvoiceFacts>, decode?: () => InvoiceFacts) =>
        verifyReceiveInvoice({
            invoice: "lnbcrt49u1p...",
            decode:
                decode ??
                ((raw) => ({
                    raw,
                    paymentHash: PAYMENT_HASH,
                    amountSats: 5_000,
                    expiresAt: INVOICE_EXPIRES_AT,
                    ...facts,
                })),
            paymentHash: PAYMENT_HASH,
            quote,
        });

    it("takes the earlier of the invoice expiry and valid_until", () => {
        expect(verify({}).payDeadline).toBe(INVOICE_EXPIRES_AT);
        expect(verify({ expiresAt: VALID_UNTIL + 600 }).payDeadline).toBe(VALID_UNTIL);
    });

    it("refuses an invoice on another payment hash", () => {
        expect(() => verify({ paymentHash: "ff".repeat(32) })).toThrow(
            expect.objectContaining({ reason: "invoice_hash_mismatch" }),
        );
    });

    it("refuses an amountless invoice and one repricing the quote", () => {
        expect(() => verify({ amountSats: 0 })).toThrow(
            expect.objectContaining({ reason: "invoice_amount_mismatch" }),
        );
        expect(() => verify({ amountSats: 5_001 })).toThrow(
            expect.objectContaining({ reason: "invoice_amount_mismatch" }),
        );
    });

    // NaN fails every comparison, so an unchecked one would sail through both
    // this function's expiry arithmetic and assertReceivable's two gates.
    it("refuses a non-finite expiry, which would disarm every gate downstream", () => {
        for (const expiresAt of [NaN, Infinity, -Infinity]) {
            expect(() => verify({ expiresAt })).toThrow(
                expect.objectContaining({ reason: "invoice_undecodable" }),
            );
        }
        expect(() => verify({ amountSats: NaN })).toThrow(
            expect.objectContaining({ reason: "invoice_amount_mismatch" }),
        );
    });

    // The wire is JSON: `valid_until` is typed number here but nothing
    // typechecks the solver's payload, and it is the other operand of the min.
    it("refuses a quote whose valid_until is not a finite number", () => {
        const malformed = { ...quote, valid_until: "soon" as unknown as number };
        expect(() =>
            verifyReceiveInvoice({
                invoice: "lnbcrt49u1p...",
                decode: (raw) => ({
                    raw,
                    paymentHash: PAYMENT_HASH,
                    amountSats: 5_000,
                    expiresAt: INVOICE_EXPIRES_AT,
                }),
                paymentHash: PAYMENT_HASH,
                quote: malformed,
            }),
        ).toThrow(expect.objectContaining({ reason: "quote_malformed" }));
    });

    it("blames the solver for an undecodable invoice", () => {
        expect(() =>
            verify({}, () => {
                throw new Error("bad checksum");
            }),
        ).toThrow(
            expect.objectContaining({
                reason: "invoice_undecodable",
                // the decoder's own cause is surfaced, not swallowed
                message: expect.stringContaining("bad checksum"),
            }),
        );
    });
});

describe("assertReceivable", () => {
    const quote = (over: Partial<RfqQuote> = {}): RfqQuote =>
        ({
            v: 1,
            type: "rfq_quote",
            rfq_id: RFQ_ID,
            pair: LIGHTNING_RECEIVE_PAIR,
            from_amount: 5_000,
            to_amount: 4_950,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {},
            ...over,
        }) as RfqQuote;

    it("passes a live quote whose refund leaves room to claim", () => {
        assertReceivable({ quote: quote(), payDeadline: INVOICE_EXPIRES_AT, now: NOW });
    });

    it("refuses once the pay deadline has passed", () => {
        expect(() => assertReceivable({ quote: quote(), payDeadline: NOW, now: NOW })).toThrow(
            expect.objectContaining({ reason: "quote_expired" }),
        );
    });

    // Unreachable through requestLightningReceive — deriveLightningReceive
    // refuses the missing binding field first — but this is exported, so the
    // standalone call has to hold its own.
    it("refuses a quote carrying no refund_locktime", () => {
        expect(() =>
            assertReceivable({
                quote: quote({ refund_locktime: undefined }),
                payDeadline: INVOICE_EXPIRES_AT,
                now: NOW,
            }),
        ).toThrow(expect.objectContaining({ reason: "missing_refund_locktime" }));
    });

    // Measured from the pay deadline, not from now: the payer can pay at the
    // last moment and the claim window is what remains after that. Both sides
    // of the floor are pinned, so a `<` that slips to `<=` fails here.
    it("refuses when a last-moment payment would leave no claim window", () => {
        expect(() =>
            assertReceivable({
                quote: quote({ refund_locktime: INVOICE_EXPIRES_AT + 1_799 }),
                payDeadline: INVOICE_EXPIRES_AT,
                now: NOW,
            }),
        ).toThrow(expect.objectContaining({ reason: "claim_window_too_short" }));
        assertReceivable({
            quote: quote({ refund_locktime: INVOICE_EXPIRES_AT + 1_800 }),
            payDeadline: INVOICE_EXPIRES_AT,
            now: NOW,
        });
    });

    it("applies maxPayAmount to from_amount only when given", () => {
        assertReceivable({
            quote: quote(),
            payDeadline: INVOICE_EXPIRES_AT,
            now: NOW,
            maxPayAmount: 5_000,
        });
        expect(() =>
            assertReceivable({
                quote: quote(),
                payDeadline: INVOICE_EXPIRES_AT,
                now: NOW,
                maxPayAmount: 4_999,
            }),
        ).toThrow(expect.objectContaining({ reason: "price_too_high" }));
    });

    // Each of these would otherwise delete the gate it belongs to rather than
    // fail it: every comparison against a non-finite number is false.
    it("refuses a non-finite input instead of silently dropping its gate", () => {
        expect(() => assertReceivable({ quote: quote(), payDeadline: NaN, now: NOW })).toThrow(
            expect.objectContaining({ reason: "quote_malformed" }),
        );
        expect(() =>
            assertReceivable({
                quote: quote({ refund_locktime: NaN }),
                payDeadline: INVOICE_EXPIRES_AT,
                now: NOW,
            }),
        ).toThrow(expect.objectContaining({ reason: "quote_malformed" }));
        expect(() =>
            assertReceivable({
                quote: quote(),
                payDeadline: INVOICE_EXPIRES_AT,
                now: NOW,
                maxPayAmount: NaN,
            }),
        ).toThrow(expect.objectContaining({ reason: "invalid_gate_input" }));
        expect(() =>
            assertReceivable({
                quote: quote(),
                payDeadline: INVOICE_EXPIRES_AT,
                now: NOW,
                minClaimWindowSeconds: NaN,
            }),
        ).toThrow(expect.objectContaining({ reason: "invalid_gate_input" }));
        // a NaN clock would leave `now >= payDeadline` false and pass an
        // expired quote through
        expect(() =>
            assertReceivable({ quote: quote(), payDeadline: INVOICE_EXPIRES_AT, now: NaN }),
        ).toThrow(expect.objectContaining({ reason: "invalid_gate_input" }));
    });
});

/** A wallet backed by the real allocator and the real deterministic signer. */
const hdWallet = async (
    createContract: () => Promise<unknown> = async () => ({}),
): Promise<IWallet> => {
    const identity = MnemonicIdentity.fromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        { isMainnet: false },
    );
    const provider = await HDDescriptorProvider.create(identity, new InMemoryWalletRepository());
    return {
        identity,
        getAddress: async () => PAYOUT_ADDRESS,
        getContractManager: async () => ({ createContract }),
        getCurrentSigningDescriptor: () => provider.getCurrentSigningDescriptor(),
        getNextSigningDescriptor: () => provider.getNextSigningDescriptor(),
        getUsedSigningDescriptors: async () => [],
        advanceSigningDescriptorWatermark: async () => {},
        signerForDescriptor: async (descriptor: string) =>
            new DescriptorIdentity({ descriptor, signer: provider, base: identity }),
    } as unknown as IWallet;
};

/** The full flow with the solver's answers under test control. The decoder
 * echoes the hash the request actually carried, so a test that overrides
 * nothing is a well-behaved solver; `createContract` doubles as the marker for
 * how far the call got before throwing. */
const lightningReceiveFlow = async (
    over: {
        quote?: { from?: number; to?: number; profile?: Record<string, unknown> };
        invoice?: Partial<InvoiceFacts>;
        decode?: (bolt11: string) => InvoiceFacts;
        maxPayAmount?: number;
        register?: () => Promise<unknown>;
        /** Reuse a wallet across flows, to observe what a second call
         * allocates. Carries its own writer, so `register` does not apply. */
        wallet?: IWallet;
    } = {},
) => {
    const createContract = vi.fn(over.register ?? (async () => ({})));
    const wallet = over.wallet ?? (await hdWallet(createContract));
    const seen: { paymentHash?: string; payoutPubkey?: string; claimPacket?: unknown } = {};
    const transport: RfqTransport = {
        async requestQuote(payload) {
            const profile = (payload as { profile: Record<string, unknown> }).profile;
            seen.paymentHash = profile.payment_hash as string;
            seen.payoutPubkey = profile.payout_pubkey as string;
            seen.claimPacket = profile.claim_packet;
            return receiveQuote(payload, { from: 5_000, to: 4_950, ...over.quote });
        },
        async status() {
            return null;
        },
        async close() {},
    };
    const decode =
        over.decode ??
        ((raw: string): InvoiceFacts => ({
            raw,
            paymentHash: seen.paymentHash!,
            amountSats: 5_000,
            expiresAt: INVOICE_EXPIRES_AT,
            ...over.invoice,
        }));
    return {
        wallet,
        seen,
        createContract,
        run: () =>
            requestLightningReceive(wallet, "http://ark", transport, {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                amount: 5_000,
                amountSide: "from",
                covclaimdPubkey: COVCLAIMD_PK,
                decodeInvoice: decode,
                maxPayAmount: over.maxPayAmount,
            }),
    };
};

describe("requestLightningReceive on an HD wallet", () => {
    it("commits to the derived preimage, seals the packet to covclaimd, and returns the hold invoice to pay", async () => {
        const flow = await lightningReceiveFlow();
        const result = await flow.run();

        expect(result.payAmount).toBe(5_000);
        // What the claim gate compares against is the side that LANDS.
        expect(result.expectedAmount).toBe(4_950);
        expect(result.invoice).toBe("lnbcrt49u1p...");
        // Absolute, so this pins exactly rather than tolerating drift between
        // module load (NOW) and the clock requestLightningReceive captures.
        expect(result.invoiceExpiresAt).toBe(INVOICE_EXPIRES_AT);
        // The quote was requested against sha256 of the derived preimage, and
        // the covenant's receiver key is the allocated one.
        const preimage = await contractPreimage(
            flow.wallet,
            result.secrets.descriptor,
            result.secrets.preimage,
        );
        expect(flow.seen.paymentHash).toBe(paymentHashOf(preimage));
        expect(flow.seen.payoutPubkey).toBe(hex.encode(result.payoutPubkey));
        // The wire carries the sealed packet string, never an object.
        expect(typeof flow.seen.claimPacket).toBe("string");
        // Nothing secret leaves the function.
        expect(result).not.toHaveProperty("preimage");
    });

    it("refuses a quote that repriced the fixed side", async () => {
        // The request says from=5_000; the quote answers from=4_999.
        const flow = await lightningReceiveFlow({ quote: { from: 4_999, to: 4_900 } });
        await expect(flow.run()).rejects.toThrow(/does not match the requested/);
    });

    // The one attack with no on-chain trace: the payer pays an invoice on
    // another hash and no lockup on ours is ever funded.
    it("refuses an invoice on another payment hash, before anything is registered", async () => {
        const flow = await lightningReceiveFlow({ invoice: { paymentHash: "ff".repeat(32) } });
        await expect(flow.run()).rejects.toMatchObject({ reason: "invoice_hash_mismatch" });
        expect(flow.createContract).not.toHaveBeenCalled();
    });

    it("a record built from the result rebuilds the covenant the solver must fund", async () => {
        // The receive leg's half of `rfqDerivedSecrets`'s send-leg round trip:
        // what the entrypoint hands back must survive the hand-written hop into
        // `RfqSwapOrigin` and rebuild the same covenant. `expectedAmount` and
        // `preimageHex` ride along because neither is re-derivable at claim time.
        const result = await (await lightningReceiveFlow()).run();
        const t = result.treeParams;

        const record = createRfqSwapRecord(
            {
                kind: "lightning_receive",
                solverPubkey: hex.encode(t.solverPubkey),
                emulatorPubkey: hex.encode(t.emulatorPubkey),
                serverPubkey: hex.encode(t.serverPubkey),
                paymentHash: t.paymentHash,
                refundLocktime: t.refundLocktime,
                claimDelay: t.claimDelay,
                payoutPubkey: hex.encode(t.payoutPubkey),
                payoutPkScript: hex.encode(t.payoutPkScript),
                solverRefundPkScript: hex.encode(t.solverRefundPkScript),
                payoutAddress: result.payoutAddress,
                expectedAmount: result.expectedAmount,
                signingDescriptor: result.secrets.descriptor,
                ...(result.secrets.mustPersistPreimage
                    ? { preimageHex: hex.encode(result.secrets.preimage) }
                    : {}),
                lockupAddress: result.address,
                amount: result.payAmount,
            },
            {
                kind: "lightning_receive",
                rfqId: result.rfqId,
                state: "pending",
                lockupPkScript: result.swapPkScript,
                paymentHash: t.paymentHash,
                refundLocktime: t.refundLocktime,
                expectedAmount: result.expectedAmount,
                createdAt: 1,
                updatedAt: 1,
            },
        );

        const rebuilt = rebuildRfqSwap(record) as LightningReceiveSwap;
        expect(hex.encode(rebuilt.lockupPkScript)).toBe(hex.encode(result.swapPkScript));
        expect(rebuilt.expectedAmount).toBe(4_950);
        // an HD wallet re-derives P from the seed, so nothing secret is stored
        expect(record.preimageHex).toBeUndefined();
    });

    it("refuses an amountless invoice and one above from_amount", async () => {
        await expect(
            (await lightningReceiveFlow({ invoice: { amountSats: 0 } })).run(),
        ).rejects.toMatchObject({
            reason: "invoice_amount_mismatch",
        });
        await expect(
            (await lightningReceiveFlow({ invoice: { amountSats: 5_001 } })).run(),
        ).rejects.toMatchObject({ reason: "invoice_amount_mismatch" });
    });

    it("surfaces a decoder failure as a solver-blaming error", async () => {
        const flow = await lightningReceiveFlow({
            decode: () => {
                throw new Error("bad checksum");
            },
        });
        await expect(flow.run()).rejects.toMatchObject({ reason: "invoice_undecodable" });
    });

    it("reports the pay deadline as the earlier of the invoice and the quote", async () => {
        const early = await (await lightningReceiveFlow()).run();
        expect(early.invoiceExpiresAt).toBe(INVOICE_EXPIRES_AT);

        const late = await (
            await lightningReceiveFlow({ invoice: { expiresAt: VALID_UNTIL + 3_600 } })
        ).run();
        expect(late.invoiceExpiresAt).toBe(VALID_UNTIL);
    });

    it("enforces maxPayAmount only when the caller sets one", async () => {
        const capped = await lightningReceiveFlow({ maxPayAmount: 4_999 });
        await expect(capped.run()).rejects.toMatchObject({ reason: "price_too_high" });
        expect(capped.createContract).not.toHaveBeenCalled();

        const allowed = await lightningReceiveFlow({ maxPayAmount: 5_000 });
        expect((await allowed.run()).payAmount).toBe(5_000);
    });

    it("carries the covenant beside the address when registration fails", async () => {
        const flow = await lightningReceiveFlow({
            register: async () => {
                throw new Error("repository unavailable");
            },
        });
        const error = (await flow.run().catch((e: unknown) => e)) as LockupRegistrationFailed;

        expect(error).toBeInstanceOf(LockupRegistrationFailed);
        expect(error.cause).toMatchObject({ message: "repository unavailable" });
        // Both halves of `registerLockupContract`'s call travel together, so a
        // holder of the record can retry the write without a quote.
        expect(error.script.address("tark", SERVER).encode()).toBe(error.address);
        // The invoice must be unreachable, not merely discouraged: a payer who
        // pays into an unwatched lockup loses the payment.
        expect(error).not.toHaveProperty("invoice");
        expect(error.message).not.toContain("lnbcrt");
    });

    it("derives a fresh payment hash per call, so starting over cannot reuse H", async () => {
        const wallet = await hdWallet();
        const first = await lightningReceiveFlow({ wallet });
        await first.run();
        const second = await lightningReceiveFlow({ wallet });
        await second.run();

        expect(first.seen.paymentHash).toBeDefined();
        expect(second.seen.paymentHash).not.toBe(first.seen.paymentHash);
    });
});

describe("requestOnchainReceive on an HD wallet", () => {
    it("returns the locally-derived L1 HTLC to fund, with secrets persisted-able", async () => {
        const wallet = await hdWallet();
        const seen: { paymentHash?: string } = {};
        const transport: RfqTransport = {
            async requestQuote(payload) {
                const profile = (payload as { profile: Record<string, unknown> }).profile;
                seen.paymentHash = profile.payment_hash as string;
                const script = receiveVtxoScript({
                    solverPubkey: SOLVER,
                    refundLocktime: REFUND_LOCKTIME,
                    serverPubkey: SERVER,
                    paymentHash: seen.paymentHash!,
                    claimDelay: 4096,
                    emulatorPubkey: EMULATOR_PUBKEY,
                    solverRefundPkScript: SOLVER_REFUND_PK_SCRIPT,
                    payoutPubkey: hex.decode(profile.payout_pubkey as string),
                    payoutPkScript: ArkAddress.decode(PAYOUT_ADDRESS).pkScript,
                });
                const htlc = onchainHtlcScript(
                    {
                        paymentHash: seen.paymentHash!,
                        claimKey: HTLC_CLAIM_PUBKEY,
                        refundKey: L1_REFUND_PUBKEY,
                        refundLocktime: HTLC_LOCKTIME,
                    },
                    "regtest",
                );
                return {
                    v: 1,
                    type: "rfq_quote",
                    rfq_id: payload.rfq_id as string,
                    pair: ONCHAIN_RECEIVE_PAIR,
                    from_amount: 100_000,
                    to_amount: 99_000,
                    solver_pubkey: hex.encode(SOLVER),
                    valid_until: VALID_UNTIL,
                    refund_locktime: REFUND_LOCKTIME,
                    profile: {
                        payment_hash: seen.paymentHash,
                        claim_pubkey: hex.encode(HTLC_CLAIM_PUBKEY),
                        htlc_locktime: HTLC_LOCKTIME,
                        htlc_address: htlc.address,
                        min_confirmations: 2,
                        lockup_address: script.address("tark", SERVER).encode(),
                        solver_refund_pk_script: hex.encode(SOLVER_REFUND_PK_SCRIPT),
                    },
                } satisfies RfqQuote;
            },
            async status() {
                return null;
            },
            async close() {},
        };

        const result = await requestOnchainReceive(wallet, "http://ark", transport, {
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            amount: 100_000,
            amountSide: "from",
            refundPubkey: L1_REFUND_PUBKEY,
            covclaimdPubkey: COVCLAIMD_PK,
        });

        expect(result.fundAmount).toBe(100_000);
        expect(result.expectedAmount).toBe(99_000);
        expect(result.htlc.address).toMatch(/^bcrt1p/);
        const preimage = await contractPreimage(
            wallet,
            result.secrets.descriptor,
            result.secrets.preimage,
        );
        expect(seen.paymentHash).toBe(paymentHashOf(preimage));
    });
});
