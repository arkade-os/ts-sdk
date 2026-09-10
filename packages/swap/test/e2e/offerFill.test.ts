/**
 * The fill, against the real stack — the half no e2e in this package covered.
 *
 * `swap.test.ts`, `offerCancel.test.ts` and `assetToBtc.test.ts` all stop at the
 * maker loop and say why: a fill needs a taker holding the wanted asset, and no
 * solver runs here. The `offerAsset` direction escapes that. The maker deposits
 * a minted asset and wants SATS, so the taker delivers plain bitcoin — two
 * funded wallets and nothing else.
 *
 * What that buys is the only end-to-end exercise of the `fulfill` leaf: the
 * emulator evaluates the covenant against a real transaction and co-signs it,
 * or refuses. Everything below `fillOffer` — asset packet, prevout proofs,
 * output layout, the tweaked co-signer key — is asserted by arkd accepting the
 * spend, which no unit test can stand in for.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    asset,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    Wallet,
} from "@arkade-os/sdk";
import {
    classifyDepositSpend,
    createOffer,
    decodeOffer,
    fillOffer,
    spendTxidsOf,
} from "../../src/protocol";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const EMULATOR_URL = "http://localhost:7073";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 20_000;
const ISSUE_UNITS = 1_000n;
/** What the taker must put at output 0, in sats — this side's whole point. */
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

const newWallet = async (): Promise<Wallet> =>
    Wallet.create({
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

const faucet = async (w: Wallet, sats: number): Promise<void> => {
    const note = execCommand(`${arkdExec} arkd note --amount 200000`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    execCommand(
        `${arkdExec} ark send --to ${await w.getAddress()} --amount ${sats} --password secret`,
    );
    await waitFor(async () => (await w.getBalance()).available >= sats);
};

let maker: Wallet;
let taker: Wallet;
let operatorPubkey: Uint8Array;
let assetId: string;

beforeAll(async () => {
    maker = await newWallet();
    taker = await newWallet();
    await faucet(maker, FAUCET_SATS);
    // enough to cover WANT_SATS plus the fee the spend pays
    await faucet(taker, FAUCET_SATS);

    ({ assetId } = await maker.assetManager.issue({ amount: ISSUE_UNITS }));
    await waitFor(async () =>
        (await maker.getBalance()).availableAssets.some(
            (a) => a.assetId === assetId && a.amount === ISSUE_UNITS,
        ),
    );

    operatorPubkey = ArkAddress.decode(await maker.getAddress()).serverPubKey;
}, 300_000);

describe("filling an offer (regtest)", () => {
    it("spends the deposit through the fulfill leaf and pays the maker", async () => {
        const offer = await createOffer(maker, {
            wantAmount: WANT_SATS,
            offerAsset: asset.AssetId.fromString(assetId),
        });
        // No `amount`: an asset deposit rides the SDK's dust-sat carrier.
        const fundingTxid = await maker.send({
            address: offer.address,
            assets: [{ assetId, amount: ISSUE_UNITS }],
            extensions: [offer.extension],
        });
        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            return vtxos.some((v) => v.txid === fundingTxid);
        });

        const makerBefore = (await maker.getBalance()).available;
        const coins = await taker.getVtxos();
        const fillTxid = await fillOffer(taker, OPERATOR_URL, offer.offerHex, {
            fund: coins.map((c) => ({
                txid: c.txid,
                vout: c.vout,
                value: c.value,
                tapLeafScript: c.forfeitTapLeafScript,
                tapTree: c.tapTree,
            })),
            fundingTxid,
            emulator: EMULATOR_URL,
        });
        expect(fillTxid).toHaveLength(64);

        // The deposit is gone from the covenant, which only the emulator
        // co-signing the fulfill leaf can achieve.
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            return vtxos.every((v) => v.txid !== fundingTxid || v.isSpent === true);
        });

        // WHICH leaf, read off the spend rather than inferred from the outcome:
        // a cancel also empties the covenant and would pay the maker nothing.
        //
        // BOTH txids, via `classifyDepositSpend`. A spend is two linked
        // transactions and only the CHECKPOINT takes the deposit outpoint; hand
        // it the ark tx alone and every real spend reads `indeterminate`.
        const { vtxos } = await indexer.getVtxos({ scripts: [script] });
        const deposit = vtxos.find((v) => v.txid === fundingTxid)!;
        const candidates = spendTxidsOf(deposit);
        expect(candidates.length).toBeGreaterThan(0);
        const { txs } = await indexer.getVirtualTxs(candidates);

        expect(
            classifyDepositSpend(
                decodeOffer(hex.decode(offer.offerHex)),
                operatorPubkey,
                // decoded, not the base64 the indexer returns
                txs.map((psbt) => Transaction.fromPSBT(base64.decode(psbt))),
                { txid: fundingTxid, vout: deposit.vout },
            ),
        ).toBe("fulfilled");

        // WHAT it paid, read off the transaction rather than polled from a
        // balance: output 0 carrying `wantAmount` to the maker's script is the
        // covenant's actual obligation, and the emulator refuses anything else.
        const decoded = decodeOffer(hex.decode(offer.offerHex));
        const paid = txs
            .map((psbt) => Transaction.fromPSBT(base64.decode(psbt)))
            .some((tx) => {
                const out = tx.getOutput(0);
                return (
                    out?.script !== undefined &&
                    hex.encode(out.script) === hex.encode(decoded.makerPkScript) &&
                    out.amount === WANT_SATS
                );
            });
        expect(paid).toBe(true);

        // and the asset left with the taker — the other side of the trade
        await waitFor(async () =>
            (await taker.getBalance()).availableAssets.some(
                (a) => a.assetId === assetId && a.amount === ISSUE_UNITS,
            ),
        );
    }, 600_000);
});
