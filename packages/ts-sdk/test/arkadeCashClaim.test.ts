import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { Wallet, ArkadeCashCreateError } from "../src/wallet/wallet";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { SingleKey } from "../src/identity/singleKey";
import { ArkadeCash } from "../src/arkadeCash";
import { ArkAddress } from "../src/script/address";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { buildOffchainTx } from "../src/utils/arkTransaction";
import type { VirtualCoin } from "../src/wallet";

// claimCash's accounting across the drain-pending path: a claim interrupted
// between submitTx and finalizeTx leaves a pending sweep on the server, and the
// re-run that completes it must report the funds as swept — the VTXO reads back
// spent, so the naive classification calls money this very call just moved
// "unclaimed".

const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CHECKPOINT_TAPSCRIPT =
    "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac";

const info = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
    network: "mutinynet",
    batchExpiry: 144n,
    unilateralExitDelay: 144n,
    boardingExitDelay: 604672n,
    roundInterval: 144n,
    dust: 1000n,
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript: CHECKPOINT_TAPSCRIPT,
    deprecatedSigners: [],
    digest: "d",
    fees: { intentFee: {}, txFeeRate: "0" },
    serviceStatus: {},
    sessionDuration: 3600n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
    version: "1",
};

const CASH_TXID = "a".repeat(64);
const CASH_VALUE = 5000;

function idleOnchain() {
    return {
        getCoins: vi.fn(async () => []),
        getTransactions: vi.fn(async () => []),
        getTxOutspends: vi.fn(async () => []),
        getTxStatus: vi.fn(async () => ({ confirmed: false })),
        getChainTip: vi.fn(async () => ({ height: 0, hash: "", time: 0 })),
        broadcastTransaction: vi.fn(async () => "txid"),
        watchAddresses: vi.fn(async () => () => {}),
    } as never;
}

/** Indexer that only knows about the arkadeCash address. */
function cashIndexer(cashPkScript: string, vtxos: VirtualCoin[]) {
    return {
        getVtxos: vi.fn(async (opts?: { scripts?: string[] }) => ({
            vtxos: opts?.scripts?.includes(cashPkScript) ? vtxos : [],
        })),
        subscribeForScripts: vi.fn(async () => "sub-id"),
        unsubscribeForScripts: vi.fn(async () => {}),
        getSubscription: vi.fn(async function* (_subId: string, abortSignal: AbortSignal) {
            await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) return resolve();
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
        }),
        watchAddresses: vi.fn(async () => () => {}),
    } as never;
}

