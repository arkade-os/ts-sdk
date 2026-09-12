/**
 * `requestOnchainSend` returns `fundAmount: quote.from_amount` verbatim, so a
 * quote naming a different amount than the request is funded at the solver's
 * number. `requestLightningSend` compares against the invoice instead.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, SingleKey, type IWallet } from "@arkade-os/sdk";
import {
    ONCHAIN_SEND_PAIR,
    lightningSendContract,
    requestOnchainSend,
    type RfqQuote,
    type RfqTransport,
} from "../src/rfq";
import { onchainHtlcScript } from "../src/onchainHtlc";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const SERVER = key(3);
const SOLVER = key(1);
const RECEIVER_PK_SCRIPT = p2tr(key(1));
const EMULATOR_PUBKEY_HEX = "02" + hex.encode(key(9));
const PAYOUT_PUBKEY = key(15);
const HTLC_PUBKEY = key(11);
const REFUND_ADDRESS = new ArkAddress(SERVER, key(21), "tark").encode();
const WALLET_KEY = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

/** The server info the entrypoint reads off the wallet's own connection —
 * one object, so the covenant derived in-flow and the one the transport stub
 * builds from SERVER cannot drift. */
const ARK_INFO = {
    signerPubkey: hex.encode(SERVER),
    unilateralExitDelay: 4096,
    network: "regtest",
};

const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 3600;
const REFUND_LOCKTIME = NOW + 60 * 24 * 3600;
const HTLC_LOCKTIME = NOW + 30 * 24 * 3600;

const wallet = (): IWallet =>
    ({
        identity: SingleKey.fromHex(WALLET_KEY),
        getAddress: async () => REFUND_ADDRESS,
        getArkadeInfo: async () => ARK_INFO,
        getContractManager: async () => ({ createContract: async () => ({}) }),
    }) as unknown as IWallet;

/**
 * Quotes exactly the two amounts it is given, and derives the rest to match
 * whatever the caller sent — so the ONLY thing a test varies is the pricing,
 * and every other gate in the flow still passes.
 */
const quoting = (fromAmount: number, toAmount: number): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const paymentHash = profile.payment_hash as string;
        const lockup = lightningSendContract({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            operatorPubkey: SERVER,
            paymentHash,
            claimDelay: 4096,
            emulatorPubkey: key(9),
            senderPubkey: hex.decode(profile.client_refund_pubkey as string),
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
        });
        const htlc = onchainHtlcScript(
            {
                paymentHash,
                claimKey: PAYOUT_PUBKEY,
                refundKey: HTLC_PUBKEY,
                refundLocktime: HTLC_LOCKTIME,
            },
            "regtest",
        );
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: ONCHAIN_SEND_PAIR,
            from_amount: fromAmount,
            to_amount: toAmount,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                lockup_address: lockup.address("tark", SERVER).encode(),
                htlc_pubkey: hex.encode(HTLC_PUBKEY),
                htlc_locktime: HTLC_LOCKTIME,
                htlc_address: htlc.address,
                min_confirmations: 2,
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

const send = (transport: RfqTransport, amount: number, amountSide: "from" | "to") =>
    requestOnchainSend(wallet(), transport, {
        amount,
        amountSide,
        payoutPubkey: PAYOUT_PUBKEY,
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
    });

describe("requestOnchainSend prices the trade that was asked for", () => {
    it("funds the quoted from_amount when the quote matches the request", async () => {
        const result = await send(quoting(101_000, 100_000), 100_000, "to");
        expect(result.quote.to_amount).toBe(100_000);
        expect(result.fundAmount).toBe(101_000);
    });

    it("refuses an exact-out quote that pays out less than was asked for", async () => {
        // The shape the old fixtures encoded, unnoticed by eleven tests.
        await expect(send(quoting(100_000, 99_000), 100_000, "to")).rejects.toThrow(
            /to_amount 99000 does not match the requested 100000/,
        );
    });

    it("refuses an exact-in quote that takes in more than was offered", async () => {
        await expect(send(quoting(120_000, 100_000), 100_000, "from")).rejects.toThrow(
            /from_amount 120000 does not match the requested 100000/,
        );
    });

    it("refuses a quote that pays out more than it takes in", async () => {
        // Not generosity: a negative spread describes some other trade.
        await expect(send(quoting(100_000, 100_001), 100_001, "to")).rejects.toThrow(
            /pays out more than it takes in/,
        );
    });

    it("refuses BEFORE the covenant is registered, so nothing is left to fund", async () => {
        const rows: unknown[] = [];
        const registering = {
            identity: SingleKey.fromHex(WALLET_KEY),
            getAddress: async () => REFUND_ADDRESS,
            getArkadeInfo: async () => ARK_INFO,
            getContractManager: async () => ({
                createContract: async (row: unknown) => {
                    rows.push(row);
                    return {};
                },
            }),
        } as unknown as IWallet;

        await expect(
            requestOnchainSend(registering, quoting(100_000, 99_000), {
                amount: 100_000,
                amountSide: "to",
                payoutPubkey: PAYOUT_PUBKEY,
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
            }),
        ).rejects.toThrow(/does not match the requested/);
        expect(rows).toEqual([]);
    });
});
