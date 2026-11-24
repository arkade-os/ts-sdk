package main

import (
	"crypto/elliptic"
	"crypto/sha256"
	"math"
	"math/big"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	. "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	becdsa "github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	gnarkbn254 "github.com/consensys/gnark-crypto/ecc/bn254"
)

func emulatorPacketWorld(name string, entries ...EmulatorEntry) *world {
	p, err := NewPacket(entries...)
	if err != nil {
		panic(err)
	}
	data, _ := p.Serialize()
	return txWith(name, func(tx *wire.MsgTx) { tx.AddTxOut(extOut(extension.UnknownPacket{PacketType: PacketType, Data: data})) })
}

func extOut(pkts ...extension.Packet) *wire.TxOut {
	out, err := extension.Extension(pkts).TxOut()
	if err != nil {
		panic(err)
	}
	return out
}

func introspectHand() []*Case {
	b := &book{}
	coverageCases(b, "introspect")
	for _, i := range []int{0, 1, 2, -1} {
		b.ex("introspect/OP_INSPECTINPUTOUTPOINT/index-"+itoa(i), OP_INSPECTINPUTOUTPOINT, "3.9/outpoint-internal-order", sc(i, o(OP_INSPECTINPUTOUTPOINT)))
		b.ex("introspect/OP_INSPECTINPUTVALUE/index-"+itoa(i), OP_INSPECTINPUTVALUE, "3.9/value-vs-script-sources", sc(i, o(OP_INSPECTINPUTVALUE)))
		b.ex("introspect/OP_INSPECTINPUTSCRIPTPUBKEY/index-"+itoa(i), OP_INSPECTINPUTSCRIPTPUBKEY, "3.9/value-vs-script-sources", sc(i, o(OP_INSPECTINPUTSCRIPTPUBKEY)))
		b.ex("introspect/OP_INSPECTINPUTSEQUENCE/index-"+itoa(i), OP_INSPECTINPUTSEQUENCE, "3.9/index-negative", sc(i, o(OP_INSPECTINPUTSEQUENCE)))
		b.ex("introspect/OP_INSPECTOUTPUTVALUE/index-"+itoa(i), OP_INSPECTOUTPUTVALUE, "3.9/index-negative", sc(i, o(OP_INSPECTOUTPUTVALUE)))
		b.ex("introspect/OP_INSPECTOUTPUTSCRIPTPUBKEY/index-"+itoa(i), OP_INSPECTOUTPUTSCRIPTPUBKEY, "3.9/pushscriptpubkey-sentinel", sc(i, o(OP_INSPECTOUTPUTSCRIPTPUBKEY)))
	}
	d := defaultWorld()
	missing := &world{name: "in1-unfetchable", tx: d.tx, prevouts: d.prevouts[:1]}
	b.ex("introspect/OP_INSPECTINPUTVALUE/fetcher-miss", OP_INSPECTINPUTVALUE, "2.6/fetcher-nil", sc(1, o(OP_INSPECTINPUTVALUE)), inW(missing))
	b.ex("introspect/OP_INSPECTINPUTSCRIPTPUBKEY/vtxo-miss-is-hard", OP_INSPECTINPUTSCRIPTPUBKEY, "2.6/fetcher-nil", sc(1, o(OP_INSPECTINPUTSCRIPTPUBKEY)))
	legacyVtxo := &world{name: "in1-legacy-vtxo", tx: d.tx, prevouts: []prevout{d.prevouts[0], {op: d.prevouts[1].op, out: d.prevouts[1].out, vtxo: d.prevouts[1].out.PkScript}}}
	b.ex("introspect/OP_INSPECTINPUTSCRIPTPUBKEY/non-witness-hash-and-minus-one", OP_INSPECTINPUTSCRIPTPUBKEY, "3.9/pushscriptpubkey-sentinel", sc(1, o(OP_INSPECTINPUTSCRIPTPUBKEY)), inW(legacyVtxo))
	for _, v := range []int64{-1, 2_100_000_000_000_000, 2_100_000_000_000_001, 0} {
		w := &world{name: "in0-value-" + big.NewInt(v).String(), tx: d.tx, prevouts: []prevout{{op: d.prevouts[0].op, out: &wire.TxOut{Value: v, PkScript: p2tr(3)}}, d.prevouts[1]}}
		b.ex("introspect/OP_INSPECTINPUTVALUE/value-"+big.NewInt(v).String(), OP_INSPECTINPUTVALUE, "3.9/value-range", sc(0, o(OP_INSPECTINPUTVALUE)), inW(w))
	}
	outs := txWith("odd-outputs", func(tx *wire.MsgTx) {
		tx.TxOut = []*wire.TxOut{
			{Value: 1, PkScript: []byte{txscript.OP_RETURN, 1, 7}},
			{Value: 2, PkScript: append([]byte{txscript.OP_16, 2}, 0xbe, 0xef)},
			{Value: 3, PkScript: append([]byte{txscript.OP_1, 40}, rep(0x44, 40)...)},
			{Value: 4, PkScript: append([]byte{txscript.OP_1, 41}, rep(0x44, 41)...)},
			{Value: 5, PkScript: []byte{}},
			{Value: -1, PkScript: []byte{}},
		}
	})
	for i := 0; i < 6; i++ {
		b.ex("introspect/OP_INSPECTOUTPUTSCRIPTPUBKEY/odd-"+itoa(i), OP_INSPECTOUTPUTSCRIPTPUBKEY, "3.9/pushscriptpubkey-sentinel", sc(i, o(OP_INSPECTOUTPUTSCRIPTPUBKEY)), inW(outs))
		b.ex("introspect/OP_INSPECTOUTPUTVALUE/odd-"+itoa(i), OP_INSPECTOUTPUTVALUE, "3.9/value-range", sc(i, o(OP_INSPECTOUTPUTVALUE)), inW(outs))
	}
	for _, v := range []int32{-1, 3, 1} {
		w := txWith("version-"+itoa(int(v)), func(tx *wire.MsgTx) { tx.Version = v })
		b.ex("introspect/OP_INSPECTVERSION/version-"+itoa(int(v)), OP_INSPECTVERSION, "3.9/inspectversion-uint32", sc(o(OP_INSPECTVERSION)), inW(w))
	}
	maxLock := txWith("locktime-max", func(tx *wire.MsgTx) { tx.LockTime = math.MaxUint32 })
	b.ex("introspect/OP_INSPECTLOCKTIME/max", OP_INSPECTLOCKTIME, "", sc(o(OP_INSPECTLOCKTIME)), inW(maxLock))
	b.ex("introspect/OP_INSPECTLOCKTIME/default", OP_INSPECTLOCKTIME, "", sc(o(OP_INSPECTLOCKTIME)))
	b.ex("introspect/counts", OP_INSPECTNUMINPUTS, "", sc(o(OP_INSPECTNUMINPUTS, OP_INSPECTNUMOUTPUTS)))
	b.ex("introspect/OP_INSPECTNUMOUTPUTS/default", OP_INSPECTNUMOUTPUTS, "", sc(o(OP_INSPECTNUMOUTPUTS)))
	b.ex("introspect/OP_TXWEIGHT/stripped-times-four", OP_TXWEIGHT, "3.9/txweight-txid-stripped", sc(o(OP_TXWEIGHT)))
	b.ex("introspect/OP_TXID/stripped-internal-order", OP_TXID, "3.9/txweight-txid-stripped", sc(o(OP_TXID)))
	b.ex("introspect/OP_TXID/scriptsig-changes-it", OP_TXID, "3.9/txweight-txid-stripped", sc(o(OP_TXID)),
		inW(txWith("scriptsig-one", func(tx *wire.MsgTx) { tx.TxIn[0].SignatureScript = []byte{txscript.OP_1} })))
	b.ex("introspect/OP_PUSHCURRENTINPUTINDEX/at-1", OP_PUSHCURRENTINPUTINDEX, "", sc(o(OP_PUSHCURRENTINPUTINDEX)), at(1, 3000))
	ep := emulatorPacketWorld("emulator-packet",
		EmulatorEntry{Vin: 1, Script: []byte{OP_1}, Witness: wire.TxWitness{{0xaa}, {}}},
		EmulatorEntry{Vin: 0, Script: []byte{OP_2, OP_DROP}})
	for _, i := range []int{0, 1, 2, -1} {
		b.ex("introspect/OP_INSPECTINPUTARKADESCRIPTHASH/vin-"+itoa(i), OP_INSPECTINPUTARKADESCRIPTHASH, "3.9/arkadescripthash-by-vin", sc(i, o(OP_INSPECTINPUTARKADESCRIPTHASH)), inW(ep), pk())
		b.ex("introspect/OP_INSPECTINPUTARKADEWITNESSHASH/vin-"+itoa(i), OP_INSPECTINPUTARKADEWITNESSHASH, "3.9/witnesshash-empty", sc(i, o(OP_INSPECTINPUTARKADEWITNESSHASH)), inW(ep), pk())
	}
	b.ex("introspect/OP_INSPECTINPUTARKADESCRIPTHASH/no-packet", OP_INSPECTINPUTARKADESCRIPTHASH, "3.9/arkadescripthash-by-vin", sc(0, o(OP_INSPECTINPUTARKADESCRIPTHASH)))
	one := emulatorPacketWorld("emulator-packet-vin0", EmulatorEntry{Vin: 0, Script: []byte{OP_1}})
	b.ex("introspect/OP_INSPECTINPUTARKADESCRIPTHASH/no-entry", OP_INSPECTINPUTARKADESCRIPTHASH, "3.9/arkadescripthash-by-vin", sc(1, o(OP_INSPECTINPUTARKADESCRIPTHASH)), inW(one), pk())
	b.cov("introspect/covenant/reads-own-packet", OP_INSPECTINPUTARKADEWITNESSHASH, "3.9/witnesshash-empty", sc(o(OP_PUSHCURRENTINPUTINDEX, OP_INSPECTINPUTARKADEWITNESSHASH, OP_SIZE), 32, o(OP_EQUALVERIFY, OP_DROP, OP_1)), nil, inW(ep))
	return b.cases
}

