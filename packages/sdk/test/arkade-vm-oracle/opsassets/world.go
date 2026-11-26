package opsassets

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type prevout struct {
	op    wire.OutPoint
	out   *wire.TxOut
	arkTx *wire.MsgTx
	vtxo  []byte
}

type world struct {
	name     string
	recipe   string
	tx       *wire.MsgTx
	prevouts []prevout
}

type fetcher map[wire.OutPoint]prevout

func (f fetcher) FetchPrevOutput(op wire.OutPoint) *wire.TxOut     { return f[op].out }
func (f fetcher) FetchPrevOutArkTx(op wire.OutPoint) *wire.MsgTx   { return f[op].arkTx }
func (f fetcher) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte { return f[op].vtxo }

func (w *world) fetcher() fetcher {
	f := fetcher{}
	for _, p := range w.prevouts {
		f[p.op] = p
	}
	return f
}

func h(tag string) chainhash.Hash { return sha256.Sum256([]byte(tag)) }

func op(tag string, i uint32) wire.OutPoint { return wire.OutPoint{Hash: h(tag), Index: i} }

func p2trish(b byte) []byte { return append([]byte{0x51, 0x20}, bytes.Repeat([]byte{b}, 32)...) }

var in0, in1 = op("t5-in0", 0), op("t5-in1", 3)

func baseTx() *wire.MsgTx {
	tx := wire.NewMsgTx(3)
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: in0, Sequence: wire.MaxTxInSequenceNum})
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: in1, Sequence: wire.MaxTxInSequenceNum})
	tx.AddTxOut(&wire.TxOut{Value: 5000, PkScript: p2trish(1)})
	tx.AddTxOut(&wire.TxOut{Value: 3000, PkScript: p2trish(2)})
	tx.AddTxOut(&wire.TxOut{Value: 5000, PkScript: p2trish(9)})
	return tx
}

func arkTx(extra ...*wire.TxOut) *wire.MsgTx {
	tx := wire.NewMsgTx(3)
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: op("t5-ark-parent", 0), Sequence: wire.MaxTxInSequenceNum})
	tx.AddTxOut(&wire.TxOut{Value: 5000, PkScript: p2trish(1)})
	for _, o := range extra {
		tx.AddTxOut(o)
	}
	return tx
}

// in0's vtxo script differs from its prevout script; in1 has no vtxo script at all.
func basePrevouts(ark *wire.MsgTx) []prevout {
	return []prevout{
		{op: in0, out: &wire.TxOut{Value: 5000, PkScript: p2trish(9)}, arkTx: ark, vtxo: p2trish(1)},
		{op: in1, out: &wire.TxOut{Value: 3000, PkScript: p2trish(2)}},
	}
}

var worlds []*world

func addWorld(name string, extra ...*wire.TxOut) *world {
	tx := baseTx()
	for _, o := range extra {
		tx.AddTxOut(o)
	}
	w := &world{name: name, tx: tx, prevouts: basePrevouts(arkTx())}
	worlds = append(worlds, w)
	return w
}

func extOut(pkts ...extension.Packet) *wire.TxOut {
	out, err := extension.Extension(pkts).TxOut()
	if err != nil {
		panic(err)
	}
	return out
}

func raw(pt uint8, data []byte) extension.Packet {
	return extension.UnknownPacket{PacketType: pt, Data: data}
}

func scriptOut(s string) *wire.TxOut {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return &wire.TxOut{PkScript: b}
}

func mustPacket(groups ...asset.AssetGroup) asset.Packet {
	p, err := asset.NewPacket(groups)
	if err != nil {
		panic(err)
	}
	return p
}

func id(tag string, idx uint16) *asset.AssetId { return &asset.AssetId{Txid: h(tag), Index: idx} }

func local(vin uint16, amt uint64) asset.AssetInput {
	return asset.AssetInput{Type: asset.AssetInputTypeLocal, Vin: vin, Amount: amt}
}

func intent(tag string, vin uint16, amt uint64) asset.AssetInput {
	return asset.AssetInput{Type: asset.AssetInputTypeIntent, Txid: h(tag), Vin: vin, Amount: amt}
}

func out(vout uint16, amt uint64) asset.AssetOutput {
	return asset.AssetOutput{Type: asset.AssetOutputTypeLocal, Vout: vout, Amount: amt}
}

func md(k, v string) asset.Metadata { return asset.Metadata{Key: []byte(k), Value: []byte(v)} }

func le16(v int) []byte { return binary.LittleEndian.AppendUint16(nil, uint16(v)) }

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

func emuEntry(vin int, script, witness []byte) []byte {
	var b bytes.Buffer
	b.Write(le16(vin))
	wire.WriteVarBytes(&b, 0, script)
	wire.WriteVarBytes(&b, 0, witness)
	return b.Bytes()
}

func witnessBlob(items ...[]byte) []byte {
	var b bytes.Buffer
	wire.WriteVarInt(&b, 0, uint64(len(items)))
	for _, it := range items {
		wire.WriteVarBytes(&b, 0, it)
	}
	return b.Bytes()
}
