/**
 * The `onchain -> arkade` L1 refund, wired by the drive.
 *
 * The trader funds the HTLC from outside the wallet, so when the solver never funds the Arkade
 * lockup the money only comes back through the HTLC's refund leaf. A client that monitored the
 * swap with nothing able to take that leaf would strand the funding; these tests pin that the
 * drive builds the refund itself, signs it with the key the HTLC was derived with, pays the
 * record's own refund script, and still defers to a caller's callback or to manual mode.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { SingleKey } from "@arkade-os/sdk";
import { createSwapDrive } from "../../src/client/drive";
import { onchainHtlcScript } from "../../src/onchainHtlc";
import { RFQ_CONFIGURATION_REFUSAL } from "../../src/swapManager";
import {
    BEFORE,
    PAYMENT_HASH,
    RECEIVE_LOCKUP,
    corridorRecord,
    fakeContracts,
    fakeCorridors,
    fakeIndexer,
    fakeOperator,
    fakeWallet,
    key,
    memoryRepository,
} from "./driveFixtures";

/** A wallet whose identity key is the HTLC's refund key — TRADER's. */
const TRADER = SingleKey.fromRandomBytes();
/** The HTLC's refund leaf opens here; the fake chain's MTP is past it. */
const HTLC_LOCKTIME = 1_750_000_000;
/** Where the refund pays: the boarding address the quote fixed. */
const REFUND_PK_SCRIPT = Uint8Array.from([0x51, 0x20, ...key(30)]);
const FUNDED = 100_000n;

const onchainReceiveRecord = async (over: { refundDescriptor?: string | null } = {}) => {
    const refundPubkey = await TRADER.xOnlyPublicKey();
    const htlc = onchainHtlcScript(
        {
            paymentHash: PAYMENT_HASH,
            claimKey: key(10),
            refundKey: refundPubkey,
            refundLocktime: HTLC_LOCKTIME,
        },
        "regtest",
    );
    const descriptor =
        over.refundDescriptor === undefined
            ? `tr(${hex.encode(refundPubkey)})`
            : over.refundDescriptor;
    const base = corridorRecord({ kind: "onchain_receive" });
    return {
        htlc,
        record: corridorRecord({
            kind: "onchain_receive",
            route: {
                give: {
                    corridor: "onchain",
                    asset: "bitcoin:regtest/slip44:1",
                    instrument: { kind: "address", address: htlc.address },
                },
                take: base.route.take,
            },
            profile: {
                ...base.profile,
                claimKey: hex.encode(key(10)),
                refundKey: hex.encode(refundPubkey),
                ...(descriptor === null ? {} : { refundDescriptor: descriptor }),
                htlcLocktime: HTLC_LOCKTIME,
                network: "regtest",
                htlcAddress: htlc.address,
                minConfirmations: 1,
                refundPkScript: hex.encode(REFUND_PK_SCRIPT),
            },
        }),
    };
};

/** An L1 view where the trader's funding sits confirmed and the refund leaf has matured. */
const chainWithFunding = (htlc: { pkScript: Uint8Array }) => {
    const broadcasts: string[] = [];
    const chain = {
        getScriptUtxos: async (pkScript: Uint8Array) =>
            hex.encode(pkScript) === hex.encode(htlc.pkScript)
                ? [{ txid: "bb".repeat(32), vout: 0, amount: FUNDED, confirmations: 3 }]
                : [],
        getSpendingTx: async () => null,
        broadcast: async (txHex: string) => {
            broadcasts.push(txHex);
            return "cc".repeat(32);
        },
        getMtp: async () => HTLC_LOCKTIME + 60,
    };
    return { chain, broadcasts };
};

const driveFor = async (
    record: Awaited<ReturnType<typeof onchainReceiveRecord>>["record"],
    corridors: ReturnType<typeof fakeCorridors>,
) => {
    const repository = memoryRepository();
    await repository.saveSwapRecord(record);
    const contracts = fakeContracts([RECEIVE_LOCKUP]);
    const { wallet } = fakeWallet({ contracts, identity: TRADER });
    const drive = createSwapDrive({
        wallet,
        repository,
        corridors,
        network: async () => "regtest",
        operator: fakeOperator(),
        // The solver never funded: no lockup output to read a fate from.
        indexer: fakeIndexer({ vtxos: [] }),
        contracts,
        now: () => BEFORE,
        pollIntervalMs: 10 * 60 * 1000,
    });
    await drive.ready;
    await drive.idle();
    return drive;
};

describe("the wallet-backed default refund", () => {
    it("takes the L1 funding back to the record's refund script, signed by the HTLC's key", async () => {
        const { htlc, record } = await onchainReceiveRecord();
        const { chain, broadcasts } = chainWithFunding(htlc);
        const drive = await driveFor(record, fakeCorridors({ chain, claimFeeRateSatVb: 1 }));

        expect(broadcasts).toHaveLength(1);
        const tx = btc.Transaction.fromRaw(hex.decode(broadcasts[0]!), {
            allowUnknownOutputs: true,
        });
        // The refund leaf, spent after its locktime, to the boarding script the quote fixed.
        expect(tx.lockTime).toBe(HTLC_LOCKTIME);
        expect(hex.encode(tx.getInput(0).txid!)).toBe("bb".repeat(32));
        expect(tx.outputsLength).toBe(1);
        expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(REFUND_PK_SCRIPT));
        expect(tx.getOutput(0).amount).toBeLessThan(FUNDED);
        await drive.dispose();
    });

    it("refuses to sign with a key the HTLC was not derived with", async () => {
        const other = await SingleKey.fromRandomBytes().xOnlyPublicKey();
        const { htlc, record } = await onchainReceiveRecord({
            refundDescriptor: `tr(${hex.encode(other)})`,
        });
        const { chain, broadcasts } = chainWithFunding(htlc);
        const drive = await driveFor(record, fakeCorridors({ chain, claimFeeRateSatVb: 1 }));

        expect(broadcasts).toHaveLength(0);
        // Not terminal: the funding is still the trader's, and a fixed wallet can take it back.
        expect(drive.swap("q1")?.outcome).not.toBe("refunded");
        await drive.dispose();
    });

    it("keeps manual mode when the corridor carries no fee rate", async () => {
        const { htlc, record } = await onchainReceiveRecord();
        const { chain, broadcasts } = chainWithFunding(htlc);
        const drive = await driveFor(record, fakeCorridors({ chain }));

        expect(broadcasts).toHaveLength(0);
        expect(drive.swap("q1")?.outcome).toBe("needs_recovery");
        expect(drive.swap("q1")?.blockedReason).toBe(
            RFQ_CONFIGURATION_REFUSAL.noRefundOnchainCallback,
        );
        await drive.dispose();
    });

    it("prefers the caller's refund callback over the default it would have built", async () => {
        const { htlc, record } = await onchainReceiveRecord();
        const { chain, broadcasts } = chainWithFunding(htlc);
        const refund = vi.fn(async () => ({ txid: "dd".repeat(32) }));
        const drive = await driveFor(
            record,
            fakeCorridors({ chain, refund, claimFeeRateSatVb: 1 }),
        );

        expect(refund).toHaveBeenCalledTimes(1);
        expect(broadcasts).toHaveLength(0);
        await drive.dispose();
    });
});
