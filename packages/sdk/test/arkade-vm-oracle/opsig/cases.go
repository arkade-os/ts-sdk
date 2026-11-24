package opsig

import (
	"crypto/elliptic"
	"crypto/sha256"
	"math"
	"math/big"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	A "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	gnarkbn254 "github.com/consensys/gnark-crypto/ecc/bn254"
	gnarkbn254fp "github.com/consensys/gnark-crypto/ecc/bn254/fp"
	gnarkbn254fr "github.com/consensys/gnark-crypto/ecc/bn254/fr"
	gnarksecp "github.com/consensys/gnark-crypto/ecc/secp256k1"
	gnarksecpfp "github.com/consensys/gnark-crypto/ecc/secp256k1/fp"
	gnarksecpfr "github.com/consensys/gnark-crypto/ecc/secp256k1/fr"
)

const (
	CLTV = byte(A.OP_CHECKLOCKTIMEVERIFY)
	CSV  = byte(A.OP_CHECKSEQUENCEVERIFY)
)

func buildWorlds() {
	mkWorld("d", 2, 600000, []in{
		{tag: "t4-in0", vout: 1, seq: 0xfffffffe, value: 5000, pk: p2tr(20), vtxo: p2tr(21)},
		{tag: "t4-in1", vout: 0xffffffff, seq: 10, value: 7000, pk: p2tr(22)},
		{tag: "t4-in2", vout: 7, seq: 0xffffffff, value: 1000, pk: cat([]byte{0, 20}, rep(0x44, 20)), vtxo: []byte{}},
	}, []*wire.TxOut{
		out(4000, p2tr(23)),
		out(0, p2pkh()),
		out(2_100_000_000_000_000, []byte{0x60, 2, 0xaa, 0xbb}),
		out(2_100_000_000_000_001, cat([]byte{0x00, 40}, rep(0x55, 40))),
		out(-1, cat([]byte{0x51, 0x4c, 32}, rep(0x66, 32))),
		out(1, []byte{}),
		out(2, []byte{0x4f, 2, 0xaa, 0xbb}),
		out(3, cat([]byte{0x51, 41}, rep(0x77, 41))),
		out(4, []byte{0x00, 2, 0x01, 0x02}),
		out(5, cat([]byte{0x51, 32}, rep(0x88, 32), []byte{0x00})),
		out(6, []byte{0x50, 2, 0xaa, 0xbb}),
		out(7, []byte{0x51, 1, 0x20}),
	})
	mkWorld("v1", 1, 500000001, []in{{tag: "v1-in0", seq: 0x00400005, value: 900, pk: p2tr(24)}},
		[]*wire.TxOut{out(800, p2tr(25))})
	mkWorld("neg", -1, 0xffffffff, []in{{tag: "neg-in0", seq: 0, value: 900, pk: p2tr(24)}}, nil)
	mkWorld("v80", math.MinInt32, 0, []in{{tag: "v80-in0", seq: 3, value: 900, pk: p2tr(24)}},
		[]*wire.TxOut{out(800, p2tr(25))})
	mkWorld("csv", 2, 0, []in{
		{tag: "csv-in0", seq: 0x00400010, value: 1, pk: p2tr(26)},
		{tag: "csv-in1", seq: 0x80000005, value: 1, pk: p2tr(26)},
		{tag: "csv-in2", seq: 20, value: 1, pk: p2tr(26)},
	}, []*wire.TxOut{out(1, p2tr(27))})
	mkWorld("few", 2, 0, []in{
		{tag: "few-in0", seq: 0, value: 100, pk: p2tr(28)},
		{tag: "few-in1", seq: 1, value: 200, pk: p2tr(28)},
		{tag: "few-in2", seq: 2, value: 300, pk: p2tr(28)},
	}, []*wire.TxOut{out(500, p2tr(29))})
	mkWorld("nonp2tr", 2, 0, []in{
		{tag: "np-in0", seq: 0, value: 100, pk: cat([]byte{0, 20}, rep(0x12, 20))},
		{tag: "np-in1", seq: 0, value: 200, pk: p2pkh()},
	}, []*wire.TxOut{out(250, p2tr(30)), out(40, p2pkh())})
	mkWorld("miss", 2, 0, []in{
		{tag: "miss-in0", seq: 0, value: 2_100_000_000_000_001, pk: p2tr(31)},
		{tag: "miss-in1", seq: 0, noOut: true},
		{tag: "miss-in2", seq: 0, value: -1, pk: p2tr(31)},
		{tag: "miss-in3", seq: 0, value: 2_100_000_000_000_000, pk: p2tr(31)},
	}, nil)
	wit := mkWorld("wit", 2, 0, []in{{tag: "wit-in0", seq: 0, value: 1, pk: p2tr(32)}},
		[]*wire.TxOut{out(1, p2tr(33))})
	wit.tx.TxIn[0].Witness = wire.TxWitness{rep(0xab, 70), {}, {0x01}}

	entries := []A.EmulatorEntry{
		{Vin: 0, Script: []byte{0xaa, 0xbb}, Witness: wire.TxWitness{{0xcc}, {0xdd, 0xdd}}},
		{Vin: 1, Script: []byte{0xee}},
	}
	emu := extension.UnknownPacket{PacketType: A.PacketType, Data: emuPacketData(entries...)}
	twoIns := func(tag string) []in {
		return []in{
			{tag: tag + "-in0", seq: 0, value: 1000, pk: p2tr(34)},
			{tag: tag + "-in1", seq: 7, value: 2000, pk: p2tr(35)},
		}
	}
	mkWorld("mask", 3, 0, twoIns("mask"), []*wire.TxOut{out(900, p2tr(36)), extOut(emu), out(1900, p2tr(37))})
	mkWorld("mask0", 3, 0, twoIns("mask0"), []*wire.TxOut{extOut(emu), out(900, p2tr(36))})
	bad := extension.UnknownPacket{PacketType: A.PacketType, Data: append(emuPacketData(entries...), 0x00)}
	mkWorld("maskbad", 3, 0, twoIns("maskbad"), []*wire.TxOut{out(900, p2tr(36)), extOut(bad), out(1900, p2tr(37))})
	other := extension.UnknownPacket{PacketType: 0x42, Data: []byte{1, 2, 3}}
	mkWorld("extnoemu", 3, 0, twoIns("extnoemu"), []*wire.TxOut{out(900, p2tr(36)), extOut(other), out(1900, p2tr(37))})
}

// ---------- time

