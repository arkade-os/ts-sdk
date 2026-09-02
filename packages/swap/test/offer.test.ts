import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, arkade, asset, type RelativeTimelock } from "@arkade-os/sdk";
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

    // Emitted by solverd's own encoder (`pkg/swap/contract`) against the keys
    // above, so these pin the wire format and the taproot tree to the reference
    // rather than to ourselves. The two exit-less vectors reproduce the goldens
    // at the top of this file — which is what says they share the same inputs.
    describe("solverd reference vectors", () => {
        const vectors: {
            label: string;
            offerHex: string;
            address: string;
            exit?: RelativeTimelock;
            ratio?: [bigint, bigint];
        }[] = [
            {
                label: "wantBtc, no exit",
                offerHex:
                    "0100225120004739eb4ad3eab769b0c2278cd70cce628e20477e8b8c508bcf8519a5f451c9020008000000000000c3500b0022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65qz8884545l2ka5mps383ntsennz3csywl5t33gghnu9rxjlg5wfv467cj",
            },
            {
                label: "wantBtc, exit blocks 144",
                offerHex:
                    "0100225120a928b3f0209a939822b5a73a5d507c9bcc7f68b7875b28b50b5b8412cda16f4d020008000000000000c3500b0022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f270c0009000000000000000090",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc642fgk0czpx5nnq3ttfe6t4g8ex7v0a5t0p6m9z6skkuyztx6zm6d9ccar9",
                exit: { type: "blocks", value: BigInt(144) },
            },
            {
                label: "wantAsset, no exit",
                offerHex:
                    "0100225120b2a1cd158c7a7e2e6346b6d2d0c323eae90d9d6b8c6e2245de4170d953e2bca6020008000000000000c350030022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc64v4pe52cc7n79e35ddkj6rpj86hfpkwkhrrwyfzaustsm9f7909xukfu7j",
            },
            {
                label: "wantAsset, exit seconds 51200",
                offerHex:
                    "0100225120a454544d8df3377853e1ac907f9e67c8284780232ecd9ca76fb04af7f87df6bd020008000000000000c350030022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f270c000901000000000000c800",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc64fz523xcmueh0pf7rtys070x0jpgg7qzxtkdnjnklvz27lu8ma4a2sqp7d",
                exit: { type: "seconds", value: BigInt(51_200) },
            },
            {
                label: "wantAsset, exit seconds 604672",
                offerHex:
                    "0100225120350b08d2374dedf0346be509962c39899ea3b09e9b1b4df572ba3ecb5ae5f6e5020008000000000000c350030022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f270c0009010000000000093a00",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65dgtprfrwn0d7q6xhegfjckrnzv75wcfaxcmfh6h9w37eddwtah9v56pnn",
                exit: { type: "seconds", value: BigInt(604_672) },
            },
            {
                label: "wantAsset, ratio 1/4",
                offerHex:
                    "0100225120b2a1cd158c7a7e2e6346b6d2d0c323eae90d9d6b8c6e2245de4170d953e2bca6020008000000000000c350030022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa09000800000000000000010a0008000000000000000405002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc64v4pe52cc7n79e35ddkj6rpj86hfpkwkhrrwyfzaustsm9f7909xukfu7j",
                ratio: [BigInt(1), BigInt(4)],
            },
            {
                // every optional record at once: the only vector that pins the
                // canonical order *between* the ratios and offerAsset
                label: "wantBtc, ratio 3/8, exit blocks 4032",
                offerHex:
                    "01002251204a0bd091ba08d9724dcbe74ae91812e8cb3f1a82ff068b8be55c0538842a7fa8020008000000000000c35009000800000000000000030a000800000000000000080b0022aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05002251203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b10700203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1080020466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f270c0009000000000000000fc0",
                address:
                    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65jst6zgm5zxewfxuhe62ayvp96xt8udg9lcx3w972hq98zzz5lagzyxac8",
                exit: { type: "blocks", value: BigInt(4_032) },
                ratio: [BigInt(3), BigInt(8)],
            },
        ];

        vectors.forEach((v) => {
            it(`decodes and re-derives -- ${v.label}`, () => {
                const offer = decodeOffer(hex.decode(v.offerHex));
                expect(offer.exitDelay).toEqual(v.exit);
                expect(offer.ratioNum).toBe(v.ratio?.[0]);
                expect(offer.ratioDen).toBe(v.ratio?.[1]);

                // the reconstructed tree must be the one the payload names, or
                // the § 5.1 consistency check rejects every offer solverd emits
                const script = offerVtxoScript(offer, server);
                expect(hex.encode(script.pkScript)).toBe(hex.encode(offer.swapPkScript));
                expect(new ArkAddress(server, script.tweakedPublicKey, "tark").encode()).toBe(
                    v.address,
                );
                expect(script.scripts).toHaveLength(v.exit ? 3 : 2);

                // and re-emitting must reproduce the reference bytes exactly --
                // that is what pins our record order to § 2.1
                expect(hex.encode(encodeOffer(offer))).toBe(v.offerHex);
            });
        });

        it("re-derives an exit offer from its persisted contract params", () => {
            // registerOfferContract stores the program as artifact JSON, and the
            // exit's timelock is a `$param` reference rather than a literal -- a
            // round trip that dropped it would leave a registered row whose
            // script no longer matches the address the maker funded
            const offer = decodeOffer(hex.decode(vectors[1].offerHex));
            const { program, args, keys: bound } = swapProgramBinding(offer, server);
            const stored = arkade.serializeArkadeContractParams({
                program,
                args,
                serverKey: bound.serverKey,
                userKey: bound.userKey,
                emulatorKey: bound.emulatorKey,
            });
            const back = arkade.deserializeArkadeContractParams(stored);
            const rebuilt = new arkade.ArkadeProgramScript(back.program, back.args, {
                serverKey: back.serverKey,
                userKey: back.userKey,
                emulatorKey: back.emulatorKey,
            });
            expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(offer.swapPkScript));
        });

        it("appends the exit closure, leaving the other two leaves in place", () => {
            // leaf order is part of the address (the tree is assembled from the
            // list), so an exit inserted anywhere else derives a different swap
            const withExit = decodeOffer(hex.decode(vectors[1].offerHex));
            const { exitDelay: _unused, ...withoutExit } = withExit;
            const before = offerVtxoScript(withoutExit, server);
            const after = offerVtxoScript(withExit, server);
            expect(after.scripts.slice(0, 2).map((s) => hex.encode(s))).toEqual(
                before.scripts.map((s) => hex.encode(s)),
            );
            expect(after.scripts).toHaveLength(3);
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

    describe("the optional records", () => {
        const base = { wantAmount: BigInt(50_000), wantAsset: testAsset, ...keys };
        const full = (over: Partial<Offer> = {}): Offer => ({
            ...base,
            swapPkScript: new Uint8Array(34),
            ...over,
        });
        /** A valid payload plus one hand-built record — decode-side coverage
         * for shapes encodeOffer refuses to emit. */
        const spliced = (...extra: Uint8Array[]) => cat(encodeOffer(full()), ...extra);
        const u64be = (n: number) => {
            const out = new Uint8Array(8);
            new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
            return out;
        };

        it("rejects an unassigned exit locktime type", () => {
            // reading a third type as `blocks` would derive a swap address the
            // emitter never meant, and the deposit would land somewhere else
            const exotic = spliced(rec(0x0c, cat(Uint8Array.of(0x02), u64be(144))));
            expect(() => decodeOffer(exotic)).toThrow("unknown exitDelay locktime type: 0x2");
            expect(() =>
                encodeOffer(full({ exitDelay: { type: "months" as never, value: BigInt(1) } })),
            ).toThrow("unknown exitDelay locktime type");
        });

        it("rejects an exit record that is not the 9-byte wire width", () => {
            expect(() => decodeOffer(spliced(rec(0x0c, u64be(144))))).toThrow(
                "missing/invalid exitTimelock",
            );
        });

        it("rejects an exit delay wider than the reference's u32 locktime", () => {
            // the reference decoder narrows the wire u64 to uint32, so a wider
            // value derives one swap address there and another here
            expect(() =>
                encodeOffer(
                    full({ exitDelay: { type: "blocks", value: BigInt(1) << BigInt(32) } }),
                ),
            ).toThrow("exitDelay does not fit");
        });

        it("rejects half a ratio on both sides of the codec", () => {
            expect(() => decodeOffer(spliced(rec(0x09, u64be(3))))).toThrow(
                "both ratioNum and ratioDen",
            );
            expect(() => encodeOffer(full({ ratioNum: BigInt(3) }))).toThrow(
                "both ratioNum and ratioDen",
            );
        });

        it("rejects a zero ratio record, which contradicts its own presence", () => {
            // the reference spells "unset" as 0 and emits nothing for it
            const zeroed = spliced(rec(0x09, u64be(0)), rec(0x0a, u64be(4)));
            expect(() => decodeOffer(zeroed)).toThrow("missing/invalid ratioNum");
        });

        it("rejects a negative ratio rather than dropping it as unset", () => {
            // 0 is the reference's "unset"; a negative is a value the u64 field
            // cannot carry, and treating it as unset would publish an offer
            // without the ratio the caller asked for
            expect(() => encodeOffer(full({ ratioNum: BigInt(-1), ratioDen: BigInt(4) }))).toThrow(
                "ratioNum does not fit",
            );
            expect(() => encodeOffer(full({ ratioNum: BigInt(3), ratioDen: BigInt(-4) }))).toThrow(
                "ratioDen does not fit",
            );
        });

        it("treats a zero ratio as unset when encoding, as the reference does", () => {
            const encoded = encodeOffer(full({ ratioNum: BigInt(0), ratioDen: BigInt(0) }));
            expect(hex.encode(encoded)).toBe(hex.encode(encodeOffer(full())));
        });

        it("roundtrips an offer carrying every optional record", () => {
            const offer = full({
                ratioNum: BigInt(3),
                ratioDen: BigInt(8),
                exitDelay: { type: "seconds", value: BigInt(51_200) },
            });
            const back = decodeOffer(encodeOffer(offer));
            expect(back.ratioNum).toBe(BigInt(3));
            expect(back.ratioDen).toBe(BigInt(8));
            expect(back.exitDelay).toEqual({ type: "seconds", value: BigInt(51_200) });
        });
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
