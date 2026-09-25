import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, type IWallet } from "@arkade-os/sdk";
import {
    ASSET_CARRIER_SATS,
    assembleOfferFill,
    connectFillContract,
    decodeOffer,
    fillOffer,
    encodeOffer,
    offerVtxoScript,
    resolveDeposit,
    type Offer,
    type SponsorFillInput,
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

/** A sats-only deposit — what a want-ASSET offer is funded with. */
const satsDeposit = { txid: "dd".repeat(32), vout: 0, value: 60_000 };
/** A want-BTC deposit carrying the asset the offer sells — the covenant does not
 * check that it does, so `fillOffer` has to. */
const coin = { ...satsDeposit, assets: [{ assetId: DEPOSIT_ASSET, amount: 7 }] };
/** One taker coin. `as never` because a real `ArkTxInput` also carries a
 * tapLeafScript and an encoded vtxo script, neither of which the mocked builder
 * looks at — the shape under test is what the fill ASKS for, not the coin. */
const fundingCoin = (
    over: { value?: number; assets?: { assetId: string; amount: number }[] } = {},
) => [{ txid: "ee".repeat(32), vout: 1, value: 80_000, ...over }] as never;
const fund = fundingCoin();

const reset = (deposit: (typeof coin)[] = [coin]) => {
    state.serverKey = fundedServerKey;
    state.utxos = deposit;
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
        state.utxos = [{ ...coin, value: 45_000, assets: [{ assetId: DEPOSIT_ASSET, amount: 7 }] }];
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, {
                fund: fundingCoin({ value: 5_000 }),
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

    // `offerAsset` is a TLV claim about a deposit the covenant never inspects:
    // it gates output 0 only. A fill against an unbacked deposit succeeds
    // on-chain and pays wantAmount for nothing.
    it.each([
        ["carrying nothing", undefined],
        ["carrying a different asset", [{ assetId: STRAY_ASSET, amount: 9 }]],
        ["carrying a zero amount of it", [{ assetId: DEPOSIT_ASSET, amount: 0 }]],
    ])("refuses a deposit %s the offer says it sells", async (_label, assets) => {
        reset([{ ...satsDeposit, ...(assets ? { assets } : {}) }]);
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, { fund, emulator: EMULATOR }),
        ).rejects.toThrow(/carries no aa+0000, which this offer sells/);
        expect(state.sends).toBe(0);
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
        reset([satsDeposit]);
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
        reset([satsDeposit]);
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
        reset([satsDeposit]);
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

    it("declares BOTH assets when one deposit VTXO carries two", async () => {
        reset([
            {
                ...satsDeposit,
                assets: [
                    { assetId: DEPOSIT_ASSET, amount: 2_000 },
                    { assetId: STRAY_ASSET, amount: 5 },
                ],
            },
        ]);
        await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            payoutScript: TAKER_PAYOUT,
        });

        const specs = callsOf("withAsset").map(
            (c) => c.args[0] as { assetId: string; inputs: unknown[]; outputs: unknown[] },
        );
        expect(specs.map((s) => s.assetId)).toEqual([DEPOSIT_ASSET, STRAY_ASSET]);
        for (const spec of specs) {
            expect(spec.inputs).toEqual([{ vin: 0, amount: expect.any(BigInt) }]);
            expect(spec.outputs).toEqual([{ vout: 1, amount: expect.any(BigInt) }]);
        }
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

describe("fillOffer deposit resolution by outpoint", () => {
    const callsOf = (fn: string) => state.calls.filter((c) => c.fn === fn);
    const twinDeposits = () => [coin, { ...coin, vout: 1 }];

    it("selects the exact deposit by outpoint when one txid funds two", async () => {
        reset(twinDeposits());
        const txid = await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            fundingOutpoint: { txid: coin.txid, vout: 1 },
            payoutScript: TAKER_PAYOUT,
        });
        expect(txid).toBe("ff".repeat(32));
        expect((callsOf("from")[0].args[0] as { vout: number }).vout).toBe(1);
    });

    it("rejects a fundingTxid shared by two deposits instead of taking the first", async () => {
        reset(twinDeposits());
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, {
                fund,
                emulator: EMULATOR,
                fundingTxid: coin.txid,
                payoutScript: TAKER_PAYOUT,
            }),
        ).rejects.toThrow(/pass fundingOutpoint to select one/);
        expect(state.sends).toBe(0);
    });

    it("rejects an outpoint that names no deposit", async () => {
        reset();
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, {
                fund,
                emulator: EMULATOR,
                fundingOutpoint: { txid: "ab".repeat(32), vout: 0 },
                payoutScript: TAKER_PAYOUT,
            }),
        ).rejects.toThrow(/no spendable VTXO at the swap address/);
        expect(state.sends).toBe(0);
    });

    it("rejects a fundingTxid that disagrees with the outpoint", async () => {
        reset();
        await expect(
            fillOffer(wallet, "http://ark", wantBtcHex, {
                fund,
                emulator: EMULATOR,
                fundingTxid: "ab".repeat(32),
                fundingOutpoint: { txid: coin.txid, vout: 0 },
                payoutScript: TAKER_PAYOUT,
            }),
        ).rejects.toThrow(/does not match fundingOutpoint/);
        expect(state.sends).toBe(0);
    });

    it("keeps resolving a lone deposit by fundingTxid", async () => {
        reset();
        const txid = await fillOffer(wallet, "http://ark", wantBtcHex, {
            fund,
            emulator: EMULATOR,
            fundingTxid: coin.txid,
            payoutScript: TAKER_PAYOUT,
        });
        expect(txid).toBe("ff".repeat(32));
        expect((callsOf("from")[0].args[0] as { txid: string }).txid).toBe(coin.txid);
    });
});

