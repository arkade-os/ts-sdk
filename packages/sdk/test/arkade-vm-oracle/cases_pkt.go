package main

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	. "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/wire/v2"
)

func assetID(tag string, idx uint16) *asset.AssetId {
	return &asset.AssetId{Txid: h(tag), Index: idx}
}

func md(k, v string) asset.Metadata { return asset.Metadata{Key: []byte(k), Value: []byte(v)} }

func assetPacket(groups ...asset.AssetGroup) asset.Packet {
	p, err := asset.NewPacket(groups)
	if err != nil {
		panic(err)
	}
	return p
}

func assetWorld(name string, p asset.Packet, extra ...extension.Packet) *world {
	return txWith(name, func(tx *wire.MsgTx) { tx.AddTxOut(extOut(append([]extension.Packet{p}, extra...)...)) })
}

func local(vin uint16, amt uint64) asset.AssetInput {
	return asset.AssetInput{Type: asset.AssetInputTypeLocal, Vin: vin, Amount: amt}
}

func out(vout uint16, amt uint64) asset.AssetOutput {
	return asset.AssetOutput{Type: asset.AssetOutputTypeLocal, Vout: vout, Amount: amt}
}

func mainAssetPacket() asset.Packet {
	return assetPacket(
		asset.AssetGroup{
			ControlAsset: &asset.AssetRef{Type: asset.AssetRefByGroup, GroupIndex: 3},
			Outputs:      []asset.AssetOutput{out(0, 100)},
			Metadata:     []asset.Metadata{md("name", "x"), md("ticker", "X"), md("decimals", "8")},
		},
		asset.AssetGroup{
			AssetId: assetID("asset-a", 3),
			Inputs:  []asset.AssetInput{local(0, 40), local(1, 60)},
			Outputs: []asset.AssetOutput{out(0, 30), out(1, 70)},
		},
		asset.AssetGroup{
			AssetId: assetID("asset-b", 0),
			Inputs:  []asset.AssetInput{{Type: asset.AssetInputTypeIntent, Txid: h("intent-tx"), Vin: 0, Amount: 25}},
			Outputs: []asset.AssetOutput{out(1, 25)},
		},
		asset.AssetGroup{
			ControlAsset: &asset.AssetRef{Type: asset.AssetRefByID, AssetId: *assetID("ctrl", 9)},
			Outputs:      []asset.AssetOutput{out(1, 1)},
		},
		asset.AssetGroup{
			AssetId: assetID("asset-c", 1),
			Inputs:  []asset.AssetInput{local(0, math.MaxUint64), local(1, 0)},
			Outputs: []asset.AssetOutput{out(0, 5)},
		},
	)
}