func timeHand() []*Case {
	b := &book{}
	cltv := func(name, hz string, v any, mods ...mod) {
		b.ex("time/OP_CHECKLOCKTIMEVERIFY/"+name, OP_CHECKLOCKTIMEVERIFY, hz, sc(v, o(OP_CHECKLOCKTIMEVERIFY)), mods...)
	}
	cltv("below", "3.10/cltv", 500000)
	cltv("equal", "3.10/cltv", 600000)
	cltv("above", "3.10/cltv", 600001)
	cltv("time-vs-height", "3.10/cltv", 500000000)
	cltv("negative", "3.10/cltv", -1)
	cltv("five-bytes", "3.10/cltv", n64(1<<32))
	cltv("eight-bytes-small-path", "3.1/usebig", n64(1<<62))
	cltv("nine-bytes-big-path", "3.1/usebig", num(pow2(63)))
	cltv("non-minimal", "3.10/cltv", raw(push([]byte{1, 0})))
	cltv("empty-stack", "3.10/cltv", raw{})
	cltv("input-final", "3.10/cltv", 500000, inW(txWith("in0-final", func(tx *wire.MsgTx) { tx.TxIn[0].Sequence = wire.MaxTxInSequenceNum })))
	timeLock := txWith("locktime-time", func(tx *wire.MsgTx) { tx.LockTime = 1_700_000_000 })
	cltv("time-below", "3.10/cltv", 1_600_000_000, inW(timeLock))
	cltv("height-vs-time", "3.10/cltv", 500, inW(timeLock))
	csv := func(name, hz string, v any, mods ...mod) {
		b.ex("time/OP_CHECKSEQUENCEVERIFY/"+name, OP_CHECKSEQUENCEVERIFY, hz, sc(v, o(OP_CHECKSEQUENCEVERIFY)), append([]mod{at(1, 3000)}, mods...)...)
	}
	csv("below", "3.10/csv", 5)
	csv("equal", "3.10/csv", 10)
	csv("above", "3.10/csv", 11)
	csv("disable-bit-is-nop", "3.10/csv", int64(1<<31|500))
	csv("seconds-vs-blocks", "3.10/csv", 1<<22|5)
	csv("non-consensus-bits-masked", "3.10/csv", 1<<20|5)
	csv("negative", "3.10/csv", -5)
	csv("five-bytes", "3.10/csv", n64(1<<32))
	csv("nine-bytes", "3.1/usebig", num(pow2(63)))
	csv("version-1", "3.10/csv", 5, inW(txWith("version-1-csv", func(tx *wire.MsgTx) { tx.Version = 1 })))
	b.ex("time/OP_CHECKSEQUENCEVERIFY/tx-disable-bit", OP_CHECKSEQUENCEVERIFY, "3.10/csv", sc(5, o(OP_CHECKSEQUENCEVERIFY)))
	px := func(name, hz string, mods ...mod) {
		b.ex("time/OP_PUSHEXPIRY/"+name, OP_PUSHEXPIRY, hz, sc(o(OP_PUSHEXPIRY)), mods...)
	}
	px("unset", "3.10/pushexpiry")
	px("typical", "3.10/pushexpiry", exp(1_764_000_000))
	px("negative", "3.10/pushexpiry", exp(-5))
	px("max-int64", "3.1/pushint-poison", exp(math.MaxInt64))
	px("min-int64-panics", "3.1/pushexpiry-minint64", exp(math.MinInt64))
	px("zero", "3.10/pushexpiry", exp(0))
	b.ex("time/OP_PUSHEXPIRY/eight-bytes-poison-pick", OP_PICK, "3.1/pushint-poison", sc(o(OP_PUSHEXPIRY, OP_PICK)), exp(math.MaxInt64))
	ct := func(name, hz string, v any) {
		b.ex("time/OP_CHECKTIME/"+name, OP_CHECKTIME, hz, sc(v, o(OP_CHECKTIME)))
	}
	ct("zero-is-past", "3.10/checktime", 0)
	ct("2001-is-past", "3.10/checktime", 1_000_000_000)
	ct("far-future", "3.10/checktime", pow2(40))
	ct("nine-byte-future", "3.10/checktime", pow2(80))
	ct("negative", "3.10/checktime", -1)
	ct("non-minimal", "3.10/checktime", raw(push([]byte{5, 0})))
	return b.cases
}

