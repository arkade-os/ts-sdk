import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    ReadonlyWallet,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    type ArkProvider,
    type IndexerProvider,
    type OnchainProvider,
    type ExtendedVirtualCoin,
} from "../src";
import type { ArkInfo } from "../src/providers/ark";
import type { Contract } from "../src/contracts/types";
import { VHTLCContractHandler } from "../src/contracts/handlers/vhtlc";
import { saveVtxosForContract } from "../src/contracts/vtxoOwnership";
import { timelockToSequence } from "../src/utils/timelock";
import { ReadonlySingleKey, SingleKey } from "../src/identity/singleKey";

/**
 * `getBalance()` must count only the contracts the wallet owns outright.
 * A `vhtlc` contract is escrow — the wallet is one of two parties on it and
 * cannot spend it unilaterally — so its VTXOs are not spendable balance, even
 * though they are legitimately tracked and must stay visible to `getVtxos()`.
 */

const serverKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const privKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";

const arkInfo = (): ArkInfo => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: serverKeyHex,
    network: "mutinynet",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: serverKeyHex,
    unilateralExitDelay: 144n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

// The wallet reads VTXO state from the repository; the indexer only needs to
// satisfy the watcher's subscription calls and report nothing new.
const quietIndexer = () =>
    ({
        getVtxos: async () => ({ vtxos: [] }),
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

const vhtlcParams = {
    sender: "0192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4",
    receiver: "1e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b",
    server: "aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88",
    hash: "4d487dd3753a89bc9fe98401d1196523058251fc",
    refundLocktime: "800000",
    claimDelay: timelockToSequence({ type: "blocks", value: 17n }).toString(),
    refundDelay: timelockToSequence({ type: "blocks", value: 144n }).toString(),
    refundNoReceiverDelay: timelockToSequence({ type: "blocks", value: 144n }).toString(),
};

const ESCROW_SATS = 50_000;

const vtxoAt = (script: string, txid: string, value: number): ExtendedVirtualCoin =>
    ({
        txid,
        vout: 0,
        value,
        script,
        status: { confirmed: true },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        virtualStatus: { state: "settled" },
    }) as unknown as ExtendedVirtualCoin;

describe("getBalance contract-type scope", () => {
    async function walletWithEscrow() {
        const walletRepository = new InMemoryWalletRepository();
        const contractRepository = new InMemoryContractRepository();

        const vhtlcScript = VHTLCContractHandler.createScript(vhtlcParams);
        const vhtlcContract: Contract = {
            type: "vhtlc",
            params: vhtlcParams,
            script: hex.encode(vhtlcScript.pkScript),
            address: "ark1vhtlc-escrow",
            state: "active",
            createdAt: Date.now(),
        };
        await contractRepository.saveContract(vhtlcContract);
        await saveVtxosForContract(walletRepository, vhtlcContract, [
            vtxoAt(vhtlcContract.script, "e".repeat(64), ESCROW_SATS),
        ]);

        const identity = ReadonlySingleKey.fromPublicKey(
            await SingleKey.fromHex(privKeyHex).compressedPublicKey(),
        );
        const wallet = await ReadonlyWallet.create({
            identity,
            arkServerUrl: "http://localhost:7070",
            arkProvider: {
                getInfo: async () => arkInfo(),
            } as Partial<ArkProvider> as ArkProvider,
            indexerProvider: quietIndexer(),
            // getBalance also sums boarding UTXOs; keep that side empty so the
            // assertions below are about contract-type scope alone.
            onchainProvider: {
                getCoins: async () => [],
            } as Partial<OnchainProvider> as OnchainProvider,
            storage: { walletRepository, contractRepository },
        });

        return { wallet, vhtlcContract };
    }

    it("excludes vhtlc escrow from every balance bucket", async () => {
        const { wallet } = await walletWithEscrow();

        const balance = await wallet.getBalance();

        // Not merely absent from `available` — escrow must not leak into
        // settled/preconfirmed/recoverable/total either.
        expect(balance.total).toBe(0);
        expect(balance.available).toBe(0);
    });

    it("still reports the escrow VTXO through the unfiltered getVtxos()", async () => {
        const { wallet, vhtlcContract } = await walletWithEscrow();

        const vtxos = await wallet.getVtxos();

        // The exclusion is a balance-accounting decision, not a tracking one:
        // recovery and inspection paths still need to see the escrow.
        expect(vtxos.map((v) => v.script)).toContain(vhtlcContract.script);
        expect(vtxos.reduce((sum, v) => sum + v.value, 0)).toBe(ESCROW_SATS);
    });

    it("scopes getVtxos to the requested contract type", async () => {
        const { wallet, vhtlcContract } = await walletWithEscrow();

        expect(await wallet.getVtxos({ type: ["default", "delegate"] })).toEqual([]);
        expect((await wallet.getVtxos({ type: "vhtlc" })).map((v) => v.script)).toEqual([
            vhtlcContract.script,
        ]);
        // An array is membership across the listed types, not an intersection
        // and not just the first entry.
        expect(
            (await wallet.getVtxos({ type: ["vhtlc", "default"] })).map((v) => v.script),
        ).toEqual([vhtlcContract.script]);
    });
});
