/**
 * The other offer direction: the maker deposits an ASSET and wants sats.
 *
 * `swap.test.ts` and `offerCancel.test.ts` both fund BTC and want an asset, so
 * `offerAsset` — the `swap-want-btc` program, the asset-carrying deposit, and
 * the `fromAsset`/`toAsset` pair the restore scan reads off it — had no e2e
 * anywhere. Everything below the encoder is different on this side: the deposit
 * rides a dust-sat carrier rather than being the value itself, so what a
 * funding tx puts at the covenant and what `restoreAssetSwaps` reads back out
 * of it are both shapes the other direction never produces.
 *
 * The asset is minted here rather than assumed: an offer binds an asset id, and
 * an id nothing holds cannot be deposited. The want side stays notional for the
 * usual reason — no solver runs in this stack, so nothing fills — which leaves
 * fund, restore and cancel, and those are the whole maker loop.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
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
    Wallet,
} from "@arkade-os/sdk";
import { InMemoryAssetSwapRepository } from "../../src";
import { cancelOffer, createOffer, restoreAssetSwaps, type Tx } from "../../src/protocol";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 20_000;
/** Every unit minted, and every unit deposited: the asset side's drain case. */
const ISSUE_UNITS = 1_000n;
/** Sats the fill would have to deliver. Notional — nothing fills here. */
const WANT_SATS = BigInt(5_000);

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
    { timeout = 60_000, interval = 500 } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("timeout in waitFor");
};

const indexer = new RestIndexerProvider(OPERATOR_URL);
let wallet: Wallet;
let operatorPubkey: Uint8Array;
let assetId: string;

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

    const note = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    const address = await wallet.getAddress();
    execCommand(`${arkdExec} ark send --to ${address} --amount ${FAUCET_SATS} --password secret`);
    await waitFor(async () => (await wallet.getBalance()).available >= FAUCET_SATS);

    ({ assetId } = await wallet.assetManager.issue({ amount: ISSUE_UNITS }));
    await waitFor(async () =>
        (await wallet.getBalance()).availableAssets.some(
            (a) => a.assetId === assetId && a.amount === ISSUE_UNITS,
        ),
    );

    operatorPubkey = ArkAddress.decode(address).serverPubKey;
}, 240_000);

describe("the asset -> BTC offer direction (regtest)", () => {
    let offer: Awaited<ReturnType<typeof createOffer>>;
    let fundingTxid: string;
    const history: Tx[] = [];

    it("funds a want-BTC covenant with the asset, and restores it from chain data alone", async () => {
        offer = await createOffer(wallet, {
            wantAmount: WANT_SATS,
            offerAsset: asset.AssetId.fromString(assetId),
        });

        // No `amount`: an asset deposit rides the SDK's dust-sat carrier, and
        // naming a sats figure here would describe the carrier rather than the
        // deposit. This is the call `accept()`'s funding path makes.
        fundingTxid = await wallet.send({
            address: offer.address,
            assets: [{ assetId, amount: ISSUE_UNITS }],
            extensions: [offer.extension],
        });

        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            return vtxos.some((v) => v.txid === fundingTxid);
        });

        // The units left the spendable set whole — the deposit is the asset, not
        // the sats the covenant happens to hold.
        const balance = await wallet.getBalance();
        expect(balance.availableAssets.find((a) => a.assetId === assetId)).toBeUndefined();
        expect(balance.assets.find((a) => a.assetId === assetId)?.amount).toBe(ISSUE_UNITS);

        history.push({
            type: "sent",
            redeemTxid: fundingTxid,
            createdAt: Math.floor(Date.now() / 1000),
        });
        const { restored } = await restoreAssetSwaps(indexer, history, new Set(), {
            operatorPubkey,
        });

        expect(restored).toHaveLength(1);
        // The pair, the right way round. `fromAsset` is the deposited asset and
        // `toAsset` is BTC — the mirror of what every other offer suite asserts,
        // and the field the want-asset program can never produce.
        expect(restored[0]).toMatchObject({
            fundingTxid,
            fromAsset: assetId,
            toAsset: "btc",
            fromAmount: ISSUE_UNITS.toString(),
            toAmount: WANT_SATS.toString(),
            swapPkScript: script,
            status: "pending",
        });
        expect(restored[0].offerHex).toBe(offer.offerHex);
    }, 240_000);

    it("cancels it, restores the cancel, and returns every unit", async () => {
        const cancelTxid = await cancelOffer(wallet, offer.offerHex, {
            repository: new InMemoryAssetSwapRepository(),
            fundingTxid,
            swapAddress: offer.address,
        });
        expect(cancelTxid).toBeTruthy();

        history.push({
            type: "received",
            redeemTxid: cancelTxid,
            createdAt: Math.floor(Date.now() / 1000),
        });
        const { restored } = await restoreAssetSwaps(indexer, history, new Set(), {
            operatorPubkey,
        });
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({ status: "cancelled", spentTxid: cancelTxid });

        // Whole, and spendable again: a cancelled asset offer nets to nothing.
        await waitFor(async () =>
            (await wallet.getBalance()).availableAssets.some(
                (a) => a.assetId === assetId && a.amount === ISSUE_UNITS,
            ),
        );
    }, 240_000);
});
