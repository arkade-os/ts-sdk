package opsassets

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type obj = map[string]any

// big keeps the pinned expectations small: anything over 64 bytes is pinned by its sha256.
func big(b []byte) string {
	if len(b) > 64 {
		d := sha256.Sum256(b)
		return "sha256:" + hex.EncodeToString(d[:])
	}
	return hex.EncodeToString(b)
}

var leaf, _ = hex.DecodeString("2079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac")

func txBytes(tx *wire.MsgTx) []byte {
	var b bytes.Buffer
	if err := tx.Serialize(&b); err != nil {
		panic(err)
	}
	return b.Bytes()
}

func classify(err error) obj {
	var se txscript.Error
	if errors.As(err, &se) {
		return obj{"code": se.ErrorCode.String()}
	}
	msg := err.Error()
	for prefix, kind := range map[string]string{
		"failed to execute arkade script: failed to parse extension": "ErrExtensionParse",
		"failed to parse extension":                                  "ErrExtensionParse",
		"failed to parse emulator packet":                            "ErrEmulatorPacketParse",
		"no prevout found for input":                                 "ErrNoPrevout",
	} {
		if strings.HasPrefix(msg, prefix) {
			return obj{"kind": kind}
		}
	}
	panic("unclassified: " + msg)
}

func runCase(c *tcase) obj {
	if c.mode == "covenant" {
		ptx, err := psbt.NewFromUnsignedTx(c.w.tx)
		if err != nil {
			panic(err)
		}
		ptx.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
			ControlBlock: make([]byte, 33), Script: leaf, LeafVersion: txscript.BaseLeafVersion,
		}}
		s, err := arkade.NewArkadeScript(ptx, arkade.EmulatorEntry{Vin: 0, Script: c.script})
		if err != nil {
			panic(err)
		}
		if err := s.Execute(c.w.tx, c.w.fetcher(), 0); err != nil {
			return classify(err)
		}
		return obj{"ok": true}
	}
	f := c.w.fetcher()
	var amount int64
	if p := f.FetchPrevOutput(c.w.tx.TxIn[c.input].PreviousOutPoint); p != nil {
		amount = p.Value
	}
	vm, err := arkade.NewEngine(c.script, c.w.tx, c.input, nil, nil, amount, f)
	if err != nil {
		panic(err)
	}
	if c.inject != nil {
		ext, err := extension.NewExtensionFromTx(c.inject.tx)
		if err != nil {
			panic(err)
		}
		if ap := ext.GetAssetPacket(); ap != nil {
			vm.SetAssetPacket(ap)
		}
		ep, err := arkade.FindEmulatorPacket(c.inject.tx)
		if err != nil {
			panic(err)
		}
		if ep != nil {
			vm.SetEmulatorPacket(ep)
		}
	}
	if c.message != nil {
		arkade.WithIntentMessage(*c.message)(vm)
	}
	for done := false; !done; {
		if done, err = vm.Step(); err != nil {
			return classify(err)
		}
	}
	stack := []string{}
	for _, it := range vm.GetStack() {
		stack = append(stack, big(it))
	}
	return obj{"stack": stack}
}

func groupJSON(g asset.AssetGroup) obj {
	idj := func(a asset.AssetId) obj { return obj{"txid": hex.EncodeToString(a.Txid[:]), "index": a.Index} }
	o := obj{"id": nil, "ctrl": nil}
	if g.AssetId != nil {
		o["id"] = idj(*g.AssetId)
	}
	if g.ControlAsset != nil {
		o["ctrl"] = obj{"type": g.ControlAsset.Type, "id": idj(g.ControlAsset.AssetId), "group": g.ControlAsset.GroupIndex}
	}
	ins := []obj{}
	for _, in := range g.Inputs {
		ins = append(ins, obj{"type": in.Type, "vin": in.Vin, "txid": hex.EncodeToString(in.Txid[:]), "amount": strconv.FormatUint(in.Amount, 10)})
	}
	outs := []obj{}
	for _, o := range g.Outputs {
		outs = append(outs, obj{"type": o.Type, "vout": o.Vout, "amount": strconv.FormatUint(o.Amount, 10)})
	}
	mds := []string{}
	for _, m := range g.Metadata {
		b, _ := m.Serialize()
		mds = append(mds, hex.EncodeToString(b))
	}
	o["inputs"], o["outputs"], o["metadata"] = ins, outs, mds
	return o
}

