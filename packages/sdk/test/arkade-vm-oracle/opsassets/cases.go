package opsassets

import (
	"bytes"
	"math"
	"strconv"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	. "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type tcase struct {
	name, mode  string
	w, inject   *world
	input       int
	script      []byte
	message     *string
	template    string
	unsupported bool
}

var cases []*tcase

func itoa(i int) string { return strconv.Itoa(i) }

func rev(b []byte) []byte {
	out := make([]byte, len(b))
	for i := range b {
		out[len(b)-1-i] = b[i]
	}
	return out
}

func hb(tag string) []byte { x := h(tag); return x[:] }

func hashOf(w *world) []byte { x := w.tx.TxHash(); return x[:] }

type opc byte

// sc assembles ints (minimal pushes), []byte (data pushes) and opcodes.
func sc(parts ...any) []byte {
	b := txscript.NewScriptBuilder()
	for _, p := range parts {
		switch v := p.(type) {
		case int:
			b.AddInt64(int64(v))
		case []byte:
			b.AddData(v)
		case opc:
			b.AddOp(byte(v))
		default:
			panic("bad part")
		}
	}
	s, err := b.Script()
	if err != nil {
		panic(err)
	}
	return s
}

func ex(name string, w, inject *world, input int, parts ...any) *tcase {
	c := &tcase{name: name, mode: "expression", w: w, inject: inject, input: input, script: sc(parts...)}
	cases = append(cases, c)
	return c
}

func cov(name string, w *world, parts ...any) {
	cases = append(cases, &tcase{name: name, mode: "covenant", w: w, script: sc(parts...)})
}

var bs = string([]byte{92})

func intentCase(name, template, path string) *tcase {
	m := strings.ReplaceAll(template, "%u", bs+"u")
	c := ex(name, plainW, nil, 0, []byte(path), opc(OP_INSPECTINTENTMESSAGE))
	c.message, c.template = &m, template
	return c
}

var plainW *world

