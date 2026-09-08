/**
 * The v2 client's `cancel()` against the real regtest stack.
 *
 * What the unit suite cannot prove, and this can: the covenant `accept()` funded
 * is the one `cancel()` rebuilds from the record's pinned `swapAddress`, the
 * 2-of-2 maker+server spend is accepted by the real operator, and the record the
 * cancel writes is the one a second client reads back.
 *
 * **The fill half of the race is not here, and cannot be.** A fill needs a taker
 * holding the want-asset, and no solver runs in this stack — the same limit
 * `swap.test.ts` records for the v1 loop. The race is pinned in
 * `test/client/cancel.test.ts` instead, against a real leaf-classified spend;
 * what regtest adds is everything around it, plus the C diagnosis a rebuild that
 * disagrees with the funded script produces.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { hex } from "@scure/base";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    ArkAddress,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import {
    createSwapClient,
    InMemoryAssetSwapRepository,
    NotCancellable,
    type OfferSwapRecord,
    type SwapClient,
    quoteIdOfSwapId,
} from "../../src";
import {
    cancelOffer,
    OfferCovenantMismatchError,
    restoreAssetSwaps,
    type Tx,
} from "../../src/protocol";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const arkdExec = "docker exec -t arkd";

const FAUCET_SATS = 30_000;
const DEPOSIT_SATS = 10_000;

/** The want-asset never has to exist for accept/cancel: the covenant binds its
 * id, and only the fill path would ever spend it. */
const USD_ASSET_ID = "f121ac9b7656797cc68d1e8fecacfbaa2069ec1461edf0bf2f3c37404cb9791a0000";

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

/** An arkade-to-arkade card: feed-priced, no rendezvous, no corridor. The
 * registry is not part of what this exercises, so it is injected. */
const CARD: DiscoveredMarket = {
    pair: "BTC/USD",
    base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_asset: { id: USD_ASSET_ID, name: "US Dollar", ticker: "USD", decimals: 2 },
    price_feed: "https://feed.example/btc-usd",
    price_feed_schema: { type: "json", price_path: "/price" },
    price_decimals: 6,
    fee_bps: 30,
    min_base_amount: "1000",
    max_base_amount: "5000000",
    min_quote_amount: "50",
    max_quote_amount: "500000",
    solver: "stub",
    source: "https://registry.example/regtest.json",
    sourceType: "registry",
} as unknown as DiscoveredMarket;

/** The price feed, answering a fixed price. Nothing about pricing is under
 * test; what is real is the covenant, the funding and the cancel. */
const feed = (async () =>
    new Response(JSON.stringify({ price: 100_000 }))) as unknown as typeof fetch;

let wallet: Wallet;
const repository = new InMemoryAssetSwapRepository();

const clientOn = (over: { repository?: InMemoryAssetSwapRepository } = {}): SwapClient =>
    createSwapClient({
        wallet,
        repository: over.repository ?? repository,
        discovery: { snapshot: [CARD] },
        fetchImpl: feed,
    });

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
    await waitFor(async () => (await wallet.getVtxos()).length > 0);
}, 180_000);