func extSummary(tx *wire.MsgTx) any {
	ext, err := extension.NewExtensionFromTx(tx)
	if errors.Is(err, extension.ErrExtensionNotFound) {
		return nil
	}
	if err != nil {
		return "error"
	}
	pkts := []obj{}
	for _, p := range ext {
		b, err := p.Serialize()
		if err != nil {
			panic(err)
		}
		pkts = append(pkts, obj{"type": p.Type(), "data": big(b)})
	}
	var assets any
	if ap := ext.GetAssetPacket(); ap != nil {
		if len(ap) > 8 {
			assets = obj{"groups": len(ap)}
		} else {
			gs := []obj{}
			for _, g := range ap {
				gs = append(gs, groupJSON(g))
			}
			assets = gs
		}
	}
	return obj{"packets": pkts, "assets": assets}
}

func emuSummary(tx *wire.MsgTx) any {
	p, err := arkade.FindEmulatorPacket(tx)
	if err != nil {
		return "error"
	}
	if p == nil {
		return nil
	}
	out := []obj{}
	for _, e := range p {
		var w bytes.Buffer
		if err := psbt.WriteTxWitness(&w, e.Witness); err != nil {
			panic(err)
		}
		out = append(out, obj{"vin": e.Vin, "script": big(e.Script), "witness": big(w.Bytes())})
	}
	return out
}

// maskReplica is sigvalidate.go maskExtensionOutput built from the exported pieces; the only
// private piece, serializeEmulatorPacketMasked, is five lines and checked by maskCheck.
func maskReplica(tx *wire.MsgTx) (*wire.TxOut, int) {
	for i, o := range tx.TxOut {
		if !extension.IsExtension(o.PkScript) {
			continue
		}
		ext, err := extension.NewExtensionFromBytes(o.PkScript)
		if err != nil {
			return nil, -1
		}
		for j, pkt := range ext {
			if pkt.Type() != arkade.PacketType {
				continue
			}
			u, ok := pkt.(extension.UnknownPacket)
			if !ok {
				return nil, -1
			}
			ip, err := arkade.DeserializeEmulatorPacket(u.Data)
			if err != nil {
				return nil, -1
			}
			var b bytes.Buffer
			wire.WriteVarInt(&b, 0, uint64(len(ip)))
			for _, e := range ip {
				binary.Write(&b, binary.LittleEndian, e.Vin)
				wire.WriteVarBytes(&b, 0, e.Script)
				wire.WriteVarInt(&b, 0, 0)
			}
			ext[j] = extension.UnknownPacket{PacketType: arkade.PacketType, Data: b.Bytes()}
			s, err := ext.Serialize()
			if err != nil {
				panic(err)
			}
			return &wire.TxOut{Value: o.Value, PkScript: s}, i
		}
		return nil, -1
	}
	return nil, -1
}

func digest(tx *wire.MsgTx, f fetcher) []byte {
	d, err := arkade.CalcArkadeScriptSignatureHash(txscript.NewTxSigHashes(tx, f), txscript.SigHashDefault,
		tx, 0, f, txscript.NewBaseTapLeaf(leaf))
	if err != nil {
		panic(err)
	}
	return d
}