var sigKey = keyN(7)

func sighashFor(w *world, idx int, leaf []byte, ht txscript.SigHashType, codeSep ...uint32) []byte {
	f := w.fetcher()
	var opts []ArkadeSigHashOption
	if len(codeSep) > 0 {
		opts = append(opts, WithCodeSepPosition(codeSep[0]))
	}
	d, err := CalcArkadeScriptSignatureHash(txscript.NewTxSigHashes(w.tx, f), ht, w.tx, idx, f, txscript.NewTapLeaf(txscript.BaseLeafVersion, leaf), opts...)
	if err != nil {
		panic(err)
	}
	return d
}

func schnorrSig(k *btcec.PrivateKey, digest []byte) []byte {
	s, err := schnorr.Sign(k, digest)
	if err != nil {
		panic(err)
	}
	return s.Serialize()
}

func ecdsaK1(k *btcec.PrivateKey, digest []byte, highS bool) []byte {
	sig := becdsa.Sign(k, digest)
	r, s := sig.R(), sig.S()
	if highS {
		s.Negate()
	}
	rb, sb := r.Bytes(), s.Bytes()
	return append(rb[:], sb[:]...)
}

// ecdsaR1 signs with a nonce derived from the key and digest, so vectors stay stable.
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
	return append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
}

