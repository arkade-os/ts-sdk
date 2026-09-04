import { hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { asset, ArkAddress, RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeOffer, offerContract, OFFER_CONTRACT_KIND, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";
import { lightningSendContract } from "../src/rfq";
import * as btc from "@scure/btc-signer";
import { L1_NETWORKS, onchainHtlcScript } from "../src/onchainHtlc";
import type { LightningSendSwap, OnchainSendSwap } from "../src/swapManager";
import { createSwapClient, type SwapQuote, type UnifiedSwap } from "../src/swapClient";
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
        const script = offerContract(binding, SERVER_KEY);
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
            // the watcher reads spending txs through this seam — see watch.test.ts
            getArkadeReader: async () => ({ getVirtualTxs }),
        } as never;

        const fulfillTx = (() => {
            const leaf = script.functionByName("fulfill")!.tapLeafScript;
            const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
            tx.addInput({ txid: hex.decode(FUNDING_TXID), index: 0, tapLeafScript: [leaf] });
            tx.addOutput({ script: binding.makerPkScript, amount: BigInt(992) });
            return tx;
        })();
        const getVirtualTxs = vi.fn().mockResolvedValue({
            txs: [Buffer.from(fulfillTx.toPSBT()).toString("base64")],
        });

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

    it("reports a dead backend as one, not as a swap it could not find", async () => {
        const broken: AssetSwapRepository = {
            ...new InMemoryAssetSwapRepository(),
            version: 5,
            getAllSwaps: async () => {
                throw new Error("backend gone");
            },
        };
        const { client } = makeClient({ repository: broken });
        // "no offer swap with funding txid …" here would be a lie about a swap
        // that may well be stored, on a path that goes on to write
        await expect(client.cancel(FUNDING_TXID)).rejects.toThrow(/backend gone/);
    });
});

// ── The RFQ half of accept(): what is durable, and when ─────────────────────

const REFUND_LOCKTIME = 1_900_000_000;
// BIP68 encodes second-based relative timelocks in 512s units, and the refund
// tiers stack on top, so the delay must be a multiple of 512
const CLAIM_DELAY = 4096;
const PREIMAGE = new Uint8Array(32).fill(0xa7);
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

// A real covenant, because `assertSameSwap` decodes the origin's address and
// refuses a record whose funded address is not the script the swap watches.
const LOCKUP = lightningSendContract({
    solverPubkey: key("01"),
    refundLocktime: REFUND_LOCKTIME,
    operatorPubkey: SERVER_KEY,
    paymentHash: PAYMENT_HASH,
    claimDelay: CLAIM_DELAY,
    emulatorPubkey: key("09"),
    refundPkScript: p2tr(key("21")),
    senderPubkey: key("07"),
    receiverPkScript: p2tr(key("01")),
});
const LOCKUP_ADDRESS = LOCKUP.address("tark", SERVER_KEY).encode();

const lnSendQuote = (rfqId = "rfq-ln-send") =>
    ({
        kind: "ln_send",
        market: lnMarket,
        request: {
            rfqId,
            quote: {} as never,
            address: LOCKUP_ADDRESS,
            fundAmount: 10_500,
            swapPkScript: LOCKUP.pkScript,
            script: LOCKUP,
            refundAddress: "",
            senderPubkey: key("07"),
            secrets: { descriptor: "tr(sender)", pubkey: key("07") },
            contractParams: { paymentHash: PAYMENT_HASH, refundLocktime: REFUND_LOCKTIME },
        },
    }) as unknown as SwapQuote;

const HTLC_LOCKTIME = REFUND_LOCKTIME - 3600;
const htlcParams = {
    paymentHash: PAYMENT_HASH,
    claimKey: key("aa"),
    refundKey: key("bb"),
    refundLocktime: HTLC_LOCKTIME,
};

/** Where the L1 claim pays. With no `payoutAddress` on the quote input,
 * `quote()` defaults it to the trader's own claim key as a key-path P2TR; the
 * fixture pins the same script so what the record stores is checkable. */
