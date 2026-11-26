// Package opsig runs the pkg/arkade engine and writes one JSON line per world and per case,
// read by packages/sdk/test/arkade-vm-ops-sig.test.ts.
package opsig

import (
	"bytes"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"slices"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	A "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	becdsa "github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	gnarkbn254 "github.com/consensys/gnark-crypto/ecc/bn254"
	gnarkbn254fp "github.com/consensys/gnark-crypto/ecc/bn254/fp"
	gnarksecpfp "github.com/consensys/gnark-crypto/ecc/secp256k1/fp"
	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
)

// ---------- script helpers

type raw []byte

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
	}
	return append(binary.LittleEndian.AppendUint16([]byte{txscript.OP_PUSHDATA2}, uint16(n)), d...)
}

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
			out = append(out, push(n64(int64(t)))...)
		case int64:
			out = append(out, push(n64(t))...)
		case *big.Int:
			out = append(out, push(num(t))...)
		default:
			panic(fmt.Sprintf("sc: %T", p))
		}
	}
	return out
}

func rep(b byte, n int) []byte     { return bytes.Repeat([]byte{b}, n) }
func hh(tag string) chainhash.Hash { return sha256.Sum256([]byte(tag)) }
func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}
func bi(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 0)
	if !ok {
		panic(s)
	}
	return v
}
func pow2(k uint) *big.Int    { return new(big.Int).Lsh(big.NewInt(1), k) }
func be32(v *big.Int) []byte  { return v.FillBytes(make([]byte, 32)) }
func cat(bs ...[]byte) []byte { return bytes.Join(bs, nil) }

func keyN(n byte) *btcec.PrivateKey {
	k, _ := btcec.PrivKeyFromBytes(rep(n, 32))
	return k
}
func xonly(k *btcec.PrivateKey) []byte { return k.PubKey().SerializeCompressed()[1:] }
func p2tr(key byte) []byte             { return append([]byte{txscript.OP_1, 32}, xonly(keyN(key))...) }

// ---------- worlds

type prevout struct {
	op   wire.OutPoint
	out  *wire.TxOut
	vtxo []byte
}

type world struct {
	name  string
	tx    *wire.MsgTx
	prevs []prevout
}

type fetcher map[wire.OutPoint]prevout

func (f fetcher) FetchPrevOutput(op wire.OutPoint) *wire.TxOut {
	if p, ok := f[op]; ok {
		return p.out
	}
	return nil
}
func (f fetcher) FetchPrevOutArkTx(wire.OutPoint) *wire.MsgTx      { return nil }
func (f fetcher) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte { return f[op].vtxo }

func (w *world) fetcher() fetcher {
	f := fetcher{}
	for _, p := range w.prevs {
		f[p.op] = p
	}
	return f
}

var worlds = map[string]*world{}
var worldOrder []string

func addWorld(w *world) *world {
	worlds[w.name] = w
	worldOrder = append(worldOrder, w.name)
	return w
}

type in struct {
	tag   string
	vout  uint32
	seq   uint32
	value int64
	pk    []byte
	vtxo  []byte
	noOut bool
}

func mkWorld(name string, version int32, locktime uint32, ins []in, outs []*wire.TxOut) *world {
	tx := wire.NewMsgTx(version)
	tx.LockTime = locktime
	w := &world{name: name, tx: tx}
	for _, i := range ins {
		op := wire.OutPoint{Hash: hh(i.tag), Index: i.vout}
		tx.AddTxIn(&wire.TxIn{PreviousOutPoint: op, Sequence: i.seq})
		p := prevout{op: op, vtxo: i.vtxo}
		if !i.noOut {
			p.out = &wire.TxOut{Value: i.value, PkScript: i.pk}
		}
		w.prevs = append(w.prevs, p)
	}
	for _, o := range outs {
		tx.AddTxOut(o)
	}
	return addWorld(w)
}

func out(v int64, s []byte) *wire.TxOut { return &wire.TxOut{Value: v, PkScript: s} }

func p2pkh() []byte { return cat([]byte{0x76, 0xa9, 0x14}, rep(0x33, 20), []byte{0x88, 0xac}) }

func emuPacketData(entries ...A.EmulatorEntry) []byte {
	p, err := A.NewPacket(entries...)
	if err != nil {
		panic(err)
	}
	d, err := p.Serialize()
	if err != nil {
		panic(err)
	}
	return d
}

