import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, arkade, asset } from "@arkade-os/sdk";
import { decodeOffer, encodeOffer, offerVtxoScript, swapProgramBinding, Offer } from "../src/offer";

// deterministic keys -> the derived swap addresses must never drift (any
// change to the program JSONs or the arg binding changes them); goldens from
// the swap covenant's reference selfCheck
const server = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const keys = {
    makerPkScript: hex.decode(
        "51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1",
    ),
    makerPublicKey: hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");

// hand-built TLV records: encodeOffer now rejects malformed offers, so the
// decode-side coverage below assembles its foreign payloads from raw records
const rec = (tag: number, value: Uint8Array): Uint8Array =>
    Uint8Array.from([tag, (value.length >> 8) & 0xff, value.length & 0xff, ...value]);
const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};
/** The five required records, no asset direction — the smallest invalid base. */
const directionlessPayload = () =>
    cat(
        rec(0x01, new Uint8Array(34)), // swapPkScript
        rec(0x02, new Uint8Array(8)), // wantAmount
        rec(0x05, keys.makerPkScript),
        rec(0x07, keys.makerPublicKey),
        rec(0x08, keys.emulatorPubkey),
    );

const goldens: [Omit<Offer, "swapPkScript">, string][] = [
    [
        { wantAmount: BigInt(50_000), wantAsset: testAsset, ...keys },
        "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2",
    ],
    [
        { wantAmount: BigInt(50_000), offerAsset: testAsset, ...keys },
        "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65qz8884545l2ka5mps383ntsennz3csywl5t33gghnu9rxjlg5wfv467cj",
    ],
];

