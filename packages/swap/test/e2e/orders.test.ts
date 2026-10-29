/**
 * Partial-fill limit orders against the real stack: the emulator evaluates sell_order.ark and
 * buy_order.ark on every fill, settle and refusal below. The traded asset is issued at group
 * index 1, so every covenant lookup runs with a gidx other than 0.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { hex } from "@scure/base";
import {
    ArkNote,
    arkade,
    asset,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    type VirtualCoin,
} from "@arkade-os/sdk";
import type { FillFunding } from "../../src/offer";
import {
    cancelOrder,
    createOrder,
    fillOrder,
    orderContract,
    settleExpiredOrder,
    type Order,
    type OrderTerms,
} from "../../src/orders";

const OPERATOR_URL = process.env.ARK_SERVER_URL ?? "http://localhost:7070";
const ESPLORA_API_URL = process.env.ESPLORA_URL ?? "http://localhost:3000/api";
const EMULATOR_URL = process.env.EMULATOR_URL ?? "http://localhost:7073";
const PREFIX = process.env.REGTEST_CONTAINER_PREFIX ?? "";
const CARRIER = 330n;

const indexer = new RestIndexerProvider(OPERATOR_URL);

let alice: Wallet;
let bob: Wallet;
let carol: Wallet;
let gold: string;

beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([newWallet(), newWallet(), newWallet()]);
    await Promise.all([faucet(alice, 40_000), faucet(bob, 20_000), faucet(carol, 20_000)]);
    gold = await issueAtGroupOne(alice, 1_000n);
    const sent = await alice.send({
        address: await carol.getAddress(),
        assets: [{ assetId: gold, amount: 30n }],
    });
    await coinsOf(carol, sent);
}, 600_000);

describe("partial-fill limit orders (regtest)", { timeout: 300_000 }, () => {
    it("fills a sell order in parts and pays the maker on the last unit", async () => {
        const terms = await termsOf(alice, { side: "sell", priceSats: 600n, minFill: 2n });
        const placed = await createOrder(alice, await connect(alice), terms, 10n);
        const A = placed.contract.pkScript;
        let order: Order = { terms, coin: await coinAt(A, placed.txid) };
        const value = BigInt(order.coin.value);

        await expectCovenantRefusal(
            () => handFill(bob, order, 3n, { script: A, sats: value + 1799n, units: 7n }),
            "underpaid fill",
        );
        await expectCovenantRefusal(
            () => handFill(bob, order, 3n, { script: A, sats: value + 1800n, units: 6n }),
            "taker skims a unit",
        );
        await expectCovenantRefusal(
            () => handFill(bob, order, 1n, { script: A, sats: value + 600n, units: 9n }),
            "below min fill",
        );

        const bobClient = await connect(bob);
        const first = await fillOrder(bobClient, order, 3n, {
            fund: await coinsOf(bob),
            change: scriptOf(bob),
        });
        order = { terms, coin: await coinAt(A, first.txid) };
        expect(order.coin.value).toBe(Number(CARRIER + 1800n));
        expect(order.coin.assets).toEqual([{ assetId: gold, amount: 7n }]);

        const last = await fillOrder(bobClient, order, 7n, {
            fund: await coinsOf(bob, first.txid),
            change: scriptOf(bob),
        });
        const paid = await coinAt(terms.makerScript, last.txid);
        expect(paid.value).toBe(Number(CARRIER + 1800n + 4200n));
        expect(paid.assets ?? []).toEqual([]);
        expect(await liveCoins(A)).toEqual([]);
    });

    it("refuses a sell fill under 330 sats or leaving a remainder worth less", async () => {
        // A min fill worth under 330 sats, which `createOrder` refuses: funded by hand.
        const terms = await termsOf(alice, { side: "sell", priceSats: 200n });
        const D = orderContract(await connect(alice), terms);
        const txid = await alice.send({
            address: D.address,
            assets: [{ assetId: gold, amount: 6n }],
        });
        const order: Order = { terms, coin: await coinAt(D.pkScript, txid) };
        const value = BigInt(order.coin.value);

        const script = D.pkScript;
        await expectCovenantRefusal(
            () => handFill(bob, order, 1n, { script, sats: value + 200n, units: 5n }),
            "fill under 330 sats",
        );
        await expectCovenantRefusal(
            () => handFill(bob, order, 5n, { script, sats: value + 1000n, units: 1n }),
            "remainder under 330 sats",
        );
        const ok = await handFill(bob, order, 2n, { script, sats: value + 400n, units: 4n });
        expect((await coinAt(script, ok.txid)).assets).toEqual([{ assetId: gold, amount: 4n }]);
    });

    it("fills a buy order in parts and pays the maker the units on the closing fill", async () => {
        const terms = await termsOf(alice, { side: "buy", priceSats: 350n });
        const placed = await createOrder(alice, await connect(alice), terms, 10n);
        const B = placed.contract.pkScript;
        let order: Order = { terms, coin: await coinAt(B, placed.txid) };
        let value = BigInt(order.coin.value);
        expect(value).toBe(3500n + CARRIER);

        await expectCovenantRefusal(
            () => handFill(carol, order, 4n, { script: B, sats: value - 1401n, units: 4n }),
            "buy order overspent",
        );
        await expectCovenantRefusal(
            () => handFill(carol, order, 4n, { script: B, sats: value - 1400n, units: 3n }),
            "short delivery",
        );
        await expectCovenantRefusal(
            () =>
                handFill(carol, order, 4n, {
                    script: terms.makerScript,
                    sats: value - 1400n,
                    units: 4n,
                }),
            "closed while budget remains",
        );

        const carolClient = await connect(carol);
        const first = await fillOrder(carolClient, order, 4n, {
            fund: await coinsOf(carol),
            change: scriptOf(carol),
        });
        order = { terms, coin: await coinAt(B, first.txid) };
        value = BigInt(order.coin.value);
        expect(value).toBe(2100n + CARRIER);
        expect(order.coin.assets).toEqual([{ assetId: gold, amount: 4n }]);

        await expectCovenantRefusal(
            () => handFill(carol, order, 6n, { script: B, sats: value - 2100n, units: 10n }),
            "kept open with no budget left",
        );
        const closing = await fillOrder(carolClient, order, 6n, {
            fund: await coinsOf(carol, first.txid),
            change: scriptOf(carol),
        });
        const bought = await coinAt(terms.makerScript, closing.txid);
        expect(bought.value).toBe(Number(CARRIER));
        expect(bought.assets).toEqual([{ assetId: gold, amount: 10n }]);
        expect(await liveCoins(B)).toEqual([]);
    });

    it("fills before expiry, refuses after, and anyone returns the order to its maker", async () => {
        const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30);
        const ask = await termsOf(alice, { side: "sell", priceSats: 900n, expiresAt });
        const placedAsk = await createOrder(alice, await connect(alice), ask, 2n);
        const C = placedAsk.contract.pkScript;
        let sell: Order = { terms: ask, coin: await coinAt(C, placedAsk.txid) };
        // An unfilled bid holds no assets: its settle must work without an asset packet.
        const bid = await termsOf(alice, { side: "buy", priceSats: 100n, minFill: 4n, expiresAt });
        const placedBid = await createOrder(alice, await connect(alice), bid, 10n);
        const buy: Order = {
            terms: bid,
            coin: await coinAt(placedBid.contract.pkScript, placedBid.txid),
        };

        await expectCovenantRefusal(() => handSettle(sell, ask.makerScript), "settle while live");
        const live = await fillOrder(await connect(bob), sell, 1n, {
            fund: await coinsOf(bob),
            change: scriptOf(bob),
        });
        sell = { terms: ask, coin: await coinAt(C, live.txid) };
        await new Promise((r) => setTimeout(r, Number(expiresAt) * 1000 + 3_000 - Date.now()));

        await expectCovenantRefusal(
            () =>
                handFill(bob, sell, 1n, {
                    script: ask.makerScript,
                    sats: BigInt(sell.coin.value) + 900n,
                    units: 0n,
                }),
            "fill after expiry",
        );
        await expectCovenantRefusal(() => handSettle(sell, scriptOf(bob)), "settle to a stranger");

        const watcher = await connect();
        const settled = await settleExpiredOrder(watcher, sell);
        const returned = await coinAt(ask.makerScript, settled.txid);
        expect(returned.value).toBe(Number(CARRIER + 900n));
        expect(returned.assets).toEqual([{ assetId: gold, amount: 1n }]);

        const refunded = await settleExpiredOrder(watcher, buy);
        expect((await coinAt(bid.makerScript, refunded.txid)).value).toBe(buy.coin.value);
    });

    it("lets the maker cancel with the operator", async () => {
        const terms = await termsOf(alice, { side: "sell", priceSats: 500n });
        const placed = await createOrder(alice, await connect(alice), terms, 5n);
        const coin = await coinAt(placed.contract.pkScript, placed.txid);
        const cancelled = await cancelOrder(await connect(alice), { terms, coin });
        const back = await coinAt(terms.makerScript, cancelled.txid);
        expect(back.value).toBe(coin.value);
        expect(back.assets).toEqual([{ assetId: gold, amount: 5n }]);
    });
});

/**
 * A fill built by hand, so nothing but the covenant stands between it and the order's coin.
 * Output 0 is `out`; output 1 gives the taker every other sat and unit.
 */
