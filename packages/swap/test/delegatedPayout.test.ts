/**
 * A wallet whose Executor watches its key shows the delegated twin as its address, and the swap
 * package takes that address as given: payouts and refunds land where the Executor renews them.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    asset,
    CSVMultisigTapscript,
    ExecutorContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ReadonlySingleKey,
    ReadonlyWallet,
    type IndexerProvider,
    type IWallet,
    type OnchainProvider,
    type OperatorProvider,
} from "@arkade-os/sdk";
import { createOffer, decodeOffer } from "../src/offer";
import { requestArkadeSwap } from "../src/rfq";
import type { AttestingRfqTransport } from "../src/client/transport";

const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const signerKey = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const owner = hex.decode("02" + hex.encode(schnorr.getPublicKey(makerKey)));

const arkInfo = () => ({
    boardingExitDelay: 144n,
    checkpointTapscript: hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [hex.decode(signerKey)],
        }).script,
    ),
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: "02" + signerKey,
    network: "regtest",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: "02" + signerKey,
    unilateralExitDelay: 4096n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

/** The maker's live renewal watch: the twin of its key. */
function twinRow() {
    const params = ExecutorContractHandler.serializeParams({
        template: "renewal",
        owner,
        exitDelay: 144,
        renewalWindow: 1000,
        maxFee: 100,
        batchCosignerPubKey: hex.decode("02" + hex.encode(makerKey)),
        operatorPubKey: hex.decode("02" + signerKey),
        emulatorPubKey: hex.decode(emulatorPubkey),
    });
    const script = ExecutorContractHandler.createScript(params);
    return {
        pkScript: script.pkScript,
        contract: {
            type: "executor",
            params,
            script: hex.encode(script.pkScript),
            address: script.address("tark", hex.decode(signerKey)).encode(),
            state: "active" as const,
            createdAt: Date.now(),
            metadata: { delegationStatus: "active" },
        },
    };
}

async function makerWallet(twin?: ReturnType<typeof twinRow>) {
    const contractRepository = new InMemoryContractRepository();
    if (twin) await contractRepository.saveContract(twin.contract);
    const wallet = await ReadonlyWallet.create({
        arkProvider: {
            getInfo: async () => arkInfo(),
        } as Partial<OperatorProvider> as OperatorProvider,
        indexerProvider: {
            getVtxos: async () => ({ vtxos: [], page: undefined }),
            subscribeForScripts: async () => "sub-1",
            unsubscribeForScripts: async () => undefined,
            getSubscription: async function* () {},
        } as Partial<IndexerProvider> as IndexerProvider,
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository },
        identity: ReadonlySingleKey.fromPublicKey(owner),
    });
    return wallet as unknown as ReadonlyWallet & IWallet;
}

describe("a maker whose Executor watches its key", () => {
    it("is paid by an offer at the twin", async () => {
        const twin = twinRow();
        const wallet = await makerWallet(twin);

        const offer = await createOffer(wallet, {
            wantAmount: 50_000n,
            wantAsset: testAsset,
            emulatorPubkey,
        });

        expect(decodeOffer(hex.decode(offer.offerHex)).makerPkScript).toEqual(twin.pkScript);
        await wallet.dispose();
    });

    it("is paid by an offer at its own address without a watch", async () => {
        const wallet = await makerWallet();

        const offer = await createOffer(wallet, {
            wantAmount: 50_000n,
            wantAsset: testAsset,
            emulatorPubkey,
        });

        expect(decodeOffer(hex.decode(offer.offerHex)).makerPkScript).toEqual(
            wallet.arkAddress.pkScript,
        );
        await wallet.dispose();
    });

    it("asks the solver to pay an RFQ at the twin", async () => {
        const twin = twinRow();
        const wallet = await makerWallet(twin);
        const stop = new Error("stop");
        const requestQuote = vi.fn(async () => {
            throw stop;
        });
        const transport = { requestQuote } as unknown as AttestingRfqTransport;

        await expect(
            requestArkadeSwap(wallet, transport, {
                offerAsset: asset.AssetId.fromString("bb".repeat(32) + "0000"),
                wantAsset: testAsset,
                amount: 50_000n,
                emulatorPubkey,
            }),
        ).rejects.toBe(stop);

        const [[request]] = requestQuote.mock.calls as unknown as [
            [{ profile: { maker_pk_script: string } }],
        ];
        expect(request.profile.maker_pk_script).toBe(hex.encode(twin.pkScript));
        await wallet.dispose();
    });
});