async function makeWallet(indexerProvider: never, arkProvider: Record<string, unknown>) {
    return Wallet.create({
        identity: SingleKey.fromHex("1".repeat(64)),
        settlementConfig: false,
        arkProvider: { getInfo: vi.fn(async () => info), ...arkProvider } as never,
        indexerProvider,
        onchainProvider: idleOnchain(),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
}

/** The arkadeCash VTXO as it reads back after a sweep was registered: spent. */
function spentCashVtxo(cashPkScript: string): VirtualCoin {
    return {
        txid: CASH_TXID,
        vout: 0,
        value: CASH_VALUE,
        script: cashPkScript,
        status: { confirmed: true },
        virtualStatus: { state: "preconfirmed" },
        isSpent: true,
        createdAt: new Date(),
    } as VirtualCoin;
}

/** A distinct spent arkadeCash VTXO, one per index, all at the same pkScript. */
function spentCashVtxoAt(cashPkScript: string, index: number): VirtualCoin {
    return {
        ...spentCashVtxo(cashPkScript),
        txid: index.toString(16).padStart(64, "0"),
    };
}

/**
 * The pending sweep the crashed claim left on the server: the offchain tx it
 * built and submitted but never finalized, paying `destinationPkScript`.
 */
function pendingSweep(cash: ArkadeCash, destinationPkScript: Uint8Array) {
    const cashScript = cash.vtxoScript;
    const offchainTx = buildOffchainTx(
        [
            {
                txid: CASH_TXID,
                vout: 0,
                value: CASH_VALUE,
                tapLeafScript: cashScript.forfeit(),
                tapTree: cashScript.encode(),
            },
        ],
        [{ script: destinationPkScript, amount: BigInt(CASH_VALUE) }],
        CSVMultisigTapscript.decode(hex.decode(CHECKPOINT_TAPSCRIPT)),
    );

    return {
        arkTxid: "b".repeat(64),
        finalArkTx: base64.encode(offchainTx.arkTx.toPSBT()),
        signedCheckpointTxs: offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    };
}

const makeCash = () =>
    ArkadeCash.generate(
        hex.decode(SERVER_PUBKEY_HEX).slice(1),
        { type: "blocks", value: 144n },
        "tarkcash",
    );

describe("claimCash drain-pending accounting", () => {
    it("reports a drained sweep as swept, not unclaimed", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn();

        const wallet = await makeWallet(cashIndexer(cashPkScript, [spentCashVtxo(cashPkScript)]), {
            getPendingTxs,
            finalizeTx,
        });

        // The crashed claim swept to this very wallet.
        const myPkScript = ArkAddress.decode(await wallet.getAddress()).pkScript;
        getPendingTxs.mockResolvedValue([pendingSweep(cash, myPkScript)]);

        const result = await wallet.claimCash(cash.toString());

        expect(finalizeTx).toHaveBeenCalledOnce();
        expect(result.swept).toBe(CASH_VALUE);
        expect(result.unclaimed.amount).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([]);
    });

    it("does not credit itself a drained sweep that pays someone else", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn();

        const wallet = await makeWallet(cashIndexer(cashPkScript, [spentCashVtxo(cashPkScript)]), {
            getPendingTxs,
            finalizeTx,
        });

        // A different claimer won the race and crashed mid-claim: finalizing
        // their sweep is still correct, but it pays them, not us.
        const stranger = ArkadeCash.generate(
            hex.decode(SERVER_PUBKEY_HEX).slice(1),
            { type: "blocks", value: 144n },
            "tarkcash",
        );
        getPendingTxs.mockResolvedValue([pendingSweep(cash, stranger.vtxoScript.pkScript)]);

        const result = await wallet.claimCash(cash.toString());

        expect(finalizeTx).toHaveBeenCalledOnce();
        expect(result.swept).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "already-spent" },
        ]);
    });

    it("chunks the drain proof into batches of at most 20 inputs", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn();

        // 45 spent inputs → 3 proofs (20 + 20 + 5). Each proof carries the
        // batch's inputs plus the synthetic BIP-322 toSpend reference.
        const drainable = Array.from({ length: 45 }, (_, i) => spentCashVtxoAt(cashPkScript, i));
        const wallet = await makeWallet(cashIndexer(cashPkScript, drainable), {
            getPendingTxs,
            finalizeTx,
        });

        // Every batch surfaces the same pending sweep; dedup by arkTxid must
        // collapse them so the tx is finalized exactly once.
        const myPkScript = ArkAddress.decode(await wallet.getAddress()).pkScript;
        getPendingTxs.mockResolvedValue([pendingSweep(cash, myPkScript)]);

        await wallet.claimCash(cash.toString());

        expect(getPendingTxs).toHaveBeenCalledTimes(3);
        for (const [{ proof }] of getPendingTxs.mock.calls as [{ proof: string }][]) {
            const inputs = Transaction.fromPSBT(base64.decode(proof), {
                allowUnknown: true,
            }).inputsLength;
            expect(inputs).toBeLessThanOrEqual(20 + 1);
        }
        // Same arkTxid across all batches → finalized once, not three times.
        expect(finalizeTx).toHaveBeenCalledOnce();
    });

    it("surfaces the recoverable token when the funding send fails", async () => {
        const wallet = await makeWallet(cashIndexer("x", []), {});

        // send fails after the note may already have been submitted; the token
        // controlling the funded output must not be lost.
        const sendError = new Error("submitted then crashed");
        vi.spyOn(wallet, "send").mockRejectedValue(sendError);

        const err = await wallet
            .createCash(5000)
            .then(() => null)
            .catch((e) => e);

        expect(err).toBeInstanceOf(ArkadeCashCreateError);
        expect(err.cause).toBe(sendError);
        // The carried token round-trips back to a usable arkadeCash note.
        expect(() => ArkadeCash.fromString(err.cash)).not.toThrow();
        expect(err.cash.startsWith("tarkadecash1")).toBe(true);
    });

    it("preserves the empty-input behavior", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn(async () => []);

        // Only a subdust VTXO is present. The indexer keys it by the taproot
        // key and reports it under the P2TR script (never the OP_RETURN form),
        // flagged swept, with a below-dust value. It is excluded from the drain
        // by value, so no proof is ever built or submitted.
        const subdustValue = 500; // < info.dust (1000)
        const subdust: VirtualCoin = {
            ...spentCashVtxo(cashPkScript),
            value: subdustValue,
            isSpent: false,
        };
        const wallet = await makeWallet(cashIndexer(cashPkScript, [subdust]), {
            getPendingTxs,
            finalizeTx,
        });

        const result = await wallet.claimCash(cash.toString());

        expect(getPendingTxs).not.toHaveBeenCalled();
        expect(finalizeTx).not.toHaveBeenCalled();
        expect(result.swept).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: subdustValue, reason: "subdust" },
        ]);
    });
});
