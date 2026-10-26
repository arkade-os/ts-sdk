import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { Transaction } from "../src/utils/transaction";
import {
    Wallet,
    ArkadeCashCreateError,
    ArkadeCashOperatorMismatchError,
} from "../src/wallet/wallet";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { SingleKey } from "../src/identity/singleKey";
import { ArkadeCash } from "../src/arkadeCash";
import { ArkAddress } from "../src/script/address";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { buildOffchainTx } from "../src/utils/arkTransaction";
import { timelockToSequence } from "../src/utils/timelock";
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
        isSpent: true,
        createdAt: new Date(),
    } as VirtualCoin;
}

/** The same VTXO after a unilateral exit: onchain now, but nothing spent it. */
function exitedCashVtxo(cashPkScript: string): VirtualCoin {
    return { ...spentCashVtxo(cashPkScript), isSpent: false, isUnrolled: true };
}

/** The arkadeCash VTXO the server swept at batch expiry: swept but unspent. */
function sweptCashVtxo(cashPkScript: string): VirtualCoin {
    return {
        txid: CASH_TXID,
        vout: 0,
        value: CASH_VALUE,
        script: cashPkScript,
        status: { confirmed: true },
        virtualStatus: { state: "swept" },
        isSwept: true,
        isSpent: false,
        isUnrolled: false,
        createdAt: new Date(),
    } as VirtualCoin;
}

/** White-box reach for the wallet's keyring (private) in these unit tests. */
function keyringOf(wallet: Wallet) {
    return (
        wallet as unknown as {
            _keyring: { hasKey(d: string): boolean; listKeyringDescriptors(): string[] };
        }
    )._keyring;
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
        "tarkadecash",
    );

const makeCashUnder = (serverPubKey: Uint8Array) =>
    ArkadeCash.generate(serverPubKey, { type: "blocks", value: 144n }, "tarkadecash");

// The token holds the signer its script uses: unknown to the connected operator means the wrong
// operator; in its deprecated list means the same operator after a rotation.
describe("claimCash operator check", () => {
    const FOREIGN_SIGNER = new Uint8Array(32).fill(2);
    const ROTATED_SIGNER = new Uint8Array(32).fill(3);

    it("rejects cash issued under a signer the operator does not advertise, before querying the indexer", async () => {
        const cash = makeCashUnder(FOREIGN_SIGNER);
        const indexer = cashIndexer(hex.encode(cash.vtxoScript.pkScript), []);
        const wallet = await makeWallet(indexer, {});
        const getVtxos = (indexer as unknown as { getVtxos: ReturnType<typeof vi.fn> }).getVtxos;
        getVtxos.mockClear();

        const err = await wallet
            .claimCash(cash.toString())
            .then(() => null)
            .catch((e) => e);

        expect(err).toBeInstanceOf(ArkadeCashOperatorMismatchError);
        expect(err.cashSignerPubKey).toBe(hex.encode(FOREIGN_SIGNER));
        expect(err.activeSignerPubKey).toBe(SERVER_PUBKEY_HEX.slice(2));
        expect(getVtxos).not.toHaveBeenCalled();
    });

    // A second read could land on both sides of a rotation: the check on the old signer set, the
    // sweep's checkpoint on the new one.
    it("checks the operator and builds the sweep from one server-info snapshot", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const unspent = { ...spentCashVtxo(cashPkScript), isSpent: false };
        const getInfo = vi.fn(async () => info);
        const submitTx = vi.fn(async () => {
            throw new Error("rejected");
        });
        const wallet = await makeWallet(cashIndexer(cashPkScript, [unspent]), {
            getInfo,
            getPendingTxs: vi.fn(async () => []),
            submitTx,
        });
        getInfo.mockClear();

        const result = await wallet.claimCash(cash.toString());

        expect(submitTx).toHaveBeenCalledOnce();
        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "sweep-failed" },
        ]);
        expect(getInfo).toHaveBeenCalledOnce();
    });

    // A rotation must not lock the holder out of this operator's cash: before the cutoff it can
    // migrate; after it, once the batch expires and is swept, the claim recovers it.
    it.each([
        ["no cutoff advertised", 0n],
        ["cutoff ahead", BigInt(Math.floor(Date.now() / 1000) + 86_400)],
        ["cutoff passed", 1n],
    ])("claims cash issued under a deprecated signer (%s)", async (_label, cutoffDate) => {
        const cash = makeCashUnder(ROTATED_SIGNER);
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const wallet = await makeWallet(cashIndexer(cashPkScript, [spentCashVtxo(cashPkScript)]), {
            getPendingTxs: vi.fn(async () => []),
            getInfo: vi.fn(async () => ({
                ...info,
                // arkd may send signers compressed; the check compares x-only.
                deprecatedSigners: [{ pubkey: `02${hex.encode(ROTATED_SIGNER)}`, cutoffDate }],
            })),
        });

        const result = await wallet.claimCash(cash.toString());

        expect(result.unclaimed.vtxos).toEqual([
            { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "already-spent" },
        ]);
    });
});

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
            "tarkadecash",
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
            const inputs = Transaction.fromPSBT(base64.decode(proof)).inputsLength;
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
        const tx = Transaction.fromPSBT(base64.decode(proof));
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

