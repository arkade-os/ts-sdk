import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { SigHash } from "@scure/btc-signer";
import {
    ArkAddress,
    ConditionWitness,
    CSVMultisigTapscript,
    EmulatorPacket,
    Extension,
    MultisigTapscript,
    PrevArkTxField,
    SingleKey,
    Transaction,
    VtxoScript,
    arkade,
    asset,
    getArkPsbtFields,
    setArkPsbtField,
    tapLeavesOfInput,
    type BatchSignableIdentity,
    type Identity,
    type IWallet,
} from "@arkade-os/sdk";
import { encodeOffer, offerVtxoScript, type Offer } from "../src/offer";
import {
    OFFER_FILL_TEMPLATE,
    buildOfferFillPlan,
    verifyOfferFillPlan,
    type JointGraph,
} from "../src/offerFillPlan";
import {
    JointSigningError,
    JointSubmissionAmbiguousError,
    providerCosignerKey,
    prepareJointSubmission,
    signJointGraphForOwner,
    submitJointFill,
    type JointSignerBinding,
} from "../src/jointSigning";

const state = vi.hoisted(() => ({
    vtxos: [] as unknown[],
    managed: null as unknown,
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
                return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
            }
        },
    };
});

const SERVER_SEED = new Uint8Array(32).fill(0x59);
const SERVER_KEY = schnorr.getPublicKey(SERVER_SEED);
const EMULATOR_SEED = new Uint8Array(32).fill(0x5a);
const EMULATOR_KEY = schnorr.getPublicKey(EMULATOR_SEED);
const CHECKPOINT = hex.encode(
    CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(10) },
        pubkeys: [SERVER_KEY],
    }).script,
);

const MAKER_KEY = "71102fc86b5c576c72f411e083cc03eb83d1b55065406ba2a483208dbb5074ab";
const MAKER_PK_SCRIPT = `5120${MAKER_KEY}`;
const WANT_ASSET = "12".repeat(32) + "0000";
const SOLVER_SEED = new Uint8Array(32).fill(0x53);
const SOLVER_B_SEED = new Uint8Array(32).fill(0x5b);
const TAXI_SEED = new Uint8Array(32).fill(0x54);
const TAXI_B_SEED = new Uint8Array(32).fill(0x55);
const solverKey = schnorr.getPublicKey(SOLVER_SEED);
const solverBKey = schnorr.getPublicKey(SOLVER_B_SEED);
const taxiKey = schnorr.getPublicKey(TAXI_SEED);
const taxiBKey = schnorr.getPublicKey(TAXI_B_SEED);

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
    emulatorPubkey: EMULATOR_KEY,
};
const planScript = offerVtxoScript(planOffer, SERVER_KEY);
const planOfferHex = hex.encode(encodeOffer({ ...planOffer, swapPkScript: planScript.pkScript }));

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

const fundingCoinFor = (ownerKey: Uint8Array, value: number) => {
    const vs = new VtxoScript([
        MultisigTapscript.encode({ pubkeys: [ownerKey, SERVER_KEY] }).script,
    ]);
    return { ...mintCoin(value), tapLeafScript: vs.leaves[0], tapTree: vs.encode() };
};

const wallet = {
    identity: {
        xOnlyPublicKey: async () => solverKey,
        sign: async (tx: Transaction) => tx,
    },
    getAddress: async () =>
        new ArkAddress(SERVER_KEY, hex.decode("22".repeat(32)), "tark").encode(),
    getContractManager: async () => state.managed,
} as unknown as IWallet;

const solverCoin = (key: Uint8Array, units: number) => ({
    ...fundingCoinFor(key, 1),
    assets: [{ assetId: WANT_ASSET, amount: units }],
});

const sponsored = (solverFund: unknown[], taxiFund: unknown[]) =>
    buildOfferFillPlan(wallet, "http://ark", planOfferHex, {
        fund: solverFund as never,
        payoutScript: SOLVER_PAYOUT,
        assetCarrierSats: BigInt(330),
        sponsor: {
            fund: taxiFund as never,
            netContributionSats: BigInt(330),
            fare: { assetId: WANT_ASSET, amount: 1, script: FARE_SCRIPT, sats: 1 },
            changeScript: TAXI_CHANGE_SCRIPT,
        },
    });

const trustedGraph = async (): Promise<JointGraph> => {
    state.vtxos = [{ ...mintCoin(1_000) }];
    return sponsored([solverCoin(solverKey, 201)], [{ ...fundingCoinFor(taxiKey, 1_000) }]);
};

const signBoth = async (expected: JointGraph) => {
    const afterSolver = await signJointGraphForOwner({
        expected,
        owner: "solver",
        bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
    });
    return signJointGraphForOwner({
        expected,
        partial: afterSolver,
        owner: "sponsor",
        bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
    });
};

const arkOf = (g: JointGraph) => Transaction.fromPSBT(base64.decode(g.arkTx));
const cpOf = (g: JointGraph, i: number) => Transaction.fromPSBT(base64.decode(g.checkpoints[i]));
const sigCount = (tx: Transaction, i: number) => tx.getInput(i).tapScriptSig?.length ?? 0;

const withArk = (g: JointGraph, f: (tx: Transaction) => void): JointGraph => {
    const tx = arkOf(g);
    f(tx);
    return { ...structuredClone(g), arkTx: base64.encode(tx.toPSBT()) };
};

const extensionIndex = (tx: Transaction): number => {
    for (let i = 0; i < tx.outputsLength; i++) {
        if (Extension.isExtension(tx.getOutput(i).script!)) return i;
    }
    throw new Error("no extension output");
};

