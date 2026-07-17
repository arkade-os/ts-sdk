import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { Wallet } from "../src/wallet/wallet";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { SingleKey } from "../src/identity/singleKey";
import { ArkCash } from "../src/arkcash";
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

/** Indexer that only knows about the arkcash address. */
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

/** The arkcash VTXO as it reads back after a sweep was registered: spent. */
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

/** The arkcash VTXO the server swept at batch expiry: swept but unspent. */
function sweptCashVtxo(cashPkScript: string): VirtualCoin {
    return {
        txid: CASH_TXID,
        vout: 0,
        value: CASH_VALUE,
        script: cashPkScript,
        status: { confirmed: true },
        virtualStatus: { state: "swept" },
        isSpent: false,
        createdAt: new Date(),
    } as VirtualCoin;
}

/** White-box reach for the wallet's keyring (private) in these unit tests. */
function keyringOf(wallet: Wallet) {
    return (wallet as unknown as { _keyring: { hasKey(d: string): boolean } })._keyring;
}

/**
 * The pending sweep the crashed claim left on the server: the offchain tx it
 * built and submitted but never finalized, paying `destinationPkScript`.
 */
function pendingSweep(cash: ArkCash, destinationPkScript: Uint8Array) {
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
    ArkCash.generate(
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
        const stranger = ArkCash.generate(
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
});

describe("claimCash import-for-recovery", () => {
    // Claim a wallet holding a single server-swept arkcash VTXO. The kick is
    // stubbed so the import artifacts can be inspected without a live recovery
    // settlement racing the assertions.
    async function claimSwept(cash: ArkCash) {
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

        // The arkcash key is filed in the keyring, and a signable recovery-only
        // contract was registered at the arkcash script.
        const descriptor = `tr(${hex.encode(cash.publicKey)})`;
        expect(keyringOf(wallet).hasKey(descriptor)).toBe(true);
        const cm = await wallet.getContractManager();
        const [contract] = await cm.getContracts({ script: cashPkScript });
        expect(contract.type).toBe("default");
        expect(contract.metadata?.signingDescriptor).toBe(descriptor);
        expect(contract.metadata?.recoveryOnly).toBe(true);
    });

    it("routes the imported input to the keyring, not the baseline identity", async () => {
        const cash = makeCash();
        const { wallet } = await claimSwept(cash);

        // Reach the wallet's real signer router: this proves the keyring was
        // wired into it (a bare descriptor provider would leave a static wallet
        // unable to resolve the arkcash descriptor).
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
