import { describe, expect, it, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    asset,
    CSVMultisigTapscript,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
    ReadonlySingleKey,
    ReadonlyWallet,
    type ArkProvider,
    type IndexerProvider,
    type IWallet,
    type RelativeTimelock,
    type OnchainProvider,
} from "@arkade-os/sdk";
import { createOffer, decodeOffer, OFFER_CONTRACT_KIND, OFFER_CONTRACT_LABEL } from "../src/offer";

// the covenant derivation, Arkade.connect, ArkadeContract and register() are
// all real here — only the wallet's view of the server and the contract manager
// are stubbed, so a writer that omits or misspells the escrow marker fails this
// test rather than passing on a hand-built fixture
const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";

// ── The server both wallets below answer for ────────────────────────────────
//
// `createOffer` reads its info off the wallet, so this is the single source of
// truth for the covenant: the fake wallet hands it back directly and the real
// `ReadonlyWallet` further down resolves it through a stubbed `arkProvider`.
// One fixture, so the two derive against the same server.

const SIGNER_PUBKEY = "02" + "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";

// derived from the signer key rather than pinned, the way arkd advertises it:
// a checkpoint committing to some other key would describe a different server
const checkpointTapscript = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 10n },
        pubkeys: [hex.decode(SIGNER_PUBKEY.slice(2))],
    }).script,
);