describe("the v2 cancel (regtest)", () => {
    it("funds an offer covenant and takes the deposit back", async () => {
        const client = clientOn();
        const quote = await client.quote({
            give: "BTC",
            take: "USD",
            amount: BigInt(DEPOSIT_SATS),
            amountOn: "give",
        });
        const swap = await client.accept(quote);
        const quoteId = quoteIdOfSwapId(swap.id);

        expect(swap.family).toBe("offer");
        expect(swap.id).toBe(`offer:${quoteId}`);
        expect(swap.fundingTxid).toEqual(expect.any(String));

        // The deposit has to be visible to the operator before the 2-of-2 can
        // spend it.
        const funded = (await repository.getSwapRecord(quoteId)) as OfferSwapRecord;
        await waitFor(async () => {
            const reader = await wallet.getArkadeReader();
            const { vtxos } = await reader.getVtxos({ scripts: [funded.swapPkScript] });
            return vtxos.some((v) => v.txid === funded.fundingTxid);
        });

        await expect(client.cancel(swap.id)).resolves.toEqual({ outcome: "cancelled" });

        const cancelled = (await repository.getSwapRecord(quoteId)) as OfferSwapRecord;
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.spentTxid).toEqual(expect.any(String));
        // A completion time is a fill's, not a cancel's.
        expect(cancelled.completedAt).toBeUndefined();
        await client[Symbol.asyncDispose]();
    }, 180_000);

    it("answers a second cancel from the record rather than re-broadcasting", async () => {
        // A terminal record is one condition however the call reached it, and a
        // fresh client reads the same answer off the same store.
        const client = clientOn();
        const [swap] = await client.swaps({ family: "offer" });
        await expect(client.cancel(swap.id)).resolves.toEqual({ outcome: "cancelled" });
        expect(swap.outcome).toBe("cancelled");
        await client[Symbol.asyncDispose]();
    }, 120_000);

    it("refuses a corridor id and an id no record backs", async () => {
        const client = clientOn();
        const [swap] = await client.swaps({ family: "offer" });
        const quoteId = quoteIdOfSwapId(swap.id);

        // The tag parse, with no repository read: the same quote id under the
        // other family's prefix is refused outright.
        await expect(client.cancel(`rfq:${quoteId}`)).rejects.toBeInstanceOf(NotCancellable);
        await expect(client.cancel("offer:nothing-here")).rejects.toBeInstanceOf(NotCancellable);
        await client[Symbol.asyncDispose]();
    }, 120_000);

    it("names the rebuild mismatch when the pinned address is not the funded one", async () => {
        // C, against the real operator: the v2 record pins `swapAddress` at
        // accept, so the only way to reach the diagnosis is to corrupt it — and
        // it must be the typed error, never "no spendable VTXO".
        const store = new InMemoryAssetSwapRepository();
        const client = clientOn({ repository: store });
        const quote = await client.quote({
            give: "BTC",
            take: "USD",
            amount: BigInt(DEPOSIT_SATS),
            amountOn: "give",
        });
        const swap = await client.accept(quote);
        const quoteId = quoteIdOfSwapId(swap.id);

        const record = (await store.getSwapRecord(quoteId)) as OfferSwapRecord;
        const decoded = ArkAddress.decode(record.swapAddress);
        // Same wallet key, a different operator key: the rebuild derives a
        // script the offer's own `swapPkScript` does not match.
        const rotated = new ArkAddress(
            hex.decode("11".repeat(32)),
            decoded.vtxoTaprootKey,
            decoded.hrp,
        ).encode();
        await store.saveSwapRecord({ ...record, swapAddress: rotated });

        await expect(client.cancel(swap.id)).rejects.toBeInstanceOf(OfferCovenantMismatchError);

        // Restore the pin and the same call goes through — the record was the
        // only thing wrong.
        await store.saveSwapRecord({ ...record, status: "pending" });
        await expect(client.cancel(swap.id)).resolves.toEqual({ outcome: "cancelled" });
        await client[Symbol.asyncDispose]();
    }, 180_000);
    it("funds an offer with the whole available balance", async () => {
        // "Swap everything I have." It funds, and the two reasons are worth
        // pinning because neither is general: an asset swap denominates its fee
        // on the TAKE leg, so the give side needs no headroom held back, and a
        // deposit that consumes every coin leaves no change output to fall
        // under dust. A corridor route puts the fee on the give leg instead,
        // which is why the same drain is refused there — see `rfqVerbs.test.ts`.
        const store = new InMemoryAssetSwapRepository();
        const client = clientOn({ repository: store });
        // Every test above cancels its deposit back, so the faucet amount is
        // what the wallet settles at — waited for rather than read, because a
        // preceding cancel may still be landing and a drain that races one
        // leaves a balance this test would misread as its own doing.
        await waitFor(async () => (await wallet.getBalance()).available === FAUCET_SATS);
        const { available, gated: gatedBefore } = await wallet.getBalance();

        const quote = await client.quote({
            give: "BTC",
            take: "USD",
            amount: BigInt(available),
            amountOn: "give",
        });
        // The whole balance is the give leg, and the fee is not denominated in
        // it — so nothing has to be left over to pay one.
        expect(quote.give.amount).toBe(BigInt(available));
        expect(quote.fee.asset).toBe(quote.take.asset);

        const swap = await client.accept(quote);
        const record = (await store.getSwapRecord(quoteIdOfSwapId(swap.id))) as OfferSwapRecord;
        await waitFor(async () => {
            const reader = await wallet.getArkadeReader();
            const { vtxos } = await reader.getVtxos({ scripts: [record.swapPkScript] });
            return vtxos.some((v) => v.txid === record.fundingTxid && v.value === available);
        });

        // Every sat is escrowed now: still owned, and out of generic reach.
        const after = await wallet.getBalance();
        expect(after.available).toBe(0);
        expect(after.gated).toBe(gatedBefore + available);

        // And a zero available balance does not strand it. Cancel names its
        // input outpoint, so it needs no coin of its own to spend with — a
        // drain that could not be undone would be the whole hazard here.
        await expect(client.cancel(swap.id)).resolves.toEqual({ outcome: "cancelled" });
        await waitFor(async () => (await wallet.getBalance()).available === available);
        await client[Symbol.asyncDispose]();
    }, 240_000);

    it("loses a funded offer to a wiped store, and takes the chain scan to get it back", async () => {
        // A wallet restored onto a second device: same seed, same VTXOs, empty
        // swap store. The v2 construction restore reads records and nothing
        // else, so the offer is invisible to the client — while the deposit
        // stays escrowed, so generic spending cannot reach it either. Both
        // halves are asserted because either one alone is survivable and
        // together they are a deposit with no route out through this API.
        //
        // `restoreAssetSwaps` is the route out, and it has no call site in this
        // package by design — a consumer runs it on their own schedule. That is
        // the contract this test pins; a drive that ever learns to scan for
        // itself should fail here and be rewritten, not deleted.
        const store = new InMemoryAssetSwapRepository();
        const client = clientOn({ repository: store });
        const quote = await client.quote({
            give: "BTC",
            take: "USD",
            amount: BigInt(DEPOSIT_SATS),
            amountOn: "give",
        });
        const swap = await client.accept(quote);
        const record = (await store.getSwapRecord(quoteIdOfSwapId(swap.id))) as OfferSwapRecord;
        await waitFor(async () => {
            const reader = await wallet.getArkadeReader();
            const { vtxos } = await reader.getVtxos({ scripts: [record.swapPkScript] });
            return vtxos.some((v) => v.txid === record.fundingTxid);
        });
        await client[Symbol.asyncDispose]();

        const wiped = clientOn({ repository: new InMemoryAssetSwapRepository() });
        await wiped.ready;
        expect(await wiped.swaps()).toEqual([]);
        await expect(wiped.cancel(swap.id)).rejects.toBeInstanceOf(NotCancellable);
        expect((await wallet.getBalance()).gated).toBeGreaterThanOrEqual(DEPOSIT_SATS);
        await wiped[Symbol.asyncDispose]();

        // The scan rebuilds the offer from the funding transaction alone, and
        // the bytes it hands back are the ones the covenant was funded against.
        //
        // The txid is named here rather than read from `getTransactionHistory`,
        // and that is not a shortcut: `createOffer` registers the covenant as a
        // contract of this wallet, so the deposit output counts as CHANGE in the
        // history builder. A BTC-give funding tx therefore nets to zero and is
        // dropped as a pure self-transfer (`transactionHistory.ts`), and the
        // wallet's history never carries the one txid this scan needs.
        const history: Tx[] = [
            {
                type: "sent",
                redeemTxid: record.fundingTxid!,
                createdAt: Math.floor(Date.now() / 1000),
            },
        ];
        const { restored } = await restoreAssetSwaps(
            new RestIndexerProvider(OPERATOR_URL),
            history,
            new Set(),
            { operatorPubkey: ArkAddress.decode(await wallet.getAddress()).serverPubKey },
        );
        const found = restored.find((s) => s.fundingTxid === record.fundingTxid);
        expect(found?.offerHex).toBe(record.offerHex);
        expect(found?.status).toBe("pending");

        // And they are enough to get the deposit back, with no v2 record in
        // sight — which is what makes the loss above recoverable rather than
        // terminal.
        const cancelTxid = await cancelOffer(wallet, found!.offerHex, {
            repository: new InMemoryAssetSwapRepository(),
            fundingTxid: record.fundingTxid!,
            swapAddress: record.swapAddress,
        });
        expect(cancelTxid).toBeTruthy();
        await waitFor(async () => {
            const reader = await wallet.getArkadeReader();
            const { vtxos } = await reader.getVtxos({ scripts: [record.swapPkScript] });
            return vtxos.some((v) => v.txid === record.fundingTxid && v.isSpent);
        });
    }, 300_000);
});