func timeCases() {
	expr("cltv/equal-locktime-peeks", "d", sc(600000, CLTV))
	expr("cltv/zero", "d", sc(0, CLTV))
	expr("cltv/above-locktime", "d", sc(600001, CLTV))
	expr("cltv/threshold-mismatch", "d", sc(500000000, CLTV))
	expr("cltv/threshold-minus-one", "d", sc(499999999, CLTV))
	expr("cltv/negative", "d", sc(-1, CLTV))
	expr("cltv/uint32-max", "d", sc(int64(0xffffffff), CLTV))
	expr("cltv/over-uint32", "d", sc(int64(0x100000000), CLTV))
	expr("cltv/9-byte", "d", sc(pow2(63), CLTV))
	expr("cltv/9-byte-negative", "d", sc(new(big.Int).Neg(pow2(63)), CLTV))
	expr("cltv/non-minimal", "d", sc([]byte{0x05, 0x00}, CLTV))
	expr("cltv/empty-stack", "d", sc(CLTV))
	expr("cltv/finalized-input", "d", sc(0, CLTV)).withIdx(2)
	expr("cltv/time-equal", "v1", sc(500000001, CLTV))
	expr("cltv/time-vs-block", "v1", sc(5, CLTV))

	expr("csv/blocks-equal-peeks", "csv", sc(20, CSV)).withIdx(2)
	expr("csv/blocks-above", "csv", sc(21, CSV)).withIdx(2)
	expr("csv/seconds-equal", "csv", sc(0x00400010, CSV))
	expr("csv/seconds-vs-blocks", "csv", sc(16, CSV))
	expr("csv/stack-disable-bit-is-nop", "csv", sc(int64(0x80000000), CSV)).withIdx(2)
	expr("csv/stack-disable-bit-before-version", "v1", sc(int64(0x80000000), CSV))
	expr("csv/version-1", "v1", sc(5, CSV))
	expr("csv/tx-disable-bit", "csv", sc(5, CSV)).withIdx(1)
	expr("csv/non-consensus-bits-masked", "csv", sc(0x10014, CSV)).withIdx(2)
	expr("csv/negative", "csv", sc(-1, CSV)).withIdx(2)
	expr("csv/over-uint32", "csv", sc(int64(0x100000000), CSV)).withIdx(2)
	expr("csv/9-byte", "csv", sc(pow2(64), CSV)).withIdx(2)
	expr("csv/empty-stack", "csv", sc(CSV)).withIdx(2)
	expr("csv/non-minimal", "csv", sc([]byte{0x05, 0x00}, CSV)).withIdx(2)
	expr("csv/negative-version-is-large", "neg", sc(0, CSV))

	pe := byte(A.OP_PUSHEXPIRY)
	expr("pushexpiry/unset", "d", sc(pe))
	expr("pushexpiry/typical", "d", sc(pe)).withExpiry(1764000000)
	expr("pushexpiry/zero", "d", sc(pe)).withExpiry(0)
	expr("pushexpiry/negative", "d", sc(pe)).withExpiry(-5)
	expr("pushexpiry/5-byte", "d", sc(pe)).withExpiry(1 << 31)
	expr("pushexpiry/max-int64", "d", sc(pe)).withExpiry(math.MaxInt64)
	expr("pushexpiry/min-int64-panics", "d", sc(pe)).withExpiry(math.MinInt64)

	ct := byte(A.OP_CHECKTIME)
	expr("checktime/zero", "d", sc(0, ct))
	expr("checktime/past", "d", sc(1000000000, ct))
	expr("checktime/far-future", "d", sc(int64(1)<<40, ct))
	expr("checktime/9-byte-future", "d", sc(pow2(63), ct))
	expr("checktime/pops-operand", "d", sc(5, 0, ct))
	expr("checktime/negative", "d", sc(-1, ct))
	expr("checktime/non-minimal", "d", sc([]byte{0x05, 0x00}, ct))
	expr("checktime/empty-stack", "d", sc(ct))
}

// ---------- introspection

func introspectCases() {
	o := func(op byte) byte { return op }
	for _, i := range []int{0, 1, 2, 3, -1} {
		expr("outpoint/index-"+itoa(i), "d", sc(i, o(A.OP_INSPECTINPUTOUTPOINT)))
	}
	expr("outpoint/non-minimal-index", "d", sc([]byte{0x00}, o(A.OP_INSPECTINPUTOUTPOINT)))
	expr("outpoint/5-byte-index", "d", sc(int64(1)<<32, o(A.OP_INSPECTINPUTOUTPOINT)))
	expr("outpoint/empty-stack", "d", sc(o(A.OP_INSPECTINPUTOUTPOINT)))

	for _, i := range []int{0, 1, 2, 3, -1} {
		expr("inputvalue/index-"+itoa(i), "d", sc(i, o(A.OP_INSPECTINPUTVALUE)))
	}
	for _, i := range []int{0, 1, 2, 3} {
		expr("inputvalue/miss-world-"+itoa(i), "miss", sc(i, o(A.OP_INSPECTINPUTVALUE)))
	}
	for _, i := range []int{0, 1, 2, 3} {
		expr("inputspk/index-"+itoa(i), "d", sc(i, o(A.OP_INSPECTINPUTSCRIPTPUBKEY)))
	}
	expr("inputspk/negative", "d", sc(-1, o(A.OP_INSPECTINPUTSCRIPTPUBKEY)))
	for _, i := range []int{0, 1, 2, 3} {
		expr("sequence/index-"+itoa(i), "d", sc(i, o(A.OP_INSPECTINPUTSEQUENCE)))
	}
	expr("currentindex/0", "d", sc(o(A.OP_PUSHCURRENTINPUTINDEX)))
	expr("currentindex/2", "d", sc(o(A.OP_PUSHCURRENTINPUTINDEX))).withIdx(2)

	for i := -1; i <= 12; i++ {
		expr("outputvalue/index-"+itoa(i), "d", sc(i, o(A.OP_INSPECTOUTPUTVALUE)))
	}
	for i := 0; i <= 12; i++ {
		expr("outputspk/index-"+itoa(i), "d", sc(i, o(A.OP_INSPECTOUTPUTSCRIPTPUBKEY)))
	}
	expr("outputspk/negative", "d", sc(-1, o(A.OP_INSPECTOUTPUTSCRIPTPUBKEY)))
	expr("outputvalue/no-outputs", "neg", sc(0, o(A.OP_INSPECTOUTPUTVALUE)))

	for _, w := range []string{"d", "v1", "neg", "v80"} {
		expr("version/"+w, w, sc(o(A.OP_INSPECTVERSION)))
		expr("locktime/"+w, w, sc(o(A.OP_INSPECTLOCKTIME)))
		expr("numinputs/"+w, w, sc(o(A.OP_INSPECTNUMINPUTS)))
		expr("numoutputs/"+w, w, sc(o(A.OP_INSPECTNUMOUTPUTS)))
		expr("txweight/"+w, w, sc(o(A.OP_TXWEIGHT)))
		expr("txid/"+w, w, sc(o(A.OP_TXID)))
	}
	expr("txweight/witness-not-counted", "wit", sc(o(A.OP_TXWEIGHT)))
	expr("txid/witness-stripped", "wit", sc(o(A.OP_TXID)))

	pkt := []A.EmulatorEntry{
		{Vin: 2, Script: []byte{0xaa, 0xbb}, Witness: wire.TxWitness{{0xcc}, {0xdd, 0xdd}}},
		{Vin: 0, Script: []byte{0xee}},
		{Vin: 1, Script: []byte{0x51}, Witness: wire.TxWitness{{}}},
	}
	for _, op := range []struct {
		name string
		v    byte
	}{{"scripthash", A.OP_INSPECTINPUTARKADESCRIPTHASH}, {"witnesshash", A.OP_INSPECTINPUTARKADEWITNESSHASH}} {
		for _, i := range []int{0, 1, 2, 3, -1} {
			expr(op.name+"/index-"+itoa(i), "d", sc(i, op.v)).withPacket(pkt...)
		}
		expr(op.name+"/vin-missing-from-packet", "d", sc(1, op.v)).withPacket(pkt[:2]...)
		expr(op.name+"/no-packet", "d", sc(0, op.v))
		expr(op.name+"/out-of-range-before-packet", "d", sc(3, op.v))
	}
}

