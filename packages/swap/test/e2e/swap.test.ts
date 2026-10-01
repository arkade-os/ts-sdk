/**
 * The swap loop end to end against the real regtest stack, in two suites.
 *
 * Offer suite: derive, fund, restore, and cooperatively cancel an offer —
 * the package's persistence contract: offerHex + fundingTxid is all a maker
 * must keep, everything else comes back from the indexer.
 *
 * Fill suite, against the stack's solverd: swaps in both directions, all-in
 * and partial, resolved live off the wallet's own vtxo_spent event (never a
 * restore scan); plus oversized and underbid offers the solver doesn't fill,
 * which the wallet cancels.
 * afterAll sells leftover asset back to the solver, so its inventory
 * survives every run and the default solver-init float needs no sizing.
 * The minted asset id changes on every regtest boot, so nothing here may
 * hardcode it: the solver's card (`GET /v1/card`) is the one source of truth.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { faucet } from "./harness";
import { hex } from "@scure/base";
import {
    ArkAddress,
    asset,
    type Asset,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import { discover, quoteOffer, type Market } from "@arkade-os/solver-discovery";
import {
    addAssetSwap,
    ASSET_CARRIER_SATS,
    cancelOffer,
    createOffer,
    decodeOffer,
    getAssetSwaps,
    InMemoryAssetSwapRepository,
    QUOTE_OPTIONS,
    restoreAssetSwaps,
    watchOfferSwaps,
    type AssetSwap,
    type Tx,
} from "../../src";

const OPERATOR_URL = "http://localhost:7070";
// mempool serves the Esplora REST API under `/api`; the root path is the HTML UI
const ESPLORA_API_URL = "http://localhost:3000/api";
// solverd's HTTP API and the mock price feed, on their host-published ports
const SOLVER_HTTP_URL = "http://localhost:7091";
const PRICEFEED_URL = "http://localhost:8088";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 30_000;
const DEPOSIT_SATS = 10_000;
const WANT_AMOUNT = 1_000n;
// fills in this stack land in ~1s, so a deposit untouched after 8s was refused
const FILL_WAIT_MS = 8_000;

const indexer = new RestIndexerProvider(OPERATOR_URL);
const repository = new InMemoryAssetSwapRepository();
let wallet: Wallet;
// the key the covenants are funded against — restore classifies each spend by
// the covenant leaf it took, so it has to rebuild the same script
let operatorPubkey: Uint8Array;
// the solverd suite's market, discovered by its beforeAll: which side is BTC,
// and the asset leg (the market's non-BTC side)
let market: Market;
let btcSide: "base" | "quote";
let assetLeg: Market["base_asset"];
// the solver's asset inventory at discovery time — afterAll must hand it all back
let solverAssetBaseline: bigint;

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

    // fund the maker offchain: mint a note to the arkd CLI wallet, redeem it,
    // and send from there (the same faucet path the ts-sdk e2e suites use)
    faucet(arkdExec, [await wallet.getAddress()], FAUCET_SATS);
    await waitFor(async () => (await availableSats()) >= FAUCET_SATS);

    operatorPubkey = ArkAddress.decode(await wallet.getAddress()).serverPubKey;
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

    it("derives, funds, and restores a pending offer from its funding transaction alone", async () => {
        // no override — asserts the default pin matches the regtest stack
        offer = await createOffer(wallet, OPERATOR_URL, {
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
        // Pending deposits have no spend to classify; serverPubkey is required
        // by the restore API but does not affect this assertion.
        const { restored, scannedTxids } = await restoreAssetSwaps(indexer, history, new Set(), {
            serverPubkey: operatorPubkey,
        });

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

    // everything below runs through the real createOffer -> register ->
    // ContractManager path above, never a hand-built contract row: a hand-marked
    // fixture cannot catch a writer that omits or misspells the marker
    it("escrows the deposit: owned and watched, but not generically spendable", async () => {
        const script = hex.encode(offer.swapPkScript);
        const manager = await wallet.getContractManager();
        const [row] = await manager.getContracts({ script });

        expect(row).toBeDefined();
        expect(row?.type).toBe("arkade");
        expect(row?.metadata?.genericallySpendable).toBe(false);

        // the funding tx also pays the maker's own change, so match the
        // covenant script too — by txid alone this picks up the change output,
        // which is ordinary wallet money and rightly stays spendable
        const isDeposit = (v: { txid: string; script: string }) =>
            v.txid === fundingTxid && v.script === script;
        // the raw read keeps it — this is the maker's money, and filtering it
        // here would make it unrecoverable and erase it from history
        await waitFor(async () => (await wallet.getVtxos()).some(isDeposit));
        // ...while the spendable read, the one every coin selection goes
        // through, does not
        expect((await wallet.getSpendableVtxos()).some(isDeposit)).toBe(false);

        const balance = await wallet.getBalance();
        expect(balance.settled + balance.preconfirmed).toBeGreaterThanOrEqual(DEPOSIT_SATS);
        expect(balance.available).toBeLessThanOrEqual(FAUCET_SATS - DEPOSIT_SATS);
    }, 120_000);

    it("refuses to fund an unrelated payment out of the escrowed deposit", async () => {
        // without the marker, coin selection picks the offer deposit like any
        // other output, the operator cosigns the covenant's untimelocked cancel
        // leaf, and the offer silently ceases to exist. This send only succeeds
        // if that happens: an amount the wallet can only reach by dipping into
        // the deposit — under the totals (which count it) but above what is
        // left once it is excluded
        const balance = await wallet.getBalance();
        const needsTheDeposit =
            balance.settled + balance.preconfirmed - Math.floor(DEPOSIT_SATS / 2);

        await expect(
            wallet.send({ address: await wallet.getAddress(), amount: needsTheDeposit }),
        ).rejects.toThrow();

        // and the deposit is still there to be cancelled below
        const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(offer.swapPkScript)] });
        const depositVtxo = vtxos.find((v) => v.txid === fundingTxid);
        expect(depositVtxo).toBeDefined();
        expect(depositVtxo?.isSpent).toBe(false);
    }, 120_000);

    it("cancels the offer cooperatively and restores it as cancelled", async () => {
        // cancel from the restored bytes, not the createOffer result:
        // this is the restored-wallet path, plus the swapAddress pin.
        // It doubles as the escape-hatch assertion: cancel names its input
        // outpoint, so the escrow marker must not close the one spend route the
        // maker actually owns. A future tightening that gates explicit inputs
        // would strand every offer deposit, and would fail here.
        const cancelTxid = await cancelOffer(wallet, OPERATOR_URL, restoredOfferHex, {
            repository,
            fundingTxid,
            swapAddress: offer.address,
        });
        expect(cancelTxid).toBeTruthy();

        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            const vtxo = vtxos.find((v) => v.txid === fundingTxid);
            return vtxo?.isSpent === true;
        });

        // a fresh restore (empty store, as after a wallet wipe) must classify
        // the spend as a cancel: the spending tx is in the history and carries
        // no want-asset
        history.push({
            type: "received",
            redeemTxid: cancelTxid,
            createdAt: Math.floor(Date.now() / 1000),
        });
        const { restored } = await restoreAssetSwaps(indexer, history, new Set(), {
            serverPubkey: operatorPubkey,
        });
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

    it("resolves the swap as cancelled from the wallet's own spend event, without a restore scan", async () => {
        // registration makes the covenant watched, the watcher's SSE delivers
        // `vtxo_spent`, and the record resolves without anyone scanning history.
        // A second offer, because the one above is already spent.
        //
        // The cancel is submitted against a DIFFERENT repository on purpose.
        // `cancelOffer` records its own outcome, so cancelling into the watched
        // store would resolve the record before the event arrived and this test
        // could not tell the two apart. Cancelling elsewhere is also the case
        // that actually exercises the classifier: another device's cancel, read
        // back off the spending transaction's covenant leaf.
        const elsewhere = new InMemoryAssetSwapRepository();
        const swapRepository = new InMemoryAssetSwapRepository();
        const updates: AssetSwap[] = [];
        const watcher = await watchOfferSwaps({
            wallet,
            arkServerUrl: OPERATOR_URL,
            repository: swapRepository,
            onUpdate: (swap) => updates.push(swap),
        });

        try {
            const second = await createOffer(wallet, OPERATOR_URL, {
                wantAmount: WANT_AMOUNT + 1n,
                wantAsset,
            });
            const secondFundingTxid = await wallet.send({
                address: second.address,
                amount: DEPOSIT_SATS,
                extensions: [second.extension],
            });
            const secondScript = hex.encode(second.swapPkScript);
            await waitFor(async () => {
                const { vtxos } = await indexer.getVtxos({ scripts: [secondScript] });
                return vtxos.some((v) => v.txid === secondFundingTxid);
            });

            // the record the watcher will resolve. `pending`, as createOffer
            // leaves it — the watcher's job is to move it
            await addAssetSwap(swapRepository, {
                id: secondFundingTxid,
                fromAsset: "btc",
                toAsset: wantAsset.toString(),
                fromAmount: String(DEPOSIT_SATS),
                toAmount: (WANT_AMOUNT + 1n).toString(),
                swapAddress: second.address,
                swapPkScript: secondScript,
                offerHex: second.offerHex,
                fundingTxid: secondFundingTxid,
                status: "pending",
                createdAt: Date.now(),
            });

            await cancelOffer(wallet, OPERATOR_URL, second.offerHex, {
                repository: elsewhere,
                fundingTxid: secondFundingTxid,
                swapAddress: second.address,
            });

            // no restoreAssetSwaps anywhere in this test: the event carries it
            await waitFor(async () => {
                await watcher.idle();
                const [swap] = await getAssetSwaps(swapRepository);
                return swap?.status === "cancelled";
            });
            const [resolved] = await getAssetSwaps(swapRepository);
            expect(resolved.spentTxid).toBeTruthy();
            expect(updates.map((u) => u.status)).toContain("cancelled");

            // and the settled script leaves the watched set: no live record is
            // left at it, so the row is kept for history and dropped from every
            // background channel
            const rows = await (await wallet.getContractManager()).getContracts();
            expect(rows.find((c) => c.script === secondScript)?.watch).toBe("retained");
        } finally {
            watcher.stop();
        }
    }, 180_000);
});

describe("asset swaps against solverd (regtest)", () => {
    // Discovery lives in beforeAll (a failure there fails every test with the
    // real error, and -t subset runs still discover). Each test arranges the
    // wallet state it needs through the buy/sell helpers — no-ops in the full
    // sequence, real buys and sells in a subset run — so any subset passes and
    // no test reads another test's leftovers.
    beforeAll(async () => {
        market = await solverMarket();
        btcSide = market.base_asset.id === "btc" ? "base" : "quote";
        assetLeg = btcSide === "base" ? market.quote_asset : market.base_asset;
        solverAssetBaseline = await solverAssetBalance();
    }, 60_000);

    // sell leftover asset back to the solver; the baseline pin makes
    // inventory restoration a check, not a hope
    afterAll(async () => {
        if (!assetLeg) return; // discovery failed, so nothing was ever funded
        await sellAllAssetForBtc();
        expect(await solverAssetBalance()).toBe(solverAssetBaseline);
    }, 180_000);

    it("swaps all BTC for the asset", async () => {
        // ALL the BTC: the deposit is the wallet's whole available balance. The
        // landing wait inside buyAssetWithBtc is the assertion
        await buyAssetWithBtc(await availableSats());
    }, 180_000);

    it("swaps all of the asset back to BTC", async () => {
        // own both legs: normalize to BTC first (the sale's proceeds are the
        // BTC this test needs), so the baseline is this test's own and nothing
        // is read from the previous test's state
        await sellAllAssetForBtc();
        const startAvailable = await availableSats();
        await buyAssetWithBtc(startAvailable);

        await sellAllAssetForBtc();

        // buying and selling back ends where it started, minus the solver's
        // fee on both legs: the carrier nets out (the inbound fill pays it,
        // the reversal's deposit spends it) and no asset is left
        expect(await availableSats()).toBeLessThan(startAvailable);
        expect(await heldAssetAmount()).toBe(0n);
    }, 180_000);

    it("swaps a quarter of the BTC for the asset, leaving change", async () => {
        // normalize to no-asset: while any asset is held, `available` reserves
        // one dust carrier (wallet/balance.ts), so a pre-held asset output would
        // skew the exact change pin below by exactly one carrier
        await sellAllAssetForBtc();
        const startAvailable = await availableSats();
        const quarter = Math.floor(startAvailable / 4);
        await buyAssetWithBtc(quarter);

        // the BTC left behind is exactly the other three quarters: the asset's
        // carrier sats ride with the asset, so they never count toward available
        expect(await availableSats()).toBe(startAvailable - quarter);
    }, 180_000);

    it("swaps a quarter of the asset back to BTC, leaving change", async () => {
        // a standalone run has nothing to sell: buy half the BTC first
        if ((await heldAssetAmount()) === 0n) {
            await buyAssetWithBtc(Math.floor((await availableSats()) / 2));
        }
        const assetAmount = await heldAssetAmount();
        // BigInt division truncates: `assetAmount - quarter` below is the exact
        // residual, up to 3 units more than three literal quarters
        const quarter = assetAmount / 4n;

        await sellAssetForBtc(quarter);

        expect(await heldAssetAmount()).toBe(assetAmount - quarter);
    }, 180_000);

    it("cancels an oversized BTC to asset offer that the solver doesn't fill", async () => {
        // one unit over max_quote_amount: the bounds gate drops it at market
        // matching, before any price check — the solver never acknowledges it.
        // (No case under the minimum: the minimum is 1 unit, and a zero want
        // would let anyone take the deposit without paying anything.)
        const offer = await createOffer(wallet, OPERATOR_URL, {
            wantAmount: BigInt(market.max_quote_amount) + 1n,
            wantAsset: asset.AssetId.fromString(assetLeg.id),
        });
        const fundingTxid = await fundAndExpectNoFill(offer, { amount: DEPOSIT_SATS });

        const cancelTxid = await cancelOffer(wallet, OPERATOR_URL, offer.offerHex, {
            repository,
            fundingTxid,
            swapAddress: offer.address,
        });
        expect(cancelTxid).toBeTruthy();
        await waitFor(async () => (await wallet.getVtxos()).some((v) => v.txid === cancelTxid));
    }, 60_000);

    it("cancels an underbid BTC to asset offer that the solver doesn't fill", async () => {
        // ten times the quoted amount — inside the amount bounds, so the offer
        // matches the market, but a maker this greedy is outside the feed's
        // tolerance and the solver refuses to fill
        const plan = await quoteOffer(market, {
            give: btcSide,
            giveAmount: BigInt(DEPOSIT_SATS),
            safetyBps: QUOTE_OPTIONS.safetyBps,
        });
        const offer = await createOffer(wallet, OPERATOR_URL, {
            wantAmount: plan.receive.atomic * 10n,
            wantAsset: asset.AssetId.fromString(assetLeg.id),
        });
        const fundingTxid = await fundAndExpectNoFill(offer, { amount: DEPOSIT_SATS });

        const cancelTxid = await cancelOffer(wallet, OPERATOR_URL, offer.offerHex, {
            repository,
            fundingTxid,
            swapAddress: offer.address,
        });
        expect(cancelTxid).toBeTruthy();
        await waitFor(async () => (await wallet.getVtxos()).some((v) => v.txid === cancelTxid));
    }, 60_000);

    it("cancels an underbid asset to BTC offer that the solver doesn't fill", async () => {
        // a standalone run has nothing to deposit: buy half the BTC first
        if ((await heldAssetAmount()) === 0n) {
            await buyAssetWithBtc(Math.floor((await availableSats()) / 2));
        }
        // ten times the quoted BTC for a small asset deposit — inside the
        // amount bounds, but offering this little per sat is outside the
        // feed's tolerance and the solver refuses to fill
        const plan = await quoteOffer(market, {
            give: btcSide === "base" ? "quote" : "base",
            giveAmount: 1_000n,
            safetyBps: QUOTE_OPTIONS.safetyBps,
        });
        const offer = await createOffer(wallet, OPERATOR_URL, {
            wantAmount: plan.receive.atomic * 10n,
            offerAsset: asset.AssetId.fromString(assetLeg.id),
        });
        const fundingTxid = await fundAndExpectNoFill(offer, {
            amount: Number(ASSET_CARRIER_SATS),
            assets: [{ assetId: assetLeg.id, amount: 1_000n }],
        });

        const cancelTxid = await cancelOffer(wallet, OPERATOR_URL, offer.offerHex, {
            repository,
            fundingTxid,
            swapAddress: offer.address,
        });
        expect(cancelTxid).toBeTruthy();
        await waitFor(async () => (await wallet.getVtxos()).some((v) => v.txid === cancelTxid));
    }, 60_000);
});

// expect.poll refuses to run outside a test (the beforeAll faucet wait needs
// this); vi.waitFor polls anywhere but retries ANY throw until the deadline —
// a real error (stack down, HTTP 500) would burn the whole timeout, so capture
// it, stop polling, and rethrow at once. Only a `false` (not ready yet) may spin.
const waitFor = (fn: () => Promise<boolean>, timeout = 30_000): Promise<void> => {
    let fatal: { err: unknown } | undefined;
    return vi
        .waitFor(
            async () => {
                if (fatal) return;
                let ready: boolean;
                try {
                    ready = await fn();
                } catch (err) {
                    fatal = { err };
                    return;
                }
                if (!ready) throw new Error("timeout in waitFor");
            },
            { timeout, interval: 500 },
        )
        .then(() => {
            if (fatal) throw fatal.err;
        });
};

/** The solver's BTC market, discovered from its own published card. */
const solverMarket = async (): Promise<Market> => {
    const response = await fetch(`${SOLVER_HTTP_URL}/v1/card`);
    if (!response.ok) throw new Error(`solver card: HTTP ${response.status}`);
    const card = await response.json();
    // the card names the feed by its in-docker hostname; the same feed is
    // published to the host, and nothing else about the market changes
    for (const m of card.markets ?? []) {
        if (typeof m.price_feed === "string" && m.price_feed.startsWith("http://pricefeed")) {
            m.price_feed = m.price_feed.replace("http://pricefeed", PRICEFEED_URL);
        }
    }
    // registries: [] — hermetic: the local card is the only source, never the
    // network's published default index (discoverMarkets cannot express this)
    const { markets, warnings } = await discover({
        registries: [],
        localCards: [{ card }],
        network: "regtest",
    });
    const market = markets.find((m) => m.base_asset.id === "btc" || m.quote_asset.id === "btc");
    if (!market) {
        throw new Error(`solverd card advertises no BTC market (${warnings.join("; ")})`);
    }
    return market;
};