/**
 * `fillOffer` refuses sponsor funding, so the sponsor leg is only reachable
 * through `assembleOfferFill`. It routes other people's money, so the shape it
 * asks the builder for is asserted here rather than left to the live fill.
 */
describe("assembleOfferFill routes the sponsor leg", () => {
    const callsOf = (fn: string) => state.calls.filter((c) => c.fn === fn);
    const TAXI_CHANGE = hex.decode("5120" + "33".repeat(32));
    const FARE_SCRIPT = hex.decode("5120" + "44".repeat(32));
    const recycledWant = { ...wantAsset, wantAmount: BigInt(9_995) };
    const recycledScript = offerVtxoScript(recycledWant, fundedServerKey);
    const recycledWantHex = hex.encode(
        encodeOffer({ ...recycledWant, swapPkScript: recycledScript.pkScript }),
    );
    const taxiCoin = (over: Record<string, unknown> = {}) =>
        [{ txid: "77".repeat(32), vout: 3, value: 10_000, ...over }] as never;

    const assemble = async (
        offerHex: string,
        sponsor: SponsorFillInput | undefined,
        solverFund: never = fund,
    ) => {
        const offer = decodeOffer(hex.decode(offerHex));
        const contract = await connectFillContract(wallet, "http://ark", offer, {});
        const vtxo = resolveDeposit(await contract.getUtxos(), {});
        return assembleOfferFill(contract.functions.fulfill(), {
            offer,
            vtxo,
            solverFund,
            solverPayout: TAKER_PAYOUT,
            assetCarrierSats: ASSET_CARRIER_SATS,
            sponsor,
        });
    };

    const sponsorLeg = (over: Partial<SponsorFillInput> = {}): SponsorFillInput => ({
        fund: taxiCoin(),
        netContributionSats: BigInt(1_000),
        changeScript: TAXI_CHANGE,
        ...over,
    });

    const recycledFill = async (sponsor: SponsorFillInput) => {
        reset([{ ...satsDeposit, value: 10_000 }]);
        const layout = await assemble(
            recycledWantHex,
            sponsor,
            fundingCoin({
                value: 330,
                assets: [{ assetId: WANTED_ASSET, amount: 10_000 }],
            }),
        );
        return {
            layout,
            asset: callsOf("withAsset")[0].args[0],
            to: callsOf("to").map((call) => call.args),
        };
    };

    it("refuses sponsor funding that carries an asset", async () => {
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({ fund: taxiCoin({ assets: [{ assetId: STRAY_ASSET, amount: 1 }] }) }),
            ),
        ).rejects.toThrow(/sats-only/);
    });

    it("refuses a contribution larger than the sponsor put in", async () => {
        reset();
        await expect(
            assemble(wantBtcHex, sponsorLeg({ netContributionSats: BigInt(50_000) })),
        ).rejects.toThrow(/netContributionSats 50000 exceeds/);
    });

    it("emits no change output when the contribution spends every sponsor sat", async () => {
        reset();
        const layout = await assemble(
            wantBtcHex,
            sponsorLeg({ netContributionSats: BigInt(10_000) }),
        );
        expect(layout.outputs.map((o) => o.role)).not.toContain("sponsor-change");
        expect(callsOf("to")).toHaveLength(1);
    });

    it("pays sponsor change back to the sponsor's own script", async () => {
        reset();
        const layout = await assemble(wantBtcHex, sponsorLeg());
        const change = layout.outputs.find((o) => o.role === "sponsor-change");
        expect(change?.sats).toBe(BigInt(9_000));
        expect(hex.encode(change!.script)).toBe(hex.encode(TAXI_CHANGE));
    });

    it.each([
        ["absent", {}],
        ["false", { combineSatsFareWithChange: false }],
    ])("keeps the exact legacy fare layout and packet when combine is %s", async (_label, flag) => {
        const result = await recycledFill(
            sponsorLeg({
                fund: taxiCoin({ value: 1_000 }),
                netContributionSats: BigInt(329),
                fare: { script: TAXI_CHANGE, sats: BigInt(4) },
                ...flag,
            }),
        );
        expect(result.layout.outputs).toEqual([
            { role: "receiver", script: recycledWant.makerPkScript, sats: BigInt(330) },
            { role: "sponsor-fare", script: TAXI_CHANGE, sats: BigInt(4) },
            { role: "sponsor-change", script: TAXI_CHANGE, sats: BigInt(671) },
            { role: "solver", script: TAKER_PAYOUT, sats: BigInt(10_325) },
        ]);
        expect(result.asset).toEqual({
            assetId: WANTED_ASSET,
            inputs: [{ vin: 1, amount: BigInt(10_000) }],
            outputs: [
                { vout: 0, amount: BigInt(9_995) },
                { vout: 3, amount: BigInt(5) },
            ],
        });
    });

    it("reports the outputs the builder was actually asked to build, in vout order", async () => {
        const result = await recycledFill(
            sponsorLeg({
                fund: taxiCoin({ value: 1_000 }),
                netContributionSats: BigInt(329),
                fare: { script: FARE_SCRIPT, sats: BigInt(4) },
            }),
        );
        const built = [
            ...callsOf("to").map((call) => call.args[0] as Uint8Array),
            callsOf("change")[0].args[0] as Uint8Array,
        ];
        expect(built.map((script) => hex.encode(script))).toEqual(
            result.layout.outputs.map((output) => hex.encode(output.script)),
        );
    });

    it("coalesces a sats fare into sponsor change without netting the gross loan", async () => {
        const result = await recycledFill(
            sponsorLeg({
                fund: taxiCoin({ value: 1_000 }),
                netContributionSats: BigInt(329),
                fare: { script: TAXI_CHANGE, sats: BigInt(4) },
                combineSatsFareWithChange: true,
            }),
        );
        expect(result.layout.inputs.map(({ owner }) => owner)).toEqual([null, "solver", "sponsor"]);
        expect(result.layout.outputs).toEqual([
            { role: "receiver", script: recycledWant.makerPkScript, sats: BigInt(330) },
            { role: "sponsor-change", script: TAXI_CHANGE, sats: BigInt(675) },
            { role: "solver", script: TAKER_PAYOUT, sats: BigInt(10_325) },
        ]);
        expect(result.to).toEqual([
            [recycledWant.makerPkScript, BigInt(330)],
            [TAXI_CHANGE, BigInt(675)],
        ]);
        expect(result.asset).toEqual({
            assetId: WANTED_ASSET,
            inputs: [{ vin: 1, amount: BigInt(10_000) }],
            outputs: [
                { vout: 0, amount: BigInt(9_995) },
                { vout: 2, amount: BigInt(5) },
            ],
        });
        expect(result.layout.outputs.reduce((sum, output) => sum + output.sats, BigInt(0))).toBe(
            BigInt(11_330),
        );
    });

    it("creates sponsor change from a coalesced fare when gross contribution spends the fund", async () => {
        const result = await recycledFill(
            sponsorLeg({
                fund: taxiCoin({ value: 329 }),
                netContributionSats: BigInt(329),
                fare: { script: TAXI_CHANGE, sats: BigInt(330) },
                combineSatsFareWithChange: true,
            }),
        );
        expect(result.layout.outputs.filter(({ role }) => role.startsWith("sponsor"))).toEqual([
            { role: "sponsor-change", script: TAXI_CHANGE, sats: BigInt(330) },
        ]);
    });

    it.each([
        ["missing fare", { combineSatsFareWithChange: true }, /requires a fare/],
        [
            "asset fare",
            {
                combineSatsFareWithChange: true,
                fare: {
                    assetId: DEPOSIT_ASSET,
                    amount: BigInt(1),
                    script: TAXI_CHANGE,
                    sats: BigInt(4),
                },
            },
            /sats-only fare/,
        ],
        [
            "different script",
            {
                combineSatsFareWithChange: true,
                fare: { script: FARE_SCRIPT, sats: BigInt(4) },
            },
            /same script/,
        ],
        [
            "non-boolean flag",
            {
                combineSatsFareWithChange: 0 as never,
                fare: { script: TAXI_CHANGE, sats: BigInt(4) },
            },
            /must be a boolean/,
        ],
    ])("rejects %s before touching the builder", async (_label, over, message) => {
        reset();
        await expect(assemble(wantBtcHex, sponsorLeg(over))).rejects.toThrow(message);
        expect(state.calls).toEqual([]);
    });

    it("rejects an unsafe combined sponsor output before touching the builder", async () => {
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fund: taxiCoin({ value: Number.MAX_SAFE_INTEGER }),
                    netContributionSats: BigInt(1),
                    fare: { script: TAXI_CHANGE, sats: BigInt(2) },
                    combineSatsFareWithChange: true,
                }),
            ),
        ).rejects.toThrow(/combined sponsor change must be a safe integer amount of sats/);
        expect(state.calls).toEqual([]);
    });

    it("rejects invalid change script validation even for a tiny combined output", async () => {
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fund: taxiCoin({ value: 329 }),
                    netContributionSats: BigInt(329),
                    changeScript: new Uint8Array(),
                    fare: { script: new Uint8Array(), sats: BigInt(1) },
                    combineSatsFareWithChange: true,
                }),
            ),
        ).rejects.toThrow(/sponsor.changeScript must be a non-empty output script/);
        expect(state.calls).toEqual([]);
    });

    it("keeps the gross contribution bound when the fare is coalesced", async () => {
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fund: taxiCoin({ value: 1_000 }),
                    netContributionSats: BigInt(1_001),
                    fare: { script: TAXI_CHANGE, sats: BigInt(4) },
                    combineSatsFareWithChange: true,
                }),
            ),
        ).rejects.toThrow(/netContributionSats 1001 exceeds the sponsor inputs 1000/);
        expect(state.calls).toEqual([]);
    });

    it("still rejects duplicate inputs before a coalesced build", async () => {
        reset();
        const shared = fundingCoin()[0] as { txid: string; vout: number; value: number };
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fund: [shared] as never,
                    fare: { script: TAXI_CHANGE, sats: BigInt(4) },
                    combineSatsFareWithChange: true,
                }),
            ),
        ).rejects.toThrow(/duplicate fill input/);
        expect(state.calls).toEqual([]);
    });

    it("folds a same-asset fare into the wanted group, not a second one", async () => {
        reset([satsDeposit]);
        await assemble(
            wantAssetHex,
            sponsorLeg({
                fare: {
                    assetId: WANTED_ASSET,
                    amount: BigInt(5),
                    script: FARE_SCRIPT,
                    sats: ASSET_CARRIER_SATS,
                },
            }),
            fundingCoin({ assets: [{ assetId: WANTED_ASSET, amount: 50_005 }] }),
        );
        const groups = callsOf("withAsset");
        expect(groups).toHaveLength(1);
        const g = groups[0].args[0] as { assetId: string; outputs: { amount: bigint }[] };
        expect(g.assetId).toBe(WANTED_ASSET);
        // maker's 50_000 and the taxi's 5 both ride group 0.
        expect(g.outputs.reduce((s, o) => s + o.amount, BigInt(0))).toBe(BigInt(50_005));
    });

    it("gives a cross-asset fare its own group behind the wanted one", async () => {
        reset([satsDeposit]);
        await assemble(
            wantAssetHex,
            sponsorLeg({
                fare: {
                    assetId: STRAY_ASSET,
                    amount: BigInt(2),
                    script: FARE_SCRIPT,
                    sats: ASSET_CARRIER_SATS,
                },
            }),
            fundingCoin({
                assets: [
                    { assetId: WANTED_ASSET, amount: 50_000 },
                    { assetId: STRAY_ASSET, amount: 2 },
                ],
            }),
        );
        const ids = callsOf("withAsset").map((c) => (c.args[0] as { assetId: string }).assetId);
        expect(ids[0]).toBe(WANTED_ASSET);
        expect(ids).toContain(STRAY_ASSET);
    });

    it("refuses the same coin funding the solver and the sponsor", async () => {
        reset();
        const shared = fundingCoin()[0] as { txid: string; vout: number; value: number };
        await expect(assemble(wantBtcHex, sponsorLeg({ fund: [shared] as never }))).rejects.toThrow(
            /duplicate fill input/,
        );
    });

    it("charges a fare in sats alone, opening no asset group for it", async () => {
        reset();
        const layout = await assemble(
            wantBtcHex,
            sponsorLeg({ fare: { script: FARE_SCRIPT, sats: BigInt(750) } }),
        );
        const fare = layout.outputs.find((o) => o.role === "sponsor-fare");
        expect(fare?.sats).toBe(BigInt(750));
        expect(hex.encode(fare!.script)).toBe(hex.encode(FARE_SCRIPT));
        // The deposit asset still routes to the solver; the fare adds no group.
        const ids = callsOf("withAsset").map((c) => (c.args[0] as { assetId: string }).assetId);
        expect(ids).toEqual([DEPOSIT_ASSET]);
    });

    it("refuses a fare naming an asset without an amount, or the reverse", async () => {
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fare: { assetId: STRAY_ASSET, script: FARE_SCRIPT, sats: BigInt(330) },
                }),
            ),
        ).rejects.toThrow(/assetId and amount together/);
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fare: { amount: BigInt(1), script: FARE_SCRIPT, sats: BigInt(330) },
                }),
            ),
        ).rejects.toThrow(/assetId and amount together/);
    });

    it("names a sats shortfall before the builder sees it", async () => {
        reset();
        await expect(
            assemble(
                wantBtcHex,
                sponsorLeg({
                    fare: {
                        assetId: DEPOSIT_ASSET,
                        amount: BigInt(1),
                        script: FARE_SCRIPT,
                        sats: BigInt(10_000_000),
                    },
                }),
            ),
        ).rejects.toThrow(/outputs total \d+ sats but the inputs carry/);
    });
});

