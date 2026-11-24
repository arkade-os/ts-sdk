package emulate

import (
	"bytes"
	"encoding/hex"
	"slices"

	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

// Verbatim from executor af8d9eb pkg/template/internal/version/v1/draft.go (internal, so copied),
// with model.Source reduced to the three fields the fetcher reads.
type Source struct {
	Outpoint wire.OutPoint
	Amount   uint64
	Tx       *wire.MsgTx
}

type draft struct {
	tx      *wire.MsgTx
	sources []*Source
	bound   []bool
}

func (d *draft) FetchPrevOutput(op wire.OutPoint) *wire.TxOut {
	s, ok := d.source(op)
	if !ok {
		return nil
	}
	if s == nil {
		if len(d.sources) < 2 || !d.bound[1] {
			return nil
		}
		return &wire.TxOut{PkScript: pkScript(d.sources[1])}
	}
	return &wire.TxOut{Value: int64(s.Amount), PkScript: pkScript(s)}
}

func (d *draft) FetchPrevOutArkTx(op wire.OutPoint) *wire.MsgTx {
	if s, ok := d.source(op); ok && s != nil {
		return s.Tx
	}
	return nil
}

func (d *draft) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte {
	if out := d.FetchPrevOutput(op); out != nil {
		return out.PkScript
	}
	return nil
}

func (d *draft) source(op wire.OutPoint) (*Source, bool) {
	i := slices.IndexFunc(d.tx.TxIn, func(in *wire.TxIn) bool { return in.PreviousOutPoint == op })
	if i < 0 || !d.bound[i] {
		return nil, false
	}
	return d.sources[i], true
}

func newDraft(proof bool, sources []*Source) *draft {
	d := &draft{tx: wire.NewMsgTx(3)}
	if proof {
		d.tx.AddTxIn(&wire.TxIn{Sequence: wire.MaxTxInSequenceNum})
		d.sources = append(d.sources, nil)
		d.bound = append(d.bound, true)
	}
	for _, s := range sources {
		d.tx.AddTxIn(&wire.TxIn{PreviousOutPoint: s.Outpoint, Sequence: wire.MaxTxInSequenceNum})
		d.sources = append(d.sources, s)
		d.bound = append(d.bound, isBound(s))
	}
	return d
}

func isBound(s *Source) bool {
	if s.Tx == nil {
		return true
	}
	i := int(s.Outpoint.Index)
	return uint64(s.Outpoint.Index) < uint64(len(s.Tx.TxOut)) && s.Tx.TxHash() == s.Outpoint.Hash &&
		s.Tx.TxOut[i].Value == int64(s.Amount)
}

func pkScript(s *Source) []byte {
	if s.Tx == nil {
		return nil
	}
	return s.Tx.TxOut[s.Outpoint.Index].PkScript
}

type draftQuery struct {
	Outpoint   string `json:"outpoint"`
	Value      *int64 `json:"value"`
	Script     string `json:"script"`
	ArkTx      string `json:"arkTx"`
	VtxoScript string `json:"vtxoScript"`
}

type draftCase struct {
	Name    string       `json:"name"`
	PrevTx  string       `json:"prevTx"`
	Queries []draftQuery `json:"queries"`
}

func orNil(b []byte) string {
	if b == nil {
		return "nil"
	}
	return hex.EncodeToString(b)
}

func draftCases() []draftCase {
	prev := wire.NewMsgTx(2)
	prev.AddTxIn(&wire.TxIn{Sequence: wire.MaxTxInSequenceNum})
	prev.AddTxOut(&wire.TxOut{Value: 1000, PkScript: append([]byte{0x51, 0x20}, bytes.Repeat([]byte{0xaa}, 32)...)})
	prev.AddTxOut(&wire.TxOut{Value: 2000, PkScript: append([]byte{0x00, 0x14}, bytes.Repeat([]byte{0xbb}, 20)...)})
	var raw bytes.Buffer
	must(prev.Serialize(&raw))
	h := prev.TxHash()
	op := func(hash chainhash.Hash, i uint32) wire.OutPoint { return wire.OutPoint{Hash: hash, Index: i} }
	var x, unknown chainhash.Hash
	copy(x[:], bytes.Repeat([]byte{0x07}, 32))
	copy(unknown[:], bytes.Repeat([]byte{0x09}, 32))
	bound := &Source{Outpoint: op(h, 0), Amount: 1000, Tx: prev}
	wrongAmount := &Source{Outpoint: op(h, 1), Amount: 999, Tx: prev}
	noTx := &Source{Outpoint: op(x, 7), Amount: 5}
	queries := []wire.OutPoint{{}, op(h, 0), op(h, 1), op(x, 7), op(unknown, 9)}
	run := func(name string, d *draft) draftCase {
		c := draftCase{Name: name, PrevTx: hex.EncodeToString(raw.Bytes())}
		for _, q := range queries {
			r := draftQuery{Outpoint: q.String(), Script: "nil", ArkTx: "nil"}
			if out := d.FetchPrevOutput(q); out != nil {
				v := out.Value
				r.Value, r.Script = &v, orNil(out.PkScript)
			}
			if tx := d.FetchPrevOutArkTx(q); tx != nil {
				r.ArkTx = tx.TxID()
			}
			r.VtxoScript = orNil(d.FetchVtxoPrevOutPkScript(q))
			c.Queries = append(c.Queries, r)
		}
		return c
	}
	return []draftCase{
		run("proof", newDraft(true, []*Source{bound, wrongAmount, noTx})),
		run("proof whose first source is unbound", newDraft(true, []*Source{wrongAmount, bound})),
		run("virtual", newDraft(false, []*Source{noTx, bound})),
	}
}
