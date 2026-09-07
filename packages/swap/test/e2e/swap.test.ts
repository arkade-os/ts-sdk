/**
 * The maker-side swap loop against the real regtest stack: derive an offer
 * (arkd + emulator infos), fund its covenant address with the offer packet
 * embedded, rebuild the record from chain data alone, cancel cooperatively
 * (the 2-of-2 maker+server spend), and restore the cancel classification.
 *
 * This is the package's persistence contract exercised end to end: offerHex +
 * fundingTxid is all a maker must keep — everything else comes back from the
 * indexer.
 *
 * The second block is the fill, against the stack's own solverd: every swap
 * shape a wallet can put through it, in both directions, and what the wallet
 * sees of each before and after a restore or a reload. The regtest `solver`
 * profile funds solverd, mints a regtest asset (RGT) and registers a BTC/RGT
 * market on a mock feed, so an offer priced off the solver's own card is
 * taken within seconds of funding, and one priced away from the feed is
 * looked at and declined — which is how a deposit is made to stay pending.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import {
    ArkAddress,
    asset,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    type Asset,
} from "@arkade-os/sdk";
import { planOffer, type Market, type OfferPlan } from "@arkade-os/solver-discovery";
import {
    addAssetSwap,
    BTC_ASSET_ID,
    cancelOffer,
    createOffer,
    decodeOffer,
    getAssetSwaps,
    InMemoryAssetSwapRepository,
    QUOTE_OPTIONS,
    restoreAssetSwaps,
    validatePlan,
    watchOfferSwaps,
    type AssetSwap,
    type AssetSwapRepository,
    type OfferSwapWatcher,
    type Tx,
} from "../../src";

const ARK_URL = "http://localhost:7070";
// mempool serves the Esplora REST API under `/api`; the root path is the HTML UI
const ESPLORA_API_URL = "http://localhost:3000/api";
/** solverd's HTTP gateway: the regtest stack remaps the container's 7171 here. */
const SOLVER_URL = "http://localhost:7091";
/** The mock feed the solver's regtest market prices from, on its published port. */
const PRICEFEED_URL = "http://localhost:8088";
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
const repository = new InMemoryAssetSwapRepository();
let wallet: Wallet;
// the key the covenants are funded against — restore classifies each spend by
// the covenant leaf it took, so it has to rebuild the same script
let operatorPubkey: Uint8Array;

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

    it("derives, funds, and restores a pending offer from chain data alone", async () => {
        // no override — asserts the default pin matches the regtest stack
        offer = await createOffer(wallet, ARK_URL, {
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

    // The Phase 2 merge gate: everything below runs through the real
    // createOffer -> register -> ContractManager path above, never a hand-built
    // contract row, because a hand-marked fixture cannot catch a writer that
    // omits or misspells the marker.
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
        // the §3 hazard as a behaviour test: without the marker, coin selection
        // picks the offer deposit like any other UTXO, the server co-signs the
        // covenant's untimelocked cancel leaf, and the offer silently ceases to
        // exist. This send only succeeds if that happens.
        // an amount the wallet can only reach by dipping into the deposit:
        // under the totals (which count it, per D1c) but above what is left
        // once it is excluded
        const balance = await wallet.getBalance();
        const needsTheDeposit =
            balance.settled + balance.preconfirmed - Math.floor(DEPOSIT_SATS / 2);

        await expect(
            wallet.send({ address: await wallet.getAddress(), amount: needsTheDeposit }),
        ).rejects.toThrow();

        // and the deposit is still there to be cancelled below
        const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(offer.swapPkScript)] });
        expect(vtxos.find((v) => v.txid === fundingTxid)?.virtualStatus.state).not.toBe("spent");
    }, 120_000);

    it("cancels the deposit cooperatively and restores it as cancelled", async () => {
        // cancel from the chain-recovered bytes, not the createOffer result:
        // this is the restored-wallet path, plus the swapAddress pin.
        // It doubles as the escape-hatch assertion: cancel names its input
        // outpoint, so the escrow marker must not close the one spend route the
        // maker actually owns. A future tightening that gates explicit inputs
        // would strand every offer deposit, and would fail here.
        const cancelTxid = await cancelOffer(wallet, ARK_URL, restoredOfferHex, {
            repository,
            fundingTxid,
            swapAddress: offer.address,
        });
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

    it("drives status from the wallet's own spend event, with no restore call", async () => {
        // Phase 3 end to end, and the half no unit test can reach: registration
        // makes the covenant watched, the watcher's SSE delivers `vtxo_spent`,
        // and the record resolves without anyone scanning history. A second
        // offer, because the one above is already spent.
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
            arkServerUrl: ARK_URL,
            repository: swapRepository,
            onUpdate: (swap) => updates.push(swap),
        });

        try {
            const second = await createOffer(wallet, ARK_URL, {
                wantAmount: WANT_AMOUNT + BigInt(1),
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
                toAmount: (WANT_AMOUNT + BigInt(1)).toString(),
                swapAddress: second.address,
                swapPkScript: secondScript,
                offerHex: second.offerHex,
                fundingTxid: secondFundingTxid,
                status: "pending",
                createdAt: Date.now(),
            });

            await cancelOffer(wallet, ARK_URL, second.offerHex, {
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

// ---------------------------------------------------------------------------
// The fill, against solverd
// ---------------------------------------------------------------------------

/** The wallet's own storage — what a restore loses and a reload keeps. */
interface WalletRepos {
    walletRepository: InMemoryWalletRepository;
    contractRepository: InMemoryContractRepository;
}

const newRepos = (): WalletRepos => ({
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
});

/**
 * A wallet on the given repositories, fresh ones by default. Called twice
 * with one key and fresh repositories it yields the restore case: same funds
 * on chain, nothing remembered locally. Called again on the SAME repositories
 * it yields the reload case: an app refresh, everything remembered.
 */
const createWallet = async (keyHex: string, repos: WalletRepos = newRepos()): Promise<Wallet> =>
    Wallet.create({
        identity: SingleKey.fromHex(keyHex),
        arkServerUrl: ARK_URL,
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: repos,
        settlementConfig: false,
    });

/** Fund `wallet` offchain from the arkd CLI wallet, a fresh note each time. */
const faucet = async (wallet: Wallet, sats: number): Promise<void> => {
    const before = (await wallet.getBalance()).available;
    const note = execCommand(`${arkdExec} arkd note --amount ${Math.max(200_000, sats * 2)}`);
    execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    const address = await wallet.getAddress();
    execCommand(`${arkdExec} ark send --to ${address} --amount ${sats} --password secret`);
    await waitFor(async () => (await wallet.getBalance()).available >= before + sats);
};

const assetAmount = (assets: readonly Asset[], assetId: string): bigint =>
    assets.find((a) => a.assetId === assetId)?.amount ?? BigInt(0);

/** The deposit `txid` at `script`, as the indexer sees it, or undefined. */
const vtxoAt = async (script: string, txid: string) =>
    (await indexer.getVtxos({ scripts: [script] })).vtxos.find((v) => v.txid === txid);

/**
 * The wallet's own history in the shape the restore scan reads — the mapping a
 * consumer applies to `getTransactionHistory()` (arkade.money's
 * `arkTransactionToTx`): the ark txid is the funding tx's identity, the type
 * is lower-cased, and the time is unix seconds.
 */
const historyOf = async (wallet: Wallet): Promise<Tx[]> =>
    (await wallet.getTransactionHistory()).map((tx) => ({
        type: tx.type.toLowerCase(),
        redeemTxid: tx.key.arkTxid,
        roundTxid: tx.key.commitmentTxid,
        boardingTxid: tx.key.boardingTxid,
        createdAt: Math.floor(tx.createdAt / 1000),
    }));

/** The history once it names every txid in `txids` — a fresh wallet syncs it. */
const historyWith = async (wallet: Wallet, txids: string[]): Promise<Tx[]> => {
    let history: Tx[] = [];
    await waitFor(
        async () => {
            history = await historyOf(wallet);
            return txids.every((id) => history.some((tx) => tx.redeemTxid === id));
        },
        { timeout: 60_000 },
    );
    return history;
};

const getJson = async (url: string, what: string): Promise<any> => {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(
            `${what}: ${url} -> HTTP ${res.status} — is the regtest \`solver\` profile up, and ` +
                "its SOLVER_IMAGE new enough to serve it?",
        );
    }
    return res.json();
};

/**
 * The solver's own card, and its feed's current value — what a wallet's
 * discovery hands the quote. The card names the feed by its docker-network
 * host; from here it is the mock feed's published port, same path.
 */
const solverMarket = async (): Promise<{ market: Market; feedValue: number }> => {
    const card = (await getJson(`${SOLVER_URL}/v1/card?name=regtest`, "solver card")) as {
        markets: Market[];
    };
    const found = card.markets.find((m) => m.base_asset.id === BTC_ASSET_ID);
    if (!found?.price_feed || !found.price_feed_schema) {
        throw new Error(
            "solverd advertises no BTC market with a feed — is the `solver` profile up?",
        );
    }
    const body = await getJson(
        `${PRICEFEED_URL}${new URL(found.price_feed).pathname}`,
        "the solver's price feed",
    );
    const value = found.price_feed_schema.price_path
        .split("/")
        .filter(Boolean)
        .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], body);
    return { market: found, feedValue: Number(value) };
};

describe("the swap, against solverd (regtest)", () => {
    const SOLVER_FAUCET_SATS = 20_000;
    /** How long a fill may take once the funding tx is on the stream. */
    const FILL_TIMEOUT = 90_000;
    /** How long the solver gets to look at an offer it will decline. */
    const DECLINE_GRACE_MS = 4_000;
    /**
     * The sats solverd puts under an asset payout: its own constant (330, in
     * `FulfillOffer`), not the server's dust — the two agree on this stack,
     * but the arithmetic below names the one it actually depends on.
     */
    const SOLVER_CARRIER = 330;

    const keyHex = SingleKey.fromRandomBytes().toHex();
    const makerRepos = newRepos();
    let maker: Wallet;
    let makerRepository: AssetSwapRepository;
    let makerWatcher: OfferSwapWatcher;
    let serverPubkey: Uint8Array;
    let dust: bigint;
    let market: Market;
    let feedValue: number;
    let rgt: string;

    const btcToRgt = (sats: number | bigint): OfferPlan =>
        planOffer({ market, give: "base", feedValue, giveAmount: BigInt(sats), ...QUOTE_OPTIONS });
    const rgtToBtc = (units: bigint): OfferPlan =>
        planOffer({ market, give: "quote", feedValue, giveAmount: units, ...QUOTE_OPTIONS });

    /** A want the solver will look at and decline: twice the fair amount. */
    const wrongPrice = (plan: OfferPlan): bigint => plan.receive.atomic * BigInt(2);

    const rgtHeld = async (wallet: Wallet) =>
        assetAmount((await wallet.getBalance()).availableAssets, rgt);

    /** Sats for the next deposit, whatever the earlier cases left behind. */
    const ensureSats = async (min: number) => {
        if ((await maker.getBalance()).available < min) await faucet(maker, SOLVER_FAUCET_SATS);
    };

    /**
     * RGT for the next asset deposit. The maker's asset balance is shared
     * across these cases, and a restore case runs a second wallet on the same
     * key that can spend or strand the shared coins, so a case that needs RGT
     * buys it fresh here with a fair BTC -> RGT swap rather than counting on a
     * carry-over. Buying at a price the solver takes, this never hits the
     * swap-all hazard: the deposit is a bounded BTC amount, not the balance.
     */
    const ensureRgt = async (minUnits: number) => {
        if ((await rgtHeld(maker)) >= BigInt(minUnits)) return;
        const give = minUnits * 2;
        await ensureSats(give + 4 * Number(dust));
        const plan = btcToRgt(give);
        const { fundingTxid, script } = await publish(maker, plan, makerRepository);
        await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");
        await waitFor(async () => (await rgtHeld(maker)) >= BigInt(minUnits));
    };

    /**
     * What arkade.money's `createSwap` does with a plan: derive the offer
     * keyed on the receive side, fund it with the deposit side (sats, or the
     * asset on a dust carrier), and record it by its funding txid.
     * `wantAmount` overrides the plan's — how a test publishes an offer no
     * solver will take.
     */
    const publish = async (
        wallet: Wallet,
        plan: OfferPlan,
        repository: AssetSwapRepository,
        wantAmount = plan.receive.atomic,
    ) => {
        const wantsBtc = plan.receive.asset.id === BTC_ASSET_ID;
        const depositsBtc = plan.deposit.asset.id === BTC_ASSET_ID;
        const offer = await createOffer(wallet, ARK_URL, {
            wantAmount,
            ...(wantsBtc
                ? { offerAsset: asset.AssetId.fromString(plan.deposit.asset.id) }
                : { wantAsset: asset.AssetId.fromString(plan.receive.asset.id) }),
        });
        const fundingTxid = await wallet.send({
            address: offer.address,
            ...(depositsBtc
                ? { amount: Number(plan.deposit.atomic) }
                : { assets: [{ assetId: plan.deposit.asset.id, amount: plan.deposit.atomic }] }),
            extensions: [offer.extension],
        });
        const swap: AssetSwap = {
            id: fundingTxid,
            fromAsset: plan.deposit.asset.id,
            toAsset: plan.receive.asset.id,
            fromAmount: plan.deposit.atomic.toString(),
            toAmount: wantAmount.toString(),
            swapAddress: offer.address,
            swapPkScript: hex.encode(offer.swapPkScript),
            offerHex: offer.offerHex,
            fundingTxid,
            status: "pending",
            createdAt: Date.now(),
        };
        await addAssetSwap(repository, swap);
        const script = hex.encode(offer.swapPkScript);
        await waitFor(async () => Boolean(await vtxoAt(script, fundingTxid)));
        return { offer, fundingTxid, swap, script };
    };

    const statusOf = async (repository: AssetSwapRepository, id: string) =>
        (await getAssetSwaps(repository)).find((s) => s.id === id);

    /**
     * The watcher-driven resolution: no scan anywhere, the event carries it.
     * On a miss, says what the record reads against what the chain says of
     * its deposit — the two disagreeing is the finding.
     */
    const untilStatus = async (
        watcher: OfferSwapWatcher,
        repository: AssetSwapRepository,
        id: string,
        script: string,
        status: AssetSwap["status"],
    ) => {
        try {
            await waitFor(
                async () => {
                    await watcher.idle();
                    return (await statusOf(repository, id))?.status === status;
                },
                { timeout: FILL_TIMEOUT },
            );
        } catch {
            const record = await statusOf(repository, id);
            const deposit = await vtxoAt(script, id);
            throw new Error(
                `record ${id} reads "${record?.status}" ${FILL_TIMEOUT} ms on, expected ` +
                    `"${status}" — its deposit is ${deposit?.virtualStatus.state ?? "unknown"} on chain`,
            );
        }
    };

    /** The solver had its look and passed: still pending, still unspent. */
    const stillPending = async (repository: AssetSwapRepository, script: string, id: string) => {
        await new Promise((r) => setTimeout(r, DECLINE_GRACE_MS));
        await makerWatcher.idle();
        expect((await statusOf(repository, id))?.status).toBe("pending");
        expect((await vtxoAt(script, id))?.virtualStatus.state).not.toBe("spent");
    };

    /**
     * A wallet rebuilt from its key alone, with every record the chain still
     * carries for it: the restore scan over its own history, and the records
     * stored. What arkade.money does on "restore wallet".
     */
    const restoreFromKey = async (txids: string[]) => {
        const wallet = await createWallet(keyHex);
        const repository = new InMemoryAssetSwapRepository();
        const history = await historyWith(wallet, txids);
        const { restored } = await restoreAssetSwaps(indexer, history, new Set(), {
            serverPubkey,
        });
        for (const swap of restored) await addAssetSwap(repository, swap);
        return { wallet, repository, restored };
    };

    beforeAll(async () => {
        // the solver-init step registers the market after the stack reports
        // up; wait for it here rather than in the shared setup
        await waitFor(
            async () => {
                const res = await fetch(`${SOLVER_URL}/v1/markets`).catch(() => undefined);
                const body = res?.ok ? await res.json() : undefined;
                return Array.isArray(body?.markets) && body.markets.length > 0;
            },
            { timeout: 90_000, interval: 2_000 },
        );
        ({ market, feedValue } = await solverMarket());
        rgt = market.quote_asset.id;

        maker = await createWallet(keyHex, makerRepos);
        await faucet(maker, SOLVER_FAUCET_SATS);
        serverPubkey = ArkAddress.decode(await maker.getAddress()).serverPubKey;
        dust = maker.dustAmount;
        makerRepository = new InMemoryAssetSwapRepository();
        makerWatcher = await watchOfferSwaps({
            wallet: maker,
            arkServerUrl: ARK_URL,
            repository: makerRepository,
        });
    }, 180_000);

    afterAll(async () => {
        makerWatcher?.stop();
        await maker?.dispose().catch(() => {});
    });

    it("BTC -> RGT leaving change: quoted off the card, validated, funded, and filled", async () => {
        const plan = btcToRgt(10_000);
        expect(plan.deposit.atomic).toBe(BigInt(10_000));
        expect(plan.receive.atomic).toBeGreaterThan(BigInt(0));
        const { available } = await maker.getBalance();
        expect(validatePlan(plan, BigInt(available), dust)).toBeUndefined();

        const { fundingTxid, script } = await publish(maker, plan, makerRepository);
        await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");
        const filled = await statusOf(makerRepository, fundingTxid);
        expect(filled?.spentTxid).toBeTruthy();
        expect(filled?.completedAt).toBeGreaterThan(0);
        expect((await vtxoAt(script, fundingTxid))?.virtualStatus.state).toBe("spent");

        // the asset is in the wallet, spendable, on the solver's carrier; the
        // change from the funding is still here too
        await waitFor(async () => (await rgtHeld(maker)) >= plan.receive.atomic);
        expect((await maker.getBalance()).available).toBe(
            SOLVER_FAUCET_SATS - 10_000 + SOLVER_CARRIER,
        );
    }, 180_000);

    it("swap ALL BTC -> RGT: the balance the wallet reports available funds the offer, and it fills", async () => {
        // the case arkade.money's Max button hits: a wallet that has received
        // an asset offers every sat the wallet says it can spend
        const held = await rgtHeld(maker);
        expect(held).toBeGreaterThan(BigInt(0));
        const { available } = await maker.getBalance();
        const plan = btcToRgt(available);
        expect(validatePlan(plan, BigInt(available), dust)).toBeUndefined();

        let published: Awaited<ReturnType<typeof publish>>;
        try {
            published = await publish(maker, plan, makerRepository);
        } catch (err) {
            throw new Error(
                `funding the offer with the wallet's own available balance (${available} sats, ` +
                    `${held} RGT held) was refused: ${err instanceof Error ? err.message : err}`,
            );
        }
        const { fundingTxid, script } = published;
        await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");
        // the asset it held stayed, and the asset it bought arrived
        await waitFor(async () => (await rgtHeld(maker)) === held + plan.receive.atomic);
    }, 180_000);

    it("RGT -> BTC leaving asset change: part of the balance goes, the solver pays sats, the rest stays", async () => {
        await ensureSats(Number(dust));
        const held = await rgtHeld(maker);
        const units = BigInt(2_000);
        expect(held).toBeGreaterThan(units);
        const plan = rgtToBtc(units);
        expect(plan.deposit.atomic).toBe(units);
        expect(validatePlan(plan, held, dust)).toBeUndefined();
        const satsBefore = (await maker.getBalance()).available;

        const { fundingTxid, script } = await publish(maker, plan, makerRepository);
        await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");

        // the asset change rode the funding's change output and is spendable
        // again; the sats the solver paid are here, net of the carrier the
        // asset rode out on
        await waitFor(async () => {
            const balance = await maker.getBalance();
            return (
                assetAmount(balance.availableAssets, rgt) === held - units &&
                balance.available >= satsBefore - Number(dust) + Number(plan.receive.atomic)
            );
        });
        expect((await maker.getBalance()).available).toBe(
            satsBefore - Number(dust) + Number(plan.receive.atomic),
        );
    }, 180_000);

    it("RGT -> BTC at the WRONG price stays pending, and cancels", async () => {
        await ensureSats(Number(dust));
        const held = await rgtHeld(maker);
        // a deposit whose doubled want (2_200) is no earlier offer's want, so
        // the covenant script is this case's alone — identical offers share an
        // address, and a reused script would tangle these deposits together
        const plan = rgtToBtc(BigInt(1_100));
        // wanting twice the fair sats: the solver looks, declines, and the
        // deposit stays where the maker put it
        const { fundingTxid, script, swap } = await publish(
            maker,
            plan,
            makerRepository,
            wrongPrice(plan),
        );
        await stillPending(makerRepository, script, fundingTxid);
        // escrowed as an asset meanwhile: owned, not spendable
        expect(await rgtHeld(maker)).toBe(held - plan.deposit.atomic);

        await cancelOffer(maker, ARK_URL, swap.offerHex, {
            repository: makerRepository,
            fundingTxid,
            swapAddress: swap.swapAddress,
        });
        expect((await statusOf(makerRepository, fundingTxid))?.status).toBe("cancelled");
        await waitFor(async () => (await rgtHeld(maker)) === held);
    }, 180_000);

    it("RGT -> BTC at the WRONG price, restored from the key alone, then cancelled from the restored wallet", async () => {
        await ensureSats(Number(dust));
        const held = await rgtHeld(maker);
        // want 2_600, distinct from every other case's, so this deposit has
        // its own covenant script
        const plan = rgtToBtc(BigInt(1_300));
        const untaken = await publish(maker, plan, makerRepository, wrongPrice(plan));
        await stillPending(makerRepository, untaken.script, untaken.fundingTxid);

        // the wallet comes back with its key alone: the record is rebuilt
        // from chain data, and the offer is still the wallet's to delete
        const restored = await restoreFromKey([untaken.fundingTxid]);
        try {
            const record = restored.restored.find((s) => s.id === untaken.fundingTxid);
            expect(record).toMatchObject({
                status: "pending",
                fromAsset: rgt,
                fromAmount: plan.deposit.atomic.toString(),
                toAsset: BTC_ASSET_ID,
                toAmount: wrongPrice(plan).toString(),
                offerHex: untaken.swap.offerHex,
            });

            // the escrowed deposit is the restored wallet's asset: a wallet
            // that re-registered the covenant owns it — gated, not spendable,
            // but still counted in the total the user sees. On master nothing
            // re-covers the covenant after a restore, so the restored wallet
            // cannot see the escrowed asset at all: it reads as vanished until
            // the cancel brings it back. That gap is what this case shows —
            // the live maker, which never lost the registration, still owns it
            const makerOwned = assetAmount((await maker.getBalance()).assets, rgt);
            expect(assetAmount((await restored.wallet.getBalance()).assets, rgt)).toBe(makerOwned);

            // deleted from the restored wallet, with what a restored record
            // has: the offer bytes and the funding txid, no address
            await cancelOffer(restored.wallet, ARK_URL, record!.offerHex, {
                repository: restored.repository,
                fundingTxid: untaken.fundingTxid,
            });
            expect((await statusOf(restored.repository, untaken.fundingTxid))?.status).toBe(
                "cancelled",
            );
            // the asset is home, in the restored wallet and the live one alike
            await waitFor(async () => (await rgtHeld(restored.wallet)) === held);
            await waitFor(async () => (await rgtHeld(maker)) === held);
            // and the live wallet's watcher reads the same cancel off the leaf
            await untilStatus(
                makerWatcher,
                makerRepository,
                untaken.fundingTxid,
                untaken.script,
                "cancelled",
            );
        } finally {
            await restored.wallet.dispose().catch(() => {});
        }
    }, 240_000);

    it("RGT -> BTC restored before the solver takes it: the restored wallet sees the fill", async () => {
        // Stage "published, restored, then taken": solverd matches offers off
        // arkd's live tx stream, so pausing its container holds the funding
        // tx on the stream until the restored wallet is watching.
        //
        // The pause has to stay short. arkd pings its stream clients and
        // closes one that stays silent for ~50 s, and solverd reconnects to a
        // stream that replays nothing — so the restored wallet is brought up
        // and synced BEFORE the pause, and the paused window holds only the
        // funding and the incremental sync that follows it.
        //
        // The RGT is bought before the pause: the top-up itself is a swap, and
        // the solver has to be running to take it.
        await ensureRgt(1_500);
        await ensureSats(Number(dust));
        const plan = rgtToBtc(BigInt(1_500));
        const restoredRepository = new InMemoryAssetSwapRepository();
        const restoredWallet = await createWallet(keyHex);
        await historyOf(restoredWallet);
        const satsBefore = (await restoredWallet.getBalance()).available;
        let restoredWatcher: OfferSwapWatcher | undefined;
        execCommand("docker pause solver");
        const pausedAt = Date.now();
        try {
            const { fundingTxid, script } = await publish(maker, plan, makerRepository);

            const history = await historyWith(restoredWallet, [fundingTxid]);
            const { restored } = await restoreAssetSwaps(indexer, history, new Set(), {
                serverPubkey,
            });
            const record = restored.find((s) => s.id === fundingTxid);
            expect(record?.status).toBe("pending");
            await addAssetSwap(restoredRepository, record!);
            restoredWatcher = await watchOfferSwaps({
                wallet: restoredWallet,
                arkServerUrl: ARK_URL,
                repository: restoredRepository,
            });

            execCommand("docker unpause solver");
            const pausedMs = Date.now() - pausedAt;

            // the solver takes it: the chain says so
            try {
                await waitFor(
                    async () =>
                        (await vtxoAt(script, fundingTxid))?.virtualStatus.state === "spent",
                    { timeout: FILL_TIMEOUT },
                );
            } catch (err) {
                throw new Error(
                    `no fill after unpausing the solver (paused ${pausedMs} ms; past ~50 s arkd ` +
                        `drops a silent stream client and solverd replays nothing): ${err}`,
                );
            }
            // a scan from nothing reads it fulfilled, off the leaf
            const rescanned = await restoreAssetSwaps(indexer, history, new Set(), {
                serverPubkey,
            });
            expect(rescanned.restored.find((s) => s.id === fundingTxid)?.status).toBe("fulfilled");
            // and so must the restored wallet's own record, through its watcher
            await untilStatus(
                restoredWatcher,
                restoredRepository,
                fundingTxid,
                script,
                "fulfilled",
            );
            const filled = await statusOf(restoredRepository, fundingTxid);
            expect(filled?.completedAt).toBeGreaterThan(0);
            expect(filled?.spentTxid).toBeTruthy();
            // the sats landed in the restored wallet — same key, same address.
            // Net of the dust the asset rode out on
            await waitFor(async () => {
                const balance = await restoredWallet.getBalance();
                return balance.available >= satsBefore - Number(dust) + Number(plan.receive.atomic);
            });
            // and the live wallet's watcher saw the same fill
            await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");
        } finally {
            try {
                execCommand("docker unpause solver");
            } catch {
                // already running
            }
            restoredWatcher?.stop();
            await restoredWallet.dispose().catch(() => {});
        }
    }, 240_000);

    it("swap ALL RGT -> BTC: the whole asset balance goes, and the solver pays sats", async () => {
        // sending the whole asset frees the carriers it rode on, so this
        // direction has no swap-all hazard and is expected to go through
        await ensureRgt(4_000);
        await ensureSats(Number(dust));
        const held = await rgtHeld(maker);
        expect(held).toBeGreaterThan(BigInt(0));
        const plan = rgtToBtc(held);
        expect(plan.deposit.atomic).toBe(held);
        expect(validatePlan(plan, held, dust)).toBeUndefined();
        const satsBefore = (await maker.getBalance()).available;

        const { fundingTxid, script } = await publish(maker, plan, makerRepository);
        await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");

        await waitFor(async () => {
            const balance = await maker.getBalance();
            return (
                assetAmount(balance.availableAssets, rgt) === BigInt(0) &&
                balance.available >= satsBefore - Number(dust) + Number(plan.receive.atomic)
            );
        });
        // every spendable unit went and the sats came back. `assets` (total)
        // can still hold RGT stranded in an earlier case's un-cancellable
        // escrow — that is those cases' defect, not this one's, so this reads
        // the spendable balance, which is what "swap all" moves
        const balance = await maker.getBalance();
        expect(assetAmount(balance.availableAssets, rgt)).toBe(BigInt(0));
        expect(balance.available).toBeGreaterThanOrEqual(
            satsBefore - Number(dust) + Number(plan.receive.atomic),
        );
    }, 180_000);

    it("reload on the same storage: a fill that landed while nothing watched is picked up, a pending offer still cancels", async () => {
        // An app refresh, not a restore: the wallet's repositories and the
        // swap store survive, only the Wallet instance and its watcher are
        // new. The fill lands in between — nothing is watching — so the new
        // watcher has to pick it up on its own. No restore scan anywhere.
        await ensureSats(2 * 1_000 + Number(dust));
        makerWatcher.stop();
        const plan = btcToRgt(1_000);
        const { fundingTxid, script } = await publish(maker, plan, makerRepository);
        await waitFor(
            async () => (await vtxoAt(script, fundingTxid))?.virtualStatus.state === "spent",
            {
                timeout: FILL_TIMEOUT,
            },
        );
        expect((await statusOf(makerRepository, fundingTxid))?.status).toBe("pending");
        await maker.dispose();

        maker = await createWallet(keyHex, makerRepos);
        makerWatcher = await watchOfferSwaps({
            wallet: maker,
            arkServerUrl: ARK_URL,
            repository: makerRepository,
        });
        await untilStatus(makerWatcher, makerRepository, fundingTxid, script, "fulfilled");
        expect((await statusOf(makerRepository, fundingTxid))?.spentTxid).toBeTruthy();
        await waitFor(async () => (await rgtHeld(maker)) >= plan.receive.atomic);

        // and the other half of a reload: an offer published before it is
        // still the wallet's to cancel after it
        const untaken = await publish(maker, plan, makerRepository, wrongPrice(plan));
        await stillPending(makerRepository, untaken.script, untaken.fundingTxid);
        makerWatcher.stop();
        await maker.dispose();
        maker = await createWallet(keyHex, makerRepos);
        makerWatcher = await watchOfferSwaps({
            wallet: maker,
            arkServerUrl: ARK_URL,
            repository: makerRepository,
        });
        await makerWatcher.idle();
        expect((await statusOf(makerRepository, untaken.fundingTxid))?.status).toBe("pending");
        await cancelOffer(maker, ARK_URL, untaken.swap.offerHex, {
            repository: makerRepository,
            fundingTxid: untaken.fundingTxid,
            swapAddress: untaken.swap.swapAddress,
        });
        expect((await statusOf(makerRepository, untaken.fundingTxid))?.status).toBe("cancelled");
    }, 240_000);

    it("restored from the key alone, every record reads the status the live wallet holds", async () => {
        // the state machine after a restore is the chain's answer: fills read
        // fulfilled, cancels read cancelled, each with the spend that did it,
        // and nothing reads pending whose deposit is gone
        const live = await getAssetSwaps(makerRepository);
        expect(live.length).toBeGreaterThan(0);

        const restored = await restoreFromKey(live.map((s) => s.fundingTxid));
        try {
            const byId = new Map(restored.restored.map((s) => [s.id, s]));
            expect([...byId.keys()].sort()).toEqual(live.map((s) => s.id).sort());
            for (const swap of live) {
                const back = byId.get(swap.id);
                expect(back).toMatchObject({
                    fromAsset: swap.fromAsset,
                    toAsset: swap.toAsset,
                    fromAmount: swap.fromAmount,
                    toAmount: swap.toAmount,
                    offerHex: swap.offerHex,
                });
                if (swap.status === "fulfilled") expect(back?.completedAt).toBeGreaterThan(0);
            }
            // the live wallet's records against the chain's: a live record
            // still pending whose deposit is spent is a status that went stale
            const stale = live
                .filter((s) => s.status === "pending")
                .filter((s) => byId.get(s.id)?.status !== "pending")
                .map((s) => `${s.id} reads pending, the chain reads ${byId.get(s.id)?.status}`);
            expect(stale).toEqual([]);
            expect(live.map((s) => [s.id, s.status, s.spentTxid])).toEqual(
                live.map((s) => [s.id, byId.get(s.id)?.status, byId.get(s.id)?.spentTxid]),
            );
        } finally {
            await restored.wallet.dispose().catch(() => {});
        }
    }, 180_000);
});