const PAYOUT_PK_SCRIPT = btc.p2tr(htlcParams.claimKey, undefined, L1_NETWORKS.regtest).script;

const onchainSendQuote = (rfqId = "rfq-onchain-send") =>
    ({
        kind: "onchain_send",
        payoutPkScript: PAYOUT_PK_SCRIPT,
        market: { ...lnMarket, pair: "BTC/onchain:BTC", quote_corridor: "onchain" },
        request: {
            rfqId,
            // No `refund_locktime` on the wire quote: it is optional there, and
            // a solver may carry the value in `profile` instead. What the
            // covenant was built with is `refundLocktime`, below.
            quote: {},
            address: LOCKUP_ADDRESS,
            fundAmount: 10_500,
            swapPkScript: LOCKUP.pkScript,
            script: LOCKUP,
            refundAddress: "",
            htlc: onchainHtlcScript(htlcParams, "regtest"),
            htlcParams,
            l1Network: "regtest",
            minConfirmations: 1,
            refundLocktime: REFUND_LOCKTIME,
            senderPubkey: key("07"),
            secrets: {
                descriptor: "tr(sender)",
                pubkey: key("07"),
                preimage: PREIMAGE,
                paymentHash: sha256(PREIMAGE),
                mustPersistPreimage: false,
            },
        },
    }) as unknown as SwapQuote;

/** A repository that records the order its writes land in, against the
 * funding call, so "the record is durable first" is testable. */
const recordingRepository = (order: string[]) => {
    const repository = new InMemoryAssetSwapRepository();
    const saveRfqSwap = repository.saveRfqSwap.bind(repository);
    vi.spyOn(repository, "saveRfqSwap").mockImplementation(async (record) => {
        order.push("record");
        await saveRfqSwap(record);
    });
    return repository;
};

describe("createSwapClient — accept() persists before it funds", () => {
    it("writes the ln_send record before wallet.send can broadcast", async () => {
        const order: string[] = [];
        const repository = recordingRepository(order);
        const send = vi.fn(async () => {
            order.push("fund");
            return FUNDING_TXID;
        });
        const { client } = makeClient({ wallet: { send } as never, repository });

        const unified = await client.accept(lnSendQuote());

        // the invariant: a crash between the two leaves a restorable record,
        // never funded money without one
        expect(order).toEqual(["record", "fund"]);
        expect(send).toHaveBeenCalledWith({ address: LOCKUP_ADDRESS, amount: 10_500 });
        expect(unified.family).toBe("rfq");
        expect((unified.swap as LightningSendSwap).refundLocktime).toBe(REFUND_LOCKTIME);
        expect(await repository.getRfqSwap("rfq-ln-send")).toMatchObject({
            kind: "lightning_send",
            lockupAddress: LOCKUP_ADDRESS,
            profile: { signer: { signingDescriptor: "tr(sender)" } },
        });
    });

    it("takes the onchain_send locktime from the derived request, not the quote's optional echo", async () => {
        const order: string[] = [];
        const repository = recordingRepository(order);
        const send = vi.fn(async () => {
            order.push("fund");
            return FUNDING_TXID;
        });
        const { client } = makeClient({ wallet: { send } as never, repository });

        const unified = await client.accept(onchainSendQuote());

        expect(order).toEqual(["record", "fund"]);
        // reading `quote.refund_locktime` here would build the covenant's swap
        // record from `undefined` and say nothing about it
        expect((unified.swap as OnchainSendSwap).refundLocktime).toBe(REFUND_LOCKTIME);
        expect(await repository.getRfqSwap("rfq-onchain-send")).toMatchObject({
            kind: "onchain_send",
            // the L1 half, whose deadline is a different one entirely
            profile: {
                htlcLocktime: HTLC_LOCKTIME,
                minConfirmations: 1,
                network: "regtest",
                // nothing on the wire names where the claim pays, so a record
                // without it cannot build one after a restart
                payoutPkScript: hex.encode(PAYOUT_PK_SCRIPT),
            },
        });
    });
});

