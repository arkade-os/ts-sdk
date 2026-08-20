import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, type IWallet } from "@arkade-os/sdk";
import { fillOffer, encodeOffer, offerVtxoScript, type Offer } from "../src/offer";

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
    sends: 0,
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        arkade: {
            ...mod.arkade,
            Arkade: {
                connect: async () => ({ serverKey: state.serverKey }),
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

/** A want-ASSET offer — the case this helper refuses. */
const wantAsset: Omit<Offer, "swapPkScript"> = {
    ...wantBtc,
    offerAsset: undefined,
    wantAsset: asset.AssetId.fromString("bb".repeat(32) + "0000"),
};
const assetScript = offerVtxoScript(wantAsset, fundedServerKey);
const wantAssetHex = hex.encode(encodeOffer({ ...wantAsset, swapPkScript: assetScript.pkScript }));

const TAKER_PAYOUT = hex.decode("5120" + "11".repeat(32));
const wallet = {
    identity: {},
    getAddress: async () =>
        new ArkAddress(fundedServerKey, hex.decode("22".repeat(32)), "tark").encode(),
    getContractManager: async () => ({}),
} as unknown as IWallet;

const coin = { txid: "dd".repeat(32), vout: 0, value: 60_000 };
const fund = [{ txid: "ee".repeat(32), vout: 1, value: 80_000 }] as never;

const reset = () => {
    state.serverKey = fundedServerKey;
    state.utxos = [coin];
    state.calls = [];
    state.sends = 0;
};

describe("fillOffer refuses what it cannot build correctly", () => {
    it("refuses an asset want rather than guessing the input->output binding", async () => {
        reset();
        // The covenant checks the asset at output 0 (INSPECTOUTASSETLOOKUP), and
        // only the caller knows which of its coins carry that asset and how
        // much. A guess produces a spend the covenant rejects for reasons the
        // error does not explain, so refuse in the open.
        await expect(fillOffer(wallet, "http://ark", wantAssetHex, { fund })).rejects.toThrow(
            /does not yet support an asset want/,
        );
        expect(state.sends).toBe(0);
    });

    it("refuses an empty fund, since nothing would pay wantAmount", async () => {
        reset();
        await expect(fillOffer(wallet, "http://ark", wantBtcHex, { fund: [] })).rejects.toThrow(
            /`fund` is empty/,
        );
        expect(state.sends).toBe(0);
    });

    it("diagnoses a rotated server key instead of reporting a missing deposit", async () => {
        reset();
        state.serverKey = rotatedServerKey;
        // Same failure mode cancelOffer names: a mismatched rebuild makes
        // getUtxos return nothing, and "no deposit" is the wrong diagnosis.
        await expect(fillOffer(wallet, "http://ark", wantBtcHex, { fund })).rejects.toThrow(
            /signing key has likely rotated/,
        );
    });

    it("refuses to guess which deposit to fill when the address holds several", async () => {
        reset();
        state.utxos = [coin, { ...coin, txid: "ab".repeat(32) }];
        await expect(fillOffer(wallet, "http://ark", wantBtcHex, { fund })).rejects.toThrow(
            /pass fundingTxid/,
        );
        expect(state.sends).toBe(0);
    });

    it("reports a vanished deposit the way a lost race reads", async () => {
        reset();
        state.utxos = [];
        // A funder may cancel between the read and the broadcast. Cancel's own
        // JSDoc uses this wording for the mirror case; a caller should read it
        // as "the offer is gone", not as a fault.
        await expect(fillOffer(wallet, "http://ark", wantBtcHex, { fund })).rejects.toThrow(
            /no spendable VTXO at the swap address/,
        );
    });
});

describe("fillOffer builds the spend the covenant inspects", () => {
    const callsOf = (fn: string) => state.calls.filter((c) => c.fn === fn);

    it("pays the maker at OUTPUT 0, which is the output the covenant checks", async () => {
        reset();
        const txid = await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
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

    it("takes the deposit as input 0 and the taker's coins as inputs 1..n", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantBtcHex, { fund, payoutScript: TAKER_PAYOUT });
        const from = callsOf("from");
        expect(from).toHaveLength(1);
        expect((from[0].args[0] as { txid: string }).txid).toBe(coin.txid);
        // `fund` is what makes this a fill rather than a sweep: the maker is paid
        // from the TAKER's coins, not out of the deposit.
        expect(callsOf("fund")[0].args[0]).toBe(fund);
    });

    it("sends the taker's proceeds to the payout script it was given", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantBtcHex, { fund, payoutScript: TAKER_PAYOUT });
        expect(hex.encode(callsOf("change")[0].args[0] as Uint8Array)).toBe(
            hex.encode(TAKER_PAYOUT),
        );
    });

    it("defaults the payout to the wallet's own address when none is given", async () => {
        reset();
        await fillOffer(wallet, "http://ark", wantBtcHex, { fund });
        const expected = ArkAddress.decode(await wallet.getAddress()).pkScript;
        expect(hex.encode(callsOf("change")[0].args[0] as Uint8Array)).toBe(hex.encode(expected));
    });

    it("moves an asset-carrying DEPOSIT to the taker, not to the maker", async () => {
        reset();
        const assetId = "aa".repeat(32) + "0000";
        state.utxos = [{ ...coin, assets: [{ assetId, amount: 2_000 }] }];
        await fillOffer(wallet, "http://ark", wantBtcHex, { fund, payoutScript: TAKER_PAYOUT });

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
            swapAddress: fundedAddress,
            payoutScript: TAKER_PAYOUT,
        });
        expect(txid).toBe("ff".repeat(32));
    });
});