func itoa(i int) string {
	if i < 0 {
		return "neg" + itoa(-i)
	}
	return string(rune('0'+i/10%10)) + string(rune('0'+i%10))
}

// ---------- EC

type curve struct {
	id     int
	name   string
	p, n   *big.Int
	gx, gy *big.Int
	mul    func(x, y, k *big.Int) (*big.Int, *big.Int)
	add    func(x1, y1, x2, y2 *big.Int) (*big.Int, *big.Int)
	bCoeff *big.Int
}

func secpCurve() curve {
	_, g := gnarksecp.Generators()
	var gx, gy big.Int
	g.X.BigInt(&gx)
	g.Y.BigInt(&gy)
	conv := func(p *gnarksecp.G1Affine) (*big.Int, *big.Int) {
		if p.IsInfinity() {
			return new(big.Int), new(big.Int)
		}
		var x, y big.Int
		p.X.BigInt(&x)
		p.Y.BigInt(&y)
		return &x, &y
	}
	set := func(x, y *big.Int) gnarksecp.G1Affine {
		var p gnarksecp.G1Affine
		if x.Sign() != 0 || y.Sign() != 0 {
			p.X.SetBigInt(x)
			p.Y.SetBigInt(y)
		}
		return p
	}
	return curve{0, "secp256k1", gnarksecpfp.Modulus(), gnarksecpfr.Modulus(), &gx, &gy,
		func(x, y, k *big.Int) (*big.Int, *big.Int) {
			p := set(x, y)
			var r gnarksecp.G1Affine
			r.ScalarMultiplication(&p, k)
			return conv(&r)
		},
		func(x1, y1, x2, y2 *big.Int) (*big.Int, *big.Int) {
			a, b := set(x1, y1), set(x2, y2)
			var r gnarksecp.G1Affine
			r.Add(&a, &b)
			return conv(&r)
		}, big.NewInt(7)}
}

func p256Curve() curve {
	c := elliptic.P256()
	pr := c.Params()
	return curve{1, "secp256r1", pr.P, pr.N, pr.Gx, pr.Gy,
		func(x, y, k *big.Int) (*big.Int, *big.Int) {
			if (x.Sign() == 0 && y.Sign() == 0) || k.Sign() == 0 {
				return new(big.Int), new(big.Int)
			}
			return c.ScalarMult(x, y, k.Bytes())
		},
		func(x1, y1, x2, y2 *big.Int) (*big.Int, *big.Int) { return c.Add(x1, y1, x2, y2) }, pr.B}
}

func bnCurve() curve {
	_, _, g, _ := gnarkbn254.Generators()
	var gx, gy big.Int
	g.X.BigInt(&gx)
	g.Y.BigInt(&gy)
	conv := func(p *gnarkbn254.G1Affine) (*big.Int, *big.Int) {
		if p.IsInfinity() {
			return new(big.Int), new(big.Int)
		}
		var x, y big.Int
		p.X.BigInt(&x)
		p.Y.BigInt(&y)
		return &x, &y
	}
	set := func(x, y *big.Int) gnarkbn254.G1Affine {
		var p gnarkbn254.G1Affine
		if x.Sign() != 0 || y.Sign() != 0 {
			p.X.SetBigInt(x)
			p.Y.SetBigInt(y)
		}
		return p
	}
	return curve{2, "bn254", gnarkbn254fp.Modulus(), gnarkbn254fr.Modulus(), &gx, &gy,
		func(x, y, k *big.Int) (*big.Int, *big.Int) {
			p := set(x, y)
			var r gnarkbn254.G1Affine
			r.ScalarMultiplication(&p, k)
			return conv(&r)
		},
		func(x1, y1, x2, y2 *big.Int) (*big.Int, *big.Int) {
			a, b := set(x1, y1), set(x2, y2)
			var r gnarkbn254.G1Affine
			r.Add(&a, &b)
			return conv(&r)
		}, big.NewInt(3)}
}

