import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkAddress,
    CSVMultisigTapscript,
    Extension,
    MultisigTapscript,
    Transaction,
    VtxoScript,
    asset,
    digestJointGraph,
    type IWallet,
} from "@arkade-os/sdk";
import { encodeOffer, fillOffer, offerVtxoScript, type Offer } from "../src/offer";
import { OFFER_FILL_TEMPLATE, buildOfferFillPlan, verifyOfferFillPlan } from "../src/offerFillPlan";

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

const assetsAt = (tx: Transaction, vout: number) =>
    (Extension.fromTx(tx).getAssetPacket()?.groups ?? []).flatMap((g) =>
        g.outputs
            .filter((o) => o.vout === vout)
            .map((o) => ({ assetId: g.assetId!.toString(), units: o.amount.toString() })),
    );

const fundedBy = (checkpoint: string) => {
    const spent = Transaction.fromPSBT(base64.decode(checkpoint)).getInput(0);
    return { txid: hex.encode(spent.txid!), vout: spent.index };
};

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

describe("buildOfferFillPlan (taxi-sponsored, unsigned)", () => {
    const WANT_ASSET = "12".repeat(32) + "0000";
    const STRAY_ASSET = "34".repeat(32) + "0000";
    // The builder decodes every output script as taproot, so these must be
    // real curve points like the maker/taker keys above.
    const trKey = (seed: number) =>
        hex.decode(`5120${hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(seed)))}`);
    const FARE_SCRIPT = trKey(0xa1);
    const TAXI_CHANGE_SCRIPT = trKey(0xb2);
    const SOLVER_PAYOUT = trKey(0xc3);

    const planOffer: Omit<Offer, "swapPkScript"> = {
        wantAmount: BigInt(200),
        wantAsset: asset.AssetId.fromString(WANT_ASSET),
        makerPkScript: hex.decode(MAKER_PK_SCRIPT),
        makerPublicKey: hex.decode(MAKER_KEY),
        emulatorPubkey: hex.decode(
            "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
        ),
    };
    const planScript = offerVtxoScript(planOffer, SERVER_KEY);
    const planOfferHex = hex.encode(
        encodeOffer({ ...planOffer, swapPkScript: planScript.pkScript }),
    );

    const satsDeposit = () => ({ ...mintCoin(1_000) });
    const solverCoin = () => ({
        ...fundingCoin(1),
        assets: [{ assetId: WANT_ASSET, amount: 201 }],
    });
    const taxiCoin = () => ({ ...fundingCoin(1_000) });

    type FundCoin = {
        txid: string;
        vout: number;
        value: number;
        assets?: { assetId: string; amount: number }[];
    };
    const sponsored = (
        deposit: FundCoin,
        solver: FundCoin,
        taxi: FundCoin,
        sponsorOver: {
            netContributionSats?: bigint;
            fare?: { assetId: string; amount: number; script: Uint8Array; sats: number };
            changeScript?: Uint8Array;
            fund?: FundCoin[];
        } = {},
    ) =>
        buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
            fund: [solver] as never,
            payoutScript: SOLVER_PAYOUT,
            assetCarrierSats: BigInt(330),
            sponsor: {
                fund: (sponsorOver.fund ?? [taxi]) as never,
                netContributionSats: sponsorOver.netContributionSats ?? BigInt(330),
                fare: sponsorOver.fare ?? {
                    assetId: WANT_ASSET,
                    amount: 1,
                    script: FARE_SCRIPT,
                    sats: 1,
                },
                changeScript: sponsorOver.changeScript ?? TAXI_CHANGE_SCRIPT,
            },
        });

    it("builds the hand-checked joint graph", async () => {
        reset();
        const deposit = satsDeposit();
        const solver = solverCoin();
        const taxi = taxiCoin();
        state.vtxos = [deposit];
        const plan = await sponsored(deposit, solver, taxi);

        // Inputs 1000 + 1 + 1000 = 2001 sats; outputs 330 + 1 + 670 + 1000.
        // Solver supplies 201 units: 200 to the maker, 1 to the taxi fare.
        expect(plan.inputOwners).toEqual([null, "solver", "sponsor"]);
        const ark = Transaction.fromPSBT(base64.decode(plan.arkTx));
        expect(plan.checkpoints).toHaveLength(3);
        expect(plan.checkpoints.map(fundedBy)).toEqual([
            { txid: deposit.txid, vout: deposit.vout },
            { txid: solver.txid, vout: solver.vout },
            { txid: taxi.txid, vout: taxi.vout },
        ]);
        expect(ark.outputsLength).toBe(6);
        const payment = (vout: number) => ({
            script: hex.encode(ark.getOutput(vout).script!),
            sats: ark.getOutput(vout).amount!.toString(),
            assets: assetsAt(ark, vout),
        });
        expect(payment(0)).toEqual({
            script: MAKER_PK_SCRIPT,
            sats: "330",
            assets: [{ assetId: WANT_ASSET, units: "200" }],
        });
        expect(payment(1)).toEqual({
            script: hex.encode(FARE_SCRIPT),
            sats: "1",
            assets: [{ assetId: WANT_ASSET, units: "1" }],
        });
        expect(payment(2)).toEqual({
            script: hex.encode(TAXI_CHANGE_SCRIPT),
            sats: "670",
            assets: [],
        });
        expect(payment(3)).toEqual({
            script: hex.encode(SOLVER_PAYOUT),
            sats: "1000",
            assets: [],
        });
        expect(plan.graphId).toMatch(/^[0-9a-f]{64}$/);
        expect(verifyOfferFillPlan(plan)).toBe(true);
    });

    it("signs nothing and submits nothing", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        await sponsored(state.vtxos[0], solverCoin(), taxiCoin());
        expect(identity.sign).not.toHaveBeenCalled();
        expect(state.emulatorSubmits).toBe(0);
    });

    it("matches the spend fillOffer submits when there is no sponsor", async () => {
        reset();
        const deposit = satsDeposit();
        const solver = solverCoin();
        state.vtxos = [deposit];
        const plan = await buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
            fund: [solver] as never,
            payoutScript: SOLVER_PAYOUT,
            assetCarrierSats: BigInt(330),
        });
        const txid = await fillOffer(wallet, "http://ark", planOfferHex, {
            fund: [solver] as never,
            payoutScript: SOLVER_PAYOUT,
            assetCarrierSats: BigInt(330),
            emulator: "http://emulator.test",
        });

        // Signing appends witnesses, so the PSBTs differ — the payments and
        // the asset groups must not.
        const submitted = Transaction.fromPSBT(base64.decode(state.arkTx!));
        const planned = Transaction.fromPSBT(base64.decode(plan.arkTx));
        expect(txid).toBe(submitted.id);
        const payments = (tx: Transaction) =>
            [0, 1].map((vout) => ({
                script: hex.encode(tx.getOutput(vout).script!),
                amount: tx.getOutput(vout).amount,
            }));
        expect(payments(submitted)).toEqual(payments(planned));
        const groups = (tx: Transaction) =>
            Extension.fromTx(tx)
                .getAssetPacket()!
                .groups.map((g) => ({
                    assetId: g.assetId!.toString(),
                    inputs: g.inputs.map((i) => ({ vin: i.vin, amount: i.amount })),
                    outputs: g.outputs.map((o) => ({ vout: o.vout, amount: o.amount })),
                }));
        expect(groups(submitted)).toEqual(groups(planned));
        expect(plan.inputOwners).toEqual([null, "solver"]);
    });

    it("keeps the wanted asset first when the solver's coin carries more", async () => {
        reset();
        const deposit = satsDeposit();
        state.vtxos = [deposit];
        const solver = { ...fundingCoin(1), assets: [{ assetId: WANT_ASSET, amount: 201 }] };
        solver.assets.push({ assetId: STRAY_ASSET, amount: 5 });
        const plan = await sponsored(deposit, solver, taxiCoin());

        const groups = Extension.fromTx(Transaction.fromPSBT(base64.decode(plan.arkTx)))
            .getAssetPacket()!
            .groups.map((g) => g.assetId!.toString());
        expect(groups).toEqual([WANT_ASSET, STRAY_ASSET]);
        const planned = Transaction.fromPSBT(base64.decode(plan.arkTx));
        expect(hex.encode(planned.getOutput(3).script!)).toBe(hex.encode(SOLVER_PAYOUT));
        expect(planned.getOutput(3).amount).toBe(BigInt(1000));
        expect(assetsAt(planned, 3)).toEqual([{ assetId: STRAY_ASSET, units: "5" }]);
    });

    it("rejects sponsor funding that carries assets", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const taxi = { ...taxiCoin(), assets: [{ assetId: WANT_ASSET, amount: 1 }] };
        await expect(sponsored(state.vtxos[0], solverCoin(), taxi)).rejects.toThrow(/sats-only/);
    });

    it("rejects a fare no input carries", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        await expect(
            sponsored(state.vtxos[0], solverCoin(), taxiCoin(), {
                fare: { assetId: STRAY_ASSET, amount: 1, script: FARE_SCRIPT, sats: 1 },
            }),
        ).rejects.toThrow(/sponsor fare needs 1 of .* but the inputs carry 0/);
    });

    it("rejects a same-asset fare the solver cannot cover on top of wantAmount", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const solver = { ...fundingCoin(1), assets: [{ assetId: WANT_ASSET, amount: 200 }] };
        await expect(sponsored(state.vtxos[0], solver, taxiCoin())).rejects.toThrow(
            /needs 201 of .*`fund` declares 200/,
        );
    });

    it("rejects a contribution above the sponsor inputs, and a non-positive one", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        await expect(
            sponsored(state.vtxos[0], solverCoin(), taxiCoin(), {
                netContributionSats: BigInt(1001),
            }),
        ).rejects.toThrow(/exceeds the sponsor inputs 1000/);
        await expect(
            sponsored(state.vtxos[0], solverCoin(), taxiCoin(), { netContributionSats: BigInt(0) }),
        ).rejects.toThrow(/must be a positive amount of sats/);
    });

    it("rejects the same outpoint funding two legs", async () => {
        reset();
        const deposit = satsDeposit();
        state.vtxos = [deposit];
        const solver = solverCoin();
        await expect(
            buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
                fund: [solver, solver] as never,
                payoutScript: SOLVER_PAYOUT,
                assetCarrierSats: BigInt(330),
            }),
        ).rejects.toThrow(/duplicate fill input .* \(fund\[1\]\)/);
    });

    it("tells same-txid deposits apart only by outpoint", async () => {
        reset();
        const first = satsDeposit();
        const second = { txid: first.txid, vout: 1, value: 500 };
        state.vtxos = [first, second];
        await expect(
            buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
                fund: [solverCoin()] as never,
                payoutScript: SOLVER_PAYOUT,
                fundingTxid: first.txid,
            }),
        ).rejects.toThrow(/pass fundingOutpoint to select one/);

        const plan = await buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
            fund: [solverCoin()] as never,
            payoutScript: SOLVER_PAYOUT,
            fundingOutpoint: { txid: first.txid, vout: 1 },
        });
        expect(fundedBy(plan.checkpoints[0])).toEqual({ txid: first.txid, vout: 1 });
    });

    it("omits taxi change when the contribution spends every sat", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const plan = await sponsored(state.vtxos[0], solverCoin(), taxiCoin(), {
            netContributionSats: BigInt(1000),
        });
        const ark = Transaction.fromPSBT(base64.decode(plan.arkTx));
        expect(ark.outputsLength).toBe(5);
        expect(hex.encode(ark.getOutput(0).script!)).toBe(MAKER_PK_SCRIPT);
        expect(hex.encode(ark.getOutput(1).script!)).toBe(hex.encode(FARE_SCRIPT));
        expect(hex.encode(ark.getOutput(2).script!)).toBe(hex.encode(SOLVER_PAYOUT));
        expect(ark.getOutput(2).amount).toBe(BigInt(1670));
    });

    it("rejects a sponsor without a change script", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const { changeScript: _dropped, ...sponsor } = {
            fund: [taxiCoin()] as never,
            netContributionSats: BigInt(330),
            fare: { assetId: WANT_ASSET, amount: 1, script: FARE_SCRIPT, sats: 1 },
            changeScript: TAXI_CHANGE_SCRIPT,
        };
        await expect(
            buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
                fund: [solverCoin()] as never,
                payoutScript: SOLVER_PAYOUT,
                sponsor: sponsor as never,
            }),
        ).rejects.toThrow(/sponsor\.changeScript/);
    });

    it("binds the graph id to the receiver's amount and script", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const plan = await sponsored(state.vtxos[0], solverCoin(), taxiCoin());
        const repriced = await buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
            fund: [solverCoin()] as never,
            payoutScript: SOLVER_PAYOUT,
            assetCarrierSats: BigInt(331),
            sponsor: {
                fund: [taxiCoin()] as never,
                netContributionSats: BigInt(330),
                fare: { assetId: WANT_ASSET, amount: 1, script: FARE_SCRIPT, sats: 1 },
                changeScript: TAXI_CHANGE_SCRIPT,
            },
        });
        expect(repriced.graphId).not.toBe(plan.graphId);

        const retarget = (mutate: (tx: Transaction) => void) => {
            const tx = Transaction.fromPSBT(base64.decode(plan.arkTx));
            mutate(tx);
            return base64.encode(tx.toPSBT());
        };
        const repricedTx = retarget((tx) => {
            const out = tx.getOutput(0);
            tx.updateOutput(0, { script: out.script, amount: out.amount! + 1n });
        });
        expect(verifyOfferFillPlan({ ...plan, arkTx: repricedTx })).toBe(false);
        const rescriptedTx = retarget((tx) => {
            tx.updateOutput(0, { script: SOLVER_PAYOUT, amount: tx.getOutput(0).amount });
        });
        expect(verifyOfferFillPlan({ ...plan, arkTx: rescriptedTx })).toBe(false);
        expect(verifyOfferFillPlan(plan)).toBe(true);
    });

    it("rejects an unsafe funding value above MAX_SAFE_INTEGER", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const solver = { ...solverCoin(), value: Number.MAX_SAFE_INTEGER + 1 };
        await expect(sponsored(state.vtxos[0], solver, taxiCoin())).rejects.toThrow(
            /fund\[0\]\.value must be a safe integer amount of sats/,
        );
    });

    it("rejects a zero-value funding coin", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const solver = { ...solverCoin(), value: 0 };
        await expect(sponsored(state.vtxos[0], solver, taxiCoin())).rejects.toThrow(
            /fund\[0\]\.value must be a positive amount of sats/,
        );
    });

    it("rejects an unsafe or zero deposit value", async () => {
        reset();
        state.vtxos = [{ txid: "dd".repeat(32), vout: 0, value: Number.MAX_SAFE_INTEGER + 1 }];
        await expect(sponsored(state.vtxos[0], solverCoin(), taxiCoin())).rejects.toThrow(
            /deposit\.value must be a safe integer amount of sats/,
        );
        reset();
        state.vtxos = [{ txid: "dd".repeat(32), vout: 0, value: 0 }];
        await expect(sponsored(state.vtxos[0], solverCoin(), taxiCoin())).rejects.toThrow(
            /deposit\.value must be a positive amount of sats/,
        );
    });

    it("rejects a zero, negative or oversized asset carrier", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const base = {
            fund: [solverCoin()] as never,
            payoutScript: SOLVER_PAYOUT,
            sponsor: {
                fund: [taxiCoin()] as never,
                netContributionSats: BigInt(330),
                fare: { assetId: WANT_ASSET, amount: 1, script: FARE_SCRIPT, sats: 1 },
                changeScript: TAXI_CHANGE_SCRIPT,
            },
        };
        for (const carrier of [
            { value: BigInt(0), pattern: /assetCarrierSats must be a positive amount of sats/ },
            { value: BigInt(-1), pattern: /assetCarrierSats must be a safe integer amount/ },
            {
                value: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
                pattern: /assetCarrierSats must be a safe integer amount/,
            },
        ]) {
            await expect(
                buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
                    ...base,
                    assetCarrierSats: carrier.value,
                }),
            ).rejects.toThrow(carrier.pattern);
        }
    });

    it("rejects unsafe contribution, fare amount and fare sats", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const over = Number.MAX_SAFE_INTEGER + 1;
        await expect(
            sponsored(state.vtxos[0], solverCoin(), taxiCoin(), {
                netContributionSats: BigInt(over),
            }),
        ).rejects.toThrow(/netContributionSats must be a safe integer amount of sats/);
        await expect(
            sponsored(state.vtxos[0], solverCoin(), taxiCoin(), {
                fare: { assetId: WANT_ASSET, amount: over, script: FARE_SCRIPT, sats: 1 },
            }),
        ).rejects.toThrow(/fare\.amount must be a safe integer amount of asset units/);
        await expect(
            sponsored(state.vtxos[0], solverCoin(), taxiCoin(), {
                fare: { assetId: WANT_ASSET, amount: 1, script: FARE_SCRIPT, sats: over },
            }),
        ).rejects.toThrow(/fare\.sats must be a safe integer amount of sats/);
    });

    it("rejects a negative asset entry", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const solver = {
            ...fundingCoin(1),
            assets: [
                { assetId: WANT_ASSET, amount: 201 },
                { assetId: STRAY_ASSET, amount: -5 },
            ],
        };
        await expect(sponsored(state.vtxos[0], solver, taxiCoin())).rejects.toThrow(
            /fund\[0\]\.assets\[1\]\.amount must be a safe integer amount of asset units/,
        );
    });

    it("ignores an explicitly zero asset entry", async () => {
        reset();
        const deposit = satsDeposit();
        state.vtxos = [deposit];
        const solver = {
            ...fundingCoin(1),
            assets: [
                { assetId: WANT_ASSET, amount: 201 },
                { assetId: STRAY_ASSET, amount: 0 },
            ],
        };
        const plan = await sponsored(deposit, solver, taxiCoin());
        const groups = Extension.fromTx(Transaction.fromPSBT(base64.decode(plan.arkTx)))
            .getAssetPacket()!
            .groups.map((g) => g.assetId!.toString());
        expect(groups).toEqual([WANT_ASSET]);
    });

    it("rejects duplicate asset entries in one coin", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const solver = {
            ...fundingCoin(1),
            assets: [
                { assetId: WANT_ASSET, amount: 100 },
                { assetId: WANT_ASSET, amount: 101 },
            ],
        };
        await expect(sponsored(state.vtxos[0], solver, taxiCoin())).rejects.toThrow(
            /declares .* twice/,
        );
    });

    it("defaults an omitted fare host to the asset carrier", async () => {
        reset();
        const deposit = satsDeposit();
        const solver = solverCoin();
        const taxi = taxiCoin();
        state.vtxos = [deposit];
        const plan = await buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
            fund: [solver] as never,
            payoutScript: SOLVER_PAYOUT,
            assetCarrierSats: BigInt(330),
            sponsor: {
                fund: [taxi] as never,
                netContributionSats: BigInt(330),
                fare: { assetId: WANT_ASSET, amount: 1, script: FARE_SCRIPT },
                changeScript: TAXI_CHANGE_SCRIPT,
            },
        });
        const fareArk = Transaction.fromPSBT(base64.decode(plan.arkTx));
        expect(fareArk.outputsLength).toBe(6);
        const farePayment = (vout: number) => ({
            script: hex.encode(fareArk.getOutput(vout).script!),
            sats: fareArk.getOutput(vout).amount!.toString(),
            assets: assetsAt(fareArk, vout),
        });
        expect(farePayment(0)).toEqual({
            script: MAKER_PK_SCRIPT,
            sats: "330",
            assets: [{ assetId: WANT_ASSET, units: "200" }],
        });
        expect(farePayment(1)).toEqual({
            script: hex.encode(FARE_SCRIPT),
            sats: "330",
            assets: [{ assetId: WANT_ASSET, units: "1" }],
        });
        expect(farePayment(2)).toEqual({
            script: hex.encode(TAXI_CHANGE_SCRIPT),
            sats: "670",
            assets: [],
        });
        expect(farePayment(3)).toEqual({
            script: hex.encode(SOLVER_PAYOUT),
            sats: "671",
            assets: [],
        });
        expect(verifyOfferFillPlan(plan)).toBe(true);
    });

    it("builds a sponsored BTC-want graph with a solver-held fare asset", async () => {
        reset();
        const btcDeposit = deposit();
        state.vtxos = [btcDeposit];
        const solver = {
            ...fundingCoin(80_000),
            assets: [{ assetId: STRAY_ASSET, amount: 9 }],
        };
        const taxi = taxiCoin();
        const plan = await buildOfferFillPlan(wallet, "http://ark", offerHex, {
            fund: [solver] as never,
            payoutScript: TAKER_PAYOUT,
            sponsor: {
                fund: [taxi] as never,
                netContributionSats: BigInt(330),
                fare: { assetId: STRAY_ASSET, amount: 4, script: FARE_SCRIPT, sats: 1 },
                changeScript: TAXI_CHANGE_SCRIPT,
            },
        });

        expect(plan.inputOwners).toEqual([null, "solver", "sponsor"]);
        const btcArk = Transaction.fromPSBT(base64.decode(plan.arkTx));
        expect(btcArk.outputsLength).toBe(6);
        const btcPayment = (vout: number) => ({
            script: hex.encode(btcArk.getOutput(vout).script!),
            sats: btcArk.getOutput(vout).amount!.toString(),
            assets: assetsAt(btcArk, vout),
        });
        expect(btcPayment(0)).toEqual({ script: MAKER_PK_SCRIPT, sats: "50000", assets: [] });
        expect(btcPayment(1)).toEqual({
            script: hex.encode(FARE_SCRIPT),
            sats: "1",
            assets: [{ assetId: STRAY_ASSET, units: "4" }],
        });
        expect(btcPayment(2)).toEqual({
            script: hex.encode(TAXI_CHANGE_SCRIPT),
            sats: "670",
            assets: [],
        });
        expect(btcPayment(3)).toEqual({
            script: hex.encode(TAKER_PAYOUT),
            sats: "90329",
            assets: [
                { assetId: STRAY_ASSET, units: "5" },
                { assetId: DEPOSIT_ASSET, units: "2000" },
            ],
        });
        const groups = Extension.fromTx(Transaction.fromPSBT(base64.decode(plan.arkTx)))
            .getAssetPacket()!
            .groups.map((g) => g.assetId!.toString());
        expect(groups).toEqual([STRAY_ASSET, DEPOSIT_ASSET]);
        expect(verifyOfferFillPlan(plan)).toBe(true);
    });

    it("rejects malformed plans even with a recomputed digest", async () => {
        reset();
        state.vtxos = [satsDeposit()];
        const plan = await sponsored(state.vtxos[0], solverCoin(), taxiCoin());
        // Recompute the binding id the same way the implementation does, so a
        // rejection below can only come from the shape gate, not the digest.
        const reid = (p: any) =>
            digestJointGraph(
                {
                    arkTx: p.arkTx,
                    checkpoints: [...p.checkpoints],
                    inputOwners: [...p.inputOwners],
                },
                OFFER_FILL_TEMPLATE,
            );
        expect(reid(plan)).toBe(plan.graphId);
        const tamper = (mutate: (p: any) => unknown) => {
            const copy = JSON.parse(JSON.stringify(plan));
            mutate(copy);
            try {
                copy.graphId = reid(copy);
            } catch {
                copy.graphId = "00".repeat(32);
            }
            return copy;
        };
        expect(verifyOfferFillPlan(plan)).toBe(true);
        const malformed = [
            (p: any) => {
                p.arkTx = p.arkTx.slice(0, -8);
            },
            (p: any) => {
                p.checkpoints = p.checkpoints.slice(1);
            },
            (p: any) => {
                p.inputOwners = [];
                p.checkpoints = [];
            },
            (p: any) => {
                p.inputOwners = [null, "solver", 42];
            },
            (p: any) => {
                p.inputOwners = [null, "", "sponsor"];
            },
        ];
        for (const mutate of malformed) {
            expect(verifyOfferFillPlan(tamper(mutate))).toBe(false);
        }
        expect(verifyOfferFillPlan({ ...plan, graphId: "00".repeat(32) })).toBe(false);
        const repriced = Transaction.fromPSBT(base64.decode(plan.arkTx));
        const out = repriced.getOutput(0);
        repriced.updateOutput(0, { script: out.script, amount: out.amount! + 1n });
        expect(verifyOfferFillPlan({ ...plan, arkTx: base64.encode(repriced.toPSBT()) })).toBe(
            false,
        );
        const relabeled = JSON.parse(JSON.stringify(plan));
        relabeled.inputOwners = [null, "solver", "solver"];
        expect(verifyOfferFillPlan(relabeled)).toBe(false);
    });
});
