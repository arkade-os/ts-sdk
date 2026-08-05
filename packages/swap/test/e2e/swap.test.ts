/**
 * The maker-side swap loop against the real regtest stack: derive an offer
 * (arkd + emulator infos), fund its covenant address with the offer packet
 * embedded, rebuild the record from chain data alone, cancel cooperatively
 * (the 2-of-2 maker+server spend), and restore the cancel classification.
 *
 * This is the package's persistence contract exercised end to end: offerHex +
 * fundingTxid is all a maker must keep — everything else comes back from the
 * indexer. The fill path is NOT covered here: it needs a taker holding the
 * want-asset (no solver runs in this stack) and is scoped separately.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import {
    asset,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import { cancelOffer, createOffer, decodeOffer, restoreAssetSwaps, type Tx } from "../../src";

const ARK_URL = "http://localhost:7070";
const EMULATOR_URL = "http://localhost:7073";
// mempool serves the Esplora REST API under `/api`; the root path is the HTML UI
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 30_000;
const DEPOSIT_SATS = 10_000;
const WANT_AMOUNT = BigInt(1_000);

const execCommand = (command: string): string => {
    const result = execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
    if (result.startsWith("error:")) throw new Error(result);
    return result;
};

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 30_000, interval = 500 } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
};

const indexer = new RestIndexerProvider(ARK_URL);
let wallet: Wallet;

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkServerUrl: ARK_URL,
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

    // fund the maker offchain: mint a note to the arkd CLI wallet, redeem it,
    // and send from there (the same faucet path the ts-sdk e2e suites use)
    const note = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    const address = await wallet.getAddress();
    execCommand(`${arkdExec} ark send --to ${address} --amount ${FAUCET_SATS} --password secret`);
    await waitFor(async () => (await wallet.getVtxos()).length > 0);
}, 120_000);

describe("maker-side swap loop (regtest)", () => {
    // the want-asset never has to exist for create/cancel/restore: the covenant
    // only binds its id, and the fill path is the one place it would be spent
    const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
    let offer: Awaited<ReturnType<typeof createOffer>>;
    let fundingTxid: string;
    let restoredOfferHex: string;
    // the tx feed a wallet would pass to the restore scan, grown as the flow
    // progresses — entries are the package's own Tx shape, built from real txids
    const history: Tx[] = [];

    it("derives, funds, and restores a pending offer from chain data alone", async () => {
        offer = await createOffer(wallet, ARK_URL, EMULATOR_URL, {
            wantAmount: WANT_AMOUNT,
            wantAsset,
        });

        fundingTxid = await wallet.send({
            address: offer.address,
            amount: DEPOSIT_SATS,
            extensions: [offer.extension],
        });

        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            return vtxos.some((v) => v.txid === fundingTxid);
        });

        history.push({
            type: "sent",
            redeemTxid: fundingTxid,
            createdAt: Math.floor(Date.now() / 1000),
        });
        const { restored, scannedTxids } = await restoreAssetSwaps(indexer, history, new Set());

        expect(scannedTxids).toEqual([fundingTxid]);
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            id: fundingTxid,
            fundingTxid,
            fromAsset: "btc",
            toAsset: wantAsset.toString(),
            fromAmount: String(DEPOSIT_SATS),
            toAmount: WANT_AMOUNT.toString(),
            swapPkScript: script,
            status: "pending",
        });
        expect(restored[0].spentTxid).toBeUndefined();

        // the offer read back off the funding tx is byte-identical to the one
        // we embedded — the whole persistence contract rests on this
        restoredOfferHex = restored[0].offerHex;
        expect(restoredOfferHex).toBe(offer.offerHex);
        expect(() => decodeOffer(hex.decode(restoredOfferHex))).not.toThrow();
    }, 120_000);

    it("cancels the deposit cooperatively and restores it as cancelled", async () => {
        // cancel from the chain-recovered bytes, not the createOffer result:
        // this is the restored-wallet path, plus the swapAddress pin
        const cancelTxid = await cancelOffer(
            wallet,
            ARK_URL,
            restoredOfferHex,
            fundingTxid,
            offer.address,
        );
        expect(cancelTxid).toBeTruthy();

        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            const vtxo = vtxos.find((v) => v.txid === fundingTxid);
            return vtxo?.virtualStatus.state === "spent";
        });

        // a fresh restore (empty store, as after a wallet wipe) must classify
        // the spend as a cancel: the spending tx is in the history and carries
        // no want-asset
        history.push({
            type: "received",
            redeemTxid: cancelTxid,
            createdAt: Math.floor(Date.now() / 1000),
        });
        const { restored } = await restoreAssetSwaps(indexer, history, new Set());
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            status: "cancelled",
            spentTxid: cancelTxid,
        });

        // and the deposit is back in the maker's wallet, whole (zero-fee env)
        await waitFor(async () => {
            const vtxos = await wallet.getVtxos();
            return vtxos.some((v) => v.txid === cancelTxid && v.value === DEPOSIT_SATS);
        });
    }, 120_000);
});