describe("resolveDeposit picks one deposit or refuses", () => {
    const at = (txid: string, vout: number) => ({ txid, vout, value: 10_000 });

    it("matches a txid the indexer returned in a different case", () => {
        expect(resolveDeposit([at("A".repeat(64), 0)], { fundingTxid: "a".repeat(64) }).vout).toBe(
            0,
        );
    });

    it("refuses deposits sharing a txid rather than taking the first", () => {
        const shared = "a".repeat(64);
        expect(() =>
            resolveDeposit([at(shared, 0), at(shared, 1)], { fundingTxid: shared }),
        ).toThrow(/share fundingTxid/);
    });

    it("takes the outpoint when both references are given and agree", () => {
        const shared = "a".repeat(64);
        // `vout`, not `value`: both deposits are worth 10_000
        expect(
            resolveDeposit([at(shared, 0), at(shared, 1)], {
                fundingTxid: shared,
                fundingOutpoint: { txid: shared, vout: 1 },
            }),
        ).toMatchObject({ txid: shared, vout: 1 });
    });

    it("refuses a txid and outpoint that disagree", () => {
        expect(() =>
            resolveDeposit([at("a".repeat(64), 0)], {
                fundingTxid: "b".repeat(64),
                fundingOutpoint: { txid: "a".repeat(64), vout: 0 },
            }),
        ).toThrow(/pass one deposit reference/);
    });
});