// maskCheck proves the replica against the real engine through the sighash: a masked output
// substituted back changes nothing, and an output Go fails open on is hashed raw.
func maskCheck(w *world, m *wire.TxOut, idx int) string {
	f := w.fetcher()
	d0 := digest(w.tx, f)
	k := -1
	for i, o := range w.tx.TxOut {
		if extension.IsExtension(o.PkScript) {
			k = i
			break
		}
	}
	if k < 0 {
		return "no-extension"
	}
	junk := w.tx.Copy()
	junk.TxOut[k] = &wire.TxOut{Value: w.tx.TxOut[k].Value, PkScript: append(bytes.Clone(w.tx.TxOut[k].PkScript), 0x61)}
	dj := digest(junk, f)
	if m == nil {
		if bytes.Equal(d0, dj) {
			panic(w.name + ": replica failed open but the engine masked")
		}
		return "fail-open-raw"
	}
	// digest(sub) masks m again, so it only proves m once m is itself witness-free
	ext, err := extension.NewExtensionFromBytes(m.PkScript)
	if err != nil {
		panic(w.name + ": replica mask does not parse: " + err.Error())
	}
	for _, p := range ext {
		u, ok := p.(extension.UnknownPacket)
		if !ok || p.Type() != arkade.PacketType {
			continue
		}
		ip, err := arkade.DeserializeEmulatorPacket(u.Data)
		if err != nil {
			panic(w.name + ": replica emulator packet does not parse: " + err.Error())
		}
		for _, e := range ip {
			if len(e.Witness) > 0 {
				panic(w.name + ": replica kept a witness")
			}
		}
	}
	sub := w.tx.Copy()
	sub.TxOut[idx] = m
	if !bytes.Equal(d0, digest(sub, f)) || !bytes.Equal(d0, dj) {
		panic(w.name + ": replica mask differs from the engine")
	}
	return "masked-equal"
}

// Generate writes the worlds, the codec answers and the cases as one JSON document.
func Generate(w io.Writer) {
	build()
	ws := []obj{}
	codec := []obj{}
	for _, w := range worlds {
		wo := obj{"name": w.name, "txid": hex.EncodeToString(hashOf(w))}
		if w.recipe == "" {
			extra := [][]string{}
			for _, o := range w.tx.TxOut[3:] {
				extra = append(extra, []string{strconv.FormatInt(o.Value, 10), hex.EncodeToString(o.PkScript)})
			}
			wo["outputs"] = extra
		} else {
			wo["recipe"] = w.recipe
		}
		if ark := txBytes(w.prevouts[0].arkTx); !bytes.Equal(ark, txBytes(arkTx())) {
			wo["ark_tx"] = hex.EncodeToString(ark)
		}
		if len(w.prevouts) < 2 {
			wo["orphan"] = true
		}
		ws = append(ws, wo)
		if w.name == "orphan" {
			continue
		}
		m, idx := maskReplica(w.tx)
		var mask any
		if m != nil {
			mask = obj{"index": idx, "value": strconv.FormatInt(m.Value, 10), "script": big(m.PkScript)}
		}
		codec = append(codec, obj{"world": w.name, "ext": extSummary(w.tx), "emu": emuSummary(w.tx),
			"mask": mask, "mask_check": maskCheck(w, m, idx)})
	}
	cs := []obj{}
	for _, c := range cases {
		co := obj{"name": c.name, "mode": c.mode, "world": c.w.name, "input": c.input, "script": hex.EncodeToString(c.script)}
		if c.inject != nil {
			co["packets"] = c.inject.name
		}
		if c.message != nil {
			if n := strings.Count(c.template, "["); n > 0 && c.template == strings.Repeat("[", n)+strings.Repeat("]", n) {
				co["message_nesting"] = n
			} else {
				co["message"] = c.template
			}
		}
		co["go"] = runCase(c)
		if c.unsupported {
			co["unsupported"] = true
		}
		cs = append(cs, co)
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	out := obj{"worlds": ws, "codec": codec, "cases": cs, "base_tx": hex.EncodeToString(txBytes(baseTx())), "ark_tx": hex.EncodeToString(txBytes(arkTx()))}
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
