import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    ArkAddress,
    CSVMultisigTapscript,
    Transaction,
    arkade,
    asset,
    type IWallet,
    type RelativeTimelock,
} from "@arkade-os/sdk";
import {
    bindingFromOffer,
    bindingProgram,
    decodeOffer,
    deriveOffer,
    encodeOffer,
    offerBindingOf,
    offerContract,
    offerFromBinding,
    OfferCovenantMismatchError,
    prepareOfferCancel,
    recordOfferBinding,
    swapProgramBinding,
    withExitClosure,
    type Offer,
    type RecordedOfferBinding,
} from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { getAssetSwapsOrThrow, type AssetSwap } from "../src/store";
import { readableRecord } from "../src/client/drive";
import { legacyOfferDepositsToAdopt } from "../src/client/legacyRecords";
import { offerRecord } from "./client/driveFixtures";
import {
    ASSET_SWAP_CONTRACTS,
    ASSET_SWAP_CONTRACT_VERSIONS,
    ASSET_SWAP_DERIVABLE_VERSIONS,
    ASSET_SWAP_V2,
    ASSET_SWAP_DIRECTED,
} from "../src/program";
import { ASSET_SWAP_DIRECTED_NONCE, assetRfqNonce } from "../src/protocol";

const operatorPubkey = hex.decode(
    "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
);
const keys = {
    makerPkScript: hex.decode(
        "51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1",
    ),
    makerPublicKey: hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const EXIT: RelativeTimelock = { type: "blocks", value: BigInt(144) };
const TAKER = schnorr.getPublicKey(new Uint8Array(32).fill(3));
const OTHER_TAKER = schnorr.getPublicKey(new Uint8Array(32).fill(4));
const RFQ_ID = "ab".repeat(32);

type Terms = Omit<Offer, "swapPkScript"> & { exitDelay: RelativeTimelock };

const directions: [string, Terms, string][] = [
    [
        "asset-swap-directed",
        { wantAmount: BigInt(50_000), wantAsset: testAsset, ...keys, exitDelay: EXIT },
        "512005f7c7cf1dd75781e8a55db2c683f90d8da874bdf6136dc7e46b236977888443",
    ],
    [
        "sats-swap-directed",
        { wantAmount: BigInt(50_000), offerAsset: testAsset, ...keys, exitDelay: EXIT },
        "5120b7387dd1c058fef6f8cc8bece1444f60a3ce5cbb8e8cf6faa20517ad1a435a0c",
    ],
];

const artifact = (name: string) =>
    JSON.parse(readFileSync(new URL(`../src/contracts/${name}.json`, import.meta.url), "utf8"));

/** The construction proven on regtest: the artifact's constructor args, written out by hand. */
const handBuilt = (name: string, terms: Terms, taker: Uint8Array) => {
    const program = withExitClosure(arkade.programFromArtifact(artifact(name)), terms.exitDelay);
    const id = terms.wantAsset;
    return new arkade.ArkadeProgramScript(
        program,
        {
            receiver: terms.makerPkScript.subarray(2),
            amount: terms.wantAmount,
            ...(id && { assetTxid: id.txid.slice().reverse(), assetGroupIndex: id.groupIndex }),
            user: terms.makerPublicKey,
            server: operatorPubkey,
            exitDelay: terms.exitDelay.value,
            taker,
        },
        {
            serverKey: operatorPubkey,
            userKey: terms.makerPublicKey,
            emulatorKey: terms.emulatorPubkey,
        },
    );
};

const registered = (terms: Terms, taker: Uint8Array | undefined) => {
    const { programs, args } = ASSET_SWAP_CONTRACTS[ASSET_SWAP_DIRECTED];
    const id = terms.wantAsset;
    return new arkade.ArkadeProgramScript(
        withExitClosure(id ? programs.wantAsset : programs.wantBtc, terms.exitDelay),
        args({
            receiver: terms.makerPkScript.subarray(2),
            amount: terms.wantAmount,
            ...(id && { asset: { txid: id.txid.slice().reverse(), groupIndex: id.groupIndex } }),
            user: terms.makerPublicKey,
            server: operatorPubkey,
            exitDelay: terms.exitDelay.value,
            taker,
        }),
        {
            serverKey: operatorPubkey,
            userKey: terms.makerPublicKey,
            emulatorKey: terms.emulatorPubkey,
        },
    );
};

describe("the directed contracts (asset-swap-directed)", () => {
    it.each(directions)("pins %s to the construction regtest proved", (name, terms, golden) => {
        const proved = hex.encode(handBuilt(name, terms, TAKER).pkScript);
        expect(hex.encode(registered(terms, TAKER).pkScript)).toBe(proved);
        expect(hex.encode(offerContract({ ...terms, taker: TAKER }, operatorPubkey).pkScript)).toBe(
            proved,
        );
        expect(proved).toBe(golden);
    });

    it.each(directions)("compiles %s on arkadec 0.1.0-rc.1, exit appended third", (name, terms) => {
        const compiled = artifact(name);
        expect(compiled.compiler).toMatchObject({ name: "arkadec", version: "0.1.0-rc.1" });
        expect(compiled.functions.map((fn: { name: string }) => fn.name)).toEqual([
            "fulfill",
            "cancel",
        ]);
        expect(registered(terms, TAKER).compiled.map((fn) => fn.name)).toEqual([
            "fulfill",
            "cancel",
            "exit",
        ]);
    });

    it.each(directions)("needs the taker to fulfill %s, and only the user back out", (_, terms) => {
        const script = registered(terms, TAKER);
        const signers = (name: string) =>
            script.functionByName(name)?.signerKeys.map((key) => hex.encode(key));
        const [user, server] = [terms.makerPublicKey, operatorPubkey].map((k) => hex.encode(k));
        expect(signers("fulfill")).toEqual([hex.encode(TAKER), server]);
        expect(signers("cancel")).toEqual([user, server]);
        expect(signers("exit")).toEqual([user]);
        expect(script.functionByName("fulfill")?.def.tapscript.signatures).toEqual([
            { name: "takerSig", type: "signature" },
        ]);
    });

    it.each(directions)("derives a different %s address for another taker", (_, terms) => {
        expect(hex.encode(registered(terms, OTHER_TAKER).pkScript)).not.toBe(
            hex.encode(registered(terms, TAKER).pkScript),
        );
    });

    it("refuses the directed tree without a taker, and v2 with one", () => {
        const [, terms] = directions[0];
        expect(() => registered(terms, undefined)).toThrow(/asset-swap-directed needs a taker/);
        const inputs = {
            receiver: terms.makerPkScript.subarray(2),
            amount: terms.wantAmount,
            user: terms.makerPublicKey,
            server: operatorPubkey,
            taker: TAKER,
        };
        expect(() => ASSET_SWAP_CONTRACTS[ASSET_SWAP_V2].args(inputs)).toThrow(/binds no taker/);
    });

    it("advertises both directed covenants and still derives v2", () => {
        expect(ASSET_SWAP_DERIVABLE_VERSIONS).toEqual([
            ASSET_SWAP_DIRECTED_NONCE,
            ASSET_SWAP_DIRECTED,
            ASSET_SWAP_V2,
        ]);
        expect(ASSET_SWAP_CONTRACT_VERSIONS).toEqual([
            ASSET_SWAP_DIRECTED_NONCE,
            ASSET_SWAP_DIRECTED,
        ]);
    });
});

describe("a directed deposit bound to an RFQ nonce", () => {
    it("hashes the raw id under the protocol domain", () => {
        expect(hex.encode(assetRfqNonce(RFQ_ID))).toBe(
            "e52c616aee55c60633ca25bade9ac3018ed1f7104f79b0983b7b13e1d362e631",
        );
        expect(assetRfqNonce(RFQ_ID.toUpperCase())).toEqual(assetRfqNonce(RFQ_ID));
        expect(() => assetRfqNonce("ab".repeat(31))).toThrow();
    });

    it.each(directions)("binds %s without changing the cancel or exit leaf", (_, terms) => {
        const directed = { ...terms, taker: TAKER };
        const old = offerContract(directed, operatorPubkey);
        const offer = { ...directed, nonce: assetRfqNonce(RFQ_ID) };
        const compiled = offerContract(offer, operatorPubkey, ASSET_SWAP_DIRECTED_NONCE);
        expect(compiled.pkScript).not.toEqual(old.pkScript);
        expect(compiled.functionByName("fulfill")?.signerKeys).toEqual(
            old.functionByName("fulfill")?.signerKeys,
        );
        for (const path of ["cancel", "exit"]) {
            expect(compiled.functionByName(path)?.leafScript).toEqual(
                old.functionByName(path)?.leafScript,
            );
        }
        const packet = encodeOffer({ ...offer, swapPkScript: compiled.pkScript });
        const fromPacket = bindingFromOffer(decodeOffer(packet), operatorPubkey);
        expect(fromPacket.version).toBe(ASSET_SWAP_DIRECTED_NONCE);
        const stored = JSON.parse(JSON.stringify(recordOfferBinding(fromPacket)));
        expect(offerBindingOf(stored)).toEqual(fromPacket);
        expect(hex.encode(packet)).not.toContain(RFQ_ID);
        expect(
            offerContract(offerFromBinding(offerBindingOf(stored)), operatorPubkey).pkScript,
        ).toEqual(compiled.pkScript);
        expect(() => offerBindingOf({ ...stored, nonce: undefined })).toThrow();
        expect(() => offerBindingOf({ ...stored, nonce: "00" })).toThrow();
    });
});

const rec = (tag: number, value: Uint8Array): Uint8Array =>
    Uint8Array.from([tag, value.length >> 8, value.length & 0xff, ...value]);

const u64 = (value: bigint, prefix: number[] = []): Uint8Array => {
    const out = new Uint8Array(prefix.length + 8);
    out.set(prefix);
    new DataView(out.buffer).setBigUint64(prefix.length, value);
    return out;
};

describe("the taker record (0x04)", () => {
    const [, terms] = directions[0];
    const swapPkScript = offerContract({ ...terms, taker: TAKER }, operatorPubkey).pkScript;
    const payload = (taker: Uint8Array) =>
        Uint8Array.from([
            ...rec(0x01, swapPkScript),
            ...rec(0x02, u64(terms.wantAmount)),
            ...rec(0x03, testAsset.serialize()),
            ...rec(0x05, keys.makerPkScript),
            ...rec(0x07, keys.makerPublicKey),
            ...rec(0x04, taker),
            ...rec(0x08, keys.emulatorPubkey),
            ...rec(0x0c, u64(EXIT.value, [0])),
        ]);

    it("round-trips the taker, emitted between the maker key and the emulator key", () => {
        const encoded = encodeOffer({ ...terms, taker: TAKER, swapPkScript });
        expect(hex.encode(encoded)).toBe(hex.encode(payload(TAKER)));
        const decoded = decodeOffer(encoded);
        expect(hex.encode(decoded.taker ?? new Uint8Array())).toBe(hex.encode(TAKER));
        expect(hex.encode(encodeOffer(decoded))).toBe(hex.encode(encoded));
    });

    it.each([31, 33])("refuses a %s-byte taker at encode and at decode", (width) => {
        const taker = new Uint8Array(width).fill(1);
        expect(() => encodeOffer({ ...terms, taker, swapPkScript })).toThrow(
            "taker must be 32 bytes",
        );
        expect(() => decodeOffer(payload(taker))).toThrow("missing/invalid taker");
    });

    it("throws on a tag outside its table, as a decoder from before the taker does on 0x04", () => {
        const unknown = Uint8Array.from([...payload(TAKER), ...rec(0x06, new Uint8Array(1))]);
        expect(() => decodeOffer(unknown)).toThrow("unknown TLV type: 0x6");
    });
});

describe("which tree an offer compiles", () => {
    const [, terms] = directions[0];
    const v2Script = offerContract(terms, operatorPubkey).pkScript;
    const directedScript = offerContract({ ...terms, taker: TAKER }, operatorPubkey).pkScript;
    const versionOf = (offer: Parameters<typeof swapProgramBinding>[0]) =>
        swapProgramBinding(offer, operatorPubkey).version;

    it("never compiles the directed tree without a taker", () => {
        expect(versionOf(terms)).toBe(ASSET_SWAP_V2);
        expect(versionOf({ ...terms, swapPkScript: directedScript })).toBe(ASSET_SWAP_V2);
    });

    it("never compiles v2 with a taker", () => {
        expect(versionOf({ ...terms, taker: TAKER })).toBe(ASSET_SWAP_DIRECTED);
        expect(versionOf({ ...terms, taker: TAKER, swapPkScript: directedScript })).toBe(
            ASSET_SWAP_DIRECTED,
        );
        expect(versionOf({ ...terms, taker: TAKER, swapPkScript: v2Script })).toBe(
            ASSET_SWAP_DIRECTED,
        );
    });

    it("refuses a taker on an explicit v2, and the directed tree without one", () => {
        const directed = { ...terms, taker: TAKER };
        expect(() => offerContract(directed, operatorPubkey, ASSET_SWAP_V2)).toThrow(
            /binds no taker/,
        );
        expect(() => offerContract(terms, operatorPubkey, ASSET_SWAP_DIRECTED)).toThrow(
            /needs a taker/,
        );
    });
});

describe("the offer binding", () => {
    // offer.test.ts's goldens, pinned before the binding existed
    const undirected: [string, Omit<Offer, "swapPkScript">, string, string][] = [
        [
            "a v2 asset-want",
            { wantAmount: BigInt(50_000), wantAsset: testAsset, ...keys },
            ASSET_SWAP_V2,
            "5120380f74f6e40eb347c46294a601bc6edfff0d509beb513bac392e8bfc6dec1d84",
        ],
        [
            "a v2 sats-want",
            { wantAmount: BigInt(50_000), offerAsset: testAsset, ...keys },
            ASSET_SWAP_V2,
            "5120004739eb4ad3eab769b0c2278cd70cce628e20477e8b8c508bcf8519a5f451c9",
        ],
    ];
    const pkScriptOf = (binding: ReturnType<typeof bindingFromOffer>) => {
        const { program, args, keys: bound } = bindingProgram(binding);
        return hex.encode(new arkade.ArkadeProgramScript(program, args, bound).pkScript);
    };

    it.each(undirected)("binds %s offer to its pinned script", (_, terms, version, golden) => {
        const offer: Offer = { ...terms, swapPkScript: hex.decode(golden) };
        const binding = bindingFromOffer(offer, operatorPubkey);
        expect(binding.version).toBe(version);
        expect(pkScriptOf(binding)).toBe(golden);
        expect(hex.encode(encodeOffer(offerFromBinding(binding)))).toBe(
            hex.encode(encodeOffer(offer)),
        );
    });

    it.each(directions)("binds a directed %s offer with its taker", (_, terms, golden) => {
        const offer: Offer = { ...terms, taker: TAKER, swapPkScript: hex.decode(golden) };
        const binding = bindingFromOffer(offer, operatorPubkey);
        expect(binding.version).toBe(ASSET_SWAP_DIRECTED);
        expect(hex.encode(binding.taker ?? new Uint8Array())).toBe(hex.encode(TAKER));
        expect(pkScriptOf(binding)).toBe(golden);
        expect(decodeOffer(encodeOffer(offerFromBinding(binding)))).toEqual(offer);
    });

    it("refuses an offer no tree reproduces under the given key", () => {
        const [, terms, , golden] = undirected[0];
        const offer: Offer = { ...terms, swapPkScript: hex.decode(golden) };
        expect(() => bindingFromOffer(offer, keys.emulatorPubkey)).toThrow(
            OfferCovenantMismatchError,
        );
    });
});

describe("a recorded binding", () => {
    const [, terms, golden] = directions[0];
    const binding = bindingFromOffer(
        { ...terms, taker: TAKER, swapPkScript: hex.decode(golden) },
        operatorPubkey,
    );

    it("survives JSON and rebuilds the binding it recorded", () => {
        const stored = JSON.parse(JSON.stringify(recordOfferBinding(binding)));
        expect(offerBindingOf(stored)).toEqual(binding);
    });

    it.each([
        ["an unknown version", { version: "asset-swap-v9" }],
        ["the removed asset-swap-v3", { version: "asset-swap-v3" }],
        ["0.1.10's name for the directed covenant", { version: "asset-swap-v4" }],
        ["no version", { version: undefined }],
        ["a negative amount", { amount: "-1" }],
        ["a fractional amount", { amount: "1.5" }],
    ])("refuses %s", (_, over) => {
        const corrupt = { ...recordOfferBinding(binding), ...over } as RecordedOfferBinding;
        expect(() => offerBindingOf(corrupt)).toThrow();
    });
});

describe("deriveOffer with a taker", () => {
    it("derives the directed tree and hands back its binding", async () => {
        const [, terms, golden] = directions[0];
        const derived = await deriveOffer({} as IWallet, {
            wantAmount: terms.wantAmount,
            wantAsset: terms.wantAsset,
            emulatorPubkey: `02${hex.encode(keys.emulatorPubkey)}`,
            info: {
                signerPubkey: `02${hex.encode(operatorPubkey)}`,
                unilateralExitDelay: EXIT.value,
                network: "regtest",
            } as never,
            maker: { pkScript: keys.makerPkScript, publicKey: keys.makerPublicKey },
            taker: TAKER,
        });
        expect(hex.encode(derived.swapPkScript)).toBe(golden);
        expect(derived.offerBinding.version).toBe(ASSET_SWAP_DIRECTED);
        expect(derived.offerBinding).toEqual(
            bindingFromOffer(decodeOffer(hex.decode(derived.offerHex)), operatorPubkey),
        );
    });
});

describe("a record that carries a binding in place of offerHex", () => {
    const [, terms, golden] = directions[0];
    const offer: Offer = { ...terms, taker: TAKER, swapPkScript: hex.decode(golden) };
    const txid = "a".repeat(64);
    const shapes: [string, { offerHex?: string; binding?: RecordedOfferBinding }][] = [
        ["offerHex", { offerHex: hex.encode(encodeOffer(offer)) }],
        ["binding", { binding: recordOfferBinding(bindingFromOffer(offer, operatorPubkey)) }],
        ["neither", {}],
    ];
    const v1Row = (shape: (typeof shapes)[number][1]) =>
        ({
            id: txid,
            fromAsset: "btc",
            toAsset: testAsset.toString(),
            fromAmount: "6000",
            toAmount: "50000",
            swapAddress: "",
            swapPkScript: golden,
            fundingTxid: txid,
            status: "pending",
            createdAt: 1,
            ...shape,
        }) as AssetSwap;

    it.each(shapes)("lists and adopts a v1 row with %s only if it can rebuild", async (n, s) => {
        const repository = new InMemoryAssetSwapRepository();
        await repository.saveSwap(v1Row(s));
        const usable = n !== "neither";
        expect(await getAssetSwapsOrThrow(repository)).toHaveLength(usable ? 1 : 0);
        expect([...(await legacyOfferDepositsToAdopt(repository))]).toEqual(usable ? [txid] : []);
    });

    it.each(shapes)("reads a v2 record with %s only if it can rebuild", (name, shape) => {
        const record = offerRecord({ offerHex: undefined, ...shape });
        expect(readableRecord(record)).toBe(name !== "neither");
    });
});

describe("a cancel built from the binding", () => {
    const CHECKPOINT = CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: BigInt(10) },
        pubkeys: [operatorPubkey],
    }).script;
    const fundingTxid = "ab".repeat(32);

    /** Offline, signing nothing: `submitTx` records the unsigned spend and stops the send. */
    const offlineWallet = (submitted: string[]): IWallet =>
        ({
            identity: {
                xOnlyPublicKey: async () => keys.makerPublicKey,
                sign: async (tx: Transaction) => tx,
            },
            getAddress: async () =>
                new ArkAddress(operatorPubkey, keys.makerPkScript.subarray(2), "tark").encode(),
            getContractManager: async () => undefined,
            getArkadeInfo: async () => ({
                signerPubkey: `02${hex.encode(operatorPubkey)}`,
                checkpointTapscript: hex.encode(CHECKPOINT),
                network: "regtest",
            }),
            getArkadeReader: async () => ({
                getVtxos: async () => ({ vtxos: [{ txid: fundingTxid, vout: 0, value: 10_000 }] }),
                getVirtualTxs: async () => ({ txs: [] }),
            }),
            getArkadeBroadcaster: async () => ({
                submitTx: async (arkTx: string) => {
                    submitted.push(arkTx);
                    throw new Error("captured");
                },
                finalizeTx: async () => {},
            }),
        }) as unknown as IWallet;

    it.each([
        ...directions.map(([name, terms]) => [name, terms, ASSET_SWAP_DIRECTED] as const),
        ["nonce-bound asset", directions[0][1], ASSET_SWAP_DIRECTED_NONCE] as const,
    ])("spends a %s deposit exactly as its offerHex does", async (_, terms, version) => {
        const directed = {
            ...terms,
            taker: TAKER,
            ...(version === ASSET_SWAP_DIRECTED_NONCE && { nonce: assetRfqNonce(RFQ_ID) }),
        };
        const swapPkScript = offerContract(directed, operatorPubkey, version).pkScript;
        const offer: Offer = { ...directed, swapPkScript };
        const submitted: string[] = [];
        const wallet = offlineWallet(submitted);
        const fromHex = await prepareOfferCancel(wallet, hex.encode(encodeOffer(offer)), {
            fundingTxid,
        });
        await expect(fromHex.send()).rejects.toThrow("captured");
        const fromBinding = await prepareOfferCancel(
            wallet,
            bindingFromOffer(offer, operatorPubkey),
            { fundingTxid },
        );
        await expect(fromBinding.send()).rejects.toThrow("captured");
        expect(submitted).toHaveLength(2);
        expect(Transaction.fromPSBT(base64.decode(submitted[0])).getInput(0).tapScriptSig).toBe(
            undefined,
        );
        expect(submitted[1]).toBe(submitted[0]);
        expect(fromBinding.offer).toEqual(fromHex.offer);
    });
});
