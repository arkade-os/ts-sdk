/**
 * The record stores what the CONTRACT ROW cannot tell us, and nothing else.
 *
 * `registerLockupContract` already persists the covenant — every tree
 * parameter, keyed by pkScript — so the properties worth testing are that the
 * rebuild resolves it from there, that a record cannot silently describe a
 * covenant nobody registered, and that no covenant fact is duplicated onto the
 * record where the two could drift apart.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, VHTLCV2ContractHandler } from "@arkade-os/sdk";
import {
    RFQ_SWAP_RETENTION_SECONDS,
    createRfqSwapRecord,
    rebuildRfqSwap,
    rfqSwapCovenant,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type PersistableRfqSwap,
    type RfqSwapContractLookup,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "../src/rfqRecord";
import { lightningSendVtxoScript } from "../src/rfq";
import type { RfqSwapState } from "../src/swapManager";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const SERVER = key(3);
// BIP68 encodes second-based relative timelocks in 512s units and the refund
// tiers stack +512/+1024, so this must be a multiple of 512.
const CLAIM_DELAY = 4096;
const REFUND_LOCKTIME = 1_900_000_000;
const PAYMENT_HASH = "d4".repeat(32);

/** A real covenant, so the row below holds real serialized parameters. */
const script = lightningSendVtxoScript({
    solverPubkey: key(1),
    refundLocktime: REFUND_LOCKTIME,
    serverPubkey: SERVER,
    paymentHash: PAYMENT_HASH,
    claimDelay: CLAIM_DELAY,
    emulatorPubkey: key(9),
    senderPubkey: key(7),
    receiverPkScript: p2tr(key(5)),
    refundPkScript: p2tr(key(21)),
});
const LOCKUP_SCRIPT = hex.encode(script.pkScript);
const LOCKUP_ADDRESS = script.address("tark", SERVER).encode();

/** The row `registerLockupContract` would have written. */
const row = {
    type: "vhtlc-v2",
    script: LOCKUP_SCRIPT,
    address: LOCKUP_ADDRESS,
    params: VHTLCV2ContractHandler.serializeParams(script.options),
};

const contracts = (rows: unknown[] = [row]): RfqSwapContractLookup =>
    ({ getContracts: async () => rows }) as unknown as RfqSwapContractLookup;

const origin: RfqSwapOrigin = {
    kind: "lightning_send",
    lockupScript: LOCKUP_SCRIPT,
    lockupAddress: LOCKUP_ADDRESS,
    paymentHash: PAYMENT_HASH,
    signingDescriptor: `tr(${hex.encode(key(7))})`,
    amount: 25_000,
};

const swapOf = (state: RfqSwapState = "pending", updatedAt = 1_000): PersistableRfqSwap =>
    ({
        kind: "lightning_send",
        rfqId: "rfq-1",
        state,
        lockupPkScript: script.pkScript,
        paymentHash: PAYMENT_HASH,
        refundLocktime: REFUND_LOCKTIME,
        createdAt: 1_000,
        updatedAt,
    }) as PersistableRfqSwap;

const record = (state: RfqSwapState = "pending", updatedAt = 1_000): RfqSwapRecord =>
    createRfqSwapRecord(origin, swapOf(state, updatedAt));

describe("the record duplicates nothing the contract row holds", () => {
    it("carries no tree parameters", () => {
        // The whole point: `registerLockupContract` persisted every one of
        // these, keyed by the same pkScript. A second copy here would be a
        // thing to keep in sync, free to disagree with the contract the wallet
        // is actually watching.
        const stored = Object.keys(record());
        for (const covenantFact of [
            "solverPubkey",
            "serverPubkey",
            "emulatorPubkey",
            "claimDelay",
            "refundLocktime",
            "senderPubkey",
            "refundPkScript",
            "receiverPkScript",
            "payoutPubkey",
            "payoutPkScript",
            "solverRefundPkScript",
        ]) {
            expect(stored, `${covenantFact} belongs to the contract row`).not.toContain(
                covenantFact,
            );
        }
    });

    it("keeps only what the row cannot answer", () => {
        const stored = record();
        expect(stored.paymentHash).toBe(PAYMENT_HASH);
        expect(stored.signingDescriptor).toBe(`tr(${hex.encode(key(7))})`);
        expect(stored.lockupScript).toBe(LOCKUP_SCRIPT);
        expect(stored.rfqId).toBe("rfq-1");
    });

    it("never carries a private key", () => {
        expect(JSON.stringify(record())).not.toContain("senderPrivateKey");
    });
});