async function handFill(
    taker: Wallet,
    order: Order,
    qty: bigint,
    out: { script: Uint8Array; sats: bigint; units: bigint },
): Promise<arkade.ArkadeSpendResult> {
    const fund = await coinsOf(taker);
    const funded = fund.reduce((s, c) => s + BigInt(c.value), 0n);
    const inputs = [order.coin, ...fund].flatMap((c, vin) =>
        units(c.assets) > 0n ? [{ vin, amount: units(c.assets) }] : [],
    );
    const total = inputs.reduce((s, i) => s + i.amount, 0n);
    return orderContract(await connect(taker), order.terms)
        .functions.fill(qty)
        .from(order.coin)
        .fund(fund)
        .to(out.script, out.sats)
        .to(scriptOf(taker), BigInt(order.coin.value) + funded - out.sats)
        .withAsset({
            assetId: gold,
            inputs,
            outputs: [
                ...(out.units > 0n ? [{ vout: 0, amount: out.units }] : []),
                ...(total > out.units ? [{ vout: 1, amount: total - out.units }] : []),
            ],
        })
        .send();
}

async function handSettle(order: Order, to: Uint8Array): Promise<arkade.ArkadeSpendResult> {
    const amount = units(order.coin.assets);
    return orderContract(await connect(), order.terms)
        .functions.settle()
        .from(order.coin)
        .to(to, BigInt(order.coin.value))
        .withAsset({ assetId: gold, inputs: [{ vin: 0, amount }], outputs: [{ vout: 0, amount }] })
        .send();
}

