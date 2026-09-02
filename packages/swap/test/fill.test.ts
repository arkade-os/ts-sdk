import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, type IWallet } from "@arkade-os/sdk";
import {
    ASSET_CARRIER_SATS,
    fillOffer,
    encodeOffer,
    offerVtxoScript,
    type Offer,
} from "../src/offer";

/**
 * `fillOffer` composes a spend the covenant will accept or reject; the tests
 * that matter are about the SHAPE it builds, not about the network. Same seam
 * as `cancel.test.ts`: mock `Arkade.connect` and `ArkadeContract`, keep the real
 * covenant derivation underneath, and record what the builder was asked for.
 */
const state = vi.hoisted(() => ({
    serverKey: new Uint8Array(0) as Uint8Array,
    utxos: [] as {
        txid: string;
        vout: number;
        value: number;
        assets?: { assetId: string; amount: number }[];
    }[],
    // What the fulfill builder received, in call order.
    calls: [] as { fn: string; args: unknown[] }[],
    // What `Arkade.connect` was configured with — the emulator lives here, and
    // the builder refuses a covenant spend without one.
    connects: [] as { emulator?: unknown }[],
    sends: 0,
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        arkade: {
            ...mod.arkade,
            Arkade: {
                connect: async (opts: { emulator?: unknown }) => {
                    state.connects.push(opts);
                    return { serverKey: state.serverKey };
                },
            },
            ArkadeContract: class {
                getUtxos = async () => state.utxos;
                functions = {
                    fulfill: () => {
                        const record =
                            (fn: string) =>
                            (...args: unknown[]) => {
                                state.calls.push({ fn, args });
                                return chain;
                            };
                        const chain = {
                            from: record("from"),
                            fund: record("fund"),
                            to: record("to"),
                            change: record("change"),
                            withAsset: record("withAsset"),
                            send: async () => {
                                state.sends += 1;
                                return { txid: "ff".repeat(32) };
                            },
                        };
                        return chain;
                    },
                };
            },
        },
    };
});

const fundedServerKey = hex.decode(
    "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
);
const rotatedServerKey = hex.decode(
    "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
);

const MAKER_PK_SCRIPT = "51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1";

/** A want-BTC offer: the funder deposited an asset and wants sats. */
const wantBtc: Omit<Offer, "swapPkScript"> = {
    wantAmount: BigInt(50_000),
    offerAsset: asset.AssetId.fromString("aa".repeat(32) + "0000"),
    makerPkScript: hex.decode(MAKER_PK_SCRIPT),
    makerPublicKey: hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};
const btcScript = offerVtxoScript(wantBtc, fundedServerKey);
const wantBtcHex = hex.encode(encodeOffer({ ...wantBtc, swapPkScript: btcScript.pkScript }));
const fundedAddress = new ArkAddress(fundedServerKey, btcScript.tweakedPublicKey, "tark").encode();

/** A want-ASSET offer: the fill must deliver the asset at output 0, through the
 * packet, with only a sat carrier on the output itself. */
const wantAsset: Omit<Offer, "swapPkScript"> = {
    ...wantBtc,
    offerAsset: undefined,
    wantAsset: asset.AssetId.fromString("bb".repeat(32) + "0000"),
};
const assetScript = offerVtxoScript(wantAsset, fundedServerKey);
const wantAssetHex = hex.encode(encodeOffer({ ...wantAsset, swapPkScript: assetScript.pkScript }));

/** The asset each offer names, plus one nothing asked for — the case that turns
 * an undeclared coin into an ASSET_NOT_FOUND from arkd. */
const WANTED_ASSET = "bb".repeat(32) + "0000";
const DEPOSIT_ASSET = "aa".repeat(32) + "0000";
const STRAY_ASSET = "cc".repeat(32) + "0000";

/** `fulfill` is a covenant path, so the builder refuses to submit without a
 * co-signer. Required, hence present on every call below. */
const EMULATOR = "http://emulator.test";