func extOut(pkts ...extension.Packet) *wire.TxOut {
	o, err := extension.Extension(pkts).TxOut()
	if err != nil {
		panic(err)
	}
	return o
}

// myMask replicates maskExtensionOutput (sigvalidate.go:297-337) so the TS test can stub the
// codec; the digest the real engine computes over the same tx is what validates it.
func myMask(tx *wire.MsgTx) (int, []byte, bool) {
	for i, o := range tx.TxOut {
		if !extension.IsExtension(o.PkScript) {
			continue
		}
		ext, err := extension.NewExtensionFromBytes(o.PkScript)
		if err != nil {
			return -1, nil, false
		}
		for j, pkt := range ext {
			if pkt.Type() != A.PacketType {
				continue
			}
			u, ok := pkt.(extension.UnknownPacket)
			if !ok {
				return -1, nil, false
			}
			ip, err := A.DeserializeEmulatorPacket(u.Data)
			if err != nil {
				return -1, nil, false
			}
			var b bytes.Buffer
			_ = wire.WriteVarInt(&b, 0, uint64(len(ip)))
			for _, e := range ip {
				_ = binary.Write(&b, binary.LittleEndian, e.Vin)
				_ = wire.WriteVarInt(&b, 0, uint64(len(e.Script)))
				b.Write(e.Script)
				_ = wire.WriteVarInt(&b, 0, 0)
			}
			ext[j] = extension.UnknownPacket{PacketType: A.PacketType, Data: b.Bytes()}
			s, err := ext.Serialize()
			if err != nil {
				panic(err)
			}
			return i, s, true
		}
		return -1, nil, false
	}
	return -1, nil, false
}

func txHex(tx *wire.MsgTx) string {
	var b bytes.Buffer
	if err := tx.Serialize(&b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b.Bytes())
}

// ---------- cases

type Case struct {
	N       string         `json:"n"`
	M       string         `json:"m"`
	W       string         `json:"w"`
	I       int            `json:"i,omitempty"`
	S       string         `json:"s,omitempty"`
	X       []string       `json:"x,omitempty"`
	L       string         `json:"l,omitempty"`
	Lim     map[string]int `json:"lim,omitempty"`
	Exp     *string        `json:"exp,omitempty"`
	Pkt     []pktJSON      `json:"pkt,omitempty"`
	Ht      *int           `json:"ht,omitempty"`
	Cs      *uint32        `json:"cs,omitempty"`
	St      []string       `json:"st"`
	E       string         `json:"e,omitempty"`
	Op      string         `json:"op,omitempty"`
	Pos     *int           `json:"pos,omitempty"`
	D       string         `json:"d,omitempty"`
	script  []byte
	witness [][]byte
	leaf    []byte
	limits  A.ComputeLimits
	expiry  *int64
	packet  A.EmulatorPacket
	idxOver bool
}

type pktJSON struct {
	V int      `json:"v"`
	S string   `json:"s"`
	X []string `json:"x"`
}

var cases []*Case

func hexes(items [][]byte) []string {
	out := []string{}
	for _, i := range items {
		out = append(out, hex.EncodeToString(i))
	}
	return out
}

func kindOf(err error) string {
	var pe secp.Error
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	for _, s := range []error{A.ErrBigNumDivisionByZero, A.ErrBigNumModuloByZero} {
		if errors.Is(err, s) {
			return s.Error()
		}
	}
	return "msg:" + err.Error()
}

func (c *Case) fail(err error) {
	var se txscript.Error
	if errors.As(err, &se) {
		c.E = se.ErrorCode.String()
	} else {
		c.E = "~" + kindOf(err)
	}
	var xe *A.ExecutionError
	if errors.As(err, &xe) {
		c.Op = xe.Opcode
		p := xe.Position
		c.Pos = &p
	}
}

func runExpr(c *Case) {
	w := worlds[c.W]
	defer func() {
		if r := recover(); r != nil {
			c.E = "~ErrPanic"
			c.St = nil
		}
	}()
	vm, err := A.NewEngine(c.script, w.tx, c.I, nil, nil, 0, w.fetcher())
	if err != nil {
		c.fail(err)
		return
	}
	if c.expiry != nil {
		A.WithExpiry(*c.expiry)(vm)
	}
	if c.packet != nil {
		vm.SetEmulatorPacket(c.packet)
	}
	for done := false; !done; {
		if done, err = vm.Step(); err != nil {
			c.fail(err)
			return
		}
	}
	c.St = hexes(vm.GetStack())
}

