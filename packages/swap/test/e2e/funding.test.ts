/**
 * fundOffer against the real regtest stack: the funding intent binds to the
 * transaction that funded it, and a send whose response was lost is recovered
 * from chain evidence instead of being sent a second time.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import {
    ArkAddress,
    asset,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    TxType,
    Wallet,
} from "@arkade-os/sdk";
import {
    createOffer,
    FundingOutcomeUnknownError,
    fundOffer,
    InMemoryAssetSwapRepository,
    restoreAssetSwapRepository,
    type Tx,
} from "../../src";
import { faucet, waitFor } from "./harness";

const OPERATOR_URL = process.env.ARK_URL ?? "http://localhost:7070";
const ESPLORA_API_URL = process.env.ESPLORA_URL ?? "http://localhost:3000/api";
const arkdExec = `docker exec -t ${process.env.ARKD_CONTAINER ?? "arkd"}`;

const FAUCET_SATS = 30_000;
const DEPOSIT_SATS = 10_000;
// no solver serves this asset, so every deposit stays at its covenant
const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");

const indexer = new RestIndexerProvider(OPERATOR_URL);
let wallet: Wallet;

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestArkProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
    faucet(arkdExec, [await wallet.getAddress()], FAUCET_SATS);
    await waitFor(async () => (await wallet.getBalance()).available >= FAUCET_SATS);
}, 120_000);

describe("fundOffer (regtest)", () => {
    it("funds an offer and binds the funding intent to its transaction", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const offer = await createOffer(wallet, OPERATOR_URL, { wantAmount: 1_000n, wantAsset });

        const swap = await fundOffer(wallet, OPERATOR_URL, {
            repository,
            offerHex: offer.offerHex,
            deposit: { amount: DEPOSIT_SATS },
        });

        expect(swap).toMatchObject({ status: "pending", fundingIntent: { state: "bound" } });
        await waitFor(async () => (await depositsAt(offer.swapPkScript)).length > 0);
        expect(await depositsAt(offer.swapPkScript)).toEqual([swap.fundingTxid]);
    }, 120_000);

    it("recovers a send whose response was lost, without funding the offer twice", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const offer = await createOffer(wallet, OPERATOR_URL, { wantAmount: 1_001n, wantAsset });
        const params = {
            repository,
            offerHex: offer.offerHex,
            deposit: { amount: DEPOSIT_SATS },
            id: "lost-response",
        };

        await expect(
            fundOffer(withLostSendResponse(wallet), OPERATOR_URL, params),
        ).rejects.toBeInstanceOf(FundingOutcomeUnknownError);
        expect(await repository.getSwap(params.id)).toMatchObject({
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
        // while the outcome is unknown, a retry refuses instead of sending again
        await expect(fundOffer(wallet, OPERATOR_URL, params)).rejects.toBeInstanceOf(
            FundingOutcomeUnknownError,
        );

        const serverPubkey = ArkAddress.decode(await wallet.getAddress()).serverPubKey;
        await waitFor(async () => {
            await restoreAssetSwapRepository({
                wallet,
                arkServerUrl: OPERATOR_URL,
                indexer,
                repository,
                txs: await sentHistory(),
                serverPubkey,
            });
            return (await repository.getSwap(params.id))?.fundingIntent?.state === "bound";
        });

        const bound = await repository.getSwap(params.id);
        const fundingTxid = bound?.fundingTxid;
        expect(await depositsAt(offer.swapPkScript)).toEqual([fundingTxid]);
        const sameDeposit = (await repository.getAllSwaps()).filter(
            (swap) => swap.fundingTxid === fundingTxid,
        );
        expect(sameDeposit.map((swap) => swap.id)).toEqual([params.id]);
        await expect(fundOffer(wallet, OPERATOR_URL, params)).resolves.toEqual(bound);
        expect(await depositsAt(offer.swapPkScript)).toEqual([fundingTxid]);
    }, 120_000);
});

const depositsAt = async (script: Uint8Array): Promise<string[]> =>
    (await indexer.getVtxos({ scripts: [hex.encode(script)] })).vtxos.map((vtxo) => vtxo.txid);

/** The real wallet, except that `send`'s answer never arrives: the transaction is
 * submitted and finalized, and the caller sees only an error. */
const withLostSendResponse = (target: Wallet): Wallet =>
    new Proxy(target, {
        get(real, prop) {
            if (prop === "send") {
                return async (...args: Parameters<Wallet["send"]>) => {
                    await real.send(...args);
                    throw new Error("connection reset before the send response arrived");
                };
            }
            const value = Reflect.get(real, prop, real);
            return typeof value === "function" ? value.bind(real) : value;
        },
    });

/** The wallet's sent transactions, in the shape the restore scan reads. */
const sentHistory = async (): Promise<Tx[]> =>
    (await wallet.getTransactionHistory())
        .filter((tx) => tx.type === TxType.TxSent && tx.key.arkTxid)
        .map((tx) => ({
            type: "sent",
            redeemTxid: tx.key.arkTxid,
            createdAt: Math.floor(tx.createdAt / 1000),
        }));