func assetHand() []*Case {
	b := &book{}
	w := assetWorld("assets", mainAssetPacket())
	ex := func(name string, op int, hz string, parts ...any) {
		b.ex("asset/"+slots[op].name+"/"+name, op, hz, sc(append(parts, o(op))...), inW(w), pk())
	}
	ex("count", OP_INSPECTNUMASSETGROUPS, "3.11/no-packet")
	b.ex("asset/OP_INSPECTNUMASSETGROUPS/no-packet", OP_INSPECTNUMASSETGROUPS, "3.11/no-packet", sc(o(OP_INSPECTNUMASSETGROUPS)))
	for _, k := range []int{0, 1, 2, 3, 4, 5, -1} {
		ks := itoa(k)
		ex("group-"+ks, OP_INSPECTASSETGROUPASSETID, "3.11/resolve-asset-id", k)
		ex("group-"+ks, OP_INSPECTASSETGROUPCTRL, "3.11/resolve-asset-id", k)
		ex("group-"+ks, OP_INSPECTASSETGROUPMETADATAHASH, "3.5/metadata-tree-differs", k)
		for src := 0; src <= 3; src++ {
			ex("group-"+ks+"-source-"+itoa(src), OP_INSPECTASSETGROUPNUM, "3.11/pop-orders", k, src)
			ex("group-"+ks+"-source-"+itoa(src), OP_INSPECTASSETGROUPSUM, "3.11/sum-bigint", k, src)
		}
	}
	over := assetWorld("assets-sum-over-uint64", assetPacket(asset.AssetGroup{
		AssetId: assetID("asset-d", 1),
		Inputs:  []asset.AssetInput{local(0, math.MaxUint64), local(1, 1)},
		Outputs: []asset.AssetOutput{out(0, 1)},
	}))
	b.ex("asset/OP_INSPECTASSETGROUPSUM/sum-over-uint64", OP_INSPECTASSETGROUPSUM, "3.11/sum-bigint",
		sc(0, 0, o(OP_INSPECTASSETGROUPSUM)), inW(over), pk())
	for _, j := range []int{0, 1, 2} {
		for src := 0; src <= 2; src++ {
			ex("group-1-item-"+itoa(j)+"-source-"+itoa(src), OP_INSPECTASSETGROUP, "3.11/variable-pushes", 1, j, src)
		}
	}
	ex("group-2-intent-input-pushes-txid", OP_INSPECTASSETGROUP, "3.11/variable-pushes", 2, 0, 0)
	ex("group-4-max-amount", OP_INSPECTASSETGROUP, "3.11/variable-pushes", 4, 0, 0)
	ex("pop-order", OP_INSPECTASSETGROUP, "3.11/pop-orders", 0, 1, 5)
	a := h("asset-a")
	ex("hit", OP_FINDASSETGROUPBYASSETID, "3.11/lookup-flag", a[:], 3)
	ex("miss-collides-with-k0", OP_FINDASSETGROUPBYASSETID, "3.11/lookup-flag", a[:], 4)
	ex("txid-31-bytes", OP_FINDASSETGROUPBYASSETID, "3.11/pop-orders", a[:31], 3)
	ex("gidx-65536", OP_FINDASSETGROUPBYASSETID, "3.11/pop-orders", a[:], 65536)
	ex("reversed-txid-misses", OP_FINDASSETGROUPBYASSETID, "3.11/assetid-internal-order", reversed(a[:]), 3)
	for _, v := range []int{0, 1, 2, 7, -1} {
		ex("vout-"+itoa(v), OP_INSPECTOUTASSETCOUNT, "3.11/count-not-bound-checked", v)
		ex("vin-"+itoa(v), OP_INSPECTINASSETCOUNT, "3.11/count-not-bound-checked", v)
		for _, t := range []int{0, 1, -1} {
			ex("vout-"+itoa(v)+"-t-"+itoa(t), OP_INSPECTOUTASSETAT, "3.11/pop-orders", v, t)
			ex("vin-"+itoa(v)+"-t-"+itoa(t), OP_INSPECTINASSETAT, "3.11/pop-orders", v, t)
		}
	}
	ex("hit", OP_INSPECTOUTASSETLOOKUP, "3.11/lookup-flag", 1, a[:], 3)
	ex("miss-is-zero-amount", OP_INSPECTOUTASSETLOOKUP, "3.11/lookup-flag", 0, a[:], 4)
	ex("hit-zero-amount", OP_INSPECTINASSETLOOKUP, "3.11/lookup-flag", 1, idBytes("asset-c"), 1)
	ex("intent-input-not-local", OP_INSPECTINASSETAT, "3.11/lookup-flag", 0, 1)
	ex("hit", OP_INSPECTINASSETLOOKUP, "3.11/lookup-flag", 0, a[:], 3)
	ex("intent-input-counts-by-vin", OP_INSPECTINASSETLOOKUP, "3.11/lookup-flag", 0, idBytes("asset-b"), 0)
	ex("bad-gidx", OP_INSPECTINASSETLOOKUP, "3.11/pop-orders", 0, a[:], -1)
	// the lookups get their hit's operands: read as an empty packet, a missing one would then miss, not fail
	lookups := map[int][]any{OP_FINDASSETGROUPBYASSETID: {a[:], 3}, OP_INSPECTOUTASSETLOOKUP: {1, a[:], 3},
		OP_INSPECTINASSETLOOKUP: {0, a[:], 3}}
	for _, op := range []int{OP_INSPECTASSETGROUPASSETID, OP_INSPECTASSETGROUPCTRL, OP_FINDASSETGROUPBYASSETID,
		OP_INSPECTASSETGROUPMETADATAHASH, OP_INSPECTASSETGROUPNUM, OP_INSPECTASSETGROUP, OP_INSPECTASSETGROUPSUM,
		OP_INSPECTOUTASSETCOUNT, OP_INSPECTOUTASSETAT, OP_INSPECTOUTASSETLOOKUP, OP_INSPECTINASSETCOUNT,
		OP_INSPECTINASSETAT, OP_INSPECTINASSETLOOKUP} {
		parts, ok := lookups[op]
		if !ok {
			parts = []any{1, 1, 1}
		}
		b.ex("asset/"+slots[op].name+"/no-packet", op, "3.11/no-packet", sc(append(parts, o(op))...))
	}
	b.cov("asset/covenant/reads-packet-from-tx", OP_INSPECTNUMASSETGROUPS, "3.11/resolve-asset-id", sc(o(OP_INSPECTNUMASSETGROUPS), 5, o(OP_NUMEQUAL)), nil, inW(w))
	return b.cases
}