/** Fund an offer and wait for solverd to fill it, resolving live off the
 * wallet's own spend event. The watcher subscribes BEFORE the send, so the
 * fill can only ever arrive as a live event — fund-first ordering let
 * solverd outrun the subscription, and the start-up pass took the fill,
 * which fails the completedAt pin below. The record is written synchronously
 * behind the send, long before solverd can possibly react, so the live
 * handler always has it. completedAt proves the live path took it: only the
 * vtxo_spent handler writes it. */
const fundAndAwaitFill = async (
    offer: Awaited<ReturnType<typeof createOffer>>,
    deposit: { amount: number; assets?: Asset[] },
    legs: { fromAsset: string; toAsset: string; fromAmount: string; toAmount: string },
): Promise<void> => {
    const repository = new InMemoryAssetSwapRepository();
    const watcher = await watchOfferSwaps({ wallet, arkServerUrl: OPERATOR_URL, repository });
    const fundingTxid = await wallet.send({
        address: offer.address,
        extensions: [offer.extension],
        ...deposit,
    });
    await addAssetSwap(repository, {
        id: fundingTxid,
        ...legs,
        swapAddress: offer.address,
        swapPkScript: hex.encode(offer.swapPkScript),
        offerHex: offer.offerHex,
        fundingTxid,
        status: "pending",
        createdAt: Date.now(),
    });

    let resolved: AssetSwap | undefined;
    try {
        await waitFor(async () => {
            await watcher.idle();
            [resolved] = await getAssetSwaps(repository);
            return resolved?.status === "fulfilled";
        }, 120_000);
        expect(resolved?.spentTxid).toBeTruthy();
        // set only from the live event's timestamp — the start-up pass passes
        // no `at`, so this is what makes the wait above a live-fill assertion
        expect(
            resolved?.completedAt,
            "completedAt unset: the start-up pass caught the fill, not the live event",
        ).toBeTruthy();
    } finally {
        watcher.stop();
    }
};