func build() {
	plainW = addWorld("plain")
	orphan := addWorld("orphan")
	orphan.prevouts = orphan.prevouts[:1]

	assets := addWorld("assets", extOut(mustPacket(
		asset.AssetGroup{
			ControlAsset: &asset.AssetRef{Type: asset.AssetRefByGroup, GroupIndex: 2},
			Outputs:      []asset.AssetOutput{out(0, 10)},
			Metadata:     []asset.Metadata{md("a", "1"), md("b", "2"), md("c", "3"), md("d", "4"), md("e", "5")},
		},
		asset.AssetGroup{AssetId: id("t5-a", 7)},
		asset.AssetGroup{
			AssetId: id("t5-b", 0),
			Inputs:  []asset.AssetInput{intent("t5-intent", 1, 7), intent("t5-intent2", 0, 9)},
			Outputs: []asset.AssetOutput{out(1, 16)},
		},
		asset.AssetGroup{
			ControlAsset: &asset.AssetRef{Type: asset.AssetRefByID, AssetId: *id("t5-ctrl", 2)},
			Outputs:      []asset.AssetOutput{out(0, 1), out(1, 2)},
			Metadata:     []asset.Metadata{md("k", "v"), md("k2", "v2")},
		},
		asset.AssetGroup{
			AssetId: id("t5-c", 65535),
			Inputs:  []asset.AssetInput{local(0, math.MaxUint64), local(1, 5)},
			Outputs: []asset.AssetOutput{out(0, 3)},
		},
	)))
	collide := addWorld("collide-src", extOut(mustPacket(
		asset.AssetGroup{Outputs: []asset.AssetOutput{out(0, 1)}},
		asset.AssetGroup{
			AssetId: &asset.AssetId{Txid: plainW.tx.TxHash(), Index: 0},
			Inputs:  []asset.AssetInput{local(0, 1)},
			Outputs: []asset.AssetOutput{out(0, 1)},
		},
		asset.AssetGroup{ControlAsset: &asset.AssetRef{Type: asset.AssetRefByGroup, GroupIndex: 1}, Outputs: []asset.AssetOutput{out(0, 2)}},
	)))
	tunnel := addWorld("tunnel", extOut(mustPacket(
		asset.AssetGroup{AssetId: id("t5-tun", 1), Inputs: []asset.AssetInput{local(0, 50)}, Outputs: []asset.AssetOutput{out(0, 50)}},
		asset.AssetGroup{AssetId: id("t5-tun2", 0), Inputs: []asset.AssetInput{local(0, 0)}},
		asset.AssetGroup{Outputs: []asset.AssetOutput{out(1, 4)}},
	)))

	nc := cat([]byte{0x81, 0x00, 0x09}, rev(hb("t5-nc")), le16(1), []byte{1, 1}, le16(0), []byte{0x81, 0x00, 1, 1}, le16(0), []byte{1})
	packets := addWorld("packets", extOut(raw(0, nc), raw(1, []byte{5, 1}), raw(3, []byte{}), raw(7, []byte{0xaa, 0xbb})))
	mdEmpty := addWorld("metadata-empty", extOut(raw(0, cat([]byte{1, 5}, rev(hb("t5-md")), le16(0), []byte{0, 0, 1, 1}, le16(0), []byte{1}))))
	dupIntent := addWorld("dup-intent-vin", extOut(raw(0, cat([]byte{1, 1}, rev(hb("t5-d")), le16(0), []byte{2},
		[]byte{2}, rev(hb("t5-i1")), le16(3), []byte{1}, []byte{2}, rev(hb("t5-i2")), le16(3), []byte{2}, []byte{0}))))

	recipe := func(name string, pkts ...extension.Packet) *world {
		w := addWorld(name, extOut(pkts...))
		w.recipe = name
		return w
	}
	g1001 := recipe("groups-1001", raw(0, cat([]byte{0xe9, 0x07}, bytes.Repeat([]byte{0, 0, 1, 1, 0, 0, 1}, 1001))))
	g1000 := recipe("groups-1000", raw(0, cat([]byte{0xe8, 0x07}, bytes.Repeat([]byte{0, 0, 1, 1, 0, 0, 1}, 1000))))
	var ins []byte
	for i := 0; i < 1001; i++ {
		ins = append(ins, cat([]byte{1}, le16(i), []byte{1})...)
	}
	i1001 := recipe("inputs-1001", raw(0, cat([]byte{1, 1}, bytes.Repeat([]byte{0x11}, 32), le16(0), []byte{0xe9, 0x07}, ins, []byte{0})))
	o1001 := recipe("outputs-1001", raw(0, cat([]byte{1, 0, 0, 0xe9, 0x07}, ins)))

	trailEmpty := addWorld("trail-empty", scriptOut("6a0841524b0701aa0500"))
	junk := addWorld("junk-after-push", scriptOut("6a0641524b0701aa4c"))
	twoPush := addWorld("two-pushes", scriptOut("6a0641524b0701aa030801bb"))
	nonMinPush := addWorld("nonminimal-push", scriptOut("6a4d060041524b0701aa"))
	lebNonMin := addWorld("leb-nonminimal", scriptOut("6a0741524b078100aa"))
	notExtFirst := addWorld("not-ext-first", scriptOut("6a0441525801"), extOut(raw(7, []byte{0xcc})))
	shortMagic := addWorld("short-magic", scriptOut("6a024152"))
	badFirst := addWorld("bad-ext-first", scriptOut("6a0541524b0709"), extOut(raw(7, []byte{0xdd})))
	assetEmpty := addWorld("asset-empty-data", extOut(raw(0, []byte{}), raw(7, []byte{1})))

	simple := mustPacket(asset.AssetGroup{AssetId: id("t5-s", 2), Inputs: []asset.AssetInput{local(0, 4)}, Outputs: []asset.AssetOutput{out(1, 4)}})
	junkAsset := addWorld("junk-after-push-asset", &wire.TxOut{PkScript: append(extOut(simple).PkScript, 0x4c)})

	emuNonCanon := addWorld("emu-noncanonical", extOut(raw(1, cat([]byte{0xfd, 1, 0}, emuEntry(0, []byte{0x51}, nil)))))
	emuTrailing := addWorld("emu-witness-trailing", extOut(simple, raw(1, cat([]byte{1}, emuEntry(0, []byte{0x51}, cat(witnessBlob([]byte{0xaa}), []byte{0xff, 0xff}))))))
	emuDupVin := addWorld("emu-dup-vin", extOut(raw(1, cat([]byte{2}, emuEntry(0, []byte{0x51}, nil), emuEntry(0, []byte{0x52}, nil)))))
	emuVinRange := addWorld("emu-vin-out-of-range", extOut(raw(1, cat([]byte{1}, emuEntry(5, []byte{0x51}, witnessBlob([]byte{1, 2}))))))
	emuEntries := cat([]byte{2}, emuEntry(0, []byte{0x51, 0x52}, witnessBlob([]byte{0xaa, 0xbb}, []byte{})), emuEntry(1, []byte{0x53}, witnessBlob([]byte{0xcc})))
	emuValid := addWorld("emu-valid", extOut(simple, raw(1, emuEntries)))
	payload := cat([]byte("ARK"), []byte{0, byte(len(nc))}, nc, []byte{1, byte(len(emuEntries))}, emuEntries)
	emuMessy := addWorld("emu-valid-messy", &wire.TxOut{Value: 7, PkScript: cat([]byte{0x6a, 0x4d}, le16(len(payload)), payload, []byte{0x4c})})
	emuWitNonCanon := addWorld("emu-witness-noncanonical", extOut(raw(1, cat([]byte{1}, emuEntry(0, []byte{0x51}, []byte{1, 0xfd, 1, 0, 0xaa})))))
	emuItem10001 := recipe("emu-witness-item-10001", raw(1, cat([]byte{1}, emuEntry(0, []byte{0x51}, witnessBlob(bytes.Repeat([]byte{7}, 10001))))))
	var big [][]byte
	for i := 0; i < 99; i++ {
		big = append(big, bytes.Repeat([]byte{7}, 10000))
	}
	big = append(big, bytes.Repeat([]byte{7}, 9699))
	maxEntry := emuEntry(0, bytes.Repeat([]byte{0x61}, 10000), witnessBlob(big...))
	budgetMax := recipe("emu-budget-max", raw(1, cat([]byte{1}, maxEntry)))
	budgetOver := recipe("emu-budget-over", raw(1, cat([]byte{2}, maxEntry, emuEntry(1, []byte{0x51}, nil))))

	prevExt := addWorld("prev-ext")
	prevExt.prevouts[0].arkTx = arkTx(extOut(raw(7, []byte{0x0e}), raw(9, bytes.Repeat([]byte{2}, 521))))
	prevBad := addWorld("prev-bad-ext")
	prevBad.prevouts[0].arkTx = arkTx(scriptOut("6a0541524b0709"))
	prevNc := addWorld("prev-noncanonical-asset")
	prevNc.prevouts[0].arkTx = arkTx(extOut(raw(0, nc)))

	a := assets
	ex("asset/num-groups", a, a, 0, opc(OP_INSPECTNUMASSETGROUPS))
	for k := 0; k <= 4; k++ {
		ex("asset/id/k"+itoa(k), a, a, 0, k, opc(OP_INSPECTASSETGROUPASSETID))
	}
	for _, k := range []int{0, 1, 3} {
		ex("asset/ctrl/k"+itoa(k), a, a, 0, k, opc(OP_INSPECTASSETGROUPCTRL))
		ex("asset/metadata/k"+itoa(k), a, a, 0, k, opc(OP_INSPECTASSETGROUPMETADATAHASH))
	}
	ex("asset/num/id-only-group", a, a, 0, 1, 2, opc(OP_INSPECTASSETGROUPNUM))
	ex("asset/group/intent-input", a, a, 0, 2, 1, 0, opc(OP_INSPECTASSETGROUP))
	ex("asset/group/max-amount", a, a, 0, 4, 0, 0, opc(OP_INSPECTASSETGROUP))
	ex("asset/group/id-only-has-no-outputs", a, a, 0, 1, 0, 1, opc(OP_INSPECTASSETGROUP))
	ex("asset/sum/overflows-uint64", a, a, 0, 4, 2, opc(OP_INSPECTASSETGROUPSUM))
	ex("asset/sum/intent-inputs", a, a, 0, 2, 0, opc(OP_INSPECTASSETGROUPSUM))
	ex("asset/find/explicit", a, a, 0, hb("t5-c"), 65535, opc(OP_FINDASSETGROUPBYASSETID))
	ex("asset/find/fresh", a, a, 0, hashOf(a), 3, opc(OP_FINDASSETGROUPBYASSETID))
	ex("asset/find/wire-order-misses", a, a, 0, rev(hb("t5-c")), 65535, opc(OP_FINDASSETGROUPBYASSETID))
	ex("asset/out-count/0", a, a, 0, 0, opc(OP_INSPECTOUTASSETCOUNT))
	ex("asset/out-count/1", a, a, 0, 1, opc(OP_INSPECTOUTASSETCOUNT))
	ex("asset/out-at/o1-t1", a, a, 0, 1, 1, opc(OP_INSPECTOUTASSETAT))
	ex("asset/out-at/o0-t2", a, a, 0, 0, 2, opc(OP_INSPECTOUTASSETAT))
	ex("asset/out-at/o0-t3", a, a, 0, 0, 3, opc(OP_INSPECTOUTASSETAT))
	ex("asset/out-lookup/fresh", a, a, 0, 0, hashOf(a), 0, opc(OP_INSPECTOUTASSETLOOKUP))
	ex("asset/out-lookup/miss", a, a, 0, 1, hashOf(a), 0, opc(OP_INSPECTOUTASSETLOOKUP))
	ex("asset/in-count/1", a, a, 0, 1, opc(OP_INSPECTINASSETCOUNT))
	ex("asset/in-at/i0-t1", a, a, 0, 0, 1, opc(OP_INSPECTINASSETAT))
	ex("asset/in-lookup/explicit", a, a, 0, 1, hb("t5-c"), 65535, opc(OP_INSPECTINASSETLOOKUP))
	ex("asset/in-lookup/intent-txid-is-not-an-asset-id", a, a, 0, 1, hb("t5-intent"), 0, opc(OP_INSPECTINASSETLOOKUP))

	// the explicit id names the executing tx: reachable only by injecting another tx's packet
	p, c := plainW, collide
	ex("collide/id/fresh-k0", p, c, 0, 0, opc(OP_INSPECTASSETGROUPASSETID))
	ex("collide/id/explicit-k1", p, c, 0, 1, opc(OP_INSPECTASSETGROUPASSETID))
	ex("collide/ctrl/by-group", p, c, 0, 2, opc(OP_INSPECTASSETGROUPCTRL))
	ex("collide/find/hit-before-collision", p, c, 0, hashOf(p), 0, opc(OP_FINDASSETGROUPBYASSETID))
	ex("collide/find/miss-reaches-collision", p, c, 0, hb("x"), 0, opc(OP_FINDASSETGROUPBYASSETID))
	ex("collide/out-count-never-resolves", p, c, 0, 0, opc(OP_INSPECTOUTASSETCOUNT))
	ex("collide/out-at/t0", p, c, 0, 0, 0, opc(OP_INSPECTOUTASSETAT))
	ex("collide/out-at/t1", p, c, 0, 0, 1, opc(OP_INSPECTOUTASSETAT))
	ex("collide/tunnel", p, c, 0, 0, 4, 0, opc(OP_TUNNEL))

	t := tunnel
	ex("tunnel/assets/zero-input-unbalanced", t, t, 0, 0, 4, 0, opc(OP_TUNNEL))
	ex("tunnel/assets/exception-balances", t, t, 0, 0, 4, hb("t5-tun2"), 0, 1, opc(OP_TUNNEL))
	ex("tunnel/assets/duplicate-exception", t, t, 0, 0, 4, hb("t5-tun2"), 0, hb("t5-tun2"), 0, 2, opc(OP_TUNNEL))
	ex("tunnel/assets/all-flags", t, t, 0, 0, 7, hb("t5-tun2"), 0, 1, opc(OP_TUNNEL))
	ex("tunnel/assets/other-output", t, t, 0, 1, 4, hb("t5-tun2"), 0, 1, opc(OP_TUNNEL))
	ex("tunnel/exception/txid-31", t, t, 0, 0, 4, hb("t5-tun2")[:31], 0, 1, opc(OP_TUNNEL))
	ex("tunnel/exception/gidx-65536", t, t, 0, 0, 4, hb("t5-tun2"), 65536, 1, opc(OP_TUNNEL))
	ex("tunnel/exception/count-guard", t, t, 0, 0, 4, 1, opc(OP_TUNNEL))
	ex("tunnel/exception/needs-asset-flag", t, t, 0, 0, 3, hb("t5-tun2"), 0, 1, opc(OP_TUNNEL))
	ex("tunnel/depth-under-2", t, t, 0, 4, 0, opc(OP_TUNNEL))
	ex("tunnel/script/vtxo-hit", p, nil, 0, 0, 1, 0, opc(OP_TUNNEL))
	ex("tunnel/script/vtxo-wins-over-prevout", p, nil, 0, 2, 1, 0, opc(OP_TUNNEL))
	ex("tunnel/script/fallback-to-prevout", p, nil, 1, 1, 1, 0, opc(OP_TUNNEL))
	ex("tunnel/script/fallback-mismatch", p, nil, 1, 0, 1, 0, opc(OP_TUNNEL))
	ex("tunnel/script/both-nil", orphan, nil, 1, 1, 1, 0, opc(OP_TUNNEL))
	ex("tunnel/value/both-nil", orphan, nil, 1, 1, 2, 0, opc(OP_TUNNEL))
	ex("tunnel/value/ok", p, nil, 0, 2, 2, 0, opc(OP_TUNNEL))
	ex("tunnel/value/mismatch", p, nil, 0, 1, 2, 0, opc(OP_TUNNEL))
	ex("tunnel/flags/9", p, nil, 0, 0, 9, 0, opc(OP_TUNNEL))
	ex("tunnel/output/negative", p, nil, 0, -1, 1, 0, opc(OP_TUNNEL))

	for _, typ := range []int{0, 1, 3, 7, 8} {
		ex("packet/mixed/type-"+itoa(typ), packets, nil, 0, typ, opc(OP_INSPECTPACKET))
	}
	ex("packet/metadata-presence-dropped", mdEmpty, nil, 0, 0, opc(OP_INSPECTPACKET))
	ex("packet/dup-intent-vin", dupIntent, nil, 0, 0, opc(OP_INSPECTPACKET))
	for _, w := range []*world{g1001, i1001, o1001, trailEmpty, badFirst, assetEmpty} {
		ex("packet/"+w.name, w, nil, 0, 7, opc(OP_INSPECTPACKET))
	}
	ex("packet/groups-1000", g1000, g1000, 0, opc(OP_INSPECTNUMASSETGROUPS))
	for _, w := range []*world{junk, twoPush, nonMinPush, lebNonMin, notExtFirst, shortMagic} {
		ex("packet/"+w.name+"/type-7", w, nil, 0, 7, opc(OP_INSPECTPACKET))
	}
	ex("packet/two-pushes/type-8", twoPush, nil, 0, 8, opc(OP_INSPECTPACKET))
	ex("packet/emu-noncanonical/type-1", emuNonCanon, nil, 0, 1, opc(OP_INSPECTPACKET))
	ex("inputpacket/found", prevExt, nil, 0, 7, 0, opc(OP_INSPECTINPUTPACKET))
	ex("inputpacket/too-big", prevExt, nil, 0, 9, 0, opc(OP_INSPECTINPUTPACKET))
	ex("inputpacket/absent", prevExt, nil, 0, 8, 0, opc(OP_INSPECTINPUTPACKET))
	ex("inputpacket/malformed", prevBad, nil, 0, 7, 0, opc(OP_INSPECTINPUTPACKET))
	ex("inputpacket/canonical-asset", prevNc, nil, 0, 0, 0, opc(OP_INSPECTINPUTPACKET))
	ex("inputpacket/no-ark-tx", prevExt, nil, 0, 7, 1, opc(OP_INSPECTINPUTPACKET))

	cov("covenant/emu-noncanonical", emuNonCanon, opc(OP_1))
	cov("covenant/emu-witness-trailing", emuTrailing, opc(OP_INSPECTNUMASSETGROUPS))
	cov("covenant/emu-dup-vin", emuDupVin, opc(OP_1))
	cov("covenant/emu-vin-out-of-range", emuVinRange, opc(OP_1))
	cov("covenant/emu-valid", emuValid, opc(OP_INSPECTNUMASSETGROUPS))
	cov("covenant/emu-valid-messy", emuMessy, opc(OP_INSPECTNUMASSETGROUPS))
	cov("covenant/emu-witness-noncanonical", emuWitNonCanon, opc(OP_1))
	cov("covenant/dup-intent-vin", dupIntent, opc(OP_1))
	cov("covenant/junk-after-push-asset", junkAsset, opc(OP_INSPECTNUMASSETGROUPS))
	cov("covenant/bad-ext-first", badFirst, opc(OP_1))
	cov("covenant/emu-budget-over", budgetOver, opc(OP_1))
	cov("covenant/emu-budget-max", budgetMax, opc(OP_1))
	cov("covenant/emu-witness-item-10001", emuItem10001, opc(OP_1))

	doc := `{"n1":1E+2,"n2":-0.0e5,"n3":1.50,"n4":15e-1,"n5":120e-1,"n6":0.00012e4,"n7":1e-0,"n8":2.000,` +
		`"n9":1e1251,"n10":1e1252,"n11":0e99999999999999999999,"n12":1e9223372036854775808,` +
		`"n13":1e-9223372036854775809,"n14":-12345678901234567890123,"n15":1e1254,"n16":-1e1255,"n17":5e-1,` +
		`"s1":"a%u0022b%u005c","s2":"x\"y\\z\/w\n\t\b\f\r","s3":"%ud83d%ude00","s4":"%ud800%u0041",` +
		`"s5":"%udc00%ud800%udc00","s6":"%ude00","s7":"é€","s8":"%ud800x","s9":"%ud800%ud800",` +
		`"o":{"p":[[1,2],[3]],"q":{ "r" : true },"e":{},"ea":[ ]},"%u0061b":"esc-key","z":null,"f":false}`
	for _, path := range []string{"n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11", "n12", "n13",
		"n14", "n15", "n16", "n17", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "o", "o.p", "o.p.0", "o.p.1",
		"o.p.0.1", "o.p.2", "o.q", "o.q.r", "o.e", "o.ea", "ab", "z", "f", "missing", "o.p.x", "o.q.0", "n1.x"} {
		intentCase("intent/doc/"+path, doc, path)
	}
	// the port refuses these: gjson answers where JSON semantics do not
	intentCase("intent/top-level-string-with-bracket", `"[1]"`, "0").unsupported = true
	intentCase("intent/top-level-string", `"abc"`, "a")
	intentCase("intent/top-level-number", ` 5 `, "a")
	intentCase("intent/duplicate-off-path", `{"a":1,"b":{"c":1,"c":2}}`, "a").unsupported = true
	intentCase("intent/duplicate-escaped", `{"a":1,"%u0061":2}`, "a").unsupported = true
	intentCase("intent/trailing-comma", `{"a":1,}`, "a").unsupported = true
	intentCase("intent/single-quotes", `{'a':1}`, "a").unsupported = true
	intentCase("intent/invalid-path-checked-first", `{"a":1,`, "A")
	intentCase("intent/depth-10000", strings.Repeat("[", 10000)+strings.Repeat("]", 10000), "0")
	intentCase("intent/depth-10001", strings.Repeat("[", 10001)+strings.Repeat("]", 10001), "0").unsupported = true
	intentCase("intent/bom", "\xef\xbb\xbf"+`{"a":1}`, "a").unsupported = true
	intentCase("intent/path-with-bom", `{"a":1}`, "\xef\xbb\xbfa")
	intentCase("intent/path-utf8", `{"é":1}`, "é")
}