func reversed(b []byte) []byte {
	out := make([]byte, len(b))
	for i := range b {
		out[len(b)-1-i] = b[i]
	}
	return out
}

func idBytes(tag string) []byte {
	x := h(tag)
	return x[:]
}

func packetHand() []*Case {
	b := &book{}
	ap := mainAssetPacket()
	w := assetWorld("packets", ap,
		extension.UnknownPacket{PacketType: 2, Data: []byte{9, 8, 7}},
		extension.UnknownPacket{PacketType: 3, Data: []byte{}},
		extension.UnknownPacket{PacketType: 4, Data: rep(1, 521)})
	for _, t := range []int{0, 2, 3, 4, 5, 255, 256, -1} {
		b.ex("packet/OP_INSPECTPACKET/type-"+itoa(t), OP_INSPECTPACKET, "3.12/inspectpacket", sc(t, o(OP_INSPECTPACKET)), inW(w))
	}
	b.ex("packet/OP_INSPECTPACKET/no-extension", OP_INSPECTPACKET, "3.12/inspectpacket", sc(2, o(OP_INSPECTPACKET)))
	malformed := txWith("malformed-extension", func(tx *wire.MsgTx) {
		tx.AddTxOut(&wire.TxOut{PkScript: []byte{0x6a, 5, 'A', 'R', 'K', 2, 9}})
	})
	b.ex("packet/OP_INSPECTPACKET/malformed-extension-is-error", OP_INSPECTPACKET, "3.12/inspectpacket", sc(2, o(OP_INSPECTPACKET)), inW(malformed))
	zeroPkts := txWith("zero-packet-extension", func(tx *wire.MsgTx) { tx.AddTxOut(&wire.TxOut{PkScript: []byte{0x6a, 3, 'A', 'R', 'K'}}) })
	b.ex("packet/OP_INSPECTPACKET/zero-packet-extension", OP_INSPECTPACKET, "3.12/extension", sc(2, o(OP_INSPECTPACKET)), inW(zeroPkts))
	dupTypes := txWith("duplicate-type-extension", func(tx *wire.MsgTx) {
		tx.AddTxOut(&wire.TxOut{PkScript: []byte{0x6a, 9, 'A', 'R', 'K', 2, 1, 7, 2, 1, 8}})
	})
	b.ex("packet/OP_INSPECTPACKET/duplicate-types", OP_INSPECTPACKET, "3.12/extension", sc(2, o(OP_INSPECTPACKET)), inW(dupTypes))
	firstOnly := txWith("second-extension-ignored", func(tx *wire.MsgTx) {
		tx.AddTxOut(extOut(extension.UnknownPacket{PacketType: 2, Data: []byte{1}}))
		tx.AddTxOut(&wire.TxOut{PkScript: []byte{0x6a, 5, 'A', 'R', 'K', 2, 9}})
	})
	b.ex("packet/OP_INSPECTPACKET/first-extension-only", OP_INSPECTPACKET, "3.12/extension", sc(2, o(OP_INSPECTPACKET)), inW(firstOnly))
	d := defaultWorld()
	arkWithExt := d.prevouts[0].arkTx.Copy()
	arkWithExt.AddTxOut(extOut(extension.UnknownPacket{PacketType: 2, Data: []byte{5, 5}}))
	prevExt := &world{name: "prev-ark-tx-extension", tx: d.tx, prevouts: []prevout{
		{op: d.prevouts[0].op, out: d.prevouts[0].out, arkTx: arkWithExt, vtxo: d.prevouts[0].vtxo}, d.prevouts[1],
	}}
	ip := func(name, hz string, typ, idx any, mods ...mod) {
		b.ex("packet/OP_INSPECTINPUTPACKET/"+name, OP_INSPECTINPUTPACKET, hz, sc(typ, idx, o(OP_INSPECTINPUTPACKET)), mods...)
	}
	ip("found", "3.12/inspectinputpacket", 2, 0, inW(prevExt))
	ip("absent-type", "3.12/inspectinputpacket", 6, 0, inW(prevExt))
	ip("no-extension", "3.12/inspectinputpacket", 2, 0)
	ip("missing-prev-tx-is-error", "2.6/fetcher-nil", 2, 1)
	ip("index-out-of-range", "3.12/inspectinputpacket", 2, 2)
	ip("negative-index", "3.12/inspectinputpacket", 2, -1)
	ip("type-out-of-range", "3.12/inspectinputpacket", 256, 0)
	ip("pop-order-index-first", "3.12/inspectinputpacket", 0, 2, inW(prevExt))
	// emulator packet validation happens in Execute before the script runs
	emu := func(name string, data []byte) {
		w := txWith("emulator-packet-"+name, func(tx *wire.MsgTx) {
			tx.AddTxOut(extOut(extension.UnknownPacket{PacketType: PacketType, Data: data}))
		})
		b.cov("packet/emulator-packet/"+name, "", "3.12/emulator-packet-validation", sc(o(OP_1)), nil, inW(w))
	}
	entry := func(vin uint16, script []byte, wit []byte) []byte {
		return append(append(append([]byte{byte(vin), byte(vin >> 8), byte(len(script))}, script...), byte(len(wit))), wit...)
	}
	emu("valid", append([]byte{1}, entry(0, []byte{OP_1}, nil)...))
	emu("empty", []byte{0})
	emu("empty-script", append([]byte{1}, entry(0, nil, nil)...))
	emu("duplicate-vin", append(append([]byte{2}, entry(0, []byte{OP_1}, nil)...), entry(0, []byte{OP_2}, nil)...))
	emu("vin-out-of-range", append([]byte{1}, entry(2, []byte{OP_1}, nil)...))
	emu("trailing-bytes", append(append([]byte{1}, entry(0, []byte{OP_1}, nil)...), 0))
	emu("count-1001", []byte{0xfd, 0xe9, 0x03})
	emu("witness-not-a-stack", append([]byte{1}, entry(0, []byte{OP_1}, []byte{5, 1})...))
	// the trailing zero witness length makes the entry complete, so only the length cap can refuse it
	emu("script-length-10001", append(append([]byte{1, 0, 0, 0xfd, 0x11, 0x27}, rep(OP_NOP, 10001)...), 0))
	b.cov("packet/extension/malformed-refused-by-execute", "", "3.8/output-masking", sc(o(OP_1)), nil, inW(malformed))
	return b.cases
}