/** The wallet the lifecycle needs: a contract manager to register lockups and
 * carry events, and the reader the offer watcher spends through. */
const watchingWallet = (callbacks: Set<(event: unknown) => void>) =>
    ({
        getAddress: async () => new ArkAddress(SERVER_KEY, key("66"), "tark").encode(),
        send: async () => FUNDING_TXID,
        getContractManager: async () => ({
            onContractEvent: (cb: (event: unknown) => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            createContract: async () => ({}),
            getContracts: async () => [],
            setContractWatchState: async () => {},
        }),
        getArkadeReader: async () => ({ getVirtualTxs: async () => ({ txs: [] }) }),
    }) as never;

/** An indexer showing the lockup fully spent by a transaction that reveals no
 * preimage — the "returned" fate, which ends the swap on the manager's first
 * pass and so makes it emit while `addSwap` is still running. */
const returnedLockup = () => {
    const spend = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    spend.addInput({ txid: hex.decode(FUNDING_TXID), index: 0 });
    spend.addOutput({ script: p2tr(key("21")), amount: BigInt(9_000) });
    return {
        getVtxos: async () => ({
            vtxos: [
                {
                    txid: FUNDING_TXID,
                    vout: 0,
                    isSpent: true,
                    spentBy: spend.id,
                    arkTxId: spend.id,
                },
            ],
        }),
        getVirtualTxs: async () => ({ txs: [Buffer.from(spend.toPSBT()).toString("base64")] }),
    } as never;
};

describe("createSwapClient — the update stream and swaps()", () => {
    it("emits one update per accepted swap, even when the first pass moves it", async () => {
        const callbacks = new Set<(event: unknown) => void>();
        const { client, repository } = makeClient({
            wallet: watchingWallet(callbacks),
            indexer: returnedLockup(),
        });

        const updates: UnifiedSwap[] = [];
        client.onUpdate((u) => updates.push(u));
        try {
            await client.start();
            await client.accept(lnSendQuote());
        } finally {
            await client.stop();
        }

        // the manager's own emission, and NOT a second one from admit() for
        // the same object it has already announced
        const rfq = updates.filter((u) => u.family === "rfq");
        expect(rfq).toHaveLength(1);
        expect((rfq[0].swap as LightningSendSwap).state).toBe("refunded");
        // and the swap that ended is still in the record, not just in the
        // update the consumer had to be listening for
        expect(await repository.getRfqSwap("rfq-ln-send")).toMatchObject({ state: "refunded" });
    });

    it("lists both families, live swaps and ended ones alike", async () => {
        const callbacks = new Set<(event: unknown) => void>();
        const { client, repository } = makeClient({
            wallet: watchingWallet(callbacks),
            indexer: returnedLockup(),
        });
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

        try {
            await client.start();
            await client.accept(lnSendQuote());
        } finally {
            await client.stop();
        }

        const swaps = await client.swaps();
        // the terminal offer AND the terminal rfq swap: one contract for both
        // halves, rather than full history on one side and live-only on the other
        expect(swaps.filter((u) => u.family === "offer")).toMatchObject([
            { swap: { id: FUNDING_TXID, status: "fulfilled" } },
        ]);
        expect(swaps.filter((u) => u.family === "rfq")).toMatchObject([
            { swap: { rfqId: "rfq-ln-send", state: "refunded" } },
        ]);
    });

    it("gives its subscriptions back on stop and takes them again on start", async () => {
        const callbacks = new Set<(event: unknown) => void>();
        const { client } = makeClient({ wallet: watchingWallet(callbacks) });
        const running = async () => (await client.manager.getStats()).isRunning;

        try {
            await client.start();
            // one for the manager's lockup events, one for the offer watcher
            expect(callbacks.size).toBe(2);
            expect(await running()).toBe(true);

            await client.stop();
            expect(callbacks.size).toBe(0);
            expect(await running()).toBe(false);

            await client.start();
            expect(callbacks.size).toBe(2);
            expect(await running()).toBe(true);
        } finally {
            await client.stop();
        }
    });
});