func r1Pub(d *big.Int) []byte {
	x, y := elliptic.P256().ScalarBaseMult(d.Bytes())
	return elliptic.MarshalCompressed(elliptic.P256(), x, y)
}

func sigHand() []*Case {
	b := &book{}
	w := defaultWorld()
	pub := xonly(sigKey)
	d0 := sighashFor(w, 0, defaultLeaf, txscript.SigHashDefault)
	good := schnorrSig(sigKey, d0)
	chk := func(name string, op int, hz string, witness [][]byte, pubkey []byte, mods ...mod) {
		b.cov("sig/"+slots[op].name+"/"+name, op, hz, sc(pubkey, o(op)), witness, mods...)
	}
	chk("valid-default", OP_CHECKSIG, "3.8/tag-arkade-tapsighash", [][]byte{good}, pub)
	all := sighashFor(w, 0, defaultLeaf, txscript.SigHashAll)
	chk("valid-explicit-all", OP_CHECKSIG, "3.8/sighash-byte", [][]byte{append(schnorrSig(sigKey, all), 1)}, pub)
	chk("65-bytes-zero-type", OP_CHECKSIG, "3.8/sighash-byte", [][]byte{append(append([]byte{}, good...), 0)}, pub)
	chk("type-0x80-is-nullfail", OP_CHECKSIG, "3.8/sighash-byte", [][]byte{append(append([]byte{}, good...), 0x80)}, pub)
	chk("63-bytes", OP_CHECKSIG, "3.8/sighash-byte", [][]byte{good[:63]}, pub)
	bad := append([]byte{}, good...)
	bad[10] ^= 1
	chk("invalid-is-nullfail", OP_CHECKSIG, "3.8/checksig-behaviour", [][]byte{bad}, pub)
	chk("empty-sig-pushes-false", OP_CHECKSIG, "3.8/checksig-behaviour", [][]byte{{}}, pub)
	chk("empty-pubkey-before-sig", OP_CHECKSIG, "3.8/pubkey-schemes", [][]byte{{}}, []byte{})
	chk("bare-33-byte-key", OP_CHECKSIG, "3.8/pubkey-schemes", [][]byte{good}, sigKey.PubKey().SerializeCompressed())
	chk("pubkey-popped-first", OP_CHECKSIG, "3.8/checksig-behaviour", [][]byte{pub}, good)
	tapsig, _ := txscript.CalcTapscriptSignaturehash(txscript.NewTxSigHashes(w.tx, w.fetcher()), txscript.SigHashDefault, w.tx, 0, w.fetcher(), txscript.NewTapLeaf(txscript.BaseLeafVersion, defaultLeaf))
	chk("bip342-tag-rejected", OP_CHECKSIG, "3.8/tag-arkade-tapsighash", [][]byte{schnorrSig(sigKey, tapsig)}, pub)
	k1 := append([]byte{0x10}, sigKey.PubKey().SerializeCompressed()...)
	chk("ecdsa-k1-low-s", OP_CHECKSIG, "3.8/low-s", [][]byte{ecdsaK1(sigKey, d0, false)}, k1)
	chk("ecdsa-k1-high-s", OP_CHECKSIG, "3.8/low-s", [][]byte{ecdsaK1(sigKey, d0, true)}, k1)
	rd := big.NewInt(0x1234567)
	r1 := append([]byte{0x11}, r1Pub(rd)...)
	chk("ecdsa-r1-low-s", OP_CHECKSIG, "3.8/low-s", [][]byte{ecdsaR1(rd, d0, false)}, r1)
	chk("ecdsa-r1-high-s", OP_CHECKSIG, "3.8/low-s", [][]byte{ecdsaR1(rd, d0, true)}, r1)
	chk("unknown-scheme-tag", OP_CHECKSIG, "3.8/pubkey-schemes", [][]byte{good}, append([]byte{0x12}, sigKey.PubKey().SerializeCompressed()...))
	chk("x-not-on-curve", OP_CHECKSIG, "3.8/pubkey-schemes", [][]byte{good}, append(rep(0, 31), 5))
	chk("x-too-big", OP_CHECKSIG, "3.8/pubkey-schemes", [][]byte{good}, rep(0xff, 32))
	b.cov("sig/OP_CHECKSIGVERIFY/valid", OP_CHECKSIGVERIFY, "3.8/checksig-behaviour", sc(pub, o(OP_CHECKSIGVERIFY, OP_1)), [][]byte{good})
	b.cov("sig/OP_CHECKSIGVERIFY/empty-sig", OP_CHECKSIGVERIFY, "3.8/checksig-behaviour", sc(pub, o(OP_CHECKSIGVERIFY, OP_1)), [][]byte{{}})
	b.cov("sig/OP_CHECKSIGVERIFY/invalid", OP_CHECKSIGVERIFY, "3.8/checksig-behaviour", sc(pub, o(OP_CHECKSIGVERIFY, OP_1)), [][]byte{bad})
	add := func(name, hz string, sig []byte, n any, tail ...any) {
		b.cov("sig/OP_CHECKSIGADD/"+name, OP_CHECKSIGADD, hz, sc(append([]any{sig, n, pub, o(OP_CHECKSIGADD)}, tail...)...), nil)
	}
	add("valid-increments", "3.8/checksigadd", good, 4, 5, o(OP_NUMEQUAL))
	add("empty-sig-keeps-n", "3.8/checksigadd", []byte{}, 4, 4, o(OP_NUMEQUAL))
	add("five-byte-result-poisons-popint", "3.1/pushint-poison", good, int64(1<<31-1), o(OP_PICK))
	add("five-byte-result-is-bignum-ok", "3.1/pushint-poison", good, int64(1<<31-1), int64(1<<31), o(OP_NUMEQUAL))
	add("invalid", "3.8/checksigadd", bad, 0, o(OP_DROP, OP_1))
	add("five-byte-accumulator", "3.8/checksigadd", good, n64(1<<32), o(OP_DROP, OP_1))
	// OP_SIGHASH pushes the digest CHECKSIG verifies; flags must be valid taproot types
	for _, f := range []int{0, 1, 2, 3, 0x81, 0x82, 0x83} {
		dg := sighashFor(w, 0, defaultLeaf, txscript.SigHashType(f))
		b.cov("sig/OP_SIGHASH/flag-"+itoa(f), OP_SIGHASH, "3.8/sighash-opcode", sc(f, o(OP_SIGHASH), dg, o(OP_EQUAL)), nil)
	}
	for _, f := range []any{0x80, 4, 256, -1, n64(1 << 32)} {
		name := "bad-flag"
		if v, ok := f.(int); ok {
			name += "-" + itoa(v)
		} else {
			name += "-five-bytes"
		}
		b.cov("sig/OP_SIGHASH/"+name, OP_SIGHASH, "3.8/sighash-opcode", sc(f, o(OP_SIGHASH, OP_DROP, OP_1)), nil)
	}
	single := txWith("one-output", func(tx *wire.MsgTx) { tx.TxOut = tx.TxOut[:1] })
	b.cov("sig/OP_SIGHASH/single-without-output", OP_SIGHASH, "3.8/sighash-opcode", sc(3, o(OP_SIGHASH, OP_DROP, OP_1)), nil, inW(single), at(1, 0))
	b.cov("sig/OP_SIGHASH/single-anyonecanpay-without-output", OP_SIGHASH, "3.8/sighash-opcode", sc(0x83, o(OP_SIGHASH, OP_DROP, OP_1)), nil, inW(single), at(1, 0))
	// masking: the emulator packet's witness blobs are not committed
	ep := emulatorPacketWorld("emulator-packet-sighash",
		EmulatorEntry{Vin: 0, Script: []byte{OP_1}, Witness: wire.TxWitness{{0xde, 0xad}}},
		EmulatorEntry{Vin: 1, Script: []byte{OP_2}})
	for _, idx := range []int{0, 1} {
		dg := sighashFor(ep, idx, defaultLeaf, txscript.SigHashDefault)
		b.cov("sig/OP_SIGHASH/masked-outputs-flag-0-input-"+itoa(idx), OP_SIGHASH, "3.8/output-masking", sc(0, o(OP_SIGHASH), dg, o(OP_EQUAL)), nil, inW(ep), at(idx, 0))
	}
	// SINGLE hashes only output[idx]; the masked form is substituted when that is the extension
	epSingle := &world{name: "emulator-packet-extension-at-1", tx: ep.tx.Copy(), prevouts: ep.prevouts}
	epSingle.tx.TxOut[1], epSingle.tx.TxOut[2] = epSingle.tx.TxOut[2], epSingle.tx.TxOut[1]
	for _, f := range []int{3, 0x83} {
		for _, idx := range []int{0, 1} {
			name := "sig/OP_SIGHASH/single-flag-" + itoa(f) + "-plain-output-0"
			if idx == 1 {
				name = "sig/OP_SIGHASH/single-flag-" + itoa(f) + "-masked-extension-output-1"
			}
			dg := sighashFor(epSingle, idx, defaultLeaf, txscript.SigHashType(f))
			b.cov(name, OP_SIGHASH, "3.8/output-masking", sc(f, o(OP_SIGHASH), dg, o(OP_EQUAL)), nil, inW(epSingle), at(idx, 0))
		}
	}
	noEmu := txWith("extension-without-emulator-packet", func(tx *wire.MsgTx) {
		tx.AddTxOut(extOut(extension.UnknownPacket{PacketType: 7, Data: []byte{1, 2, 3}}))
	})
	b.cov("sig/OP_SIGHASH/extension-without-emulator-packet", OP_SIGHASH, "3.8/output-masking", sc(0, o(OP_SIGHASH), sighashFor(noEmu, 0, defaultLeaf, 0), o(OP_EQUAL)), nil, inW(noEmu))
	// CODESEPARATOR records the opcode position, not the byte offset
	csLeaf := defaultLeaf
	script := sc(rep(9, 3), o(OP_DROP, OP_CODESEPARATOR), pub, o(OP_CHECKSIG))
	byPos := schnorrSig(sigKey, sighashFor(w, 0, csLeaf, 0, 2))
	byOffset := schnorrSig(sigKey, sighashFor(w, 0, csLeaf, 0, 5))
	b.cov("sig/OP_CODESEPARATOR/opcode-position", OP_CODESEPARATOR, "3.9/codesep-opcode-position", script, [][]byte{byPos})
	b.cov("sig/OP_CODESEPARATOR/byte-offset-rejected", OP_CODESEPARATOR, "3.9/codesep-opcode-position", script, [][]byte{byOffset})
	b.cov("sig/OP_CODESEPARATOR/dead-branch-ignored", OP_CODESEPARATOR, "3.9/codesep-opcode-position", sc(o(OP_0, OP_IF, OP_CODESEPARATOR, OP_ENDIF), pub, o(OP_CHECKSIG)), [][]byte{good})
	b.cov("sig/OP_SIGHASH/after-codeseparator", OP_SIGHASH, "3.9/codesep-opcode-position", sc(o(OP_CODESEPARATOR), 0, o(OP_SIGHASH), sighashFor(w, 0, csLeaf, 0, 0), o(OP_EQUAL)), nil)
	for _, op := range []int{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_CHECKSIGADD, OP_SIGHASH, OP_CODESEPARATOR} {
		b.ex("sig/"+slots[op].name+"/needs-taproot-context", op, "3.9/ctx-gated", sc([]byte{}, []byte{}, []byte{}, o(op)))
	}
	b.ex("sig/OP_CHECKSIGFROMSTACK/no-context-needed", OP_CHECKSIGFROMSTACK, "3.9/ctx-gated", sc([]byte{}, []byte{1}, pub, o(OP_CHECKSIGFROMSTACK)))
	b.ex("sig/OP_CHECKMULTISIG/disabled", OP_CHECKMULTISIG, "3.8/checkmultisig-disabled", sc(o(OP_0, OP_0, OP_0, OP_CHECKMULTISIG)))
	b.ex("sig/OP_CHECKMULTISIG/dead-branch-ok", OP_CHECKMULTISIG, "3.8/checkmultisig-disabled", sc(o(OP_0, OP_IF, OP_CHECKMULTISIG, OP_ENDIF, OP_1)))
	b.ex("sig/OP_CHECKMULTISIGVERIFY/disabled", OP_CHECKMULTISIGVERIFY, "3.8/checkmultisig-disabled", sc(o(OP_CHECKMULTISIGVERIFY)))
	m := sha256.Sum256([]byte("message"))
	csfs := func(name, hz string, sig, message, key []byte) {
		b.ex("sig/OP_CHECKSIGFROMSTACK/"+name, OP_CHECKSIGFROMSTACK, hz, sc(sig, message, key, o(OP_CHECKSIGFROMSTACK)))
	}
	csfs("schnorr-valid", "3.8/csfs", schnorrSig(sigKey, m[:]), m[:], pub)
	csfs("schnorr-wrong-message", "3.8/csfs", schnorrSig(sigKey, m[:]), rep(1, 32), pub)
	csfs("message-not-hashed-31-bytes", "3.8/csfs", schnorrSig(sigKey, m[:]), m[:31], pub)
	csfs("empty-sig-garbage-key", "3.8/csfs", []byte{}, m[:], []byte{9, 9})
	csfs("empty-key", "3.8/csfs", schnorrSig(sigKey, m[:]), m[:], []byte{})
	csfs("ecdsa-k1", "3.8/csfs", ecdsaK1(sigKey, m[:], false), m[:], k1)
	csfs("ecdsa-k1-high-s", "3.8/low-s", ecdsaK1(sigKey, m[:], true), m[:], k1)
	csfs("ecdsa-r1", "3.8/csfs", ecdsaR1(rd, m[:], false), m[:], r1)
	csfs("ecdsa-r1-message-33", "3.8/csfs", ecdsaR1(rd, m[:], false), append(m[:], 0), r1)
	csfs("65-byte-sig", "3.8/csfs", append(schnorrSig(sigKey, m[:]), 1), m[:], pub)
	csfs("x-not-on-curve", "3.8/pubkey-schemes", schnorrSig(sigKey, m[:]), m[:], append(rep(0, 31), 5))
	csfs("r1-key-not-on-curve", "3.8/pubkey-schemes", ecdsaR1(rd, m[:], false), m[:], append([]byte{0x11, 0x02}, rep(0xff, 32)...))
	return b.cases
}

