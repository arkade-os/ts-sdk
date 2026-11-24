package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/big"
	"slices"

	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

// raw is appended verbatim, for non-minimal or malformed encodings.
type raw []byte

// sc assembles a script: a byte is an opcode, []byte is pushed exactly (never
// AddData, which turns [0x00] into OP_0), ints and *big.Int as minimal numbers.
func sc(parts ...any) []byte {
	var out []byte
	for _, p := range parts {
		switch t := p.(type) {
		case byte:
			out = append(out, t)
		case raw:
			out = append(out, t...)
		case []byte:
			out = append(out, push(t)...)
		case int:
			out = append(out, push(num(big.NewInt(int64(t))))...)
		case int64:
			out = append(out, push(num(big.NewInt(t)))...)
		case *big.Int:
			out = append(out, push(num(t))...)
		case [][]byte:
			for _, d := range t {
				out = append(out, push(d)...)
			}
		default:
			panic(fmt.Sprintf("sc: unsupported %T", p))
		}
	}
	return out
}

func push(d []byte) []byte {
	n := len(d)
	switch {
	case n == 0:
		return []byte{txscript.OP_0}
	case n == 1 && d[0] >= 1 && d[0] <= 16:
		return []byte{txscript.OP_1 + d[0] - 1}
	case n == 1 && d[0] == 0x81:
		return []byte{txscript.OP_1NEGATE}
	case n <= 75:
		return append([]byte{byte(n)}, d...)
	case n <= 255:
		return append([]byte{txscript.OP_PUSHDATA1, byte(n)}, d...)
	case n <= 65535:
		return append(binary.LittleEndian.AppendUint16([]byte{txscript.OP_PUSHDATA2}, uint16(n)), d...)
	}
	return append(binary.LittleEndian.AppendUint32([]byte{txscript.OP_PUSHDATA4}, uint32(n)), d...)
}

// num is the minimal sign-magnitude little-endian encoding.
func num(v *big.Int) []byte {
	if v.Sign() == 0 {
		return []byte{}
	}
	le := new(big.Int).Abs(v).Bytes()
	slices.Reverse(le)
	if le[len(le)-1]&0x80 != 0 {
		le = append(le, 0)
	}
	if v.Sign() < 0 {
		le[len(le)-1] |= 0x80
	}
	return le
}

func n64(v int64) []byte { return num(big.NewInt(v)) }

func pow2(k uint) *big.Int { return new(big.Int).Lsh(big.NewInt(1), k) }

func bi(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 0)
	if !ok {
		panic("bad big int " + s)
	}
	return v
}

func rep(b byte, n int) []byte { return bytes.Repeat([]byte{b}, n) }

func h(tag string) chainhash.Hash { return sha256.Sum256([]byte(tag)) }

func p2tr(key byte) []byte { return append([]byte{txscript.OP_1, 32}, xonly(keyN(key))...) }

func ops(o ...byte) raw { return raw(o) }

// fill leaves n one-byte elements on the stack in few script bytes.
func fill(n int) raw {
	out := raw{txscript.OP_1}
	for have := 1; have < n; {
		switch {
		case have >= 3 && n-have >= 3:
			out = append(out, txscript.OP_3DUP)
			have += 3
		default:
			out = append(out, txscript.OP_DUP)
			have++
		}
	}
	return out
}

func outpoint(tag string, idx uint32) wire.OutPoint { return wire.OutPoint{Hash: h(tag), Index: idx} }

var worldDefault *world

// defaultWorld: two inputs with different fetcher coverage, so introspection
// cases can hit both the found and the missing branch of every fetch.
func defaultWorld() *world {
	if worldDefault != nil {
		return worldDefault
	}
	in0, in1 := outpoint("in0", 1), outpoint("in1", 7)
	tx := wire.NewMsgTx(2)
	tx.LockTime = 600000
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: in0, Sequence: 0xfffffffe})
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: in1, Sequence: 10})
	tx.AddTxOut(&wire.TxOut{Value: 7000, PkScript: p2tr(2)})
	tx.AddTxOut(&wire.TxOut{Value: 0, PkScript: append([]byte{txscript.OP_0, 20}, rep(0x22, 20)...)})
	ark := wire.NewMsgTx(3)
	ark.AddTxIn(&wire.TxIn{PreviousOutPoint: outpoint("ark-parent", 0), Sequence: wire.MaxTxInSequenceNum})
	ark.AddTxOut(&wire.TxOut{Value: 4000, PkScript: p2tr(5)})
	ark.AddTxOut(&wire.TxOut{Value: 5000, PkScript: p2tr(4)})
	legacy := []byte{txscript.OP_DUP, txscript.OP_HASH160, 20}
	legacy = append(append(legacy, rep(0x33, 20)...), txscript.OP_EQUALVERIFY, txscript.OP_CHECKSIG)
	worldDefault = &world{name: "default", tx: tx, prevouts: []prevout{
		{op: in0, out: &wire.TxOut{Value: 5000, PkScript: p2tr(3)}, arkTx: ark, vtxo: p2tr(4)},
		{op: in1, out: &wire.TxOut{Value: 3000, PkScript: legacy}},
	}}
	return worldDefault
}