func ecCases() {
	add, mul, pair := byte(A.OP_ECADD), byte(A.OP_ECMUL), byte(A.OP_ECPAIRING)
	zero := new(big.Int)
	for _, c := range []curve{secpCurve(), p256Curve(), bnCurve()} {
		g := func(k int64) (*big.Int, *big.Int) { return c.mul(c.gx, c.gy, big.NewInt(k)) }
		gx, gy := c.gx, c.gy
		negY := new(big.Int).Sub(c.p, gy)
		px, py := g(1234567)
		qx, qy := g(7654321)
		id := c.id
		pre := "ecadd/" + c.name + "/"
		expr(pre+"G+G", "d", sc(gx, gy, gx, gy, id, add))
		expr(pre+"G+negG", "d", sc(gx, gy, gx, negY, id, add))
		expr(pre+"inf+G", "d", sc(zero, zero, gx, gy, id, add))
		expr(pre+"G+inf", "d", sc(gx, gy, zero, zero, id, add))
		expr(pre+"inf+inf", "d", sc(zero, zero, zero, zero, id, add))
		expr(pre+"P+Q", "d", sc(px, py, qx, qy, id, add))
		expr(pre+"off-curve-first", "d", sc(1, 1, gx, gy, id, add))
		expr(pre+"off-curve-second", "d", sc(gx, gy, 1, 1, id, add))
		expr(pre+"x-equals-p", "d", sc(c.p, gy, gx, gy, id, add))
		expr(pre+"y-equals-p", "d", sc(gx, gy, gx, c.p, id, add))
		expr(pre+"negative-coord", "d", sc(gx, gy, -1, gy, id, add))
		expr(pre+"x-zero-y-nonzero", "d", sc(zero, gy, gx, gy, id, add))
		if s := new(big.Int).ModSqrt(new(big.Int).Mod(c.bCoeff, c.p), c.p); s != nil {
			expr(pre+"x-zero-on-curve", "d", sc(zero, s, gx, gy, id, add))
		}
		pre = "ecmul/" + c.name + "/"
		nm1 := new(big.Int).Sub(c.n, big.NewInt(1))
		expr(pre+"k0", "d", sc(gx, gy, 0, id, mul))
		expr(pre+"k1", "d", sc(gx, gy, 1, id, mul))
		expr(pre+"k2", "d", sc(gx, gy, 2, id, mul))
		expr(pre+"k-n-minus-1", "d", sc(gx, gy, nm1, id, mul))
		expr(pre+"k-n", "d", sc(gx, gy, c.n, id, mul))
		expr(pre+"k-negative", "d", sc(gx, gy, -1, id, mul))
		expr(pre+"k-random", "d", sc(px, py, bi("0x1f2e3d4c5b6a79881726354453627180aabbccddeeff00112233445566778899"), id, mul))
		expr(pre+"inf-times-k", "d", sc(zero, zero, 5, id, mul))
		expr(pre+"off-curve", "d", sc(1, 1, 5, id, mul))
		expr(pre+"x-equals-p", "d", sc(c.p, gy, 5, id, mul))
	}
	k1 := secpCurve()
	gx, gy := k1.gx, k1.gy
	expr("ecadd/curve-3", "d", sc(gx, gy, gx, gy, 3, add))
	expr("ecadd/curve-negative", "d", sc(gx, gy, gx, gy, -1, add))
	expr("ecadd/curve-9-byte", "d", sc(gx, gy, gx, gy, pow2(63), add))
	expr("ecadd/curve-non-minimal", "d", sc(gx, gy, gx, gy, []byte{0x00}, add))
	expr("ecadd/empty-stack", "d", sc(add))
	expr("ecadd/underflow", "d", sc(gx, 0, add))
	expr("ecadd/non-minimal-coord", "d", sc(gx, gy, gx, append(num(gy), 0x00), 0, add))
	expr("ecmul/underflow", "d", sc(5, 0, mul))

	// pairing
	_, _, g1, g2 := gnarkbn254.Generators()
	bnP := gnarkbn254fp.Modulus()
	g1c := func(p gnarkbn254.G1Affine) []any {
		if p.IsInfinity() {
			return []any{new(big.Int), new(big.Int)}
		}
		var x, y big.Int
		p.X.BigInt(&x)
		p.Y.BigInt(&y)
		return []any{&x, &y}
	}
	g2c := func(p gnarkbn254.G2Affine) []any {
		var a0, a1, b0, b1 big.Int
		p.X.A0.BigInt(&a0)
		p.X.A1.BigInt(&a1)
		p.Y.A0.BigInt(&b0)
		p.Y.A1.BigInt(&b1)
		return []any{&a1, &a0, &b1, &b0}
	}
	mulG1 := func(k int64) gnarkbn254.G1Affine {
		var r gnarkbn254.G1Affine
		r.ScalarMultiplication(&g1, big.NewInt(k))
		return r
	}
	mulG2 := func(k int64) gnarkbn254.G2Affine {
		var r gnarkbn254.G2Affine
		r.ScalarMultiplication(&g2, big.NewInt(k))
		return r
	}
	var negG1 gnarkbn254.G1Affine
	negG1.Neg(&g1)
	var inf1 gnarkbn254.G1Affine
	var inf2 gnarkbn254.G2Affine
	var seed gnarkbn254.G2Affine
	seed.X.A0.SetUint64(1)
	nonSub := gnarkbn254.MapToCurve2(&seed.X)
	if !nonSub.IsOnCurve() || nonSub.IsInSubGroup() {
		panic("non-subgroup seed")
	}
	pairs := func(items ...[]any) []any {
		var out []any
		for _, it := range items {
			out = append(out, it...)
		}
		return out
	}
	pc := func(p1 gnarkbn254.G1Affine, p2 gnarkbn254.G2Affine) []any { return append(g1c(p1), g2c(p2)...) }
	pcase := func(name string, count any, curveID any, body []any) {
		parts := append(append([]any{}, body...), count, curveID, pair)
		expr("ecpairing/"+name, "d", sc(parts...))
	}
	var negAB gnarkbn254.G1Affine
	negAB.Neg(func() *gnarkbn254.G1Affine { r := mulG1(6 * 11); return &r }())
	pcase("true-G-negG", 2, 2, pairs(pc(g1, g2), pc(negG1, g2)))
	pcase("true-aG1-bG2-neg-abG1-G2", 2, 2, pairs(pc(mulG1(6), mulG2(11)), pc(negAB, g2)))
	pcase("false-single", 1, 2, pc(g1, g2))
	pcase("false-aG1-bG2-abG1-G2", 2, 2, pairs(pc(mulG1(6), mulG2(11)), pc(mulG1(66), g2)))
	pcase("g2-infinity-is-identity", 1, 2, pc(g1, inf2))
	pcase("g1-infinity-is-identity", 1, 2, pc(inf1, g2))
	pcase("all-infinity", 2, 2, pairs(pc(inf1, inf2), pc(inf1, inf2)))
	pcase("infinity-g1-does-not-skip-subgroup-check", 1, 2, append(g1c(inf1), g2c(nonSub)...))
	pcase("off-curve-g1-with-infinity-g2", 1, 2, pairs([]any{1, 1}, g2c(inf2)))
	pcase("off-curve-g1", 1, 2, pairs([]any{1, 1}, g2c(g2)))
	g2off := g2c(g2)
	g2off[3] = new(big.Int)
	pcase("off-curve-g2", 1, 2, pairs(g1c(g1), g2off))
	g2swap := g2c(g2)
	g2swap[0], g2swap[1] = g2swap[1], g2swap[0]
	pcase("g2-c0-c1-swapped", 1, 2, pairs(g1c(g1), g2swap))
	pcase("g2-not-in-subgroup", 1, 2, pairs(g1c(g1), g2c(nonSub)))
	pcase("second-pair-not-in-subgroup", 2, 2, pairs(pc(g1, g2), append(g1c(g1), g2c(nonSub)...)))
	g2p := g2c(g2)
	g2p[1] = bnP
	pcase("g2-x-c0-equals-p", 1, 2, pairs(g1c(g1), g2p))
	pcase("g1-x-equals-p", 1, 2, pairs([]any{bnP, 1}, g2c(g2)))
	pcase("count-0", 0, 2, nil)
	pcase("count-negative", -1, 2, pc(g1, g2))
	pcase("count-17", 17, 2, pc(g1, g2))
	pcase("count-9-byte", pow2(63), 2, pc(g1, g2))
	pcase("count-non-minimal", []byte{0x01, 0x00}, 2, pc(g1, g2))
	var sixteen []any
	for i := 0; i < 8; i++ {
		sixteen = append(sixteen, pairs(pc(g1, g2), pc(negG1, g2))...)
	}
	pcase("count-16-max", 16, 2, sixteen)
	pcase("count-exceeds-stack", 2, 2, pc(g1, g2))
	pcase("curve-secp256k1-no-pairing", 1, 0, pc(g1, g2))
	pcase("curve-p256-no-pairing", 1, 1, pc(g1, g2))
	pcase("curve-3", 1, 3, pc(g1, g2))
	expr("ecpairing/empty-stack", "d", sc(pair))

	ecVerifyCases()
}