const arkInfo = () => ({
    boardingExitDelay: 144n,
    checkpointTapscript,
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: SIGNER_PUBKEY,
    network: "regtest",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: SIGNER_PUBKEY,
    unilateralExitDelay: 4096n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

const state = {
    created: [] as Record<string, unknown>[],
    watched: [] as [string, string][],
    createContract: undefined as ((params: Record<string, unknown>) => unknown) | undefined,
    // what the server advertises as its unilateral exit delay; createOffer
    // builds the offer's exit closure from it unless the caller opts out
    unilateralExitDelay: BigInt(4096),
};

const contractManager = {
    createContract: async (params: Record<string, unknown>) => {
        if (state.createContract) return state.createContract(params);
        state.created.push(params);
        return { ...params, state: "active", createdAt: 0 };
    },
    setContractWatchState: async (script: string, watch: string) => {
        state.watched.push([script, watch]);
    },
};

const wallet = {
    identity: { xOnlyPublicKey: async () => makerKey },
    getAddress: async () => makerAddress,
    getArkadeInfo: async () => ({ ...arkInfo(), unilateralExitDelay: state.unilateralExitDelay }),
    getContractManager: async () => contractManager,
} as unknown as IWallet;

// overridden so the golden expectations don't move with the pinned constants
const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const create = (maker: IWallet = wallet) =>
    createOffer(maker, {
        wantAmount: BigInt(50_000),
        wantAsset: testAsset,
        emulatorPubkey,
    });

// file-level, not per-describe: the mocked provider is module state, so a
// describe that forgot to reset it would inherit the previous one's server
beforeEach(() => {
    state.created = [];
    state.watched = [];
    state.createContract = undefined;
    state.unilateralExitDelay = BigInt(4096);
});

describe("offer contract registration", () => {
    it("registers the funded covenant as an escrowed arkade contract", async () => {
        const offer = await create();

        expect(state.created).toHaveLength(1);
        const row = state.created[0];
        expect(row.type).toBe("arkade");
        // the row must key on the script the maker is about to fund; a row at
        // any other script leaves the real deposit unwatched and unmarked
        expect(row.script).toBe(hex.encode(offer.swapPkScript));
        // and carry the address the caller was handed — a row derived against
        // the SDK's default network instead of the server's would disagree here
        expect(row.address).toBe(offer.address);
        expect(row.label).toBe(OFFER_CONTRACT_LABEL);
        expect(row.metadata).toEqual({
            genericallySpendable: false,
            kind: OFFER_CONTRACT_KIND,
        });
    });

    it("stores only script-level facts, so a shared row cannot go stale", async () => {
        // identical offers derive one address and createContract is
        // first-writer-wins, so the second deposit inherits the first row: any
        // per-offer value written here would silently describe the wrong offer
        const [a, b] = [await create(), await create()];
        expect(b.swapPkScript).toEqual(a.swapPkScript);
        expect(state.created[1]).toEqual(state.created[0]);

        const serialized = JSON.stringify(state.created[0]);
        for (const perOffer of [a.offerHex, "fundingTxid", "swapId"]) {
            expect(serialized).not.toContain(perOffer);
        }
    });

    it("fails the offer rather than returning an address it never registered", async () => {
        // registration runs before funding precisely so this can throw: the
        // same failure after wallet.send would strand an unwatched deposit
        state.createContract = () => {
            throw new Error("repository unavailable");
        };
        await expect(create()).rejects.toThrow("repository unavailable");
    });

    it("states that the address it hands back is watched", async () => {
        const offer = await create();
        expect(state.watched).toEqual([[hex.encode(offer.swapPkScript), "watched"]]);
    });
});

// ── The exit closure createOffer builds by default ───────────────────────────

describe("a new offer's unilateral exit", () => {
    it("is built by default, at the server's own delay", async () => {
        // without it `cancel` is the only route out, and cancel needs the
        // server: a server that will not co-sign strands the deposit until the
        // VTXO expires and the operator sweeps it
        const offer = decodeOffer(hex.decode((await create()).offerHex));
        expect(offer.exitDelay).toEqual({ type: "seconds", value: BigInt(4096) });
    });

    it("reads a sub-512 delay as blocks, the threshold arkd's own closures use", async () => {
        state.unilateralExitDelay = BigInt(144);
        const offer = decodeOffer(hex.decode((await create()).offerHex));
        expect(offer.exitDelay).toEqual({ type: "blocks", value: BigInt(144) });
    });

    it("puts the 512 boundary on the seconds side, as arkd and solverd do", async () => {
        // 511 is blocks, 512 is seconds; reading the boundary the other way
        // derives a different swap address from the same server
        state.unilateralExitDelay = BigInt(512);
        expect(decodeOffer(hex.decode((await create()).offerHex)).exitDelay).toEqual({
            type: "seconds",
            value: BigInt(512),
        });
        state.unilateralExitDelay = BigInt(511);
        expect(decodeOffer(hex.decode((await create()).offerHex)).exitDelay).toEqual({
            type: "blocks",
            value: BigInt(511),
        });
    });

    it("takes an explicit delay over the server's", async () => {
        const created = await createOffer(wallet, {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            exitDelay: { type: "blocks", value: BigInt(10) },
        });
        expect(decodeOffer(hex.decode(created.offerHex)).exitDelay).toEqual({
            type: "blocks",
            value: BigInt(10),
        });
    });

    it("is omitted on noExit, which also moves the swap address", async () => {
        const withExit = await create();
        const without = await createOffer(wallet, {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            noExit: true,
        });
        expect(decodeOffer(hex.decode(without.offerHex)).exitDelay).toBeUndefined();
        // the closure is part of the covenant, so the two are different contracts
        expect(without.swapPkScript).not.toEqual(withExit.swapPkScript);
    });

    const withExitDelay = (exitDelay: RelativeTimelock) =>
        createOffer(wallet, {
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            emulatorPubkey,
            exitDelay,
        });

    it("registers nothing for an explicit delay it will refuse to encode", async () => {
        // A CSV of zero compiles happily, so the covenant is derived and
        // REGISTERED before the encoder ever sees the delay. Refusing only at
        // encode time leaves a watched contract behind for an offer that never
        // formed — and promoteOfferContract has already marked its address
        // outstanding, so retireOfferContract will not take that row back.
        await expect(withExitDelay({ type: "blocks", value: BigInt(0) })).rejects.toThrow(
            "exitDelay must be a positive relative locktime",
        );
        expect(state.created, "nothing may be registered for an offer that never formed").toEqual(
            [],
        );
        expect(state.watched).toEqual([]);
    });

    it("names an oversized delay itself, rather than letting bip68 do it", async () => {
        // deriving first reports `Expected Number seconds <= 33553920` from
        // inside the timelock encoder, which names neither the field nor the way
        // out; the check has to run before the covenant is built
        await expect(
            withExitDelay({ type: "seconds", value: BigInt(1) << BigInt(32) }),
        ).rejects.toThrow("exitDelay does not fit the locktime field (u32)");
        expect(state.created).toEqual([]);
    });

    it("refuses to publish an exit in name only when the server reports none", async () => {
        // RestArkProvider defaults a missing field to 0, which would compile to
        // a CSV of zero — an offer that claims an exit it does not have
        state.unilateralExitDelay = BigInt(0);
        await expect(create()).rejects.toThrow("no usable unilateralExitDelay");
        expect(state.created, "nothing may be registered for an offer that never formed").toEqual(
            [],
        );
    });
});

// ── Re-offering a retired script, against a real contract manager ────────────

/** Offline: every indexer read fails retryably, so the row still persists. */
const offlineIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

const realWallet = async () => {
    const contractRepository = new InMemoryContractRepository();
    const wallet = await ReadonlyWallet.create({
        arkServerUrl: "http://localhost:7070",
        arkProvider: { getInfo: async () => arkInfo() } as Partial<ArkProvider> as ArkProvider,
        indexerProvider: offlineIndexer(),
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository },
        identity: ReadonlySingleKey.fromPublicKey(
            hex.decode("02" + hex.encode(schnorr.getPublicKey(makerKey))),
        ),
    });
    return { wallet: wallet as unknown as IWallet, contractRepository };
};

describe("an offer at a script an earlier offer retired", () => {
    it("is watched again before the maker can fund it", async () => {
        const { wallet, contractRepository } = await realWallet();
        const offer = await create(wallet);
        const script = hex.encode(offer.swapPkScript);
        const manager = await wallet.getContractManager();
        // the state a settled offer leaves behind
        await manager.setContractWatchState(script, "retained");

        // identical offers derive one script, and createContract is
        // first-writer-wins: it never touches the existing row, so the
        // promotion is the only thing that can restore coverage here
        await create(wallet);

        const row = (await contractRepository.getContracts()).find((c) => c.script === script);
        expect(row?.watch).toBe("watched");
    });
});