const recomputeId = (g: JointGraph): string =>
    hex.encode(
        sha256(
            new TextEncoder().encode(
                JSON.stringify({
                    template: OFFER_FILL_TEMPLATE,
                    arkTx: g.arkTx,
                    checkpoints: g.checkpoints,
                    inputOwners: g.inputOwners,
                    inputOutpoints: g.inputOutpoints,
                    outputs: g.outputs,
                }),
            ),
        ),
    );

const addLeaf = (tx: Transaction, inputIndex: number, script: Uint8Array, fill: number): void => {
    const existing = tx.getInput(inputIndex).tapLeafScript!;
    const [first] = existing;
    const forgedKey = {
        ...first[0],
        merklePath: [...first[0].merklePath, new Uint8Array(32).fill(fill)],
    };
    tx.updateInput(inputIndex, {
        tapLeafScript: [...existing, [forgedKey, new Uint8Array([...script, 0xc0])]],
    });
};

const providerTweakPriv = (arkTx: string): Uint8Array => {
    const entry = Extension.fromTx(Transaction.fromPSBT(base64.decode(arkTx)))
        .getEmulatorPacket()
        ?.entries.find((e) => e.vin === 0);
    if (!entry) throw new Error("fixture has no provider script");
    const tweak = bytesToNumberBE(arkade.arkadeScriptHash(entry.script));
    return numberToBytesBE(
        (bytesToNumberBE(EMULATOR_SEED) + tweak) % secp256k1.Point.CURVE().n,
        32,
    );
};

const batchIdentity = (priv: Uint8Array) => {
    const key = SingleKey.fromPrivateKey(priv);
    let calls = 0;
    const identity = {
        xOnlyPublicKey: () => key.xOnlyPublicKey(),
        sign: (tx: Transaction, indexes?: number[]) => key.sign(tx, indexes),
        signMultiple: async (
            reqs: { tx: Transaction; inputIndexes?: number[] }[],
        ): Promise<Transaction[]> => {
            calls++;
            return Promise.all(reqs.map((r) => key.sign(r.tx, r.inputIndexes)));
        },
    } as unknown as BatchSignableIdentity;
    return { identity, calls: () => calls };
};

const wrapIdentity = (
    priv: Uint8Array,
    mutate: (tx: Transaction, indexes?: number[]) => Promise<Transaction> | Transaction,
): Identity => {
    const key = SingleKey.fromPrivateKey(priv);
    return {
        xOnlyPublicKey: () => key.xOnlyPublicKey(),
        compressedPublicKey: () => key.compressedPublicKey(),
        signerSession: () => key.signerSession(),
        signMessage: (m: Uint8Array, t: "schnorr" | "ecdsa") => key.signMessage(m, t),
        sign: async (tx: Transaction, indexes?: number[]) => mutate(tx, indexes),
    } as Identity;
};

const pins = {
    emulatorXOnly: hex.encode(EMULATOR_KEY),
    serverXOnly: hex.encode(SERVER_KEY),
};

const ownerKeys = {
    solver: [hex.encode(solverKey)],
    sponsor: [hex.encode(taxiKey)],
};

const honestEmulator = () => ({
    submitTx: async (arkTx: string, checkpointTxs: string[]) => {
        const ark = Transaction.fromPSBT(base64.decode(arkTx));
        const co = await SingleKey.fromPrivateKey(SERVER_SEED).sign(ark);
        const providerPriv = providerTweakPriv(arkTx);
        const cps: string[] = [];
        for (let k = 0; k < checkpointTxs.length; k++) {
            const seed = k === 0 ? providerPriv : SERVER_SEED;
            const signed = await SingleKey.fromPrivateKey(seed).sign(
                Transaction.fromPSBT(base64.decode(checkpointTxs[k])),
            );
            cps.push(base64.encode(signed.toPSBT()));
        }
        return { signedArkTx: base64.encode(co.toPSBT()), signedCheckpointTxs: cps };
    },
});

