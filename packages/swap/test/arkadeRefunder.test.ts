/**
 * The `refundArkade` callback the manager is meant to be wired to.
 *
 * The three semantic rules are the point: an empty lockup is `null` rather
 * than a failure, and both typed refusals reach the manager intact — one it
 * reads as permanent, one it surfaces as `needs_recovery`. A factory that
 * caught either would turn a state the trader must act on into a retry.
 */
import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CSVMultisigTapscript, SingleKey, Transaction, type IWallet } from "@arkade-os/sdk";

import { lightningSendContract } from "../src/rfq";
import { arkadeRefunder } from "../src/arkadeRefunder";
import { RefundNotLocallyPossibleError } from "../src/refundBlocked";
import { LockupNeedsRecoveryError, type RefundOperatorProvider } from "../src/refund";
import { InMemoryAssetSwapRepository } from "../src/repository";
import type { RfqSwapRecord } from "../src/rfqRecord";
import type { LightningSendSwap } from "../src/swapManager";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);
const REFUND_LOCKTIME = 1_800_000_000;
const SENDER = SingleKey.fromPrivateKey(priv(13));
const PAYMENT_HASH = hex.encode(sha256(new Uint8Array(32).fill(7)));

const LOCKUP = lightningSendContract({
    solverPubkey: key(1),
    operatorPubkey: key(3),
    paymentHash: PAYMENT_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: 4096,
    emulatorPubkey: key(9),
    refundPkScript: p2tr(key(5)),
    senderPubkey: key(13),
    receiverPkScript: p2tr(key(1)),
});

const CHECKPOINT_TAPSCRIPT = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(144) },
        pubkeys: [key(3)],
    }).script,
);

const fakeArk = (): RefundOperatorProvider =>
    ({
        getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }),
        submitTx: async (tx: string, checkpoints: string[]) => ({
            arkTxid: Transaction.fromPSBT(base64.decode(tx)).id,
            finalArkTx: tx,
            signedCheckpointTxs: checkpoints,
        }),
        finalizeTx: async () => {},
    }) as unknown as RefundOperatorProvider;

/** The lockup as the indexer reports it: `getVtxos` is asked twice, once per
 * filter, and only the spendable half answers unless a test says otherwise. */
const fakeIndexer = (over: { spendable?: unknown[]; recoverable?: unknown[] } = {}) =>
    ({
        getVtxos: async (opts?: { spendableOnly?: boolean; recoverableOnly?: boolean }) => ({
            vtxos: opts?.spendableOnly
                ? (over.spendable ?? [])
                : opts?.recoverableOnly
                  ? (over.recoverable ?? [])
                  : [],
        }),
    }) as never;

const FUNDED = [{ txid: "11".repeat(32), vout: 0, value: 60_000 }];

const walletFor = (identity = SENDER) => ({ identity }) as unknown as IWallet;

const swap = (): LightningSendSwap =>
    ({
        rfqId: RFQ_ID,
        kind: "lightning_send",
        state: "pending",
        lockupPkScript: LOCKUP.pkScript,
        lockup: { script: LOCKUP, address: "ark1lockup" },
        paymentHash: PAYMENT_HASH,
        refundLocktime: REFUND_LOCKTIME,
        createdAt: 1,
        updatedAt: 1,
    }) as LightningSendSwap;

const record = async (over: Partial<RfqSwapRecord> = {}): Promise<RfqSwapRecord> => ({
    rfqId: RFQ_ID,
    kind: "lightning_send",
    state: "pending",
    lockupAddress: "ark1lockup",
    profile: {
        signer: { signingDescriptor: `tr(${hex.encode(await SENDER.xOnlyPublicKey())})` },
        hashlock: { paymentHash: PAYMENT_HASH },
    },
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const refunderWith = async (
    input: {
        indexer?: ReturnType<typeof fakeIndexer>;
        stored?: RfqSwapRecord | null;
        wallet?: IWallet;
    } = {},
) => {
    const repository = new InMemoryAssetSwapRepository();
    const stored = input.stored === null ? undefined : (input.stored ?? (await record()));
    if (stored) await repository.saveRfqSwap(stored);
    return arkadeRefunder({
        operator: fakeArk(),
        indexer: input.indexer ?? fakeIndexer({ spendable: FUNDED }),
        wallet: input.wallet ?? walletFor(),
        repository,
    });
};

describe("arkadeRefunder", () => {
    it("pushes refundWithoutReceiver and reports the txid and amount", async () => {
        const refund = await refunderWith();
        const result = await refund(swap());

        expect(result?.amount).toBe(60_000);
        expect(result?.txid).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns null for an empty lockup, which is not a failure", async () => {
        const refund = await refunderWith({ indexer: fakeIndexer() });
        await expect(refund(swap())).resolves.toBeNull();
    });

    it("lets RefundNotLocallyPossibleError through when the record names no key", async () => {
        const refund = await refunderWith({ stored: await record({ profile: {} }) });
        await expect(refund(swap())).rejects.toThrow(RefundNotLocallyPossibleError);
    });

    it("reports a record the store never saw as permanent, not as something to retry", async () => {
        const refund = await refunderWith({ stored: null });
        await expect(refund(swap())).rejects.toMatchObject({
            name: "RefundNotLocallyPossibleError",
            reason: "no-secrets",
        });
    });

    it("lets RefundNotLocallyPossibleError through for another wallet's key", async () => {
        const refund = await refunderWith({ wallet: walletFor(SingleKey.fromRandomBytes()) });
        await expect(refund(swap())).rejects.toMatchObject({ reason: "foreign-descriptor" });
    });

    it("lets LockupNeedsRecoveryError through instead of retrying the window away", async () => {
        const refund = await refunderWith({
            indexer: fakeIndexer({ recoverable: FUNDED }),
        });
        await expect(refund(swap())).rejects.toThrow(LockupNeedsRecoveryError);
    });

    it("refuses a swap carrying no covenant rather than building a refund from the pkScript", async () => {
        const refund = await refunderWith();
        const { lockup: _dropped, ...bare } = swap();
        await expect(refund(bare as LightningSendSwap)).rejects.toThrow(/no lockup covenant/);
    });
});
