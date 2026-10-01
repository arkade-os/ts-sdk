import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { SigHash, Transaction } from "@scure/btc-signer";
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
    "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac";

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

/** The same VTXO after a unilateral exit: onchain now, but nothing spent it. */
function exitedCashVtxo(cashPkScript: string): VirtualCoin {
    return { ...spentCashVtxo(cashPkScript), isSpent: false, isUnrolled: true };
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
function pendingSweep(
    cash: ArkadeCash,
    destinationPkScript: Uint8Array,
    txid = CASH_TXID,
    serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(CHECKPOINT_TAPSCRIPT)),
) {
    const cashScript = cash.vtxoScript;
    const offchainTx = buildOffchainTx(
        [
            {
                txid,
                vout: 0,
                value: CASH_VALUE,
                tapLeafScript: cashScript.forfeit(),
                tapTree: cashScript.encode(),
            },
        ],
        [{ script: destinationPkScript, amount: BigInt(CASH_VALUE) }],
        serverUnrollScript,
    );

    return {
        arkTxid: "b".repeat(64),
        finalArkTx: base64.encode(offchainTx.arkTx.toPSBT()),
        signedCheckpointTxs: offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    };
}

/** A checkpoint unroll script under a server key this wallet does not use. */
function foreignUnrollScript() {
    return CSVMultisigTapscript.encode({
        ...CSVMultisigTapscript.decode(hex.decode(CHECKPOINT_TAPSCRIPT)).params,
        pubkeys: [new Uint8Array(32).fill(9)],
    });
}

const makeCash = () =>
    ArkadeCash.generate(
        hex.decode(SERVER_PUBKEY_HEX).slice(1),
        { type: "blocks", value: 144n },
        "tarkcash",
    );

describe("claimCash drain-pending accounting", () => {
    // A server-returned checkpoint is signed here in place, so it must declare
    // SIGHASH_DEFAULT like the ones we build.
    it("refuses to sign a pending checkpoint declaring another sighash type", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn();

        const wallet = await makeWallet(cashIndexer(cashPkScript, [spentCashVtxo(cashPkScript)]), {
            getPendingTxs,
            finalizeTx,
        });

        const myPkScript = ArkAddress.decode(await wallet.getAddress()).pkScript;
        const sweep = pendingSweep(cash, myPkScript);
        sweep.signedCheckpointTxs = sweep.signedCheckpointTxs.map((c) => {
            const tx = Transaction.fromPSBT(base64.decode(c));
            tx.updateInput(0, { sighashType: SigHash.ALL });
            return base64.encode(tx.toPSBT());
        });
        getPendingTxs.mockResolvedValue([sweep]);

        const result = await wallet.claimCash(cash.toString());

        expect(finalizeTx).not.toHaveBeenCalled();
        expect(result.swept).toBe(0);
    });

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
        getPendingTxs.mockResolvedValue([pendingSweep(cash, myPkScript, drainable[0].txid)]);

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

    // The drain co-signs checkpoints returned by the server, so each one must
    // reconcile with the checkpoint this wallet builds for that VTXO.
    it("leaves a pending tx alone when its checkpoint does not rebuild", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn();

        const wallet = await makeWallet(cashIndexer(cashPkScript, [spentCashVtxo(cashPkScript)]), {
            getPendingTxs,
            finalizeTx,
        });

        const myPkScript = ArkAddress.decode(await wallet.getAddress()).pkScript;
        // Same VTXO, but a checkpoint locked to a different server key: its
        // output script — and so its txid — is not the one we build.
        getPendingTxs.mockResolvedValue([
            pendingSweep(cash, myPkScript, CASH_TXID, foreignUnrollScript()),
        ]);

        const result = await wallet.claimCash(cash.toString());

        expect(finalizeTx).not.toHaveBeenCalled();
        expect(result.swept).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "already-spent" },
        ]);
    });

    it("finalizes a checkpoint built under a deprecated signer", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn();

        // The sweep was submitted before a signer rotation, so its checkpoint
        // is locked to the now-deprecated key.
        const deprecated = hex.encode(new Uint8Array(32).fill(3));
        const wallet = await makeWallet(cashIndexer(cashPkScript, [spentCashVtxo(cashPkScript)]), {
            getPendingTxs,
            finalizeTx,
            getInfo: vi.fn(async () => ({
                ...info,
                deprecatedSigners: [{ pubkey: deprecated, cutoffDate: 0n }],
            })),
        });

        const myPkScript = ArkAddress.decode(await wallet.getAddress()).pkScript;
        getPendingTxs.mockResolvedValue([
            pendingSweep(
                cash,
                myPkScript,
                CASH_TXID,
                CSVMultisigTapscript.encode({
                    ...CSVMultisigTapscript.decode(hex.decode(CHECKPOINT_TAPSCRIPT)).params,
                    pubkeys: [hex.decode(deprecated)],
                }),
            ),
        ]);

        await wallet.claimCash(cash.toString());

        expect(finalizeTx).toHaveBeenCalledOnce();
    });

    // An exited output lives onchain: the thin sweep is an offchain spend, so
    // it can only report the coin — and it must say so as `exited`, not as a
    // spend that never happened.
    it("reports an exited VTXO as `exited` and never sweeps it", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const submitTx = vi.fn();
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn(async () => []);

        const wallet = await makeWallet(cashIndexer(cashPkScript, [exitedCashVtxo(cashPkScript)]), {
            getPendingTxs,
            finalizeTx,
            submitTx,
        });

        const result = await wallet.claimCash(cash.toString());

        expect(submitTx).not.toHaveBeenCalled();
        expect(finalizeTx).not.toHaveBeenCalled();
        expect(result.swept).toBe(0);
        expect(result.unclaimed.amount).toBe(CASH_VALUE);
        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "exited" },
        ]);
    });

    // Exit is a location, spend is a fate: a coin carrying both is reported by
    // its fate, so the terminal-spend branch deliberately runs first.
    it("reports an exited VTXO that was also spent as already-spent", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn(async () => []);

        const exitedAndSpent = { ...spentCashVtxo(cashPkScript), isUnrolled: true };
        const wallet = await makeWallet(cashIndexer(cashPkScript, [exitedAndSpent]), {
            getPendingTxs,
            finalizeTx,
        });

        const result = await wallet.claimCash(cash.toString());

        expect(result.swept).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "already-spent" },
        ]);
    });

    // Excluded by state, not by value: the drain finalizes pending sweeps, and
    // no sweep naming an output that already lives onchain can ever close.
    it("keeps an exited VTXO out of the drain proof", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const finalizeTx = vi.fn(async () => {});
        const getPendingTxs = vi.fn(async () => []);

        const healthy = spentCashVtxoAt(cashPkScript, 1);
        const exited = { ...spentCashVtxoAt(cashPkScript, 2), isSpent: false, isUnrolled: true };
        const wallet = await makeWallet(cashIndexer(cashPkScript, [healthy, exited]), {
            getPendingTxs,
            finalizeTx,
        });

        await wallet.claimCash(cash.toString());

        expect(getPendingTxs).toHaveBeenCalledOnce();
        const { proof } = (getPendingTxs.mock.calls as unknown as [{ proof: string }][])[0][0];
        const tx = Transaction.fromPSBT(base64.decode(proof), { allowUnknown: true });
        const inputs = Array.from({ length: tx.inputsLength }, (_, i) =>
            hex.encode(tx.getInput(i).txid!),
        );
        expect(inputs).toContain(healthy.txid);
        expect(inputs).not.toContain(exited.txid);
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