var defaultLeaf = sc(xonly(keyN(1)), byte(txscript.OP_CHECKSIG))

func runCov(c *Case) {
	w := worlds[c.W]
	leaf := c.leaf
	if leaf == nil {
		leaf = defaultLeaf
	}
	ptx, err := psbt.NewFromUnsignedTx(w.tx)
	if err != nil {
		panic(err)
	}
	ptx.Inputs[c.I].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
		ControlBlock: make([]byte, 33), Script: leaf, LeafVersion: txscript.BaseLeafVersion,
	}}
	s, err := A.NewArkadeScript(ptx, A.EmulatorEntry{Vin: uint16(c.I), Script: c.script, Witness: c.witness})
	if err != nil {
		panic(c.N + ": " + err.Error())
	}
	var last [][]byte
	opts := []A.ExecuteOption{A.WithDebugCallback(func(si *A.StepInfo, _ *A.Engine) error {
		last = si.Stack
		return nil
	})}
	if c.limits != nil {
		opts = append(opts, A.WithExactComputeLimits(c.limits))
	}
	err = s.Execute(w.tx, w.fetcher(), c.I, opts...)
	c.St = hexes(last)
	if err != nil {
		c.fail(err)
	}
}

func sighash(w *world, idx int, leaf []byte, ht int, cs *uint32) ([]byte, error) {
	f := w.fetcher()
	var opts []A.ArkadeSigHashOption
	if cs != nil {
		opts = append(opts, A.WithCodeSepPosition(*cs))
	}
	return A.CalcArkadeScriptSignatureHash(txscript.NewTxSigHashes(w.tx, f), txscript.SigHashType(ht),
		w.tx, idx, f, txscript.NewTapLeaf(txscript.BaseLeafVersion, leaf), opts...)
}

func mustSighash(w *world, idx int, leaf []byte, ht int, cs *uint32) []byte {
	d, err := sighash(w, idx, leaf, ht, cs)
	if err != nil {
		panic(err)
	}
	return d
}

func runDigest(c *Case) {
	leaf := c.leaf
	if leaf == nil {
		leaf = defaultLeaf
	}
	d, err := sighash(worlds[c.W], c.I, leaf, *c.Ht, c.Cs)
	if err != nil {
		c.E = "~msg:" + err.Error()
		return
	}
	c.D = hex.EncodeToString(d)
}

func expr(name, w string, script []byte) *Case {
	c := &Case{N: name, M: "e", W: w, script: script, S: hex.EncodeToString(script)}
	cases = append(cases, c)
	return c
}

func cov(name, w string, idx int, script []byte, wit ...[]byte) *Case {
	c := &Case{N: name, M: "c", W: w, I: idx, script: script, S: hex.EncodeToString(script), witness: wit, X: hexes(wit), L: hex.EncodeToString(defaultLeaf)}
	cases = append(cases, c)
	return c
}

func (c *Case) withLimits(l map[byte]int) *Case {
	c.limits = A.ComputeLimits{}
	c.Lim = map[string]int{}
	for op, n := range l {
		c.limits[op] = n
		c.Lim[fmt.Sprint(op)] = n
	}
	return c
}

func (c *Case) withLeaf(leaf []byte) *Case {
	c.leaf = leaf
	c.L = hex.EncodeToString(leaf)
	return c
}

func (c *Case) withIdx(i int) *Case { c.I = i; return c }

func (c *Case) withExpiry(v int64) *Case {
	c.expiry = &v
	s := fmt.Sprint(v)
	c.Exp = &s
	return c
}

func (c *Case) withPacket(entries ...A.EmulatorEntry) *Case {
	c.packet = entries
	for _, e := range entries {
		c.Pkt = append(c.Pkt, pktJSON{V: int(e.Vin), S: hex.EncodeToString(e.Script), X: hexes(e.Witness)})
	}
	return c
}

func digest(name, w string, idx, ht int, cs *uint32) *Case {
	h := ht
	c := &Case{N: name, M: "h", W: w, I: idx, Ht: &h, Cs: cs, L: hex.EncodeToString(defaultLeaf)}
	cases = append(cases, c)
	return c
}

