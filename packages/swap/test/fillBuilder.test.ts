import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkAddress,
    CSVMultisigTapscript,
    MultisigTapscript,
    Transaction,
    VtxoScript,
    asset,
    type IWallet,
} from "@arkade-os/sdk";
import { encodeOffer, fillOffer, offerVtxoScript, type Offer } from "../src/offer";

/**
 * `fill.test.ts` mocks `ArkadeContract`, so the real builder is never
 * constructed — which is how `fillOffer` shipped unable to submit anything.
 * Here only the three REST providers are stubbed, and the assertions read the
 * ark tx the emulator was actually handed.
 */
const state = vi.hoisted(() => ({
    vtxos: [] as unknown[],
    managed: null as unknown,
    emulatorSubmits: 0,
    arkTx: undefined as string | undefined,
    prevTxs: new Map<string, string>(),
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return {
                    signerPubkey: `02${hex.encode(SERVER_KEY)}`,
                    checkpointTapscript: CHECKPOINT,
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: state.vtxos };
            }
            async getVirtualTxs(txids: string[]) {
                return {
                    txs: txids
                        .map((t) => state.prevTxs.get(t))
                        .filter((p): p is string => p !== undefined),
                };
            }
        },
        RestEmulatorProvider: class {
            constructor(readonly url: string) {}
            async submitTx(arkTx: string, checkpointTxs: string[]) {
                state.emulatorSubmits += 1;
                state.arkTx = arkTx;
                return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
            }
        },
    };
});

const SERVER_KEY = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const CHECKPOINT = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(10) },
        pubkeys: [SERVER_KEY],
    }).script,
);

// Real curve points: the builder decodes every output script as taproot.
const MAKER_KEY = "71102fc86b5c576c72f411e083cc03eb83d1b55065406ba2a483208dbb5074ab";
const MAKER_PK_SCRIPT = `5120${MAKER_KEY}`;
const TAKER_PAYOUT = hex.decode(
    "512035f737927627c4af1e9a39ae02b086c6b31426d0d64f01e5ce3ee8a445bbd667",
);
const DEPOSIT_ASSET = "aa".repeat(32) + "0000";

const offer: Omit<Offer, "swapPkScript"> = {
    wantAmount: BigInt(50_000),
    offerAsset: asset.AssetId.fromString(DEPOSIT_ASSET),
    makerPkScript: hex.decode(MAKER_PK_SCRIPT),
    makerPublicKey: hex.decode(MAKER_KEY),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};
const script = offerVtxoScript(offer, SERVER_KEY);
const offerHex = hex.encode(encodeOffer({ ...offer, swapPkScript: script.pkScript }));

/** A coin whose txid is the real id of a prev ark tx the stub indexer serves —
 * the covenant path resolves one per input and keys them by computed id. */
let minted = 0;
const mintCoin = (value: number) => {
    const seed = ++minted;
    const key = new Uint8Array([
        0x51,
        0x20,
        ...schnorr.getPublicKey(new Uint8Array(32).fill(seed)),
    ]);
    const tx = new Transaction({ version: 3 });
    tx.addInput({
        txid: new Uint8Array(32).fill(seed),
        index: seed,
        witnessUtxo: { script: key, amount: BigInt(value) },
    });
    tx.addOutput({ script: key, amount: BigInt(value) });
    state.prevTxs.set(tx.id, base64.encode(tx.toPSBT()));
    return { txid: tx.id, vout: 0, value };
};

const takerKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x7a));
const identity = {
    xOnlyPublicKey: async () => takerKey,
    sign: vi.fn(async (tx: Transaction) => tx),
};
const wallet = {
    identity,
    getAddress: async () =>
        new ArkAddress(SERVER_KEY, hex.decode("22".repeat(32)), "tark").encode(),
    getContractManager: async () => state.managed,
} as unknown as IWallet;

const fundingCoin = (value: number) => {
    const vs = new VtxoScript([
        MultisigTapscript.encode({ pubkeys: [takerKey, SERVER_KEY] }).script,
    ]);
    return { ...mintCoin(value), tapLeafScript: vs.leaves[0], tapTree: vs.encode() };
};

const deposit = () => ({
    ...mintCoin(60_000),
    assets: [{ assetId: DEPOSIT_ASSET, amount: 2_000 }],
});

const reset = () => {
    state.managed = null;
    state.emulatorSubmits = 0;
    state.arkTx = undefined;
    identity.sign.mockClear();
};

const built = () => Transaction.fromPSBT(base64.decode(state.arkTx!));

describe("fillOffer against the REAL Arkade builder", () => {
    it("reaches the emulator instead of refusing to submit", async () => {
        reset();
        state.vtxos = [deposit()];
        const txid = await fillOffer(wallet, "http://ark", offerHex, {
            fund: [fundingCoin(80_000)] as never,
            emulator: "http://emulator.test",
            payoutScript: TAKER_PAYOUT,
        });
        expect(state.emulatorSubmits).toBe(1);
        expect(txid).toBe(built().id);
    });

    // `fillOffer` hardcodes vout 1 for every asset it routes, which is only
    // safe while `.change()` lands there. Pinned against the builder that
    // decides, with an asset packet in the spend.
    it("puts the maker at output 0 and the taker's payout at output 1", async () => {
        reset();
        state.vtxos = [deposit()];
        await fillOffer(wallet, "http://ark", offerHex, {
            fund: [fundingCoin(80_000)] as never,
            emulator: "http://emulator.test",
            payoutScript: TAKER_PAYOUT,
        });

        const tx = built();
        expect(hex.encode(tx.getOutput(0)!.script!)).toBe(MAKER_PK_SCRIPT);
        expect(tx.getOutput(0)!.amount).toBe(BigInt(50_000));
        expect(hex.encode(tx.getOutput(1)!.script!)).toBe(hex.encode(TAKER_PAYOUT));
        expect(tx.getOutput(1)!.amount).toBe(BigInt(90_000));
    });

    it("hands the wallet's contract manager to the arkade client", async () => {
        reset();
        // Behavioural: the manager is the only source of the deposit here.
        const registered = deposit();
        state.vtxos = [];
        state.managed = {
            getContracts: async () => [{ script: hex.encode(script.pkScript) }],
            getContractsWithVtxos: async () => [{ vtxos: [registered] }],
        };
        await fillOffer(wallet, "http://ark", offerHex, {
            fund: [fundingCoin(80_000)] as never,
            emulator: "http://emulator.test",
            payoutScript: TAKER_PAYOUT,
        });
        expect(state.emulatorSubmits).toBe(1);
        // 60_000 (the manager's deposit) + 80_000 − 50_000: the payout can only
        // balance if the coin the manager served is the one that was spent.
        expect(built().getOutput(1)!.amount).toBe(BigInt(registered.value + 80_000 - 50_000));
    });

    it("forwards emulatorPubkey, which is the only thing that validates it", async () => {
        reset();
        state.vtxos = [deposit()];
        await expect(
            fillOffer(wallet, "http://ark", offerHex, {
                fund: [fundingCoin(80_000)] as never,
                emulator: "http://emulator.test",
                emulatorPubkey: "not-a-pubkey",
                payoutScript: TAKER_PAYOUT,
            }),
        ).rejects.toThrow(/33-byte compressed secp256k1 hex/);
        expect(state.emulatorSubmits).toBe(0);
    });
});