func ecHand() []*Case {
	b := &book{}
	g := btcec.Generator()
	gx, gy := new(big.Int).SetBytes(g.X().Bytes()), new(big.Int).SetBytes(g.Y().Bytes())
	n := btcec.S256().N
	p256 := elliptic.P256().Params()
	_, _, g1, g2 := gnarkbn254.Generators()
	var bx, by, x0, x1, y0, y1 big.Int
	g1.X.BigInt(&bx)
	g1.Y.BigInt(&by)
	g2.X.A0.BigInt(&x0)
	g2.X.A1.BigInt(&x1)
	g2.Y.A0.BigInt(&y0)
	g2.Y.A1.BigInt(&y1)
	type pt struct{ x, y *big.Int }
	gens := []pt{{gx, gy}, {p256.Gx, p256.Gy}, {&bx, &by}}
	zero := big.NewInt(0)
	for id, gp := range gens {
		cid := itoa(id)
		b.ex("ec/OP_ECADD/curve-"+cid+"-double", OP_ECADD, "3.7/curves", sc(gp.x, gp.y, gp.x, gp.y, id, o(OP_ECADD)))
		b.ex("ec/OP_ECADD/curve-"+cid+"-infinity-identity", OP_ECADD, "3.7/infinity", sc(zero, zero, gp.x, gp.y, id, o(OP_ECADD)))
		b.ex("ec/OP_ECADD/curve-"+cid+"-p-plus-minus-p", OP_ECADD, "3.7/infinity", sc(gp.x, gp.y, gp.x, new(big.Int).Sub(fieldOf(id), gp.y), id, o(OP_ECADD)))
		b.ex("ec/OP_ECADD/curve-"+cid+"-off-curve", OP_ECADD, "3.7/coord-range", sc(gp.x, new(big.Int).Add(gp.y, big.NewInt(1)), gp.x, gp.y, id, o(OP_ECADD)))
		b.ex("ec/OP_ECADD/curve-"+cid+"-coordinate-at-p", OP_ECADD, "3.7/coord-range", sc(fieldOf(id), gp.y, gp.x, gp.y, id, o(OP_ECADD)))
		b.ex("ec/OP_ECMUL/curve-"+cid+"-by-3", OP_ECMUL, "3.7/coord-bignum-encoding", sc(gp.x, gp.y, 3, id, o(OP_ECMUL)))
		b.ex("ec/OP_ECMUL/curve-"+cid+"-by-0", OP_ECMUL, "3.7/infinity", sc(gp.x, gp.y, 0, id, o(OP_ECMUL)))
		b.ex("ec/OP_ECMUL/curve-"+cid+"-infinity", OP_ECMUL, "3.7/infinity", sc(zero, zero, 5, id, o(OP_ECMUL)))
		b.ex("ec/OP_ECMUL/curve-"+cid+"-scalar-at-order", OP_ECMUL, "3.7/coord-range", sc(gp.x, gp.y, orderOf(id), id, o(OP_ECMUL)))
		b.ex("ec/OP_ECMUL/curve-"+cid+"-negative-scalar", OP_ECMUL, "3.7/coord-range", sc(gp.x, gp.y, -1, id, o(OP_ECMUL)))
	}
	b.ex("ec/OP_ECADD/unknown-curve", OP_ECADD, "3.7/curves", sc(gx, gy, gx, gy, 3, o(OP_ECADD)))
	b.ex("ec/OP_ECADD/curve-id-nine-bytes", OP_ECADD, "3.1/usebig", sc(gx, gy, gx, gy, pow2(63), o(OP_ECADD)))
	b.ex("ec/OP_ECADD/curve-id-negative", OP_ECADD, "3.7/curves", sc(gx, gy, gx, gy, -1, o(OP_ECADD)))
	b.ex("ec/OP_ECADD/pop-order", OP_ECADD, "3.7/pop-orders", sc(gx, gy, 0, 0, 0, o(OP_ECADD)))
	pair := func(px, py *big.Int) []any { return []any{px, py, &x1, &x0, &y1, &y0} }
	negY := new(big.Int).Sub(fieldOf(2), &by)
	pr := func(name, hz string, parts ...any) {
		b.ex("ec/OP_ECPAIRING/"+name, OP_ECPAIRING, hz, sc(append(parts, o(OP_ECPAIRING))...))
	}
	pr("single-pair-false", "3.7/pairing", append(pair(&bx, &by), 1, 2)...)
	pr("g1-infinity-true", "3.7/pairing", append(pair(zero, zero), 1, 2)...)
	pr("p-and-minus-p-true", "3.7/pairing", append(append(pair(&bx, &by), pair(&bx, negY)...), 2, 2)...)
	pr("zero-pairs", "3.7/pairing", 0, 2)
	pr("seventeen-pairs", "3.7/pairing", 17, 2)
	pr("not-bn254", "3.7/pairing", append(pair(&bx, &by), 1, 0)...)
	pr("c0-c1-swapped", "3.7/pairing", &bx, &by, &x0, &x1, &y0, &y1, 1, 2)
	pr("too-few-items", "3.7/pairing", &bx, &by, 1, 2)
	var u gnarkbn254.E2
	u.A0.SetUint64(5)
	u.A1.SetUint64(7)
	q := gnarkbn254.MapToCurve2(&u)
	if !q.IsOnCurve() || q.IsInSubGroup() {
		panic("MapToCurve2 sample is not an off-subgroup twist point")
	}
	var qx0, qx1, qy0, qy1 big.Int
	q.X.A0.BigInt(&qx0)
	q.X.A1.BigInt(&qx1)
	q.Y.A0.BigInt(&qy0)
	q.Y.A1.BigInt(&qy1)
	pr("g2-not-in-subgroup", "3.7/pairing", &bx, &by, &qx1, &qx0, &qy1, &qy0, 1, 2)
	compressed := g.SerializeCompressed()
	two := new(btcec.JacobianPoint)
	var jg btcec.JacobianPoint
	g.AsJacobian(&jg)
	btcec.AddNonConst(&jg, &jg, two)
	two.ToAffine()
	q2 := btcec.NewPublicKey(&two.X, &two.Y).SerializeCompressed()
	k2 := make([]byte, 32)
	k2[31] = 2
	msv := func(name, hz string, k, p, q []byte) {
		b.ex("ec/OP_ECMULSCALARVERIFY/"+name, OP_ECMULSCALARVERIFY, hz, sc(k, p, q, o(OP_ECMULSCALARVERIFY, OP_1)))
	}
	msv("valid", "3.7/ecmulscalarverify", k2, compressed, q2)
	msv("wrong-q", "3.7/ecmulscalarverify", k2, compressed, compressed)
	msv("k-zero-infinity", "3.7/ecmulscalarverify", make([]byte, 32), compressed, append([]byte{2}, make([]byte, 32)...))
	msv("k-31-bytes", "3.7/ecmulscalarverify", k2[1:], compressed, q2)
	msv("k-at-order", "3.7/ecmulscalarverify", n.FillBytes(make([]byte, 32)), compressed, q2)
	msv("p-uncompressed", "3.7/ecmulscalarverify", k2, g.SerializeUncompressed(), q2)
	msv("k-little-endian", "3.7/ecmulscalarverify", append([]byte{2}, make([]byte, 31)...), compressed, q2)
	one := make([]byte, 32)
	one[31] = 1
	nm1 := new(big.Int).Sub(n, big.NewInt(1)).FillBytes(make([]byte, 32))
	tw := func(name, hz string, p, k, q []byte) {
		b.ex("ec/OP_TWEAKVERIFY/"+name, OP_TWEAKVERIFY, hz, sc(p, k, q, o(OP_TWEAKVERIFY, OP_1)))
	}
	tw("valid", "3.7/tweakverify", compressed[1:], one, q2)
	tw("cancels-to-infinity", "3.7/tweakverify", compressed[1:], nm1, append([]byte{2}, make([]byte, 32)...))
	tw("p-compressed-33", "3.7/tweakverify", compressed, one, q2)
	tw("p-not-on-curve", "3.7/tweakverify", append(rep(0, 31), 5), one, q2)
	tw("wrong-q", "3.7/tweakverify", compressed[1:], one, compressed)
	tw("k-at-order", "3.7/tweakverify", compressed[1:], n.FillBytes(make([]byte, 32)), q2)
	return b.cases
}

func fieldOf(id int) *big.Int {
	return [](*big.Int){btcec.S256().P, elliptic.P256().Params().P, bi("21888242871839275222246405745257275088696311157297823662689037894645226208583")}[id]
}

func orderOf(id int) *big.Int {
	return [](*big.Int){btcec.S256().N, elliptic.P256().Params().N, bi("21888242871839275222246405745257275088548364400416034343698204186575808495617")}[id]
}
