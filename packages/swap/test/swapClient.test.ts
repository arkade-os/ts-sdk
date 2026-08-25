import { hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { asset, ArkAddress, RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { schnorr } from "@noble/curves/secp256k1.js";
import { encodeOffer, offerVtxoScript, OFFER_CONTRACT_KIND, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";
import { createSwapClient, type UnifiedSwap } from "../src/swapClient";
import { btcUsd } from "./fixtures";

const ASSET_ID = "f1".repeat(34);
const key = (seed: string) => schnorr.getPublicKey(hex.decode(seed.repeat(32)));
const SERVER_KEY = key("11");
const FUNDING_TXID = "ab".repeat(32);

// a corridor market as a 0.2.x index publishes it (0.1.x types lack the fields)
const lnMarket = {
    ...btcUsd,
    pair: "BTC/lightning:BTC",
    quote_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_corridor: "lightning",
    discovery_pubkey: "ab".repeat(32),
} as DiscoveredMarket;

const makeClient = (over: Partial<Parameters<typeof createSwapClient>[0]> = {}) => {
    const repository = new InMemoryAssetSwapRepository();
    const transportFor = vi.fn(() => {
        throw new Error("transport built");
    });
    const feed = vi.fn(async () => new Response(JSON.stringify({ bitcoin: { usd: 50_000 } })));
    const client = createSwapClient({
        wallet: {} as never,
        arkServerUrl: "http://localhost:7070",
        repository,
        transportFor,
        discovery: {
            network: "regtest",
            registryUrl: undefined,
            fetchImpl: feed as unknown as typeof fetch,
        },
        indexer: new RestIndexerProvider("http://localhost:7070"),
        ...over,
    });
    return { client, repository, transportFor, feed };
};

describe("createSwapClient — the market and the given side name the swap", () => {
    it("quotes a spot market client-side, contacting no solver", async () => {
        const { client, transportFor, feed } = makeClient();
        const quote = await client.quote(btcUsd, {
            give: "base",
            amount: "0.01",
            amountOn: "give",
        });
        if (quote.kind !== "spot") throw new Error("expected a spot quote");
        expect(feed).toHaveBeenCalledOnce();
        expect(transportFor).not.toHaveBeenCalled();
        expect(quote.plan.deposit.atomic).toBe(BigInt(1_000_000)); // 0.01 BTC
        expect(quote.plan.receive.atomic).toBeGreaterThan(BigInt(0));
    });

    it("requires what the resolved leg needs, not a kind tag", async () => {
        const { client } = makeClient();
        await expect(client.quote(lnMarket, { give: "base" })).rejects.toThrow(
            /ln_send quote needs the invoice/,
        );
        await expect(
            client.quote(lnMarket, { give: "quote", amount: 1000, amountOn: "receive" }),
        ).rejects.toThrow(/deps.covclaimdPubkey/);
        await expect(client.quote(btcUsd, { give: "base" })).rejects.toThrow(
            /spot quote needs an amount/,
        );
    });

    it("refuses an onchain send without L1 access, before anything is derived or funded", async () => {
        const { client, transportFor } = makeClient(); // no deps.chain
        const onchainMarket = {
            ...lnMarket,
            pair: "BTC/onchain:BTC",
            quote_corridor: "onchain",
        } as typeof lnMarket;
        await expect(
            client.quote(onchainMarket, {
                give: "base",
                amount: 10_000,
                amountOn: "receive",
                payoutPubkey: key("aa"),
            }),
        ).rejects.toThrow(/deps.chain/);
        expect(transportFor).not.toHaveBeenCalled();
    });

    it("asks transportFor for the rendezvous only once the market is a corridor one", async () => {
        const { client, transportFor } = makeClient();
        await expect(
            client.quote(lnMarket, { give: "base", invoice: {} as never }),
        ).rejects.toThrow(/transport built/);
        expect(transportFor).toHaveBeenCalledWith(lnMarket);
    });
});

describe("createSwapClient — one update stream over both families", () => {
    it("surfaces an offer fill through onUpdate, tagged by family", async () => {
        const binding: Omit<Offer, "swapPkScript"> = {
            wantAmount: BigInt(992),
            wantAsset: asset.AssetId.fromString(ASSET_ID),
            makerPkScript: new Uint8Array([0x51, 0x20, ...key("55")]),
            makerPublicKey: key("22"),
            emulatorPubkey: key("33"),
        };
        const script = offerVtxoScript(binding, SERVER_KEY);
        const offer: Offer = { ...binding, swapPkScript: script.pkScript };
        const swap: AssetSwap = {
            id: FUNDING_TXID,
            fromAsset: "btc",
            toAsset: ASSET_ID,
            fromAmount: "10000",
            toAmount: "992",
            swapAddress: "",
            swapPkScript: hex.encode(offer.swapPkScript),
            offerHex: hex.encode(encodeOffer(offer)),
            fundingTxid: FUNDING_TXID,
            status: "pending",
            createdAt: 1_700_000_000_000,
        };

        const callbacks = new Set<(event: unknown) => void>();
        const wallet = {
            getAddress: async () => new ArkAddress(SERVER_KEY, key("66"), "tark").encode(),
            getContractManager: async () => ({
                onContractEvent: (cb: (event: unknown) => void) => {
                    callbacks.add(cb);
                    return () => callbacks.delete(cb);
                },
                setContractWatchState: async () => {},
            }),
        } as never;

        const fulfillTx = (() => {
            const leaf = script.functionByName("fulfill")!.tapLeafScript;
            const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
            tx.addInput({ txid: hex.decode(FUNDING_TXID), index: 0, tapLeafScript: [leaf] });
            tx.addOutput({ script: binding.makerPkScript, amount: BigInt(992) });
            return tx;
        })();
        const getVirtualTxs = vi
            .spyOn(RestIndexerProvider.prototype, "getVirtualTxs")
            .mockResolvedValue({
                txs: [Buffer.from(fulfillTx.toPSBT()).toString("base64")],
            } as never);

        const { client, repository } = makeClient({ wallet });
        await addAssetSwap(repository, swap);

        const updates: UnifiedSwap[] = [];
        client.onUpdate((u) => updates.push(u));
        try {
            await client.start();
            callbacks.forEach((cb) =>
                cb({
                    type: "vtxo_spent",
                    contractScript: hex.encode(offer.swapPkScript),
                    contract: { metadata: { kind: OFFER_CONTRACT_KIND } },
                    vtxos: [{ txid: FUNDING_TXID, vout: 0, arkTxId: fulfillTx.id }],
                    timestamp: 1_700_000_100_000,
                }),
            );
            await vi.waitFor(async () => {
                const [stored] = await getAssetSwaps(repository);
                expect(stored.status).toBe("fulfilled");
            });
        } finally {
            await client.stop();
            getVirtualTxs.mockRestore();
        }

        const offerUpdates = updates.filter((u) => u.family === "offer");
        expect(offerUpdates.length).toBeGreaterThan(0);
        expect((offerUpdates.at(-1)!.swap as AssetSwap).status).toBe("fulfilled");
    });
});

describe("createSwapClient — cancel", () => {
    it("refuses to cancel a swap that left pending, keeping its status", async () => {
        const { client, repository } = makeClient();
        await addAssetSwap(repository, {
            id: FUNDING_TXID,
            fromAsset: "btc",
            toAsset: ASSET_ID,
            fromAmount: "10000",
            toAmount: "992",
            swapAddress: "",
            swapPkScript: "51",
            offerHex: "00",
            fundingTxid: FUNDING_TXID,
            status: "fulfilled",
            createdAt: 1,
        });
        await expect(client.cancel(FUNDING_TXID)).rejects.toThrow(/fulfilled, not cancellable/);
        const [stored] = await getAssetSwaps(repository);
        expect(stored.status).toBe("fulfilled");
    });
});