/** The spend must fail inside the covenant: the emulator logs one more script failure for it. */
async function expectCovenantRefusal(attempt: () => Promise<unknown>, label: string) {
    const before = scriptFailures();
    const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error, `${label}: accepted, but the covenant must refuse it`).toBeDefined();
    await waitFor(async () => scriptFailures() > before, 10_000).catch(() => {
        throw new Error(`${label}: refused, but not by the covenant: ${String(error)}`);
    });
}

function scriptFailures(): number {
    const { stdout, stderr } = spawnSync("docker", ["logs", `${PREFIX}emulator`], {
        encoding: "utf8",
    });
    return `${stdout}\n${stderr}`.split("failed to execute arkade script").length - 1;
}

async function newWallet(): Promise<Wallet> {
    return Wallet.create({
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
}

function connect(w?: Wallet): Promise<arkade.Arkade> {
    return arkade.Arkade.connect({
        arkade: new RestArkProvider(OPERATOR_URL),
        emulator: new RestEmulatorProvider(EMULATOR_URL),
        indexer,
        ...(w ? { identity: w.identity } : {}),
    });
}

async function faucet(w: Wallet, sats: number): Promise<void> {
    const note = execFileSync(
        "docker",
        ["exec", `${PREFIX}arkd`, "arkd", "note", "--amount", String(sats)],
        { encoding: "utf8" },
    ).trim();
    await w.settle({
        inputs: [ArkNote.fromString(note)],
        outputs: [{ address: await w.getAddress(), amount: BigInt(sats) }],
    });
    await coinsOf(w);
}

/** Issues a throwaway asset at group 0 and `amount` of the traded one at group 1. */
async function issueAtGroupOne(w: Wallet, amount: bigint): Promise<string> {
    const packet = asset.Packet.create([
        asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 1n)], []),
        asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, amount)], []),
    ]);
    const txid = await w.send({
        address: await w.getAddress(),
        amount: 1_000,
        extensions: [{ type: packet.type(), payload: packet.serialize() }],
    });
    const id = asset.AssetId.create(txid, 1).toString();
    await waitFor(async () =>
        (await w.getBalance()).availableAssets.some((a) => a.assetId === id && a.amount === amount),
    );
    return id;
}

async function termsOf(w: Wallet, t: Partial<OrderTerms>): Promise<OrderTerms> {
    return {
        side: "sell",
        maker: await w.identity.xOnlyPublicKey(),
        makerScript: scriptOf(w),
        assetId: gold,
        priceSats: 100n,
        minFill: 1n,
        expiresAt: 0n,
        reserveSats: CARRIER,
        ...t,
    };
}

function scriptOf(w: Wallet): Uint8Array {
    return w.offchainTapscript.pkScript;
}

function units(assets: VirtualCoin["assets"] | FillFunding["assets"]): bigint {
    return (assets ?? []).reduce((s, a) => (a.assetId === gold ? s + BigInt(a.amount) : s), 0n);
}

/** Funding coins at `w`'s script, from the indexer, once `after` (a txid) shows up there. */
async function coinsOf(w: Wallet, after?: string): Promise<FillFunding[]> {
    const ts = w.offchainTapscript;
    let coins: VirtualCoin[] = [];
    await waitFor(async () => {
        coins = await liveCoins(ts.pkScript);
        return coins.length > 0 && (after === undefined || coins.some((c) => c.txid === after));
    });
    return coins.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        value: c.value,
        assets: c.assets,
        tapLeafScript: ts.forfeit(),
        tapTree: ts.encode(),
    }));
}

async function liveCoins(script: Uint8Array): Promise<VirtualCoin[]> {
    const { vtxos } = await indexer.getVtxos({
        scripts: [hex.encode(script)],
        spendableOnly: true,
    });
    return vtxos.filter((v) => !v.isSpent);
}

async function coinAt(script: Uint8Array, txid: string): Promise<VirtualCoin> {
    let coin: VirtualCoin | undefined;
    await waitFor(async () => {
        coin = (await liveCoins(script)).find((v) => v.txid === txid);
        return coin !== undefined;
    });
    return coin!;
}

async function waitFor(fn: () => Promise<boolean>, timeout = 60_000): Promise<void> {
    const start = Date.now();
    while (!(await fn())) {
        if (Date.now() - start > timeout) throw new Error("timeout in waitFor");
        await new Promise((r) => setTimeout(r, 500));
    }
}