describe("claimCash import-for-recovery", () => {
    // Claim a wallet holding a single server-swept arkadeCash VTXO. The kick is
    // stubbed so the import artifacts can be inspected without a live recovery
    // settlement racing the assertions.
    async function claimSwept(cash: ArkadeCash) {
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const wallet = await makeWallet(cashIndexer(cashPkScript, [sweptCashVtxo(cashPkScript)]), {
            getPendingTxs: vi.fn(async () => []),
        });
        const manager = await wallet.getVtxoManager();
        const kick = vi.spyOn(manager, "recoverImportedContracts").mockResolvedValue();
        const result = await wallet.claimCash(cash.toString());
        return { wallet, manager, kick, result, cashPkScript };
    }

    it("imports a swept VTXO for recovery and reports it as recovering", async () => {
        const cash = makeCash();
        const { wallet, kick, result, cashPkScript } = await claimSwept(cash);

        // Reported as recovering, not swept away, not left unclaimed.
        expect(result.swept).toBe(0);
        expect(result.recovering.amount).toBe(CASH_VALUE);
        expect(result.recovering.vtxos).toEqual([{ txid: CASH_TXID, vout: 0, value: CASH_VALUE }]);
        expect(result.unclaimed.vtxos).toEqual([]);

        // Recovery was kicked promptly rather than left to the poll loop.
        expect(kick).toHaveBeenCalledOnce();

        // The arkadeCash key is filed in the keyring, and a signable recovery-only
        // contract was registered at the arkadeCash script.
        const descriptor = `tr(${hex.encode(cash.publicKey)})`;
        expect(keyringOf(wallet).hasKey(descriptor)).toBe(true);
        const cm = await wallet.getContractManager();
        const [contract] = await cm.getContracts({ script: cashPkScript });
        expect(contract.type).toBe("default");
        expect(contract.metadata?.signingDescriptor).toBe(descriptor);
        expect(contract.metadata?.recoveryOnly).toBe(true);
    });

    it("keeps the imported descriptor out of the used signing descriptors", async () => {
        const cash = makeCash();
        const { wallet } = await claimSwept(cash);

        expect(await wallet.getUsedSigningDescriptors()).toEqual([]);
    });

    it("routes the imported input to the keyring, not the baseline identity", async () => {
        const cash = makeCash();
        const { wallet } = await claimSwept(cash);

        // Reach the wallet's real signer router: this proves the keyring was
        // wired into it (a bare descriptor provider would leave a static wallet
        // unable to resolve the arkadeCash descriptor).
        const router = (
            wallet as unknown as {
                _signerRouter: {
                    classify(jobs: { index: number; lookupScript: Uint8Array }[]): Promise<{
                        identityIndexes: number[];
                        descriptorGroups: Map<string, number[]>;
                    }>;
                };
            }
        )._signerRouter;

        const plan = await router.classify([{ index: 0, lookupScript: cash.vtxoScript.pkScript }]);

        // Signable by construction: the swept input routes to its keyring
        // descriptor rather than the baseline key, and classify does not throw
        // MissingSigningDescriptorError.
        expect(plan.identityIndexes).toEqual([]);
        expect([...plan.descriptorGroups.keys()]).toEqual([`tr(${hex.encode(cash.publicKey)})`]);
    });

    it("excludes the imported recovery contract from the wallet's own VTXOs", async () => {
        const cash = makeCash();
        const { wallet } = await claimSwept(cash);

        // getVtxos feeds balance / renewal / recovery / coin selection; the
        // recovery-only VTXO must not appear there, or it would poison them.
        expect(await wallet.getVtxos()).toEqual([]);
        expect(await wallet.getVtxos({ withRecoverable: true })).toEqual([]);
    });

    it("promotes a pre-existing unflagged contract at the cash script to recovery-only", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const wallet = await makeWallet(cashIndexer(cashPkScript, [sweptCashVtxo(cashPkScript)]), {
            getPendingTxs: vi.fn(async () => []),
        });
        vi.spyOn(await wallet.getVtxoManager(), "recoverImportedContracts").mockResolvedValue();

        // A consumer registered the cash address through the public surface
        // (e.g. to watch a note it issued): same script, same type, no
        // recovery flags. createContract's same-type idempotency keeps such a
        // row as-is, so the import must promote it — left unflagged it would
        // feed the wallet's own settles unsignable swept VTXOs while staying
        // invisible to the recovery pass and its purge.
        const cm = await wallet.getContractManager();
        await cm.createContract({
            type: "default",
            params: {
                pubKey: hex.encode(cash.publicKey),
                serverPubKey: hex.encode(cash.serverPubKey),
                csvTimelock: timelockToSequence(cash.csvTimelock).toString(),
            },
            script: cashPkScript,
            address: cash.address("tark").encode(),
            state: "inactive",
            metadata: { consumerTag: "watching" },
        });

        const result = await wallet.claimCash(cash.toString());
        expect(result.recovering.amount).toBe(CASH_VALUE);

        const [contract] = await cm.getContracts({ script: cashPkScript });
        expect(contract.metadata?.recoveryOnly).toBe(true);
        expect(contract.metadata?.signingDescriptor).toBe(`tr(${hex.encode(cash.publicKey)})`);
        // Unrelated consumer metadata survives until the post-recovery deletion.
        expect(contract.metadata?.consumerTag).toBe("watching");
        // An inactive row cannot dodge the recovery pass.
        expect(contract.state).toBe("active");

        // The promoted contract is now excluded from the wallet's own VTXOs...
        expect(await wallet.getVtxos({ withRecoverable: true })).toEqual([]);
        // ...and the recovery pass sees it.
        expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cash.publicKey)})`)).toBe(true);
    });

    it("boots keyringless on corrupt keyring settings; claims degrade to recovery-failed", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        // A corrupt persisted keyring blob fails loud in parseSettings — but
        // an auxiliary recovery feature must not make the wallet's own funds
        // unreachable, so Wallet.create logs and boots without a keyring.
        const walletRepository = new InMemoryWalletRepository();
        await walletRepository.saveWalletState({
            settings: { keyring: { keys: "corrupt" } },
        });
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const wallet = await Wallet.create({
                identity: SingleKey.fromHex("1".repeat(64)),
                settlementConfig: false,
                arkProvider: {
                    getInfo: vi.fn(async () => info),
                    getPendingTxs: vi.fn(async () => []),
                } as never,
                indexerProvider: cashIndexer(cashPkScript, [sweptCashVtxo(cashPkScript)]),
                onchainProvider: idleOnchain(),
                storage: {
                    walletRepository,
                    contractRepository: new InMemoryContractRepository(),
                },
            });

            // The wallet's own surface works...
            expect(await wallet.getAddress()).toBeTruthy();
            expect(errorLog).toHaveBeenCalled();

            // ...and a claim of swept funds degrades to a reported failure
            // (importArkadeCashForRecovery throws "no keyring", caught by
            // claimCash) instead of throwing.
            const result = await wallet.claimCash(cash.toString());
            expect(result.unclaimed.vtxos).toEqual([
                { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "recovery-failed" },
            ]);
        } finally {
            errorLog.mockRestore();
        }
    });

    it("reports recovery-failed when the import cannot be persisted", async () => {
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        const wallet = await makeWallet(cashIndexer(cashPkScript, [sweptCashVtxo(cashPkScript)]), {
            getPendingTxs: vi.fn(async () => []),
        });
        const manager = await wallet.getVtxoManager();
        const kick = vi.spyOn(manager, "recoverImportedContracts").mockResolvedValue();

        // The import's contract write fails: the swept funds can be neither
        // swept nor handed to recovery, so they must surface as unclaimed
        // with a reason — this is the only path that reports server-swept
        // funds as unclaimable, and dropping them from the report entirely
        // would hide recoverable money.
        const cm = await wallet.getContractManager();
        vi.spyOn(cm, "createContract").mockRejectedValue(new Error("repo write failed"));
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const result = await wallet.claimCash(cash.toString());

            expect(result.swept).toBe(0);
            expect(result.recovering).toEqual({ amount: 0, vtxos: [] });
            expect(result.unclaimed.amount).toBe(CASH_VALUE);
            expect(result.unclaimed.vtxos).toEqual([
                { txid: CASH_TXID, vout: 0, value: CASH_VALUE, reason: "recovery-failed" },
            ]);
            // No contract row, so there is no recovery to kick.
            expect(kick).not.toHaveBeenCalled();
            // And the key filed before the failing write was rolled back: with
            // no row naming its descriptor it would be unreachable at rest.
            expect(keyringOf(wallet).listKeyringDescriptors()).toEqual([]);
        } finally {
            errorLog.mockRestore();
        }
    });

    it("keeps the key when a re-claim's contract write fails", async () => {
        // The row from the successful first claim still needs the key, so the
        // rollback must not fire for a key this call didn't file.
        const cash = makeCash();
        const { wallet } = await claimSwept(cash);
        const descriptor = `tr(${hex.encode(cash.publicKey)})`;
        expect(keyringOf(wallet).hasKey(descriptor)).toBe(true);

        const cm = await wallet.getContractManager();
        vi.spyOn(cm, "createContract").mockRejectedValue(new Error("repo write failed"));
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            await wallet.claimCash(cash.toString());
            expect(keyringOf(wallet).hasKey(descriptor)).toBe(true);
        } finally {
            errorLog.mockRestore();
        }
    });

    it("purges the key even when the contract row delete fails", async () => {
        // Write order is load-bearing: the key goes first so a failed row
        // delete leaves a retryable dangling row, never an unreferenced key.
        const cash = makeCash();
        const { wallet, cashPkScript } = await claimSwept(cash);
        const descriptor = `tr(${hex.encode(cash.publicKey)})`;

        const cm = await wallet.getContractManager();
        vi.spyOn(cm, "deleteContract").mockRejectedValue(new Error("repo write failed"));

        await expect(wallet.removeRecoveryContract(cashPkScript)).rejects.toThrow(
            "repo write failed",
        );
        expect(keyringOf(wallet).hasKey(descriptor)).toBe(false);
        expect(await cm.getContracts({ script: cashPkScript })).toHaveLength(1);
    });

    it("is idempotent: re-claiming does not duplicate the import", async () => {
        const cash = makeCash();
        const { wallet, cashPkScript } = await claimSwept(cash);

        const second = await wallet.claimCash(cash.toString());
        expect(second.recovering.amount).toBe(CASH_VALUE);

        const cm = await wallet.getContractManager();
        expect(await cm.getContracts({ script: cashPkScript })).toHaveLength(1);
    });

    it("settles an imported contract in its own intent, then purges it", async () => {
        const cash = makeCash();
        const { wallet, manager, kick, cashPkScript } = await claimSwept(cash);
        kick.mockRestore();

        // Drive the isolated recovery with the settlement stubbed to succeed.
        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("recovery-txid");
        await manager.recoverImportedContracts();

        // Settled exactly the swept VTXO, to the wallet's own address.
        expect(settle).toHaveBeenCalledOnce();
        const params = settle.mock.calls[0][0]!;
        expect(params.inputs.map((i) => `${i.txid}:${i.vout}`)).toEqual([`${CASH_TXID}:0`]);
        expect(params.outputs).toEqual([
            { address: await wallet.getAddress(), amount: BigInt(CASH_VALUE) },
        ]);

        // Cleaned up: contract row removed and keyring key purged.
        const cm = await wallet.getContractManager();
        expect(await cm.getContracts({ script: cashPkScript })).toEqual([]);
        expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cash.publicKey)})`)).toBe(false);
    });

    it("settles net of intent fees", async () => {
        const cash = makeCash();
        const { wallet, manager, kick } = await claimSwept(cash);
        kick.mockRestore();
        vi.mocked(wallet.arkProvider.getInfo).mockResolvedValue({
            ...info,
            fees: { intentFee: { offchainInput: "100.0", offchainOutput: "50.0" }, txFeeRate: "0" },
        } as never);

        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("recovery-txid");
        await manager.recoverImportedContracts();

        // A gross output offers zero fee and is rejected as INTENT_INSUFFICIENT_FEE.
        expect(settle).toHaveBeenCalledOnce();
        expect(settle.mock.calls[0][0]!.outputs).toEqual([
            { address: await wallet.getAddress(), amount: BigInt(CASH_VALUE - 150) },
        ]);
    });

    it("leaves an input that can't pay its own fee out, keeping contract and key", async () => {
        const cash = makeCash();
        const { wallet, manager, kick, cashPkScript } = await claimSwept(cash);
        kick.mockRestore();
        vi.mocked(wallet.arkProvider.getInfo).mockResolvedValue({
            ...info,
            fees: { intentFee: { offchainInput: `${CASH_VALUE}.0` }, txFeeRate: "0" },
        } as never);

        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("recovery-txid");
        await manager.recoverImportedContracts();

        expect(settle).not.toHaveBeenCalled();
        const cm = await wallet.getContractManager();
        expect(await cm.getContracts({ script: cashPkScript })).toHaveLength(1);
        expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cash.publicKey)})`)).toBe(true);
    });

    it("purges on a later pass when the first pass's purge failed", async () => {
        // Re-entry is what makes a failed `removeRecoveryContract` self-heal,
        // and it needs the settled VTXO to still be in the view — spent, so
        // nothing is re-settled, but present, so the `vtxos.length === 0`
        // outage guard doesn't swallow the purge.
        const cash = makeCash();
        const cashPkScript = hex.encode(cash.vtxoScript.pkScript);
        let view: VirtualCoin[] = [sweptCashVtxo(cashPkScript)];
        const indexer = {
            ...(cashIndexer(cashPkScript, []) as Record<string, unknown>),
            getVtxos: vi.fn(async (opts?: { scripts?: string[] }) => ({
                vtxos: opts?.scripts?.includes(cashPkScript) ? view : [],
            })),
        } as never;
        const wallet = await makeWallet(indexer, { getPendingTxs: vi.fn(async () => []) });
        const manager = await wallet.getVtxoManager();
        const kick = vi.spyOn(manager, "recoverImportedContracts").mockResolvedValue();
        await wallet.claimCash(cash.toString());
        kick.mockRestore();

        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("recovery-txid");
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            // Pass 1: the settle lands, the purge does not.
            const purge = vi
                .spyOn(wallet, "removeRecoveryContract")
                .mockRejectedValueOnce(new Error("repo write failed"));
            await manager.recoverImportedContracts();
            expect(settle).toHaveBeenCalledOnce();
            purge.mockRestore();

            // The settled VTXO now reads back spent.
            view = [spentCashVtxo(cashPkScript)];

            // Pass 2: nothing left to settle, but the row and key still go.
            await manager.recoverImportedContracts();
            expect(settle).toHaveBeenCalledOnce();
        } finally {
            errorLog.mockRestore();
        }

        const cm = await wallet.getContractManager();
        expect(await cm.getContracts({ script: cashPkScript })).toEqual([]);
        expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cash.publicKey)})`)).toBe(false);
    });

    it("isolates a failing recovery: siblings still settle, the failure retries next cycle", async () => {
        // Two independently imported notes; the FIRST one's settlement is
        // rejected, so the loop must carry on to the second — the per-contract
        // isolation the "own isolated intent" design exists to guarantee.
        const cashA = makeCash();
        const cashB = makeCash();
        const pkA = hex.encode(cashA.vtxoScript.pkScript);
        const pkB = hex.encode(cashB.vtxoScript.pkScript);
        const TXID_A = "c".repeat(64);
        const TXID_B = "d".repeat(64);
        const vtxosByScript: Record<string, VirtualCoin[]> = {
            [pkA]: [{ ...sweptCashVtxo(pkA), txid: TXID_A }],
            [pkB]: [{ ...sweptCashVtxo(pkB), txid: TXID_B }],
        };
        const indexer = {
            ...(cashIndexer(pkA, []) as Record<string, unknown>),
            getVtxos: vi.fn(async (opts?: { scripts?: string[] }) => ({
                vtxos: (opts?.scripts ?? []).flatMap((s) => vtxosByScript[s] ?? []),
            })),
        } as never;
        const wallet = await makeWallet(indexer, { getPendingTxs: vi.fn(async () => []) });
        const manager = await wallet.getVtxoManager();
        const kick = vi.spyOn(manager, "recoverImportedContracts").mockResolvedValue();
        await wallet.claimCash(cashA.toString());
        await wallet.claimCash(cashB.toString());
        kick.mockRestore();

        const settle = vi
            .spyOn(wallet, "settle")
            .mockImplementation(async (params) =>
                params!.inputs.some((i) => (i as { txid: string }).txid === TXID_A)
                    ? Promise.reject(new Error("intent rejected"))
                    : "recovery-txid",
            );
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            await manager.recoverImportedContracts();

            // Both contracts were attempted — the first failure did not abort
            // the pass — and only the failed one survives for the retry.
            expect(settle).toHaveBeenCalledTimes(2);
            const cm = await wallet.getContractManager();
            expect(await cm.getContracts({ script: pkA })).toHaveLength(1);
            expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cashA.publicKey)})`)).toBe(true);
            expect(await cm.getContracts({ script: pkB })).toEqual([]);
            expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cashB.publicKey)})`)).toBe(false);

            // Next cycle: the rejection clears and the leftover recovers too.
            settle.mockResolvedValue("recovery-txid");
            await manager.recoverImportedContracts();
            expect(await cm.getContracts({ script: pkA })).toEqual([]);
            expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cashA.publicKey)})`)).toBe(false);
        } finally {
            errorLog.mockRestore();
        }
    });

    it("rotation guard classifies the imported contract directly — no unscoped scan", async () => {
        const cash = makeCash();
        const { wallet, manager, kick } = await claimSwept(cash);
        kick.mockRestore();

        // The server rotates AFTER the import: the fresh info deprecates the
        // wallet's snapshot signer (which is also the note's), so the guard
        // must still fire — but by classifying the one imported contract the
        // pass already holds, not by re-syncing every default/delegate
        // contract in the repo on each cycle.
        const rotatedInfo = {
            ...info,
            signerPubkey: "03" + "2".repeat(64),
            deprecatedSigners: [{ pubkey: SERVER_PUBKEY_HEX, cutoffDate: 0n }],
        };
        (
            wallet as unknown as { arkProvider: { getInfo: ReturnType<typeof vi.fn> } }
        ).arkProvider.getInfo.mockResolvedValue(rotatedInfo);

        const rotate = vi.spyOn(wallet, "rotateServerSigner").mockResolvedValue(undefined);
        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("recovery-txid");
        const cm = await wallet.getContractManager();
        const withVtxos = vi.spyOn(cm, "getContractsWithVtxos");

        await manager.recoverImportedContracts();

        // The deprecated input pinned the wallet to the active signer before
        // the recovery settle read its address.
        expect(rotate).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        // Every contract fetch in the pass is script-scoped; the guard never
        // ran anyInputUnderDeprecatedSigner's unscoped type-filtered sync.
        expect(withVtxos.mock.calls.length).toBeGreaterThan(0);
        for (const call of withVtxos.mock.calls) {
            expect(call[0]).toHaveProperty("script");
            expect(call[0]).not.toHaveProperty("type");
        }
    });

    it("keeps the contract and key on an empty VTXO view (indexer outage)", async () => {
        const cash = makeCash();
        const { wallet, manager, kick, cashPkScript } = await claimSwept(cash);
        kick.mockRestore();

        const cm = await wallet.getContractManager();
        const [contract] = await cm.getContracts({ script: cashPkScript });

        // A transient indexer outage: createContract's hydration and the
        // recovery sync both fall back to (empty) repo state, so the imported
        // contract reports zero VTXOs. This must NOT be read as "recovered" —
        // purging the key here would strand the funds before recovery ran.
        vi.spyOn(cm, "getContractsWithVtxos").mockResolvedValue([{ contract, vtxos: [] }]);
        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("txid");

        await manager.recoverImportedContracts();

        // Nothing settled, so the key and contract must survive for the retry.
        expect(settle).not.toHaveBeenCalled();
        expect(keyringOf(wallet).hasKey(`tr(${hex.encode(cash.publicKey)})`)).toBe(true);
        expect(await cm.getContracts({ script: cashPkScript })).toHaveLength(1);
    });

    it("skips recovery when another instance holds the cross-instance lock", async () => {
        const cash = makeCash();
        const { wallet, manager, kick } = await claimSwept(cash);
        kick.mockRestore();
        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("txid");

        // Simulate the Web Locks API with the imported-recovery lock already
        // held by a sibling tab/worker on the same repo: `ifAvailable` yields
        // null, so this instance must skip rather than submit a duplicate
        // recovery intent (which the server's duplicated-input handling could
        // resolve by DeleteIntent-ing the sibling's valid recovery).
        const held = new Set<string>(["arkade-imported-recovery"]);
        vi.stubGlobal("navigator", {
            locks: {
                request: async (
                    name: string,
                    opts: { ifAvailable?: boolean },
                    cb: (lock: unknown) => Promise<void>,
                ) => {
                    if (opts?.ifAvailable && held.has(name)) return cb(null);
                    held.add(name);
                    try {
                        return await cb({ name });
                    } finally {
                        held.delete(name);
                    }
                },
            },
        });

        try {
            // Lock held elsewhere → no duplicate submit.
            await manager.recoverImportedContracts();
            expect(settle).not.toHaveBeenCalled();

            // Sibling releases the lock → this instance now recovers.
            held.delete("arkade-imported-recovery");
            await manager.recoverImportedContracts();
            expect(settle).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