describe("rfqSwapCovenant", () => {
    it("resolves the covenant from the registered row", async () => {
        const resolved = await rfqSwapCovenant(contracts(), LOCKUP_SCRIPT);
        expect(hex.encode(resolved.pkScript)).toBe(LOCKUP_SCRIPT);
    });

    it("refuses when no row is registered, rather than inventing one", async () => {
        // A record whose contract was never registered, or whose store was
        // cleared, describes a lockup nothing is watching. Rebuilding it from
        // stored parameters would hide exactly that.
        await expect(rfqSwapCovenant(contracts([]), LOCKUP_SCRIPT)).rejects.toThrow(
            /no registered contract/,
        );
    });
});

describe("rebuildRfqSwap", () => {
    it("rebuilds from the row and reports the covenant's own locktime", async () => {
        const rebuilt = await rebuildRfqSwap(record(), contracts());
        expect(rebuilt.kind).toBe("lightning_send");
        expect(rebuilt.rfqId).toBe("rfq-1");
        expect(hex.encode(rebuilt.lockupPkScript)).toBe(LOCKUP_SCRIPT);
        expect(rebuilt.lockup?.address).toBe(LOCKUP_ADDRESS);
        // read off the covenant, not off the record
        expect(rebuilt.refundLocktime).toBe(REFUND_LOCKTIME);
    });

    it("refuses when the row's covenant is not the address that was funded", async () => {
        // The record's `lockupAddress` is independent of the row, which is what
        // lets the rebuild check itself: a row swapped underneath, or an address
        // stored wrong, otherwise yields a live record watching a covenant
        // nobody funded, and nothing says so until a refund is due.
        const elsewhere = new ArkAddress(SERVER, key(31), "tark").encode();
        await expect(
            rebuildRfqSwap({ ...record(), lockupAddress: elsewhere }, contracts()),
        ).rejects.toThrow(/cannot be spent/);
    });

    it("carries the receive leg's expectedAmount, which is not re-derivable", async () => {
        const receive = createRfqSwapRecord(
            { ...origin, kind: "lightning_receive", expectedAmount: 20_000 },
            {
                ...swapOf(),
                kind: "lightning_receive",
                expectedAmount: 20_000,
            } as PersistableRfqSwap,
        );
        const rebuilt = await rebuildRfqSwap(receive, contracts());
        expect(rebuilt.kind).toBe("lightning_receive");
        expect((rebuilt as { expectedAmount: number }).expectedAmount).toBe(20_000);
    });
});

describe("updateRfqSwapRecord", () => {
    it("clears a field the swap no longer carries, not just sets new ones", () => {
        // The manager deletes `blockedReason` when a swap leaves
        // `needs_counterparty`; a merged update would persist a refusal for a
        // swap that had recovered.
        const blocked = updateRfqSwapRecord(record(), {
            ...swapOf("needs_counterparty"),
            blockedReason: "no secrets on this wallet",
        } as PersistableRfqSwap);
        expect(blocked.blockedReason).toBe("no secrets on this wallet");

        const recovered = updateRfqSwapRecord(blocked, swapOf("pending"));
        expect(recovered.blockedReason).toBeUndefined();
        // and the origin half survives
        expect(recovered.lockupScript).toBe(LOCKUP_SCRIPT);
        expect(recovered.signingDescriptor).toBe(origin.signingDescriptor);
    });
});

describe("shouldRetainRfqSwap", () => {
    it("retains a live swap however old", () => {
        expect(shouldRetainRfqSwap(record("pending", 0), 10 * RFQ_SWAP_RETENTION_SECONDS)).toBe(
            true,
        );
    });

    it("never drops needs_counterparty — the money is still at the lockup", () => {
        expect(
            shouldRetainRfqSwap(record("needs_counterparty", 0), 10 * RFQ_SWAP_RETENTION_SECONDS),
        ).toBe(true);
    });

    it.each(["settled", "refunded", "failed"] as const)("retains %s for 30 days", (state) => {
        expect(shouldRetainRfqSwap(record(state, 0), RFQ_SWAP_RETENTION_SECONDS - 1)).toBe(true);
    });

    it.each(["settled", "refunded", "failed"] as const)("drops %s past 30 days", (state) => {
        expect(shouldRetainRfqSwap(record(state, 0), RFQ_SWAP_RETENTION_SECONDS + 1)).toBe(false);
    });
});
