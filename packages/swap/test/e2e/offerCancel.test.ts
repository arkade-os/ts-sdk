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
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
// The v2 client is still internal to the package — `src/index.ts` exports the
// v1 facade under the same name — so it is imported by path, as the unit suite
// does. M8 is what slims the root export to the v2 surface.
import { createSwapClient, type SwapClient } from "../../src/client/client";
import { NotCancellable } from "../../src/client/errors";
import { quoteIdOfSwapId, type OfferSwapRecord } from "../../src/client/record";
import { OfferCovenantMismatchError } from "../../src/offer";
import { InMemoryAssetSwapRepository } from "../../src/repository";

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
        arkServerUrl: OPERATOR_URL,
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
});