/** The wallet's spendable BTC balance. */
const availableSats = async (): Promise<number> => (await wallet.getBalance()).available;

/** The wallet's current holding of the suite's asset leg. */
const heldAssetAmount = async (): Promise<bigint> => {
    const held = (await wallet.getBalance()).assets.find((a) => a.assetId === assetLeg.id);
    return BigInt(held?.amount ?? 0);
};

/** The solver's current balance of the suite's asset leg, off its own API. */
const solverAssetBalance = async (): Promise<bigint> => {
    const response = await fetch(`${SOLVER_HTTP_URL}/v1/balance`);
    if (!response.ok) throw new Error(`solver balance: HTTP ${response.status}`);
    const body = await response.json();
    return BigInt(body.asset_balances?.[assetLeg.id] ?? 0);
};

/** Buy the asset with `sats` of BTC, waiting until the bought amount is
 * spendable in the wallet — the inbound output is a separate event from the
 * fill resolving, and a later sell can only spend what has landed. */
const buyAssetWithBtc = async (sats: number) => {
    const plan = await quoteOffer(market, {
        give: btcSide,
        giveAmount: BigInt(sats),
        safetyBps: QUOTE_OPTIONS.safetyBps,
    });
    expect(plan.receive.asset.id).toBe(assetLeg.id);
    expect(plan.receive.atomic).toBeGreaterThan(0n);

    const offer = await createOffer(wallet, OPERATOR_URL, {
        wantAmount: plan.receive.atomic,
        wantAsset: asset.AssetId.fromString(assetLeg.id),
    });
    const before = await heldAssetAmount();
    await fundAndAwaitFill(
        offer,
        { amount: sats },
        {
            fromAsset: "btc",
            toAsset: assetLeg.id,
            fromAmount: String(sats),
            toAmount: plan.receive.atomic.toString(),
        },
    );
    await waitFor(async () => (await heldAssetAmount()) >= before + plan.receive.atomic, 120_000);
};