func ecVerifyCases() {
	msv, tv := byte(A.OP_ECMULSCALARVERIFY), byte(A.OP_TWEAKVERIFY)
	n := btcec.S256().N
	p := btcec.S256().P
	d := keyN(0x41)
	P := d.PubKey().SerializeCompressed()
	k := bi("0x5a5b5c5d5e5f606162636465666768696a6b6c6d6e6f70717273747576777879")
	kP := func(k *big.Int, P []byte) []byte {
		pk, _ := btcec.ParsePubKey(P)
		x, y := btcec.S256().ScalarMult(pk.X(), pk.Y(), be32(k))
		fx, fy := new(btcec.FieldVal), new(btcec.FieldVal)
		fx.SetByteSlice(x.Bytes())
		fy.SetByteSlice(y.Bytes())
		return btcec.NewPublicKey(fx, fy).SerializeCompressed()
	}
	Q := kP(k, P)
	flip := func(b []byte) []byte { c := append([]byte{}, b...); c[0] ^= 1; return c }
	offX := notOnCurveX()
	expr("ecmulscalarverify/valid", "d", sc(be32(k), P, Q, msv))
	expr("ecmulscalarverify/leaves-rest", "d", sc(7, be32(k), P, Q, msv))
	expr("ecmulscalarverify/q-parity-flipped", "d", sc(be32(k), P, flip(Q), msv))
	expr("ecmulscalarverify/k-n-minus-1", "d", sc(be32(new(big.Int).Sub(n, big.NewInt(1))), P, flip(P), msv))
	expr("ecmulscalarverify/k-zero-is-infinity", "d", sc(be32(new(big.Int)), P, cat([]byte{2}, rep(0, 32)), msv))
	expr("ecmulscalarverify/k-n", "d", sc(be32(n), P, Q, msv))
	expr("ecmulscalarverify/k-31-bytes", "d", sc(be32(k)[1:], P, Q, msv))
	expr("ecmulscalarverify/p-32-bytes", "d", sc(be32(k), P[1:], Q, msv))
	expr("ecmulscalarverify/p-prefix-04", "d", sc(be32(k), cat([]byte{4}, P[1:]), Q, msv))
	expr("ecmulscalarverify/p-x-equals-p", "d", sc(be32(k), cat([]byte{2}, be32(p)), Q, msv))
	expr("ecmulscalarverify/p-off-curve", "d", sc(be32(k), cat([]byte{2}, offX), Q, msv))
	expr("ecmulscalarverify/q-34-bytes", "d", sc(be32(k), P, append(Q, 0), msv))
	expr("ecmulscalarverify/underflow", "d", sc(P, Q, msv))

	// TWEAKVERIFY: P x-only lifted to even y, Q = P + kG
	xP := xonly(d)
	tweak := func(xP []byte, k *big.Int) []byte {
		pk, _ := schnorr.ParsePubKey(xP)
		kx, ky := btcec.S256().ScalarBaseMult(be32(k))
		if k.Sign() == 0 {
			return pk.SerializeCompressed()
		}
		x, y := btcec.S256().Add(pk.X(), pk.Y(), kx, ky)
		fx, fy := new(btcec.FieldVal), new(btcec.FieldVal)
		fx.SetByteSlice(x.Bytes())
		fy.SetByteSlice(y.Bytes())
		return btcec.NewPublicKey(fx, fy).SerializeCompressed()
	}
	Qt := tweak(xP, k)
	dv := new(big.Int).SetBytes(d.Serialize())
	if d.PubKey().Y().Bit(0) == 0 {
		dv.Sub(n, dv)
	}
	expr("tweakverify/valid", "d", sc(xP, be32(k), Qt, tv))
	expr("tweakverify/k-zero-is-p", "d", sc(xP, be32(new(big.Int)), cat([]byte{2}, xP), tv))
	expr("tweakverify/infinity", "d", sc(xP, be32(dv), cat([]byte{2}, rep(0, 32)), tv))
	expr("tweakverify/q-parity-flipped", "d", sc(xP, be32(k), flip(Qt), tv))
	expr("tweakverify/k-n", "d", sc(xP, be32(n), Qt, tv))
	expr("tweakverify/p-x-equals-p", "d", sc(be32(p), be32(k), Qt, tv))
	expr("tweakverify/p-off-curve", "d", sc(offX, be32(k), Qt, tv))
	expr("tweakverify/p-33-bytes", "d", sc(P, be32(k), Qt, tv))
	expr("tweakverify/k-33-bytes", "d", sc(xP, append(be32(k), 0), Qt, tv))
	expr("tweakverify/p-and-k-wrong-length", "d", sc(xP[1:], be32(k)[1:], Qt, tv))
	expr("tweakverify/k-n-and-p-off-curve", "d", sc(offX, be32(n), Qt, tv))
	expr("tweakverify/underflow", "d", sc(be32(k), Qt, tv))
}

// notOnCurveX is the smallest x < p with no secp256k1 point.
func notOnCurveX() []byte {
	p := btcec.S256().P
	for x := int64(1); ; x++ {
		X := big.NewInt(x)
		y2 := new(big.Int).Exp(X, big.NewInt(3), p)
		y2.Add(y2, big.NewInt(7)).Mod(y2, p)
		if new(big.Int).ModSqrt(y2, p) == nil {
			return be32(X)
		}
	}
}

// ---------- CHECKSIGFROMSTACK

func bip340Sign(k *btcec.PrivateKey, msg []byte) []byte {
	n := btcec.S256().N
	d := new(big.Int).SetBytes(k.Serialize())
	if k.PubKey().Y().Bit(0) == 1 {
		d.Sub(n, d)
	}
	seed := sha256.Sum256(append([]byte("t4-nonce"), msg...))
	k0 := new(big.Int).Mod(new(big.Int).SetBytes(seed[:]), n)
	rx, ry := btcec.S256().ScalarBaseMult(be32(k0))
	if ry.Bit(0) == 1 {
		k0.Sub(n, k0)
	}
	e := chainhash.TaggedHash(chainhash.TagBIP0340Challenge, be32(rx), xonly(k), msg)
	ev := new(big.Int).Mod(new(big.Int).SetBytes(e[:]), n)
	s := new(big.Int).Mod(new(big.Int).Add(k0, new(big.Int).Mul(ev, d)), n)
	return append(be32(rx), be32(s)...)
}