const TAKER_PAYOUT = hex.decode("5120" + "11".repeat(32));
const wallet = {
    identity: {},
    getAddress: async () =>
        new ArkAddress(fundedServerKey, hex.decode("22".repeat(32)), "tark").encode(),
    getContractManager: async () => ({}),
} as unknown as IWallet;

const coin = { txid: "dd".repeat(32), vout: 0, value: 60_000 };
/** One taker coin. `as never` because a real `ArkTxInput` also carries a
 * tapLeafScript and an encoded vtxo script, neither of which the mocked builder
 * looks at — the shape under test is what the fill ASKS for, not the coin. */
const fundingCoin = (
    over: { value?: number; assets?: { assetId: string; amount: number }[] } = {},
) => [{ txid: "ee".repeat(32), vout: 1, value: 80_000, ...over }] as never;
const fund = fundingCoin();

const reset = () => {
    state.serverKey = fundedServerKey;
    state.utxos = [coin];
    state.calls = [];
    state.connects = [];
    state.sends = 0;
};

describe("fillOffer refuses what it cannot build correctly", () => {
    it("refuses an asset want its funding cannot pay for", async () => {
        reset();
        // The taker's coins are the only source of the wanted asset, and only
        // the caller knows what they carry. Building a spend that cannot deliver
        // leaves the emulator to refuse it, reporting nothing more than that the
        // covenant said no — so name the shortfall here instead.
        await expect(
            fillOffer(wallet, "http://ark", wantAssetHex, { fund, emulator: EMULATOR }),
        ).rejects.toThrow(/needs 50000 of .*`fund` declares 0/);
        expect(state.sends).toBe(0);
    });

    it("refuses to strand an asset it has nowhere to return", async () => {
        reset();
        // Assets land on the payout output, which the builder only creates when
        // there is a sats surplus. With none, the asset would have no output to
        // go to and arkd would refuse the spend without explaining why.
        state.utxos = [{ ...coin, value: 50_000, assets: [{ assetId: DEPOSIT_ASSET, amount: 7 }] }];
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, {
                fund: fundingCoin({ value: 0 }),
                emulator: EMULATOR,
            }),
        ).rejects.toThrow(/no payout output/);
        expect(state.sends).toBe(0);
    });

    it("refuses an empty fund, since nothing would pay wantAmount", async () => {
        reset();
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, { fund: [], emulator: EMULATOR }),
        ).rejects.toThrow(/`fund` is empty/);
        expect(state.sends).toBe(0);
    });

    it("diagnoses a rotated server key instead of reporting a missing deposit", async () => {
        reset();
        state.serverKey = rotatedServerKey;
        // Same failure mode cancelOffer names: a mismatched rebuild makes
        // getUtxos return nothing, and "no deposit" is the wrong diagnosis.
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, { fund, emulator: EMULATOR }),
        ).rejects.toThrow(/signing key has likely rotated/);
    });

    it("refuses to guess which deposit to fill when the address holds several", async () => {
        reset();
        state.utxos = [coin, { ...coin, txid: "ab".repeat(32) }];
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, { fund, emulator: EMULATOR }),
        ).rejects.toThrow(/pass fundingTxid/);
        expect(state.sends).toBe(0);
    });

    it("reports a vanished deposit the way a lost race reads", async () => {
        reset();
        state.utxos = [];
        // A funder may cancel between the read and the broadcast. Cancel's own
        // JSDoc uses this wording for the mirror case; a caller should read it
        // as "the offer is gone", not as a fault.
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, { fund, emulator: EMULATOR }),
        ).rejects.toThrow(/no spendable VTXO at the swap address/);
    });
});