describe("signJointGraphForOwner", () => {
    it("completes a sponsored graph with two independent keys", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        expect(afterSolver.graphId).toBe(expected.graphId);
        expect(verifyOfferFillPlan(afterSolver)).toBe(false);
        const afterArk = arkOf(afterSolver);
        expect([0, 1, 2].map((i) => sigCount(afterArk, i))).toEqual([0, 1, 0]);
        expect(sigCount(cpOf(afterSolver, 1), 0)).toBe(1);
        expect(sigCount(cpOf(afterSolver, 2), 0)).toBe(0);
        const complete = await signJointGraphForOwner({
            expected,
            partial: afterSolver,
            owner: "sponsor",
            bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
        });
        expect(complete.graphId).toBe(expected.graphId);
        const ark = arkOf(complete);
        expect([0, 1, 2].map((i) => sigCount(ark, i))).toEqual([0, 1, 1]);
        expect(sigCount(cpOf(complete, 2), 0)).toBe(1);
        for (const [i, key] of [
            [1, solverKey],
            [2, taxiKey],
        ] as const) {
            const [[data, sig]] = ark.getInput(i).tapScriptSig!;
            expect(hex.encode(data.pubKey)).toBe(hex.encode(key));
            expect(sig.length).toBe(64);
        }
    });

    it("signs two solver inputs with two descriptor identities", async () => {
        state.vtxos = [{ ...mintCoin(1_000) }];
        const expected = await sponsored(
            [solverCoin(solverKey, 200), solverCoin(solverBKey, 1)],
            [{ ...fundingCoinFor(taxiKey, 1_000) }],
        );
        expect(expected.inputOwners).toEqual([null, "solver", "solver", "sponsor"]);
        const bindings: JointSignerBinding[] = [
            { inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) },
            { inputIndex: 2, identity: SingleKey.fromPrivateKey(SOLVER_B_SEED) },
        ];
        const afterSolver = await signJointGraphForOwner({ expected, owner: "solver", bindings });
        const ark = arkOf(afterSolver);
        expect([0, 1, 2, 3].map((i) => sigCount(ark, i))).toEqual([0, 1, 1, 0]);
        const [[d1]] = ark.getInput(1).tapScriptSig!;
        const [[d2]] = ark.getInput(2).tapScriptSig!;
        expect(hex.encode(d1.pubKey)).toBe(hex.encode(solverKey));
        expect(hex.encode(d2.pubKey)).toBe(hex.encode(solverBKey));
    });

    it("signs two sponsor inputs with two descriptor identities", async () => {
        state.vtxos = [{ ...mintCoin(1_000) }];
        const expected = await sponsored(
            [solverCoin(solverKey, 201)],
            [{ ...fundingCoinFor(taxiKey, 1_000) }, { ...fundingCoinFor(taxiBKey, 1_000) }],
        );
        expect(expected.inputOwners).toEqual([null, "solver", "sponsor", "sponsor"]);
        const bindings: JointSignerBinding[] = [
            { inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) },
            { inputIndex: 3, identity: SingleKey.fromPrivateKey(TAXI_B_SEED) },
        ];
        const afterTaxi = await signJointGraphForOwner({ expected, owner: "sponsor", bindings });
        const ark = arkOf(afterTaxi);
        expect([0, 1, 2, 3].map((i) => sigCount(ark, i))).toEqual([0, 0, 1, 1]);
        const [[d2]] = ark.getInput(2).tapScriptSig!;
        const [[d3]] = ark.getInput(3).tapScriptSig!;
        expect(hex.encode(d2.pubKey)).toBe(hex.encode(taxiKey));
        expect(hex.encode(d3.pubKey)).toBe(hex.encode(taxiBKey));
    });

    it("uses one batch call per owner", async () => {
        const expected = await trustedGraph();
        const taxi = batchIdentity(TAXI_SEED);
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        const complete = await signJointGraphForOwner({
            expected,
            partial: afterSolver,
            owner: "sponsor",
            bindings: [{ inputIndex: 2, identity: taxi.identity }],
        });
        expect(taxi.calls()).toBe(1);
        expect(sigCount(arkOf(complete), 2)).toBe(1);
        expect(sigCount(cpOf(complete, 2), 0)).toBe(1);
    });

    it("rejects an index assigned to the other owner", async () => {
        const expected = await trustedGraph();
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "solver",
                bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/not assigned to solver/);
    });

    it("rejects an unknown owner", async () => {
        const expected = await trustedGraph();
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "operator" as never,
                bindings: [],
            }),
        ).rejects.toThrow(/unknown funding owner/);
    });

    it("rejects missing, duplicate and out-of-range bindings", async () => {
        const expected = await trustedGraph();
        const solver = SingleKey.fromPrivateKey(SOLVER_SEED);
        await expect(
            signJointGraphForOwner({ expected, owner: "solver", bindings: [] }),
        ).rejects.toThrow(/expected 1 bindings, got 0/);
        const dup = [
            { inputIndex: 1, identity: solver },
            { inputIndex: 1, identity: solver },
        ];
        await expect(
            signJointGraphForOwner({ expected, owner: "solver", bindings: dup }),
        ).rejects.toThrow(/expected 1 bindings, got 2/);
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "solver",
                bindings: [{ inputIndex: 9, identity: solver }],
            }),
        ).rejects.toThrow(/out of range/);
        state.vtxos = [{ ...mintCoin(1_000) }];
        const wide = await sponsored(
            [solverCoin(solverKey, 200), solverCoin(solverBKey, 1)],
            [{ ...fundingCoinFor(taxiKey, 1_000) }],
        );
        const dupInCount = [
            { inputIndex: 1, identity: solver },
            { inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_B_SEED) },
        ];
        await expect(
            signJointGraphForOwner({ expected: wide, owner: "solver", bindings: dupInCount }),
        ).rejects.toThrow(/duplicate binding/);
    });

    it("rejects a binding key outside the funding tapscript", async () => {
        const expected = await trustedGraph();
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
            }),
        ).rejects.toThrow(/not in its funding tapscript/);
    });

    it("rejects an ambiguous selected leaf", async () => {
        const expected = await trustedGraph();
        const tx = arkOf(expected);
        const [existing] = tx.getInput(1).tapLeafScript!;
        const forgedScript = new Uint8Array([0x20, ...solverKey, 0xac]);
        const forgedKey = {
            ...existing[0],
            merklePath: [...existing[0].merklePath, new Uint8Array(32).fill(7)],
        };
        tx.updateInput(1, {
            tapLeafScript: [existing, [forgedKey, new Uint8Array([...forgedScript, 0xc0])]],
        });
        const altered = { ...structuredClone(expected), arkTx: base64.encode(tx.toPSBT()) };
        const twoLeaf: JointGraph = { ...altered, graphId: recomputeId(altered) };
        expect(verifyOfferFillPlan(twoLeaf)).toBe(true);
        await expect(
            signJointGraphForOwner({
                expected: twoLeaf,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/multiple candidate leaves/);
    });

    it("rejects an accumulated signature on a different valid leaf", async () => {
        const base = await trustedGraph();
        const ark = arkOf(base);
        const otherScript = MultisigTapscript.encode({
            pubkeys: [solverBKey, SERVER_KEY],
        }).script;
        addLeaf(ark, 1, otherScript, 9);
        const cp1 = cpOf(base, 1);
        addLeaf(cp1, 0, otherScript, 9);
        const altered: JointGraph = {
            ...structuredClone(base),
            arkTx: base64.encode(ark.toPSBT()),
            checkpoints: [base.checkpoints[0], base64.encode(cp1.toPSBT()), base.checkpoints[2]],
        };
        const twoLeaf: JointGraph = { ...altered, graphId: recomputeId(altered) };
        expect(verifyOfferFillPlan(twoLeaf)).toBe(true);
        const foreign = await signJointGraphForOwner({
            expected: twoLeaf,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_B_SEED) }],
        });
        await expect(
            signJointGraphForOwner({
                expected: twoLeaf,
                partial: foreign,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/selected leaf/);
    });

    it("ignores key bytes embedded in non-pushdata", async () => {
        const base = await trustedGraph();
        const ark = arkOf(base);
        const filler = new Uint8Array(64).fill(0x11);
        filler.set(solverKey, 5);
        addLeaf(ark, 1, new Uint8Array([0x4c, 0x40, ...filler, 0xac]), 8);
        const altered: JointGraph = {
            ...structuredClone(base),
            arkTx: base64.encode(ark.toPSBT()),
        };
        const twoLeaf: JointGraph = { ...altered, graphId: recomputeId(altered) };
        expect(verifyOfferFillPlan(twoLeaf)).toBe(true);
        const after = await signJointGraphForOwner({
            expected: twoLeaf,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        expect(sigCount(arkOf(after), 1)).toBe(1);
    });

    it("rejects a trusted graph that fails integrity", async () => {
        const expected = await trustedGraph();
        const evil = { ...structuredClone(expected), graphId: "00".repeat(32) };
        await expect(
            signJointGraphForOwner({
                expected: evil,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/fails integrity/);
    });

    it("rejects altered outputs, packets, witness, sequence and checkpoints", async () => {
        const expected = await trustedGraph();
        const solver = { inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) };
        const attempt = (g: JointGraph) =>
            signJointGraphForOwner({ expected, partial: g, owner: "solver", bindings: [solver] });
        await expect(
            attempt(
                withArk(expected, (tx) => {
                    const out = tx.getOutput(3);
                    tx.updateOutput(3, { script: out.script, amount: out.amount! + 1n });
                }),
            ),
        ).rejects.toThrow(/unsigned/i);
        await expect(
            attempt(
                withArk(expected, (tx) => {
                    tx.updateOutput(3, { script: trKey(0xd4), amount: tx.getOutput(3).amount });
                }),
            ),
        ).rejects.toThrow(/unsigned/i);
        await expect(
            attempt(
                withArk(expected, (tx) => {
                    tx.updateInput(0, { unknown: undefined });
                }),
            ),
        ).rejects.toThrow(/unsigned/i);
        await expect(
            attempt(
                withArk(expected, (tx) => {
                    tx.updateInput(1, { sequence: 123 });
                }),
            ),
        ).rejects.toThrow(/unsigned/i);
        const swapped: JointGraph = {
            ...structuredClone(expected),
            checkpoints: [
                expected.checkpoints[0],
                expected.checkpoints[2],
                expected.checkpoints[1],
            ],
        };
        await expect(attempt(swapped)).rejects.toThrow(/alters unsigned/);
        const duped: JointGraph = {
            ...structuredClone(expected),
            checkpoints: [
                expected.checkpoints[0],
                expected.checkpoints[1],
                expected.checkpoints[1],
            ],
        };
        await expect(attempt(duped)).rejects.toThrow(/alters unsigned/);
    });

    it("rejects a removed PrevArkTx", async () => {
        const expected = await trustedGraph();
        const solver = { inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) };
        const tx = arkOf(expected);
        expect(getArkPsbtFields(tx, 1, PrevArkTxField).length).toBeGreaterThan(0);
        const prevarktx = hex.encode(new TextEncoder().encode("prevarktx"));
        const unknown = tx.getInput(1).unknown ?? [];
        const stripped = unknown.filter(([k]) => hex.encode(k.key) !== prevarktx);
        expect(stripped.length).toBeLessThan(unknown.length);
        tx.updateInput(1, { unknown: stripped });
        const evil = { ...structuredClone(expected), arkTx: base64.encode(tx.toPSBT()) };
        expect(getArkPsbtFields(tx, 1, PrevArkTxField)).toEqual([]);
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "solver",
                bindings: [solver],
            }),
        ).rejects.toThrow(/unsigned/i);
    });

    it("rejects an added condition witness", async () => {
        const expected = await trustedGraph();
        expect(getArkPsbtFields(arkOf(expected), 0, ConditionWitness)).toEqual([]);
        const evil = withArk(expected, (tx) => {
            setArkPsbtField(tx, 0, ConditionWitness, [new Uint8Array([1])]);
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/unsigned/i);
    });

    it("rejects a tweaked asset packet", async () => {
        const expected = await trustedGraph();
        const evil = withArk(expected, (tx) => {
            const ext = Extension.fromTx(tx);
            const assetPacket = ext.getAssetPacket()!;
            const groups = assetPacket.groups.map((g, gi) =>
                asset.AssetGroup.create(
                    g.assetId,
                    null,
                    g.inputs.map((i) => asset.AssetInput.create(i.vin, i.amount)),
                    g.outputs.map((o, k) =>
                        asset.AssetOutput.create(
                            o.vout,
                            gi === 0 && k === 0 ? o.amount + 1n : o.amount,
                        ),
                    ),
                    [],
                ),
            );
            const rest = ext.getPackets().filter((p) => p !== assetPacket);
            const rebuilt = Extension.create([asset.Packet.create(groups), ...rest]);
            const idx = extensionIndex(tx);
            tx.updateOutput(idx, { script: rebuilt.serialize(), amount: 0n });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/unsigned/i);
    });

    it("rejects a tweaked emulator packet", async () => {
        const expected = await trustedGraph();
        const evil = withArk(expected, (tx) => {
            const ext = Extension.fromTx(tx);
            const emulatorPacket = ext.getEmulatorPacket()!;
            const entries = emulatorPacket.entries.map((e, k) =>
                k === 0 && e.witness !== undefined
                    ? {
                          vin: e.vin,
                          script: e.script,
                          witness: new Uint8Array([
                              ...e.witness.slice(0, -1),
                              e.witness[e.witness.length - 1] ^ 1,
                          ]),
                      }
                    : { vin: e.vin, script: e.script, witness: e.witness },
            );
            const rest = ext.getPackets().filter((p) => p !== emulatorPacket);
            const rebuilt = Extension.create([...rest, EmulatorPacket.create(entries)]);
            const idx = extensionIndex(tx);
            tx.updateOutput(idx, { script: rebuilt.serialize(), amount: 0n });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/unsigned/i);
    });

    it("rejects a mutated input value", async () => {
        const expected = await trustedGraph();
        const evil = withArk(expected, (tx) => {
            const utxo = tx.getInput(1).witnessUtxo!;
            tx.updateInput(1, {
                witnessUtxo: { script: utxo.script, amount: utxo.amount + 1n },
            });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/unsigned/i);
    });

    it("rejects a recomputed graph id on an altered graph", async () => {
        const expected = await trustedGraph();
        const altered = withArk(expected, (tx) => {
            const out = tx.getOutput(0);
            tx.updateOutput(0, { script: out.script, amount: out.amount! + 1n });
        });
        const evil = { ...altered, graphId: recomputeId(altered) };
        expect(verifyOfferFillPlan(evil)).toBe(true);
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/does not match the trusted graph/);
    });

    it("rejects an owner-label spoof", async () => {
        const expected = await trustedGraph();
        const spoofed: JointGraph = {
            ...structuredClone(expected),
            inputOwners: [null, "solver", "solver"],
        };
        await expect(
            signJointGraphForOwner({
                expected,
                partial: spoofed,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/does not match the trusted graph/);
    });

    it("rejects a non-DEFAULT declared sighash on the trusted graph", async () => {
        const expected = await trustedGraph();
        const altered = withArk(expected, (tx) => {
            tx.updateInput(1, { sighashType: SigHash.ALL });
        });
        const declared: JointGraph = { ...altered, graphId: recomputeId(altered) };
        expect(verifyOfferFillPlan(declared)).toBe(true);
        await expect(
            signJointGraphForOwner({
                expected: declared,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/must be unsigned/);
    });

    it("rejects a signature transplanted onto the wrong leaf", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        const [[{ pubKey }, sig]] = arkOf(afterSolver).getInput(1).tapScriptSig!;
        const leaf2 = tapLeavesOfInput(arkOf(expected), 2)[0].leafHashHex;
        const evil = withArk(afterSolver, (tx) => {
            tx.updateInput(2, {
                tapScriptSig: [[{ pubKey, leafHash: hex.decode(leaf2) }, sig]],
            });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "sponsor",
                bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
            }),
        ).rejects.toThrow(/not in its leaf/);
    });

    it("rejects a cryptographically invalid signature", async () => {
        const expected = await trustedGraph();
        const trustedArk = arkOf(expected);
        const leaf = tapLeavesOfInput(trustedArk, 1)[0];
        const evil = withArk(expected, (tx) => {
            tx.updateInput(1, {
                tapScriptSig: [
                    [
                        {
                            pubKey: hex.decode(hex.encode(solverKey)),
                            leafHash: hex.decode(leaf.leafHashHex),
                        },
                        new Uint8Array(64).fill(1),
                    ],
                ],
            });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "sponsor",
                bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
            }),
        ).rejects.toThrow(/invalid signature/);
    });

    it("rejects a 65-byte signature and unparsable bytes", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        const [[keyData, sig]] = arkOf(afterSolver).getInput(1).tapScriptSig!;
        const evil = withArk(expected, (tx) => {
            tx.updateInput(1, {
                tapScriptSig: [
                    [
                        { pubKey: keyData.pubKey, leafHash: keyData.leafHash },
                        new Uint8Array([...sig, 0]),
                    ],
                ],
            });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "sponsor",
                bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
            }),
        ).rejects.toThrow(/65-byte/);
        const truncated: JointGraph = {
            ...structuredClone(expected),
            arkTx: expected.arkTx.slice(0, -8),
        };
        await expect(
            signJointGraphForOwner({
                expected,
                partial: truncated,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
            }),
        ).rejects.toThrow(/not a parsable PSBT/);
    });

    it("rejects a signer that drops a foreign signature", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        const dropper = wrapIdentity(TAXI_SEED, async (tx, indexes) => {
            const signed = await SingleKey.fromPrivateKey(TAXI_SEED).sign(tx, indexes);
            if (signed.inputsLength > 1) signed.updateInput(1, { tapScriptSig: undefined });
            return signed;
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: afterSolver,
                owner: "sponsor",
                bindings: [{ inputIndex: 2, identity: dropper }],
            }),
        ).rejects.toThrow(/drops a signature/);
    });

    it("rejects a signer that signs a foreign input", async () => {
        const expected = await trustedGraph();
        const rogue = wrapIdentity(SOLVER_SEED, async (tx, indexes) => {
            const signed = await SingleKey.fromPrivateKey(SOLVER_SEED).sign(tx, indexes);
            if (signed.inputsLength > 1) {
                const [[keyData, sig]] = signed.getInput(1).tapScriptSig!;
                const leaf2 = tapLeavesOfInput(arkOf(expected), 2)[0].leafHashHex;
                signed.updateInput(2, {
                    tapScriptSig: [[{ pubKey: keyData.pubKey, leafHash: hex.decode(leaf2) }, sig]],
                });
            }
            return signed;
        });
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: rogue }],
            }),
        ).rejects.toThrow(/foreign input 2/);
    });

    it("rejects a mutating signer without touching the trusted snapshot", async () => {
        const expected = await trustedGraph();
        const fingerprint = JSON.stringify(expected);
        const mutator = wrapIdentity(SOLVER_SEED, async (tx, indexes) => {
            if (tx.inputsLength > 1) tx.addOutput({ script: trKey(0xe5), amount: 1n });
            return SingleKey.fromPrivateKey(SOLVER_SEED).sign(tx, indexes);
        });
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: mutator }],
            }),
        ).rejects.toThrow(/altered unsigned/);
        expect(JSON.stringify(expected)).toBe(fingerprint);
    });

    it("rejects a signer that adds no signature", async () => {
        const expected = await trustedGraph();
        const solverKeyNow = await SingleKey.fromPrivateKey(SOLVER_SEED).xOnlyPublicKey();
        const silent = {
            xOnlyPublicKey: async () => solverKeyNow,
            sign: async (tx: Transaction) => tx.clone(),
        } as unknown as Identity;
        await expect(
            signJointGraphForOwner({
                expected,
                owner: "solver",
                bindings: [{ inputIndex: 1, identity: silent }],
            }),
        ).rejects.toThrow(/added no signature/);
    });

    it("rejects an incoming partial that signs the provider input", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        const [[keyData, sig]] = arkOf(afterSolver).getInput(1).tapScriptSig!;
        const evil = withArk(afterSolver, (tx) => {
            tx.updateInput(0, {
                tapScriptSig: [[{ pubKey: keyData.pubKey, leafHash: keyData.leafHash }, sig]],
            });
        });
        await expect(
            signJointGraphForOwner({
                expected,
                partial: evil,
                owner: "sponsor",
                bindings: [{ inputIndex: 2, identity: SingleKey.fromPrivateKey(TAXI_SEED) }],
            }),
        ).rejects.toThrow(/provider/);
    });

    it("leaves the trusted snapshot untouched", async () => {
        const expected = await trustedGraph();
        const fingerprint = JSON.stringify(expected);
        await signBoth(expected);
        expect(JSON.stringify(expected)).toBe(fingerprint);
        expect(Object.isFrozen(expected)).toBe(true);
    });
});

