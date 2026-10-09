import { vi } from "vitest";
import { hex } from "@scure/base";
import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
    Wallet,
    type ArkProvider,
    type ExtendedVirtualCoin,
    type IndexerProvider,
    type OnchainProvider,
} from "../src";
import type { ArkadeInfo } from "../src/providers/ark";
import type { IntentRepository } from "../src/repositories/intentRepository";
import { SingleKey } from "../src/identity/singleKey";

const SERVER_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const HOUR = 3_600_000;

export const BTC_ADDR = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

const arkInfo = (): ArkadeInfo => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: BTC_ADDR,
    forfeitPubkey: SERVER_KEY,
    network: "mutinynet",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: SERVER_KEY,
    unilateralExitDelay: 144n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

// Every indexer read fails retryably, so reads serve the seeded repository.
const offlineIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

const outpoint = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`;

/** Three 10,000-sat VTXOs on the wallet's own script, expiring 10h, 20h and 30h out. */
export async function fundedWallet(
    opts: { concurrentSpending?: boolean; intentRepository?: IntentRepository } = {},
) {
    const walletRepository = new InMemoryWalletRepository();
    const arkProvider = {
        getInfo: vi.fn(async () => arkInfo()),
        registerIntent: vi.fn(async () => "intent-1"),
        deleteIntent: vi.fn(async () => undefined),
        getEventStream: vi.fn(),
    };
    const wallet = await Wallet.create({
        identity: SingleKey.fromHex(
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
        ),
        arkProvider: arkProvider as Partial<ArkProvider> as ArkProvider,
        indexerProvider: offlineIndexer(),
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
            getChainTip: async () => ({ height: 1_000, hash: "00".repeat(32), time: 0 }),
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: {
            walletRepository,
            contractRepository: new InMemoryContractRepository(),
            ...(opts.intentRepository ? { intentRepository: opts.intentRepository } : {}),
        },
        settlementConfig: false,
        ...(opts.concurrentSpending === undefined
            ? {}
            : { concurrentSpending: opts.concurrentSpending }),
    });
    const coins = ["aa", "bb", "cc"].map(
        (fill, i) =>
            ({
                txid: fill.repeat(32),
                vout: 0,
                value: 10_000,
                status: { confirmed: true },
                createdAt: new Date(),
                isUnrolled: false,
                isSpent: false,
                isSwept: false,
                isPreconfirmed: false,
                commitmentTxIds: [],
                spentBy: "",
                expiresAt: new Date(Date.now() + (i + 1) * 10 * HOUR),
                script: wallet.defaultContractScript,
                forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
                intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
                tapTree: new Uint8Array(64),
            }) as unknown as ExtendedVirtualCoin,
    );
    await walletRepository.saveVtxos(await wallet.getAddress(), coins);
    return { wallet, arkProvider, coins, outpoints: coins.map(outpoint) };
}

export type Submit = { inputs: string[]; outputs: [string, bigint][]; finish(): void };

/** Park every Arkade-transaction submit until the test calls `finish()` on it. */
export function stallSubmits(wallet: Wallet): Submit[] {
    const submits: Submit[] = [];
    vi.spyOn(wallet, "buildAndSubmitOffchainTx").mockImplementation(
        (inputs, outputs) =>
            new Promise((resolve) => {
                const arkTxid = String(submits.length + 1).repeat(64);
                submits.push({
                    inputs: inputs.map(outpoint),
                    outputs: outputs.map((o) => [hex.encode(o.script!), o.amount!]),
                    finish: () => resolve({ arkTxid, signedCheckpointTxs: [] }),
                });
            }),
    );
    return submits;
}

/** Hold the next settle inside `Batch.join` until `open()`; its event stream then fails. */
export function parkSettle(
    wallet: Wallet,
    arkProvider: { getEventStream: ReturnType<typeof vi.fn> },
) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    arkProvider.getEventStream.mockImplementation(async function* () {
        await gate;
        throw new Error("event stream closed by test");
    });
    const intent = { proof: "", message: {} };
    vi.spyOn(wallet as any, "makeRegisterIntentSignature").mockResolvedValue(intent);
    vi.spyOn(wallet as any, "makeDeleteIntentSignature").mockResolvedValue(intent);
    return { open };
}