describe("fillOffer builds the spend the covenant inspects", () => {
    const callsOf = (fn: string) => state.calls.filter((c) => c.fn === fn);

    it("pays the maker at OUTPUT 0, which is the output the covenant checks", async () => {
        reset();
        const txid = await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        expect(txid).toBe("ff".repeat(32));

        // `to` is called exactly once, so the maker's output is index 0. The
        // covenant's asm is `0 INSPECTOUTPUTVALUE ... 0 INSPECTOUTPUTSCRIPTPUBKEY`
        // — it inspects output 0 specifically, so a second `to` before this one
        // would build a spend the server refuses to co-sign.
        const to = callsOf("to");
        expect(to).toHaveLength(1);
        expect(hex.encode(to[0].args[0] as Uint8Array)).toBe(MAKER_PK_SCRIPT);
        expect(to[0].args[1]).toBe(BigInt(50_000));
    });

    it("pays an ASSET want through the packet, with only a carrier at output 0", async () => {
        reset();
        const txid = await fillOffer(wallet, "http://ark", wantAssetHex, {
            fund: fundingCoin({ assets: [{ assetId: WANTED_ASSET, amount: 50_000 }] }),
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        expect(txid).toBe("ff".repeat(32));

        // Output 0 carries the dust the output needs to exist, NOT wantAmount
        // sats: on an asset want the maker is paid through the asset packet, and
        // paying 50_000 sats there would hand over the taker's own money.
        const to = callsOf("to");
        expect(to).toHaveLength(1);
        expect(hex.encode(to[0].args[0] as Uint8Array)).toBe(MAKER_PK_SCRIPT);
        expect(to[0].args[1]).toBe(ASSET_CARRIER_SATS);

        // THE WANTED ASSET IS GROUP 0 — the lookup index the fulfill script
        // uses. It is supplied by the taker's coin (input 1) and delivered to
        // output 0, which is what the covenant inspects.
        const assets = callsOf("withAsset");
        expect(assets).toHaveLength(1);
        expect(assets[0].args[0]).toEqual({
            assetId: WANTED_ASSET,
            inputs: [{ vin: 1, amount: BigInt(50_000) }],
            outputs: [{ vout: 0, amount: BigInt(50_000) }],
        });
    });

    it("returns the taker's surplus of the wanted asset, in the same group", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantAssetHex, {
            fund: fundingCoin({ assets: [{ assetId: WANTED_ASSET, amount: 80_000 }] }),
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        // The maker gets what the offer asked for; the rest comes back at vout 1
        // rather than being handed over with it.
        expect(callsOf("withAsset")[0].args[0]).toEqual({
            assetId: WANTED_ASSET,
            inputs: [{ vin: 1, amount: BigInt(80_000) }],
            outputs: [
                { vout: 0, amount: BigInt(50_000) },
                { vout: 1, amount: BigInt(30_000) },
            ],
        });
    });

    it("declares an asset a FUNDING coin merely happens to carry", async () => {
        reset();
        // arkd answers ASSET_NOT_FOUND when an input owns an asset the packet
        // does not mention. Coin selection picks for sats or for the wanted
        // asset; whatever else those coins hold comes along, and undeclared it
        // takes the whole fill down.
        state.utxos = [{ ...coin, assets: [{ assetId: DEPOSIT_ASSET, amount: 900 }] }];
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund: fundingCoin({ assets: [{ assetId: STRAY_ASSET, amount: 7 }] }),
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        const groups = callsOf("withAsset").map((c) => c.args[0]);
        expect(groups).toEqual([
            {
                assetId: DEPOSIT_ASSET,
                inputs: [{ vin: 0, amount: BigInt(900) }],
                outputs: [{ vout: 1, amount: BigInt(900) }],
            },
            {
                assetId: STRAY_ASSET,
                inputs: [{ vin: 1, amount: BigInt(7) }],
                outputs: [{ vout: 1, amount: BigInt(7) }],
            },
        ]);
    });

    it("puts the wanted asset first even when other assets are in the spend", async () => {
        reset();
        // Group order is packet order, and the fulfill script reads group 0. An
        // unrelated asset added ahead of the wanted one makes the covenant
        // inspect the wrong group and refuse.
        state.utxos = [{ ...coin, assets: [{ assetId: STRAY_ASSET, amount: 3 }] }];
        await fillOffer(wallet, "http://ark", wantAssetHex, {
            fund: fundingCoin({ assets: [{ assetId: WANTED_ASSET, amount: 50_000 }] }),
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        const groups = callsOf("withAsset").map((c) => (c.args[0] as { assetId: string }).assetId);
        expect(groups[0]).toBe(WANTED_ASSET);
        expect(groups).toEqual([WANTED_ASSET, STRAY_ASSET]);
    });

    it("lets the caller raise the carrier for a higher dust threshold", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantAssetHex, {
            fund: fundingCoin({ assets: [{ assetId: WANTED_ASSET, amount: 50_000 }] }),
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
            assetCarrierSats: BigInt(1_000),
        });
        expect(callsOf("to")[0].args[1]).toBe(BigInt(1_000));
    });

    it("connects WITH an emulator, without which the spend cannot be submitted", async () => {
        reset();
        // `fulfill` carries an arkadeScript, so ArkadeTransactionBuilder.send()
        // takes the covenant branch and throws "covenant spends require an
        // `emulator` on the Arkade client" when the client has none. There is no
        // per-network default to fall back on, so it has to come from the caller
        // — and every other test here mocks the builder, so nothing else would
        // notice a client built without one.
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        expect(state.connects).toHaveLength(1);
        expect(state.connects[0].emulator).toBeDefined();
    });

    it("takes the deposit as input 0 and the taker's coins as inputs 1..n", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        const from = callsOf("from");
        expect(from).toHaveLength(1);
        expect((from[0].args[0] as { txid: string }).txid).toBe(coin.txid);
        // `fund` is what makes this a fill rather than a sweep: the maker is paid
        // from the TAKER's coins, not out of the deposit.
        expect(callsOf("fund")[0].args[0]).toBe(fund);
    });

    it("sends the taker's proceeds to the payout script it was given", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });
        expect(hex.encode(callsOf("change")[0].args[0] as Uint8Array)).toBe(
            hex.encode(TAKER_PAYOUT),
        );
    });

    it("defaults the payout to the wallet's own address when none is given", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantBtcHex, { fund, emulator: EMULATOR });
        const expected = ArkAddress.decode(await wallet.getAddress()).pkScript;
        expect(hex.encode(callsOf("change")[0].args[0] as Uint8Array)).toBe(hex.encode(expected));
    });

    it("moves an asset-carrying DEPOSIT to the taker, not to the maker", async () => {
        reset();
        const assetId = "aa".repeat(32) + "0000";
        state.utxos = [{ ...coin, assets: [{ assetId, amount: 2_000 }] }];
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });

        const spec = callsOf("withAsset")[0].args[0] as {
            assetId: string;
            inputs: { vin: number; amount: bigint }[];
            outputs: { vout: number; amount: bigint }[];
        };
        // From input 0 — the deposit — to vout 1, the taker's. Output 0 is the
        // maker's and on a BTC want carries no asset; sending it there would pay
        // the maker the asset AND the sats.
        expect(spec.inputs).toEqual([{ vin: 0, amount: BigInt(2_000) }]);
        expect(spec.outputs).toEqual([{ vout: 1, amount: BigInt(2_000) }]);
    });

    it("selects a named deposit when the address holds several", async () => {
        reset();
        const wanted = { ...coin, txid: "ab".repeat(32) };
        state.utxos = [coin, wanted];
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            fundingTxid: wanted.txid,
            payoutScript: TAKER_PAYOUT,
        });
        expect((callsOf("from")[0].args[0] as { txid: string }).txid).toBe(wanted.txid);
    });

    it("pins the funded server key when swapAddress is given, past a rotation", async () => {
        reset();
        state.serverKey = rotatedServerKey;
        const txid = await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            swapAddress: fundedAddress,
            payoutScript: TAKER_PAYOUT,
        });
        expect(txid).toBe("ff".repeat(32));
    });
});