func tunnelHand() []*Case {
	b := &book{}
	d := defaultWorld()
	keep := txWith("tunnel-keeps", func(tx *wire.MsgTx) {
		tx.TxOut[0] = &wire.TxOut{Value: 5000, PkScript: d.prevouts[0].vtxo}
		tx.TxOut[1] = &wire.TxOut{Value: 3000, PkScript: d.prevouts[1].out.PkScript}
	})
	tn := func(name, hz string, parts []any, mods ...mod) {
		b.ex("tunnel/"+name, OP_TUNNEL, hz, sc(append(parts, o(OP_TUNNEL))...), mods...)
	}
	tn("script-and-value", "3.12/tunnel", []any{0, 3, 0}, inW(keep))
	tn("value-mismatch", "3.12/tunnel", []any{0, 2, 0})
	tn("script-mismatch", "3.12/tunnel", []any{0, 1, 0})
	tn("vtxo-miss-falls-back-to-prevout", "2.6/fetcher-nil", []any{1, 1, 0}, inW(keep), at(1, 3000))
	tn("flags-zero", "3.12/tunnel", []any{0, 0, 0}, inW(keep))
	tn("flags-eight", "3.12/tunnel", []any{0, 8, 0}, inW(keep))
	tn("assets-without-packet-is-empty", "3.12/tunnel", []any{0, 4, 0}, inW(keep))
	tn("output-index-out-of-range", "3.12/tunnel", []any{5, 1, 0}, inW(keep))
	a := h("tunnel-asset")
	tn("exception-needs-asset-flag", "3.12/tunnel", []any{0, 1, a[:], 0, 1}, inW(keep))
	tn("exception-count-guard", "3.12/tunnel", []any{0, 4, 5}, inW(keep))
	tn("negative-exception-count", "3.12/tunnel", []any{0, 4, -1}, inW(keep))
	pkt := func(name string, ins []asset.AssetInput, outs []asset.AssetOutput) *world {
		p := assetPacket(asset.AssetGroup{AssetId: &asset.AssetId{Txid: a, Index: 1}, Inputs: ins, Outputs: outs})
		return txWith("tunnel-"+name, func(tx *wire.MsgTx) {
			tx.TxOut[0] = &wire.TxOut{Value: 5000, PkScript: d.prevouts[0].vtxo}
			tx.AddTxOut(extOut(p))
		})
	}
	balanced := pkt("balanced", []asset.AssetInput{local(0, 50)}, []asset.AssetOutput{out(0, 50)})
	tn("assets-preserved", "3.12/tunnel", []any{0, 4, 0}, inW(balanced), pk())
	drained := pkt("drained", []asset.AssetInput{local(0, 50)}, nil)
	tn("assets-exception", "3.12/tunnel", []any{0, 4, a[:], 1, 1}, inW(drained), pk())
	tn("assets-drained", "3.12/tunnel", []any{0, 4, 0}, inW(drained), pk())
	tn("present-zero-vs-absent", "3.12/tunnel", []any{0, 4, 0}, inW(pkt("zero", []asset.AssetInput{local(0, 0)}, nil)), pk())
	tn("all-flags", "3.12/tunnel", []any{0, 7, 0}, inW(balanced), pk())
	return b.cases
}