describe("prepareJointSubmission", () => {
    it("prepares exact persistable bytes once every funding owner is complete", async () => {
        const expected = await trustedGraph();
        const complete = await signBoth(expected);
        const prepared = prepareJointSubmission({ expected, partial: complete, ownerKeys });
        expect(prepared.txid).toBe(arkOf(complete).id);
        expect(prepared.arkTx).toBe(complete.arkTx);
        expect([...prepared.checkpointTxs]).toEqual([...complete.checkpoints]);
        expect(JSON.parse(JSON.stringify(prepared))).toEqual({
            arkTx: complete.arkTx,
            checkpointTxs: [...complete.checkpoints],
            txid: prepared.txid,
        });
    });

    it("rejects an incomplete graph", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        expect(() => prepareJointSubmission({ expected, partial: afterSolver, ownerKeys })).toThrow(
            /funding input 2 has no sponsor signature/,
        );
    });

    it("rejects a provider-signed partial", async () => {
        const expected = await trustedGraph();
        const complete = await signBoth(expected);
        const [[keyData, sig]] = arkOf(complete).getInput(1).tapScriptSig!;
        const evil = withArk(complete, (tx) => {
            tx.updateInput(0, {
                tapScriptSig: [[{ pubKey: keyData.pubKey, leafHash: keyData.leafHash }, sig]],
            });
        });
        expect(() => prepareJointSubmission({ expected, partial: evil, ownerKeys })).toThrow(
            /provider/,
        );
    });

    it("rejects server-key-only funding signatures as incomplete", async () => {
        const expected = await trustedGraph();
        const serverArk = Transaction.fromPSBT(base64.decode(expected.arkTx));
        const serverSigned = await SingleKey.fromPrivateKey(SERVER_SEED).sign(serverArk, [1]);
        const serverCp = await SingleKey.fromPrivateKey(SERVER_SEED).sign(cpOf(expected, 1), [0]);
        const evil: JointGraph = {
            ...structuredClone(expected),
            arkTx: base64.encode(serverSigned.toPSBT()),
            checkpoints: [
                expected.checkpoints[0],
                base64.encode(serverCp.toPSBT()),
                expected.checkpoints[2],
            ],
        };
        expect(() => prepareJointSubmission({ expected, partial: evil, ownerKeys })).toThrow(
            /funding input 1 has no solver signature/,
        );
    });

    it("rejects missing owner pins", async () => {
        const expected = await trustedGraph();
        const complete = await signBoth(expected);
        expect(() =>
            prepareJointSubmission({ expected, partial: complete, ownerKeys: {} }),
        ).toThrow(/no owner keys pinned for solver/);
    });
});

