import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { arkade, asset, type RelativeTimelock } from "@arkade-os/sdk";
import {
    decodeOffer,
    encodeOffer,
    offerContract,
    swapProgramBinding,
    withExitClosure,
    type Offer,
} from "../src/offer";
import {
    ASSET_SWAP_CONTRACTS,
    ASSET_SWAP_CONTRACT_VERSIONS,
    ASSET_SWAP_DERIVABLE_VERSIONS,
    ASSET_SWAP_V2,
    ASSET_SWAP_V3,
    ASSET_SWAP_V4,
} from "../src/program";

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

type Terms = Omit<Offer, "swapPkScript"> & { exitDelay: RelativeTimelock };

const directions: [string, Terms, string][] = [
    [
        "asset-swap-v4",
        { wantAmount: BigInt(50_000), wantAsset: testAsset, ...keys, exitDelay: EXIT },
        "512005f7c7cf1dd75781e8a55db2c683f90d8da874bdf6136dc7e46b236977888443",
    ],
    [
        "sats-swap-v4",
        { wantAmount: BigInt(50_000), offerAsset: testAsset, ...keys, exitDelay: EXIT },
        "5120b7387dd1c058fef6f8cc8bece1444f60a3ce5cbb8e8cf6faa20517ad1a435a0c",
    ],
];

const artifact = (name: string) =>
    JSON.parse(readFileSync(new URL(`../src/contracts/${name}.json`, import.meta.url), "utf8"));

/** The construction proven on regtest: the v3 binding's args plus `taker`, on the v4 artifact. */
const handBuilt = (name: string, terms: Terms, taker: Uint8Array) => {
    const v3 = swapProgramBinding(terms, operatorPubkey, ASSET_SWAP_V3);
    const program = withExitClosure(arkade.programFromArtifact(artifact(name)), terms.exitDelay);
    return new arkade.ArkadeProgramScript(program, { ...v3.args, taker }, v3.keys);
};

const registered = (terms: Terms, taker: Uint8Array | undefined) => {
    const { programs, args } = ASSET_SWAP_CONTRACTS[ASSET_SWAP_V4];
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

describe("the directed contracts (asset-swap-v4)", () => {
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

    it("refuses v4 without a taker, and v2 or v3 with one", () => {
        const [, terms] = directions[0];
        expect(() => registered(terms, undefined)).toThrow(/asset-swap-v4 needs a taker/);
        const inputs = {
            receiver: terms.makerPkScript.subarray(2),
            amount: terms.wantAmount,
            user: terms.makerPublicKey,
            server: operatorPubkey,
            taker: TAKER,
        };
        expect(() => ASSET_SWAP_CONTRACTS[ASSET_SWAP_V3].args(inputs)).toThrow(/binds no taker/);
        expect(() => ASSET_SWAP_CONTRACTS[ASSET_SWAP_V2].args(inputs)).toThrow(/binds no taker/);
    });

    it("derives v4 without advertising it", () => {
        expect(ASSET_SWAP_DERIVABLE_VERSIONS).toEqual([
            ASSET_SWAP_V4,
            ASSET_SWAP_V3,
            ASSET_SWAP_V2,
        ]);
        expect(ASSET_SWAP_CONTRACT_VERSIONS).toEqual([ASSET_SWAP_V3, ASSET_SWAP_V2]);
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

    it("throws on a tag outside its table, as a pre-v4 decoder does on 0x04", () => {
        const unknown = Uint8Array.from([...payload(TAKER), ...rec(0x06, new Uint8Array(1))]);
        expect(() => decodeOffer(unknown)).toThrow("unknown TLV type: 0x6");
    });
});

describe("which tree an offer compiles", () => {
    const [, terms] = directions[0];
    const v3Script = offerContract(terms, operatorPubkey, ASSET_SWAP_V3).pkScript;
    const v4Script = offerContract({ ...terms, taker: TAKER }, operatorPubkey).pkScript;
    const versionOf = (offer: Parameters<typeof swapProgramBinding>[0]) =>
        swapProgramBinding(offer, operatorPubkey).version;

    it("never compiles v4 without a taker", () => {
        expect(versionOf(terms)).toBe(ASSET_SWAP_V2);
        expect(versionOf({ ...terms, swapPkScript: v3Script })).toBe(ASSET_SWAP_V3);
        expect(versionOf({ ...terms, swapPkScript: v4Script })).toBe(ASSET_SWAP_V2);
    });

    it("never compiles v2 or v3 with a taker", () => {
        expect(versionOf({ ...terms, taker: TAKER })).toBe(ASSET_SWAP_V4);
        expect(versionOf({ ...terms, taker: TAKER, swapPkScript: v4Script })).toBe(ASSET_SWAP_V4);
        expect(versionOf({ ...terms, taker: TAKER, swapPkScript: v3Script })).toBe(ASSET_SWAP_V4);
    });

    it("refuses a taker on an explicit v2 or v3, and v4 without one", () => {
        const directed = { ...terms, taker: TAKER };
        expect(() => offerContract(directed, operatorPubkey, ASSET_SWAP_V3)).toThrow(
            /binds no taker/,
        );
        expect(() => offerContract(directed, operatorPubkey, ASSET_SWAP_V2)).toThrow(
            /binds no taker/,
        );
        expect(() => offerContract(terms, operatorPubkey, ASSET_SWAP_V4)).toThrow(/needs a taker/);
    });
});