func intentHand() []*Case {
	b := &book{}
	doc := `{"type":"register","amount":2000,"obj":{ "a" : [1,2] },"t":true,"f":false,"n":null,"s":"x\u0041",` +
		`"e":1e2,"one":1.0,"frac":1.5,"neg0":-0,"huge":1e1300,"big":123456789012345678901234567890,` +
		`"arr":[{"k":"v"}],"0":"zero","_u":"under","long":"` + strings.Repeat("y", 521) + `"}`
	q := func(name, hz, message, path string, mods ...mod) {
		c := b.ex("intent/"+name, OP_INSPECTINTENTMESSAGE, hz, sc([]byte(path), o(OP_INSPECTINTENTMESSAGE)), append([]mod{msg(message)}, mods...)...)
		c.PortUnsupported = intentUnsupported(c.IntentMessage, []byte(path))
	}
	for _, p := range []string{"type", "amount", "obj", "obj.a", "obj.a.1", "obj.a.2", "t", "f", "n", "missing", "s", "e",
		"one", "frac", "neg0", "big", "arr.0.k", "_u", "0", "arr.00", "Type", "a-b", "", "obj..a", "obj.*", "huge", "long"} {
		name := p
		if name == "" {
			name = "empty-path"
		}
		q("path-"+name, "3.12/intent", doc, p)
	}
	q("no-message-invalid-path-is-miss", "3.12/intent", "", "", func(c *Case) { c.IntentMessage = nil })
	q("empty-message-invalid-path", "3.12/intent", "", "")
	q("empty-message-valid-path", "3.12/intent", "", "a")
	q("top-level-array", "3.12/intent", `[10,20]`, "1")
	q("duplicate-key-first-wins", "3.12/intent", `{"a":1,"a":2}`, "a")
	q("duplicate-key-nested", "3.12/intent", `{"o":{"b":1,"b":2}}`, "o.b")
	q("duplicate-key-after-huge-number", "3.12/intent", `{"large":1e1300,"a":1,"a":2}`, "a")
	q("malformed-json-tolerated", "3.12/intent", `{"a":1,`, "a")
	q("trailing-garbage", "3.12/intent", `{"a":1}x`, "a")
	q("escaped-key", "3.12/intent", `{"\u0061":5}`, "a")
	q("top-level-string-with-bracket", "3.12/intent", `"[1]"`, "0")
	q("top-level-string-plain", "3.12/intent", `"abc"`, "0")
	q("size-at-1mib", "3.12/intent", strings.Repeat("a", 1<<20), "a")
	q("size-over-1mib", "3.12/intent", strings.Repeat("a", 1<<20+1), "a")
	b.cov("intent/covenant/bound-message", OP_INSPECTINTENTMESSAGE, "3.12/intent", sc([]byte("type"), o(OP_INSPECTINTENTMESSAGE, OP_VERIFY), []byte("register"), o(OP_EQUAL)), nil, msg(doc))
	many := sc()
	for range 17 {
		many = append(many, sc([]byte("t"), o(OP_INSPECTINTENTMESSAGE, OP_2DROP))...)
	}
	b.cov("intent/covenant/compute-limit-16", OP_INSPECTINTENTMESSAGE, "2.9/charge", append(many, OP_1), nil, msg(doc))
	return b.cases
}