func csfsCases() {
	cs := byte(A.OP_CHECKSIGFROMSTACK)
	msg := func(tag string) []byte { h := sha256.Sum256([]byte(tag)); return h[:] }
	m := msg("t4-msg")
	sig := schnorrSig(kS, m)
	if s2 := bip340Sign(kS, m); !schnorrOK(s2, m) {
		panic("bip340Sign broken")
	}
	n := btcec.S256().N
	p := btcec.S256().P
	expr("csfs/schnorr-valid", "d", sc(sig, m, pkS(), cs))
	expr("csfs/schnorr-wrong-message", "d", sc(sig, msg("other"), pkS(), cs))
	m33 := append(append([]byte{}, m...), 0x01)
	m31 := m[:31]
	expr("csfs/schnorr-33-byte-message-validly-signed", "d", sc(bip340Sign(kS, m33), m33, pkS(), cs))
	expr("csfs/schnorr-31-byte-message-validly-signed", "d", sc(bip340Sign(kS, m31), m31, pkS(), cs))
	expr("csfs/schnorr-empty-message-validly-signed", "d", sc(bip340Sign(kS, nil), []byte{}, pkS(), cs))
	expr("csfs/schnorr-65-byte-sig", "d", sc(append(append([]byte{}, sig...), 0x01), m, pkS(), cs))
	expr("csfs/schnorr-63-byte-sig", "d", sc(sig[:63], m, pkS(), cs))
	expr("csfs/schnorr-r-equals-p", "d", sc(cat(be32(p), sig[32:]), m, pkS(), cs))
	expr("csfs/schnorr-s-equals-n", "d", sc(cat(sig[:32], be32(n)), m, pkS(), cs))
	sPlusN := new(big.Int).Add(new(big.Int).SetBytes(sig[32:]), n)
	if sPlusN.BitLen() <= 256 {
		expr("csfs/schnorr-s-plus-n", "d", sc(cat(sig[:32], be32(sPlusN)), m, pkS(), cs))
	}
	expr("csfs/empty-sig-garbage-key", "d", sc([]byte{}, m, []byte{1, 2, 3, 4, 5}, cs))
	expr("csfs/empty-sig-empty-key", "d", sc([]byte{}, m, []byte{}, cs))
	expr("csfs/empty-key", "d", sc(sig, m, []byte{}, cs))
	expr("csfs/bare-compressed-key", "d", sc(sig, m, kS.PubKey().SerializeCompressed(), cs))
	expr("csfs/prefix-0x12", "d", sc(sig, m, cat([]byte{0x12}, kE.PubKey().SerializeCompressed()), cs))
	expr("csfs/prefix-0x10-short", "d", sc(sig, m, cat([]byte{0x10}, xonly(kE)), cs))
	expr("csfs/35-byte-key", "d", sc(sig, m, cat(pkE(), []byte{0}), cs))
	expr("csfs/xonly-x-too-big", "d", sc(sig, m, rep(0xff, 32), cs))
	expr("csfs/xonly-x-equals-p", "d", sc(sig, m, be32(p), cs))
	expr("csfs/xonly-not-on-curve", "d", sc(sig, m, notOnCurveX(), cs))

	ek := ecdsaK1(kE, m, false)
	expr("csfs/ecdsa-k1-valid", "d", sc(ek, m, pkE(), cs))
	expr("csfs/ecdsa-k1-high-s", "d", sc(ecdsaK1(kE, m, true), m, pkE(), cs))
	expr("csfs/ecdsa-k1-wrong-message", "d", sc(ek, msg("other"), pkE(), cs))
	expr("csfs/ecdsa-k1-33-byte-message", "d", sc(ek, m33, pkE(), cs))
	expr("csfs/ecdsa-k1-65-byte-sig", "d", sc(append(append([]byte{}, ek...), 1), m, pkE(), cs))
	expr("csfs/ecdsa-k1-r-zero", "d", sc(cat(be32(new(big.Int)), ek[32:]), m, pkE(), cs))
	expr("csfs/ecdsa-k1-r-equals-n", "d", sc(cat(be32(n), ek[32:]), m, pkE(), cs))
	expr("csfs/ecdsa-k1-s-zero", "d", sc(cat(ek[:32], be32(new(big.Int))), m, pkE(), cs))
	half := new(big.Int).Rsh(n, 1)
	expr("csfs/ecdsa-k1-s-half-order-plus-1", "d", sc(cat(ek[:32], be32(new(big.Int).Add(half, big.NewInt(1)))), m, pkE(), cs))
	expr("csfs/ecdsa-k1-key-prefix-04", "d", sc(ek, m, cat([]byte{0x10, 0x04}, xonly(kE)), cs))
	expr("csfs/ecdsa-k1-key-x-too-big", "d", sc(ek, m, cat([]byte{0x10, 0x02}, be32(p)), cs))
	expr("csfs/ecdsa-k1-key-off-curve", "d", sc(ek, m, cat([]byte{0x10, 0x02}, notOnCurveX()), cs))
	expr("csfs/ecdsa-k1-key-odd-parity-wrong", "d", sc(ek, m, cat([]byte{0x10}, flipParity(kE.PubKey().SerializeCompressed())), cs))

	er := ecdsaR1(dR1, m, false)
	r1n := elliptic.P256().Params().N
	r1p := elliptic.P256().Params().P
	expr("csfs/ecdsa-r1-valid", "d", sc(er, m, pkR1(), cs))
	expr("csfs/ecdsa-r1-high-s", "d", sc(ecdsaR1(dR1, m, true), m, pkR1(), cs))
	expr("csfs/ecdsa-r1-31-byte-message", "d", sc(er, m31, pkR1(), cs))
	expr("csfs/ecdsa-r1-r-equals-n", "d", sc(cat(be32(r1n), er[32:]), m, pkR1(), cs))
	expr("csfs/ecdsa-r1-key-x-equals-p", "d", sc(er, m, cat([]byte{0x11, 0x03}, be32(r1p)), cs))
	expr("csfs/ecdsa-r1-key-prefix-05", "d", sc(er, m, cat([]byte{0x11, 0x05}, pkR1()[2:]), cs))
	expr("csfs/ecdsa-r1-key-off-curve", "d", sc(er, m, cat([]byte{0x11, 0x02}, r1NotOnCurveX()), cs))
	expr("csfs/ecdsa-r1-key-used-as-k1", "d", sc(er, m, cat([]byte{0x10}, pkR1()[1:]), cs))
	expr("csfs/underflow", "d", sc(m, pkS(), cs))
	var many []any
	for i := 0; i < 51; i++ {
		many = append(many, []byte{}, []byte{}, []byte{}, cs)
	}
	expr("csfs/unmetered-in-expression-mode", "d", sc(many...))
}

func schnorrOK(sig, m []byte) bool {
	s, err := schnorr.ParseSignature(sig)
	return err == nil && s.Verify(m, kS.PubKey())
}

func flipParity(b []byte) []byte { c := append([]byte{}, b...); c[0] ^= 1; return c }

func r1NotOnCurveX() []byte {
	pr := elliptic.P256().Params()
	for x := int64(1); ; x++ {
		X := big.NewInt(x)
		y2 := new(big.Int).Exp(X, big.NewInt(3), pr.P)
		y2.Sub(y2, new(big.Int).Mul(X, big.NewInt(3))).Add(y2, pr.B).Mod(y2, pr.P)
		if new(big.Int).ModSqrt(y2, pr.P) == nil {
			return be32(X)
		}
	}
}

// ---------- covenant signature opcodes

