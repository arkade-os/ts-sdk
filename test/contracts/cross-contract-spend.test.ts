import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
} from "../../src";
import { ArkProvider } from "../../src/providers/ark";
import { DelegatorProvider } from "../../src/providers/delegator";
import { OnchainProvider } from "../../src/providers/onchain";
import { IndexerProvider } from "../../src/providers/indexer";
import { VirtualCoin } from "../../src/wallet";

const mockPrivKeyHex =
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

// A second pubkey for the server (x-only, 32 bytes, with 02 prefix for getInfo)
const serverPubKeyHex =
    "e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb";
// Delegate pubkey (x-only, 32 bytes)
const delegatePubKeyHex =
    "f8352deebdf5658d95875d89656112b1dd150f176c702eea4f91a91527e48e26";

function createMockArkProvider(): ArkProvider {
    return {
        getInfo: vi.fn().mockResolvedValue({
            signerPubkey: "02" + serverPubKeyHex,
            forfeitPubkey: "02" + serverPubKeyHex,
            boardingExitDelay: 144n,
            unilateralExitDelay: 144n,
            sessionDuration: 10n,
            network: "regtest",
            forfeitAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
            checkpointTapscript: "5ab27520" + serverPubKeyHex + "ac",
            dust: 450n,
            fees: { delegatorFeeBps: 0 },
            deprecatedSigners: [],
            digest: "",
            scheduledSession: undefined,
            serviceStatus: { isReady: true },
            utxoMaxAmount: -1n,
            utxoMinAmount: 0n,
            version: "0.1.0",
            vtxoMaxAmount: -1n,
            vtxoMinAmount: 0n,
        }),
        submitTx: vi.fn(),
        finalizeTx: vi.fn(),
        registerIntent: vi.fn(),
        deleteIntent: vi.fn(),
        confirmRegistration: vi.fn(),
        submitTreeNonces: vi.fn(),
        submitTreeSignatures: vi.fn(),
        submitSignedForfeitTxs: vi.fn(),
        getEventStream: vi.fn(),
        getTransactionsStream: vi.fn(),
        getPendingTxs: vi.fn(),
    };
}

function createMockOnchainProvider(): OnchainProvider {
    return {
        getCoins: vi.fn().mockResolvedValue([]),
        getTransaction: vi.fn(),
        getTransactions: vi.fn().mockResolvedValue([]),
        broadcast: vi.fn(),
        getFeeRate: vi.fn().mockResolvedValue(1),
        waitForTransaction: vi.fn(),
        getTxOutspends: vi.fn().mockResolvedValue([]),
        subscribeForAddress: vi.fn(),
        unsubscribeForAddress: vi.fn(),
    };
}

function createMockDelegatorProvider(): DelegatorProvider {
    return {
        delegate: vi.fn(),
        getDelegateInfo: vi.fn().mockResolvedValue({
            pubkey: "02" + delegatePubKeyHex,
            fee: "0",
            delegatorAddress: "delegate-address",
        }),
    };
}

function createMockIndexerProvider(): IndexerProvider {
    return {
        getVtxoTree: vi.fn(),
        getVtxoTreeLeaves: vi.fn(),
        getBatchSweepTransactions: vi.fn(),
        getCommitmentTx: vi.fn(),
        getCommitmentTxConnectors: vi.fn(),
        getCommitmentTxForfeitTxs: vi.fn(),
        getSubscription: vi.fn(),
        getVirtualTxs: vi.fn(),
        getVtxoChain: vi.fn(),
        getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
        subscribeForScripts: vi.fn().mockResolvedValue("mock-subscription-id"),
        unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
        getAssetDetails: vi.fn(),
    };
}

function makeMockVirtualCoin(txidByte: number, value: number): VirtualCoin {
    return {
        txid: hex.encode(new Uint8Array(32).fill(txidByte)),
        vout: 0,
        value,
        status: { confirmed: true },
        virtualStatus: { state: "settled" },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
    };
}

describe("Cross-contract spending", () => {
    let walletRepository: InMemoryWalletRepository;
    let contractRepository: InMemoryContractRepository;

    beforeEach(() => {
        vi.useFakeTimers();
        walletRepository = new InMemoryWalletRepository();
        contractRepository = new InMemoryContractRepository();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("send should use VTXOs from all contracts, not just the current script", async () => {
        const identity = SingleKey.fromHex(mockPrivKeyHex);
        const arkProvider = createMockArkProvider();
        const onchainProvider = createMockOnchainProvider();
        const delegatorProvider = createMockDelegatorProvider();
        const mockIndexer = createMockIndexerProvider();

        // Create wallet with delegate enabled.
        // This means offchainTapscript is a DelegateVtxo.Script.
        const wallet = await Wallet.create({
            identity,
            arkServerUrl: "http://localhost:7070",
            arkProvider,
            indexerProvider: mockIndexer,
            onchainProvider,
            delegatorProvider,
            storage: { walletRepository, contractRepository },
        });

        // Initialize ContractManager so both contracts (default + delegate)
        // get registered automatically.
        const manager = await wallet.getContractManager();
        const contracts = await manager.getContracts({
            type: ["default", "delegate"],
        });
        expect(contracts).toHaveLength(2);

        // Discover the actual script hex for each contract.
        const defaultContract = contracts.find((c) => c.type === "default")!;
        const delegateContract = contracts.find((c) => c.type === "delegate")!;

        // Mock indexer: return 1000 sats on default script, 1000 sats on delegate script.
        const defaultVtxo = makeMockVirtualCoin(0xaa, 1000);
        const delegateVtxo = makeMockVirtualCoin(0xbb, 1000);

        (mockIndexer.getVtxos as any).mockImplementation(
            (opts: { scripts?: string[] }) => {
                const scripts = opts?.scripts ?? [];
                const vtxos = scripts.flatMap((s: string) => {
                    if (s === defaultContract.script) return [defaultVtxo];
                    if (s === delegateContract.script) return [delegateVtxo];
                    return [];
                });
                return Promise.resolve({ vtxos });
            }
        );

        // getVtxos (public) should see VTXOs from both contracts.
        const allVtxos = await wallet.getVtxos();
        expect(allVtxos).toHaveLength(2);
        const totalBalance = allVtxos.reduce((sum, v) => sum + v.value, 0);
        expect(totalBalance).toBe(2000);

        // Now try to send 1500 — requires VTXOs from both pools.
        //
        // Before the fix, send() called getVirtualCoins() which only
        // queried the current offchainTapscript (delegate), seeing
        // only 1000 sats, and threw "Insufficient funds".
        //
        // After the fix it queries all contract scripts, finds 2000
        // sats total, and proceeds past coin selection into the
        // transaction-building stage (which we don't fully mock here).
        const bobAddress = await wallet.getAddress();
        const sendPromise = wallet.sendBitcoin({
            address: bobAddress,
            amount: 1500,
        });
        await expect(sendPromise).rejects.not.toThrow("Insufficient funds");
    });
});