// intentUnsupported is T5's refusal rule: Go checks size and path before parsing,
// so only a valid lookup into non-strict JSON or duplicate keys is refused.
func intentUnsupported(message *string, path []byte) bool {
	if message == nil || len(*message) > 1<<20 || !simplePath(string(path)) {
		return false
	}
	if !json.Valid([]byte(*message)) || hasDuplicateKey(*message) {
		return true
	}
	// gjson scans a top-level string for the first bracket (gjson.go:2219-2229) and answers from there
	top := strings.TrimLeft(*message, " \t\n\r")
	return strings.HasPrefix(top, `"`) && strings.ContainsAny(*message, "[{")
}

func simplePath(path string) bool {
	for _, seg := range strings.Split(path, ".") {
		if seg == "" {
			return false
		}
		if seg[0] >= '0' && seg[0] <= '9' {
			n, err := strconv.ParseUint(seg, 10, 64)
			if err != nil || (len(seg) > 1 && seg[0] == '0') || n >= 1<<20 {
				return false
			}
			continue
		}
		for i, c := range []byte(seg) {
			lower, digit := c >= 'a' && c <= 'z', c >= '0' && c <= '9'
			if !(lower || c == '_' || (i > 0 && digit)) {
				return false
			}
		}
	}
	return true
}

func hasDuplicateKey(message string) bool {
	dec := json.NewDecoder(strings.NewReader(message))
	// a number float64 cannot hold (1e1300) would otherwise end the scan before a later duplicate
	dec.UseNumber()
	type frame struct {
		object  bool
		keys    map[string]bool
		wantKey bool
	}
	var stack []*frame
	for {
		tok, err := dec.Token()
		if err != nil {
			return false
		}
		top := (*frame)(nil)
		if len(stack) > 0 {
			top = stack[len(stack)-1]
		}
		switch t := tok.(type) {
		case json.Delim:
			switch t {
			case '{':
				if top != nil && top.object {
					top.wantKey = true
				}
				stack = append(stack, &frame{object: true, keys: map[string]bool{}, wantKey: true})
			case '[':
				if top != nil && top.object {
					top.wantKey = true
				}
				stack = append(stack, &frame{})
			default:
				stack = stack[:len(stack)-1]
			}
		default:
			if top != nil && top.object {
				if top.wantKey {
					k := t.(string)
					if top.keys[k] {
						return true
					}
					top.keys[k], top.wantKey = true, false
				} else {
					top.wantKey = true
				}
			}
		}
	}
}