func sigCases() {
	CS, CSV_, CSA := byte(txscript.OP_CHECKSIG), byte(txscript.OP_CHECKSIGVERIFY), byte(txscript.OP_CHECKSIGADD)
	d := worlds["d"]
	dg := func(idx, ht int, cs *uint32) []byte { return mustSighash(d, idx, defaultLeaf, ht, cs) }
	sigS := func(ht int) []byte {
		s := schnorrSig(kS, dg(0, ht, nil))
		if ht != 0 {
			s = append(s, byte(ht))
		}
		return s
	}
	cov("checksig/schnorr-default", "d", 0, sc(pkS(), CS), sigS(0))
	for _, ht := range []int{1, 2, 3, 0x81, 0x82, 0x83} {
		cov("checksig/schnorr-hashtype-"+hx(ht), "d", 0, sc(pkS(), CS), sigS(ht))
	}
	def := sigS(0)
	cov("checksig/default-sig-relabelled-all", "d", 0, sc(pkS(), CS), append(append([]byte{}, def...), 1))
	cov("checksig/trailing-zero-byte", "d", 0, sc(pkS(), CS), append(append([]byte{}, def...), 0))
	cov("checksig/hashtype-0x80", "d", 0, sc(pkS(), CS), append(append([]byte{}, def...), 0x80))
	cov("checksig/hashtype-0x04", "d", 0, sc(pkS(), CS), append(append([]byte{}, def...), 0x04))
	cov("checksig/63-byte-sig", "d", 0, sc(pkS(), CS), def[:63])
	cov("checksig/66-byte-sig", "d", 0, sc(pkS(), CS), append(append([]byte{}, def...), 1, 1))
	badSig := append([]byte{}, def...)
	badSig[10] ^= 1
	cov("checksig/bad-sig-nullfail", "d", 0, sc(pkS(), CS), badSig)
	cov("checksig/empty-sig-pushes-false", "d", 0, sc(pkS(), CS), []byte{})
	cov("checksig/empty-key", "d", 0, sc([]byte{}, CS), def)
	cov("checksig/empty-key-empty-sig", "d", 0, sc([]byte{}, CS), []byte{})
	bare := kS.PubKey().SerializeCompressed()
	cov("checksig/bare-key-empty-sig-not-parsed", "d", 0, sc(bare, CS), []byte{})
	cov("checksig/bare-key", "d", 0, sc(bare, CS), def)
	cov("checksig/bare-key-before-sig-length", "d", 0, sc(bare, CS), def[:63])
	cov("checksig/xonly-x-too-big", "d", 0, sc(rep(0xff, 32), CS), def)
	cov("checksig/xonly-not-on-curve", "d", 0, sc(notOnCurveX(), CS), def)
	cov("checksig/xonly-not-on-curve-63-byte-sig", "d", 0, sc(notOnCurveX(), CS), def[:63])
	cov("checksig/ecdsa-k1-default", "d", 0, sc(pkE(), CS), ecdsaK1(kE, dg(0, 0, nil), false))
	cov("checksig/ecdsa-k1-all", "d", 0, sc(pkE(), CS), append(ecdsaK1(kE, dg(0, 1, nil), false), 1))
	cov("checksig/ecdsa-k1-high-s", "d", 0, sc(pkE(), CS), ecdsaK1(kE, dg(0, 0, nil), true))
	cov("checksig/ecdsa-k1-bad-key", "d", 0, sc(cat([]byte{0x10, 0x02}, notOnCurveX()), CS), def)
	cov("checksig/ecdsa-r1-default", "d", 0, sc(pkR1(), CS), ecdsaR1(dR1, dg(0, 0, nil), false))
	cov("checksig/ecdsa-r1-anyonecanpay-single", "d", 0, sc(pkR1(), CS), append(ecdsaR1(dR1, dg(0, 0x83, nil), false), 0x83))
	cov("checksig/ecdsa-r1-high-s", "d", 0, sc(pkR1(), CS), ecdsaR1(dR1, dg(0, 0, nil), true))
	cov("checksig/schnorr-key-ecdsa-sig", "d", 0, sc(pkS(), CS), ecdsaK1(kS, dg(0, 0, nil), false))
	cov("checksig/input-1", "d", 1, sc(pkS(), CS), schnorrSig(kS, dg(1, 0, nil)))
	cov("checksig/input-1-with-input-0-sig", "d", 1, sc(pkS(), CS), def)
	cov("checksig/single-at-last-output", "d", 2, sc(pkS(), CS), append(schnorrSig(kS, dg(2, 3, nil)), 3))
	fewDefault := schnorrSig(kS, mustSighash(worlds["few"], 2, defaultLeaf, 0, nil))
	cov("checksig/single-without-output-nullfail", "few", 2, sc(pkS(), CS), append(append([]byte{}, fewDefault...), 3))
	cov("checksig/few-default", "few", 2, sc(pkS(), CS), fewDefault)
	leaf2 := sc(xonly(keyN(2)), byte(txscript.OP_CHECKSIG))
	cov("checksig/other-leaf", "d", 0, sc(pkS(), CS), schnorrSig(kS, mustSighash(d, 0, leaf2, 0, nil))).withLeaf(leaf2)
	cov("checksig/sig-for-other-leaf", "d", 0, sc(pkS(), CS), schnorrSig(kS, mustSighash(d, 0, leaf2, 0, nil)))
	cov("checksig/non-p2tr-prevouts", "nonp2tr", 1, sc(pkS(), CS), schnorrSig(kS, mustSighash(worlds["nonp2tr"], 1, defaultLeaf, 0, nil)))

	cov("checksigverify/valid", "d", 0, sc(pkS(), CSV_, 1), def)
	cov("checksigverify/empty-sig", "d", 0, sc(pkS(), CSV_, 1), []byte{})
	cov("checksigverify/bad-sig", "d", 0, sc(pkS(), CSV_, 1), badSig)

	cov("checksigadd/valid-from-0", "d", 0, sc(0, pkS(), CSA), def)
	cov("checksigadd/valid-int32-max-pushes-5-bytes", "d", 0, sc(int64(math.MaxInt32), pkS(), CSA), def)
	cov("checksigadd/valid-from-negative-1", "d", 0, sc(-1, pkS(), CSA), def)
	cov("checksigadd/empty-sig-keeps-n", "d", 0, sc(5, pkS(), CSA), []byte{})
	cov("checksigadd/empty-sig-bare-key", "d", 0, sc(5, bare, CSA), []byte{})
	cov("checksigadd/empty-key", "d", 0, sc(5, []byte{}, CSA), def)
	cov("checksigadd/n-non-minimal", "d", 0, sc([]byte{5, 0}, pkS(), CSA), def)
	cov("checksigadd/n-5-bytes", "d", 0, sc(int64(1)<<32, pkS(), CSA), def)
	cov("checksigadd/bad-sig", "d", 0, sc(0, pkS(), CSA), badSig)
	cov("checksigadd/bad-key-scheme", "d", 0, sc(0, bare, CSA), def)
	sigE := ecdsaK1(kE, dg(0, 0, nil), false)
	cov("checksigadd/two-of-two", "d", 0, sc(pkS(), CS, pkE(), CSA), sigE, def)

	// OP_CODESEPARATOR: opcode position, not byte offset
	cpos := func(p uint32) []byte { return schnorrSig(kS, dg(0, 0, u32p(p))) }
	sep := byte(txscript.OP_CODESEPARATOR)
	cov("codesep/first-opcode", "d", 0, sc(sep, cpos(0), pkS(), CS))
	cov("codesep/after-one-push", "d", 0, sc(cpos(1), sep, pkS(), CS))
	cov("codesep/after-pushes-position-2", "d", 0, sc([]byte{0xaa, 0xbb}, []byte{0xcc, 0xdd}, sep, cpos(2), pkS(), CS))
	cov("codesep/byte-offset-is-wrong", "d", 0, sc([]byte{0xaa, 0xbb}, []byte{0xcc, 0xdd}, sep, cpos(6), pkS(), CS))
	cov("codesep/blank-is-wrong", "d", 0, sc([]byte{0xaa, 0xbb}, sep, schnorrSig(kS, dg(0, 0, nil)), pkS(), CS))
	cov("codesep/last-one-wins", "d", 0, sc(sep, []byte{0xaa, 0xbb}, sep, cpos(2), pkS(), CS))
	cov("codesep/sighash-after-separator", "d", 0, sc(sep, 1, byte(A.OP_SIGHASH)))

	// OP_SIGHASH pushes the digest CHECKSIG verifies
	sh := byte(A.OP_SIGHASH)
	for _, ht := range []int{0, 1, 2, 3, 0x81, 0x82, 0x83} {
		cov("sighash/flag-"+hx(ht), "d", 0, sc(ht, sh))
	}
	cov("sighash/input-2-single", "d", 2, sc(3, sh))
	cov("sighash/flag-0x04", "d", 0, sc(4, sh))
	cov("sighash/flag-0x80", "d", 0, sc(0x80, sh))
	cov("sighash/flag-0x100", "d", 0, sc(0x100, sh))
	cov("sighash/flag-negative", "d", 0, sc(-1, sh))
	cov("sighash/flag-5-bytes", "d", 0, sc(int64(1)<<32, sh))
	cov("sighash/flag-non-minimal", "d", 0, sc([]byte{1, 0}, sh))
	cov("sighash/single-without-output", "few", 2, sc(3, sh))
	cov("sighash/acp-single-without-output", "few", 2, sc(0x83, sh))
	cov("sighash/few-input-0-single", "few", 0, sc(3, sh))
	cov("sighash/empty-stack", "d", 0, sc(sh))
	cov("sighash/non-p2tr-prevouts-acp", "nonp2tr", 0, sc(0x81, sh))
	cov("sighash/other-leaf", "d", 0, sc(0, sh)).withLeaf(leaf2)

	cm := byte(txscript.OP_CHECKMULTISIG)
	cov("checkmultisig/covenant", "d", 0, sc(1, cm))
	cov("checkmultisigverify/covenant", "d", 0, sc(1, byte(txscript.OP_CHECKMULTISIGVERIFY)))

	// masked sighash through Execute (TS stubs the codec with the pinned masked output)
	mw := worlds["mask"]
	cov("checksig/masked-default", "mask", 0, sc(pkS(), CS), schnorrSig(kS, mustSighash(mw, 0, defaultLeaf, 0, nil)))
	cov("checksig/masked-single-at-extension-output", "mask", 1, sc(pkS(), CS), append(schnorrSig(kS, mustSighash(mw, 1, defaultLeaf, 3, nil)), 3))

	// expression mode: no taproot context
	for _, op := range []byte{CS, CSV_, CSA, sep, sh} {
		expr("noctx/"+hx(int(op)), "d", sc(def, 0, pkS(), op))
	}
	expr("noctx/checkmultisig", "d", sc(1, cm))
	expr("noctx/checkmultisigverify", "d", sc(1, byte(txscript.OP_CHECKMULTISIGVERIFY)))

	limitCases(def)
}