describe("swap offer", () => {
    it("derives the golden swap addresses for both directions", () => {
        for (const [offer, golden] of goldens) {
            const script = offerVtxoScript(offer, server);
            const address = new ArkAddress(server, script.tweakedPublicKey, "tark").encode();
            expect(address).toBe(golden);
        }
    });

    it("roundtrips the TLV codec for both directions", () => {
        for (const [offer] of goldens) {
            const script = offerVtxoScript(offer, server);
            const full: Offer = { ...offer, swapPkScript: script.pkScript };
            const back = decodeOffer(encodeOffer(full));
            expect(hex.encode(encodeOffer(back))).toBe(hex.encode(encodeOffer(full)));
            expect(back.wantAmount).toBe(BigInt(50_000));
            expect(back.wantAsset?.toString()).toBe(offer.wantAsset?.toString());
            expect(back.offerAsset?.toString()).toBe(offer.offerAsset?.toString());
        }
    });

    it("binds the asset group index into the covenant", () => {
        const indexed = asset.AssetId.create("aa".repeat(32), 1);
        const script = offerVtxoScript(
            { wantAmount: BigInt(50_000), wantAsset: indexed, ...keys },
            server,
        );
        const address = new ArkAddress(server, script.tweakedPublicKey, "tark").encode();
        expect(address).not.toBe(goldens[0][1]);
    });

    // Both asset forms live in offer.ts: the TLV carries the identity, the
    // program args carry the txid reversed plus a numeric group index. Pinning
    // them against the shared vector is what catches a half-applied change --
    // fixing one form and not the other reads as a working file.
    describe("asset id forms, against the shared vector", () => {
        const V = asset.ASSET_ID_VECTORS;
        const drift = (label: string) =>
            `asset id encoding drifted from ASSET_ID_VECTORS (${label})`;

        /** Push framing for a script-number stack item, per ArkadeScript's
         * MINIMALDATA path: empty -> OP_0, 1..16 -> OP_1..OP_16, else a length
         * prefix. The vector pins the item; the framing is the encoder's.
         * Scoped to non-negative script numbers, which never encode a single
         * zero byte -- that would be OP_0 here, not a data push. */
        const framed = (itemHex: string): string => {
            const item = hex.decode(itemHex);
            if (item.length === 0) return "00";
            if (item.length === 1 && item[0] >= 1 && item[0] <= 16)
                return hex.encode(Uint8Array.from([0x50 + item[0]]));
            return hex.encode(Uint8Array.from([item.length])) + itemHex;
        };

        V.valid.forEach((v) => {
            const assetId = asset.AssetId.create(V.txid_hex, v.group_index);

            it(`TLV carries the identity form -- ${v.label}`, () => {
                for (const [field, tag] of [
                    ["wantAsset", 0x03],
                    ["offerAsset", 0x0b],
                ] as const) {
                    const offer = { wantAmount: BigInt(50_000), [field]: assetId, ...keys };
                    const script = offerVtxoScript(offer, server);
                    const wire = hex.encode(
                        encodeOffer({ ...offer, swapPkScript: script.pkScript }),
                    );
                    // `[tag][len BE u16][value]`, value == the identity form
                    const record = hex.encode(Uint8Array.from([tag, 0x00, 0x22])) + v.asset_id_hex;
                    expect(wire, drift(v.label)).toContain(record);
                }
            });

            it(`program args carry the reversed txid and the index -- ${v.label}`, () => {
                const { args } = swapProgramBinding(
                    { wantAmount: BigInt(50_000), wantAsset: assetId, ...keys },
                    server,
                );

                // Serialization order in the covenant, display order in the id.
                // Getting this backwards makes the lookup report the asset
                // absent, which the VERIFY turns into an unspendable contract.
                expect(hex.encode(args.wantAssetTxid as Uint8Array), drift(v.label)).toBe(
                    V.script_txid_hex,
                );
                expect(hex.encode(args.wantAssetTxid as Uint8Array), drift(v.label)).not.toBe(
                    V.txid_hex,
                );

                // ...and the index travels as a number, so ArkadeScript encodes
                // it as a script number -- not as the 2-byte wire blob, which
                // coincides only at group 258 and reads as -32767 at 65535.
                expect(args.wantAssetGroupIndex, drift(v.label)).toBe(v.group_index);
                expect(
                    hex.encode(arkade.ArkadeScript.encode([args.wantAssetGroupIndex as number])),
                    drift(v.label),
                ).toBe(framed(v.script_group_index_item_hex));
            });
        });

        it("the identity and the covenant push are reverses, never equal", () => {
            expect(hex.encode(hex.decode(V.txid_hex).reverse())).toBe(V.script_txid_hex);
            expect(V.txid_hex).not.toBe(V.script_txid_hex);
        });
    });

    it("rejects offers without exactly one direction at encode time", () => {
        const base = { wantAmount: BigInt(50_000), ...keys, swapPkScript: new Uint8Array(34) };
        expect(() => encodeOffer({ ...base, wantAsset: testAsset, offerAsset: testAsset })).toThrow(
            "exactly one",
        );
        expect(() => encodeOffer(base)).toThrow("exactly one");
    });

    it("rejects payloads without exactly one direction at decode time", () => {
        // decode enforces the invariant independently of encode: another
        // implementation may emit what ours refuses to
        const valid = encodeOffer({
            wantAmount: BigInt(50_000),
            wantAsset: testAsset,
            ...keys,
            swapPkScript: new Uint8Array(34),
        });
        const both = cat(valid, rec(0x0b, testAsset.serialize()));
        expect(() => decodeOffer(both)).toThrow("exactly one");
        expect(() => decodeOffer(directionlessPayload())).toThrow("exactly one");
    });

    it("rejects wrong-width scripts and keys at encode time", () => {
        const base = { wantAmount: BigInt(50_000), wantAsset: testAsset, ...keys };
        expect(() => encodeOffer({ ...base, swapPkScript: new Uint8Array(33) })).toThrow(
            "swapPkScript must be 34 bytes",
        );
        expect(() =>
            encodeOffer({
                ...base,
                swapPkScript: new Uint8Array(34),
                makerPublicKey: new Uint8Array(31),
            }),
        ).toThrow("makerPublicKey must be 32 bytes");
    });

    it("rejects a wrong-width makerPkScript before it binds into the covenant", () => {
        // a 33-byte script would silently truncate makerWP to 31 bytes and only
        // surface as an unspendable address once the maker funds it
        expect(() =>
            offerVtxoScript(
                {
                    wantAmount: BigInt(50_000),
                    wantAsset: testAsset,
                    ...keys,
                    makerPkScript: keys.makerPkScript.slice(0, 33),
                },
                server,
            ),
        ).toThrow("makerPkScript");
    });

    it("rejects want amounts beyond the u64 wire field", () => {
        const offer = {
            wantAmount: BigInt(1) << BigInt(64),
            wantAsset: testAsset,
            ...keys,
            swapPkScript: new Uint8Array(34),
        };
        expect(() => encodeOffer(offer)).toThrow("u64");
    });

    it("rejects malformed TLV payloads", () => {
        expect(() => decodeOffer(new Uint8Array([0x01, 0x00]))).toThrow("truncated TLV header");
        expect(() => decodeOffer(new Uint8Array([0x01, 0x00, 0x05, 0xaa]))).toThrow(
            "truncated TLV value",
        );
        expect(() => decodeOffer(new Uint8Array([0x7f, 0x00, 0x01, 0xaa]))).toThrow(
            "unknown TLV type",
        );
        // missing required fields
        expect(() => decodeOffer(new Uint8Array([0x01, 0x00, 0x01, 0xaa]))).toThrow(
            "missing/invalid",
        );
    });

    it("rejects duplicate TLV records rather than letting the last one win", () => {
        const full: Offer = { ...goldens[0][0], swapPkScript: new Uint8Array(34) };
        const encoded = encodeOffer(full);
        // same bytes twice: another implementation taking the first record would
        // derive a different offer from an identical payload
        const doubled = new Uint8Array(encoded.length * 2);
        doubled.set(encoded, 0);
        doubled.set(encoded, encoded.length);
        expect(() => decodeOffer(doubled)).toThrow("duplicate TLV record");
    });

    it("rejects a swapPkScript that is not a 34-byte taproot output at decode time", () => {
        // restore.ts uses this value as the vtxo lookup key, so a wrong-width
        // script yields a record that can never bind to its deposit. Encode
        // refuses to emit one, so splice a short record into a valid payload.
        const valid = encodeOffer({ ...goldens[0][0], swapPkScript: new Uint8Array(34) });
        // the swapPkScript record leads the payload: 3-byte header + 34 bytes
        const foreign = cat(rec(0x01, new Uint8Array(33)), valid.subarray(3 + 34));
        expect(() => decodeOffer(foreign)).toThrow("missing/invalid swapPkScript");
    });

    it("rejects zero-length asset records with the decoder's own error", () => {
        // AssetId.fromBytes would reject the empty value anyway, but the error
        // must name the offending TLV field, not an AssetId internal
        const empty = cat(directionlessPayload(), rec(0x03, new Uint8Array(0)));
        expect(() => decodeOffer(empty)).toThrow("missing/invalid wantAsset");
    });

    it("rejects a wantAmount that is not exactly the u64 wire width", () => {
        const full: Offer = { ...goldens[0][0], swapPkScript: new Uint8Array(34) };
        const encoded = encodeOffer(full);
        // the wantAmount record is [type 0x02][len 0x0008][8 bytes]; rewrite it
        // wider and narrower. A short value would make getBigUint64 throw a raw
        // RangeError; a long one would be silently truncated to its first 8
        // bytes — an amount the covenant never bound.
        const at = encoded.indexOf(0x02);
        const reweave = (value: Uint8Array) => {
            const out = new Uint8Array(encoded.length - 8 + value.length);
            out.set(encoded.subarray(0, at + 1), 0);
            out[at + 1] = (value.length >> 8) & 0xff;
            out[at + 2] = value.length & 0xff;
            out.set(value, at + 3);
            out.set(encoded.subarray(at + 3 + 8), at + 3 + value.length);
            return out;
        };
        // rewriting with the original 8 bytes must reproduce the payload exactly
        // — that is what makes the two width cases below meaningful
        expect(hex.encode(reweave(encoded.slice(at + 3, at + 3 + 8)))).toBe(hex.encode(encoded));
        expect(() => decodeOffer(reweave(new Uint8Array(4)))).toThrow("missing/invalid wantAmount");
        expect(() => decodeOffer(reweave(new Uint8Array(12)))).toThrow(
            "missing/invalid wantAmount",
        );
    });
});