func u32p(v uint32) *uint32 { return &v }

// ---------- signing

var (
	kS  = keyN(0x31)
	kE  = keyN(0x32)
	dR1 = new(big.Int).Mod(new(big.Int).SetBytes(func() []byte { h := sha256.Sum256([]byte("t4-r1")); return h[:] }()), elliptic.P256().Params().N)
)

func pkS() []byte  { return xonly(kS) }
func pkE() []byte  { return append([]byte{0x10}, kE.PubKey().SerializeCompressed()...) }
func pkR1() []byte { return append([]byte{0x11}, r1Pub(dR1)...) }

func schnorrSig(k *btcec.PrivateKey, d []byte) []byte {
	s, err := schnorr.Sign(k, d)
	if err != nil {
		panic(err)
	}
	return s.Serialize()
}

func ecdsaK1(k *btcec.PrivateKey, d []byte, highS bool) []byte {
	sig := becdsa.Sign(k, d)
	r, s := sig.R(), sig.S()
	if highS {
		s.Negate()
	}
	rb, sb := r.Bytes(), s.Bytes()
	return append(rb[:], sb[:]...)
}

func ecdsaR1(d *big.Int, digest []byte, highS bool) []byte {
	c := elliptic.P256().Params()
	seed := sha256.Sum256(append(d.Bytes(), digest...))
	k := new(big.Int).Mod(new(big.Int).SetBytes(seed[:]), c.N)
	x, _ := elliptic.P256().ScalarBaseMult(k.Bytes())
	r := new(big.Int).Mod(x, c.N)
	s := new(big.Int).Mul(r, d)
	s.Add(s, new(big.Int).SetBytes(digest)).Mul(s, new(big.Int).ModInverse(k, c.N)).Mod(s, c.N)
	half := new(big.Int).Rsh(c.N, 1)
	if (s.Cmp(half) > 0) != highS {
		s.Sub(c.N, s)
	}
	return append(be32(r), be32(s)...)
}

func r1Pub(d *big.Int) []byte {
	x, y := elliptic.P256().ScalarBaseMult(d.Bytes())
	return elliptic.MarshalCompressed(elliptic.P256(), x, y)
}

// ---------- main

// Generate writes one JSON line per world, then one per case.
func Generate(out io.Writer) {
	buildWorlds()
	timeCases()
	introspectCases()
	ecCases()
	csfsCases()
	sigCases()
	digestCases()

	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	for _, name := range worldOrder {
		w := worlds[name]
		type pj struct {
			Txid  string  `json:"txid"`
			Index uint32  `json:"index"`
			Value *string `json:"value"`
			Pk    string  `json:"pk"`
			Vtxo  *string `json:"vtxo"`
		}
		var ps []pj
		for _, p := range w.prevs {
			e := pj{Txid: hex.EncodeToString(p.op.Hash[:]), Index: p.op.Index}
			if p.out != nil {
				v := fmt.Sprint(p.out.Value)
				e.Value = &v
				e.Pk = hex.EncodeToString(p.out.PkScript)
			}
			if p.vtxo != nil {
				v := hex.EncodeToString(p.vtxo)
				e.Vtxo = &v
			}
			ps = append(ps, e)
		}
		line := map[string]any{"world": name, "tx": txHex(w.tx), "prevouts": ps}
		if i, s, ok := myMask(w.tx); ok {
			line["mask"] = map[string]any{"i": i, "s": hex.EncodeToString(s)}
		} else if hasExtension(w.tx) {
			line["mask"] = nil
		}
		_ = enc.Encode(line)
	}
	for _, c := range cases {
		switch c.M {
		case "e":
			runExpr(c)
		case "c":
			runCov(c)
		case "h":
			runDigest(c)
		}
		_ = enc.Encode(c)
	}
}

func hasExtension(tx *wire.MsgTx) bool {
	for _, o := range tx.TxOut {
		if extension.IsExtension(o.PkScript) {
			return true
		}
	}
	return false
}

var _ = math.MaxInt64
var _ = strings.Repeat
var _ = gnarkbn254.Generators
var _ = gnarkbn254fp.Modulus
var _ = gnarksecpfp.Modulus