func limitCases(def []byte) {
	CS := byte(txscript.OP_CHECKSIG)
	empty := func(n int, ops ...any) []byte {
		var parts []any
		for i := 0; i < n; i++ {
			parts = append(parts, ops...)
		}
		return sc(parts...)
	}
	cov("limits/checksig-charged-on-empty-sig", "d", 0, sc([]byte{}, pkS(), CS)).withLimits(map[byte]int{CS: 0})
	cov("limits/checksig-second-call", "d", 0, empty(2, []byte{}, pkS(), CS)).withLimits(map[byte]int{CS: 1})
	cov("limits/checksig-default-51", "d", 0, empty(51, []byte{}, pkS(), CS))
	cov("limits/checksig-default-50", "d", 0, empty(50, []byte{}, pkS(), CS))
	cov("limits/checksigadd-counted-separately", "d", 0, sc(append(append([]any{}, anyBytes(empty(50, []byte{}, pkS(), CS))...), []byte{}, 0, pkS(), byte(txscript.OP_CHECKSIGADD))...))
	for _, op := range []byte{byte(txscript.OP_CHECKSIGVERIFY), byte(txscript.OP_CHECKSIGADD), A.OP_CHECKSIGFROMSTACK,
		A.OP_ECADD, A.OP_ECMUL, A.OP_ECPAIRING, A.OP_ECMULSCALARVERIFY, A.OP_TWEAKVERIFY} {
		cov("limits/charged-before-pops-"+hx(int(op)), "d", 0, sc(op)).withLimits(map[byte]int{op: 0})
	}
	cov("limits/csfs-default-51", "d", 0, empty(51, []byte{}, []byte{}, []byte{}, byte(A.OP_CHECKSIGFROMSTACK)))
	_, _, g1, _ := gnarkbn254.Generators()
	var x, y big.Int
	g1.X.BigInt(&x)
	g1.Y.BigInt(&y)
	onePair := []any{&x, &y, []byte{}, []byte{}, []byte{}, []byte{}, 1, 2, byte(A.OP_ECPAIRING)}
	cov("limits/ecpairing-default-2", "d", 0, empty(3, onePair...))
	cov("limits/ecpairing-default-2-ok", "d", 0, empty(2, onePair...))
	cov("limits/absent-opcode-is-unlimited", "d", 0, empty(51, []byte{}, pkS(), CS)).withLimits(map[byte]int{0x87: 5})
	_ = def
}

func anyBytes(b []byte) []any { return []any{raw(b)} }

func hx(v int) string {
	const digits = "0123456789abcdef"
	return "0x" + string(digits[v>>4&0xf]) + string(digits[v&0xf])
}

// ---------- direct digests

func digestCases() {
	for _, ht := range []int{0, 1, 2, 3, 0x81, 0x82, 0x83} {
		digest("d/idx0/"+hx(ht), "d", 0, ht, nil)
		digest("d/idx0/"+hx(ht)+"/codesep-7", "d", 0, ht, u32p(7))
	}
	for _, ht := range []int{0, 3, 0x83} {
		digest("d/idx1/"+hx(ht), "d", 1, ht, nil)
	}
	for _, ht := range []int{2, 0x82} {
		digest("d/idx2/"+hx(ht), "d", 2, ht, nil)
	}
	digest("d/idx0/codesep-0", "d", 0, 0, u32p(0))
	digest("d/idx0/codesep-max-minus-1", "d", 0, 0, u32p(0xfffffffe))
	for _, ht := range []int{0x04, 0x80, 0x84, 0xff} {
		digest("d/invalid/"+hx(ht), "d", 0, ht, nil)
	}
	digest("few/idx2/single-no-output", "few", 2, 3, nil)
	digest("few/idx2/acp-single-no-output", "few", 2, 0x83, nil)
	digest("few/idx0/single", "few", 0, 3, nil)
	digest("few/idx2/none", "few", 2, 2, nil)
	for _, ht := range []int{0, 0x81, 3} {
		digest("nonp2tr/idx0/"+hx(ht), "nonp2tr", 0, ht, nil)
	}
	for _, w := range []string{"mask", "maskbad", "extnoemu"} {
		for _, ht := range []int{0, 1, 2, 3, 0x83} {
			digest(w+"/idx0/"+hx(ht), w, 0, ht, nil)
			digest(w+"/idx1/"+hx(ht), w, 1, ht, nil)
		}
	}
	digest("mask0/idx0/single-at-extension", "mask0", 0, 3, nil)
	digest("mask0/idx1/single", "mask0", 1, 3, nil)
	digest("mask0/idx0/default", "mask0", 0, 0, nil)
}