/** Sell `amount` of the asset back to BTC, waiting until the proceeds are
 * spendable — they land with the fill, separately from the record resolving.
 * The wait absorbs one carrier: a partial sell pays the deposit's carrier out
 * of available BTC, an all-in sell nets it against the asset output's own. */
const sellAssetForBtc = async (amount: bigint) => {
    if (amount <= 0n) throw new Error("sellAssetForBtc: nothing to sell");
    const plan = await quoteOffer(market, {
        give: btcSide === "base" ? "quote" : "base",
        giveAmount: amount,
        safetyBps: QUOTE_OPTIONS.safetyBps,
    });
    expect(plan.receive.asset.id).toBe("btc");
    expect(plan.receive.atomic).toBeGreaterThan(0n);

    const offer = await createOffer(wallet, OPERATOR_URL, {
        wantAmount: plan.receive.atomic,
        offerAsset: asset.AssetId.fromString(assetLeg.id),
    });
    const before = await availableSats();
    await fundAndAwaitFill(
        offer,
        {
            amount: Number(ASSET_CARRIER_SATS),
            assets: [{ assetId: assetLeg.id, amount }],
        },
        {
            fromAsset: assetLeg.id,
            toAsset: "btc",
            fromAmount: amount.toString(),
            toAmount: plan.receive.atomic.toString(),
        },
    );
    await waitFor(
        async () =>
            (await availableSats()) >=
            before + Number(plan.receive.atomic) - Number(ASSET_CARRIER_SATS),
        120_000,
    );
};

/** Sell every held unit of the asset back to BTC; a no-op when none is held. */
const sellAllAssetForBtc = async (): Promise<void> => {
    const held = await heldAssetAmount();
    if (held > 0n) await sellAssetForBtc(held);
};

/** Fund an offer the solver must never fill, wait long enough for a fill to
 * land, and assert the deposit was not touched. */
const fundAndExpectNoFill = async (
    offer: Awaited<ReturnType<typeof createOffer>>,
    deposit: { amount: number; assets?: Asset[] },
): Promise<string> => {
    const fundingTxid = await wallet.send({
        address: offer.address,
        extensions: [offer.extension],
        ...deposit,
    });
    await new Promise((r) => setTimeout(r, FILL_WAIT_MS));
    const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(offer.swapPkScript)] });
    const vtxo = vtxos.find((v) => v.txid === fundingTxid);
    // a missing deposit must fail, not pass vacuously: undefined is never spent
    expect(vtxo).toBeDefined();
    expect(vtxo?.isSpent).toBe(false);
    return fundingTxid;
};