describe("submitJointFill", () => {
    it("submits through the emulator and verifies the operator co-signature", async () => {
        const expected = await trustedGraph();
        const complete = await signBoth(expected);
        const prepared = prepareJointSubmission({ expected, partial: complete, ownerKeys });
        const outcome = await submitJointFill({
            expected,
            prepared,
            provider: honestEmulator(),
            pins,
            ownerKeys,
        });
        expect(outcome.txid).toBe(prepared.txid);
        const signed = Transaction.fromPSBT(base64.decode(outcome.signedArkTx));
        expect(signed.id).toBe(prepared.txid);
        const [[data, sig]] = signed.getInput(0).tapScriptSig!;
        expect(hex.encode(data.pubKey)).toBe(hex.encode(SERVER_KEY));
        expect(sig.length).toBe(64);
        expect(outcome.signedCheckpointTxs).toHaveLength(3);
    });

    it("accepts the tweak-derived emulator co-signature on the provider input", async () => {
        const expected = await trustedGraph();
        const entry = Extension.fromTx(arkOf(expected))
            .getEmulatorPacket()
            ?.entries.find((e) => e.vin === 0);
        if (!entry) throw new Error("fixture has no provider script");
        const tweak = bytesToNumberBE(arkade.arkadeScriptHash(entry.script));
        const n = secp256k1.Point.CURVE().n;
        const tweakedPriv = numberToBytesBE((bytesToNumberBE(EMULATOR_SEED) + tweak) % n, 32);
        const tweakedHex = hex.encode(schnorr.getPublicKey(tweakedPriv));
        expect(providerCosignerKey({ expected, emulatorXOnly: hex.encode(EMULATOR_KEY) })).toBe(
            tweakedHex,
        );
        const leaf = tapLeavesOfInput(arkOf(expected), 0)[0];
        expect(hex.encode(leaf.script)).toContain(tweakedHex);
        const tweakedEmulator = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const tx = Transaction.fromPSBT(base64.decode(arkTx));
                const co = await SingleKey.fromPrivateKey(tweakedPriv).sign(tx, [0]);
                const cp0 = await SingleKey.fromPrivateKey(tweakedPriv).sign(
                    Transaction.fromPSBT(base64.decode(cps[0])),
                    [0],
                );
                return {
                    signedArkTx: base64.encode(co.toPSBT()),
                    signedCheckpointTxs: [base64.encode(cp0.toPSBT()), cps[1], cps[2]],
                };
            },
        };
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const outcome = await submitJointFill({
            expected,
            prepared,
            provider: tweakedEmulator,
            pins,
            ownerKeys,
        });
        const [[data]] = Transaction.fromPSBT(base64.decode(outcome.signedArkTx)).getInput(0)
            .tapScriptSig!;
        expect(hex.encode(data.pubKey)).toBe(tweakedHex);
    });

    it("treats an unsigned echo as ambiguous", async () => {
        const expected = await trustedGraph();
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const echo = {
            submitTx: async (arkTx: string, cps: string[]) => ({
                signedArkTx: arkTx,
                signedCheckpointTxs: cps,
            }),
        };
        await expect(
            submitJointFill({ expected, prepared, provider: echo, pins, ownerKeys }),
        ).rejects.toThrow(JointSubmissionAmbiguousError);
        await expect(
            submitJointFill({ expected, prepared, provider: echo, pins, ownerKeys }),
        ).rejects.toThrow(/ambiguous/);
    });

    it("rejects a silent provider checkpoint", async () => {
        const expected = await trustedGraph();
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const silentCp = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const out = await honestEmulator().submitTx(arkTx, cps);
                const cp0 = Transaction.fromPSBT(base64.decode(out.signedCheckpointTxs[0]));
                cp0.updateInput(0, { tapScriptSig: undefined });
                const stripped = [...out.signedCheckpointTxs];
                stripped[0] = base64.encode(cp0.toPSBT());
                return { signedArkTx: out.signedArkTx, signedCheckpointTxs: stripped };
            },
        };
        try {
            await submitJointFill({ expected, prepared, provider: silentCp, pins, ownerKeys });
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(JointSubmissionAmbiguousError);
            expect(String((e as Error).cause)).toMatch(/carries no server or emulator signature/);
        }
    });

    it("accepts the tweaked provider key on the provider checkpoint", async () => {
        const expected = await trustedGraph();
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const tweaked = providerTweakPriv(prepared.arkTx);
        const tweakedHex = hex.encode(schnorr.getPublicKey(tweaked));
        expect(tweakedHex).not.toBe(pins.serverXOnly);
        const providerOnly = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const ark = Transaction.fromPSBT(base64.decode(arkTx));
                const co = await SingleKey.fromPrivateKey(SERVER_SEED).sign(ark, [0]);
                const cp0 = await SingleKey.fromPrivateKey(tweaked).sign(
                    Transaction.fromPSBT(base64.decode(cps[0])),
                    [0],
                );
                return {
                    signedArkTx: base64.encode(co.toPSBT()),
                    signedCheckpointTxs: [base64.encode(cp0.toPSBT()), cps[1], cps[2]],
                };
            },
        };
        const outcome = await submitJointFill({
            expected,
            prepared,
            provider: providerOnly,
            pins,
            ownerKeys,
        });
        const [[data]] = Transaction.fromPSBT(
            base64.decode(outcome.signedCheckpointTxs[0]),
        ).getInput(0).tapScriptSig!;
        expect(hex.encode(data.pubKey)).toBe(tweakedHex);
    });

    it("rejects extra response signatures from unpinned keys", async () => {
        const expected = await trustedGraph();
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const attackerKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x99));
        const leaf1 = tapLeavesOfInput(arkOf(expected), 1)[0].leafHashHex;
        const extraOnFunding = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const tx = Transaction.fromPSBT(base64.decode(arkTx));
                const co = await SingleKey.fromPrivateKey(SERVER_SEED).sign(tx, [0]);
                co.updateInput(1, {
                    tapScriptSig: [
                        [
                            { pubKey: attackerKey, leafHash: hex.decode(leaf1) },
                            new Uint8Array(64).fill(2),
                        ],
                    ],
                });
                return { signedArkTx: base64.encode(co.toPSBT()), signedCheckpointTxs: cps };
            },
        };
        await expect(
            submitJointFill({ expected, prepared, provider: extraOnFunding, pins, ownerKeys }),
        ).rejects.toThrow(JointSubmissionAmbiguousError);
        try {
            await submitJointFill({
                expected,
                prepared,
                provider: extraOnFunding,
                pins,
                ownerKeys,
            });
            expect.unreachable();
        } catch (e) {
            expect(String((e as Error).cause)).toMatch(/unpinned key/);
        }
        const extraOnProvider = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const tx = Transaction.fromPSBT(base64.decode(arkTx));
                const co = await SingleKey.fromPrivateKey(SERVER_SEED).sign(tx, [0]);
                co.updateInput(0, {
                    tapScriptSig: [
                        ...co.getInput(0).tapScriptSig!,
                        [
                            { pubKey: attackerKey, leafHash: hex.decode(leaf1) },
                            new Uint8Array(64).fill(2),
                        ],
                    ],
                });
                return { signedArkTx: base64.encode(co.toPSBT()), signedCheckpointTxs: cps };
            },
        };
        await expect(
            submitJointFill({ expected, prepared, provider: extraOnProvider, pins, ownerKeys }),
        ).rejects.toThrow(JointSubmissionAmbiguousError);
        try {
            await submitJointFill({
                expected,
                prepared,
                provider: extraOnProvider,
                pins,
                ownerKeys,
            });
            expect.unreachable();
        } catch (e) {
            expect(String((e as Error).cause)).toMatch(/unpinned key/);
        }
    });

    it("treats altered, stripped and malformed responses as ambiguous", async () => {
        const expected = await trustedGraph();
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const altered = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const tx = Transaction.fromPSBT(base64.decode(arkTx));
                const out = tx.getOutput(0);
                tx.updateOutput(0, { script: out.script, amount: out.amount! + 1n });
                const co = await SingleKey.fromPrivateKey(SERVER_SEED).sign(tx, [0]);
                return { signedArkTx: base64.encode(co.toPSBT()), signedCheckpointTxs: cps };
            },
        };
        await expect(
            submitJointFill({ expected, prepared, provider: altered, pins, ownerKeys }),
        ).rejects.toThrow(/ambiguous/);
        const stripped = {
            submitTx: async (arkTx: string, cps: string[]) => {
                const tx = Transaction.fromPSBT(base64.decode(arkTx));
                tx.updateInput(1, { tapScriptSig: undefined });
                const co = await SingleKey.fromPrivateKey(SERVER_SEED).sign(tx, [0]);
                return { signedArkTx: base64.encode(co.toPSBT()), signedCheckpointTxs: cps };
            },
        };
        await expect(
            submitJointFill({ expected, prepared, provider: stripped, pins, ownerKeys }),
        ).rejects.toThrow(/ambiguous/);
        const malformed = {
            submitTx: async () => ({ signedArkTx: "", signedCheckpointTxs: [] }) as never,
        };
        await expect(
            submitJointFill({ expected, prepared, provider: malformed, pins, ownerKeys }),
        ).rejects.toThrow(/ambiguous/);
    });

    it("maps transport failure to ambiguous", async () => {
        const expected = await trustedGraph();
        const prepared = prepareJointSubmission({
            expected,
            partial: await signBoth(expected),
            ownerKeys,
        });
        const failing = {
            submitTx: async (): Promise<never> => {
                throw new Error("connection reset");
            },
        };
        await expect(
            submitJointFill({ expected, prepared, provider: failing, pins, ownerKeys }),
        ).rejects.toThrow(JointSubmissionAmbiguousError);
    });

    it("keeps pre-network failure definitely-not-submitted", async () => {
        const expected = await trustedGraph();
        const afterSolver = await signJointGraphForOwner({
            expected,
            owner: "solver",
            bindings: [{ inputIndex: 1, identity: SingleKey.fromPrivateKey(SOLVER_SEED) }],
        });
        const prepared = {
            arkTx: afterSolver.arkTx,
            checkpointTxs: [...afterSolver.checkpoints],
            txid: arkOf(afterSolver).id,
        };
        const outcome = submitJointFill({
            expected,
            prepared,
            provider: honestEmulator(),
            pins,
            ownerKeys,
        });
        await expect(outcome).rejects.toThrow(JointSigningError);
        await expect(outcome).rejects.toThrow(/not submitted/);
        await expect(outcome).rejects.not.toThrow(JointSubmissionAmbiguousError);
    });
});

describe("providerCosignerKey", () => {
    it("rejects an unverified graph", async () => {
        const expected = await trustedGraph();
        const tampered = { ...structuredClone(expected), graphId: "00".repeat(32) };
        expect(verifyOfferFillPlan(tampered)).toBe(false);
        expect(() =>
            providerCosignerKey({ expected: tampered, emulatorXOnly: pins.emulatorXOnly }),
        ).toThrow(/fails integrity/);
    });
});
